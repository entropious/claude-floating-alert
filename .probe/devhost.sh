#!/bin/bash
# Проверка расширения в Extension Development Host.
#
#   bash .probe/devhost.sh deps             положить Claude Code и colorizer в отладочный профиль
#   bash .probe/devhost.sh start            сборка + окно с отладочным профилем
#   bash .probe/devhost.sh restart          закрыть окно и поднять пересобранное
#   bash .probe/devhost.sh stop             закрыть окно
#
#   bash .probe/devhost.sh surfaces         какие чаты Claude Code видит и где они
#   bash .probe/devhost.sh focus            какое окно считает себя активным
#   bash .probe/devhost.sh alerts           алерты, висящие на экране прямо сейчас
#
#   bash .probe/devhost.sh sidebar          открыть чат в боковой панели
#   bash .probe/devhost.sh tab              открыть чат вкладкой
#   bash .probe/devhost.sh hide             спрятать вторичную боковую панель
#   bash .probe/devhost.sh explorer         переключить панель на проводник
#   bash .probe/devhost.sh command <имя>    любая команда редактора через палитру
#
#   bash .probe/devhost.sh raise            дождаться, пока окно стенда в фокусе
#   bash .probe/devhost.sh fire [kind]      прогнать хук: stop | permission | question
#   bash .probe/devhost.sh case sidebar     два окна, в обоих чат в панели
#   bash .probe/devhost.sh case tab         два окна, в обоих чат вкладкой
#   bash .probe/devhost.sh case mixed       два окна, в обоих и панель, и вкладка
#   bash .probe/devhost.sh case <имя> <кусок описания>
#                                           только эти клетки, на уже поднятых окнах
#
#   Любой сценарий гоняется дважды: с патчем Claude Code (отчёты о поверхностях)
#   и без него. Один вид профиля ставится вручную: flavour patched | plain.
#
#   PROBE_FOCUS=real гонит фокус по-настоящему — окна выходят вперёд сами, и
#   проверяется в том числе то, как расширение публикует фокус. Работать рядом
#   в это время нельзя, поэтому по умолчанию фокус подделывается (pretend).
#
#   bash .probe/devhost.sh codex            запускает ли Codex наши хуки (доверие)
#   bash .probe/devhost.sh containers       какая панель выбрана в окне стенда
#   bash .probe/devhost.sh case codex       сценарий: панель Codex решает судьбу алерта
#   bash .probe/devhost.sh case live-codex  сценарий: событие присылает сам Codex
#   bash .probe/devhost.sh case live-claude сценарий: событие присылает сам Claude Code
#
# Окно запускается один раз и само себя не перезапускает: пересборка
# подхватывается только явным restart.
set -u
cd "$(dirname "$0")/.."
ROOT="$PWD"
CODE="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
PROFILE="$ROOT/.probe/vscode-user"
EXTENSIONS="$ROOT/.probe/vscode-ext"
export CDP_PORT="${CDP_PORT:-9333}"
# Своя папка, и намеренно вне репозитория: событие достаётся окну, у которого
# открыта папка выше по дереву, — лежи она в .probe, на событие отвечало бы и
# рабочее окно, открытое на корне проекта. В ~/.claude её тоже не место: там
# живут боевые файлы расширения, и стенд к ним ничего не добавляет.
# Переданное значение сохраняется: шаги сценария вызывают этот же скрипт, и
# безусловный экспорт сбрасывал бы им папку на первое окно — команды для
# второго доставались бы первому.
export PROBE_CWD="${PROBE_CWD:-$(dirname "$ROOT")/.claude-floating-alert-probe}"
# Второе окно того же редактора — для проверок про разные окна. Папка своя по
# той же причине: событие достаётся окну, у которого она открыта.
PROBE_CWD1="$PROBE_CWD"
PROBE_CWD2="$(dirname "$ROOT")/.claude-floating-alert-probe-2"
ARGS=(--user-data-dir="$PROFILE" --extensions-dir="$EXTENSIONS")
CHECK=(node "$ROOT/.probe/devhost-check.js")

cdp_up() { curl -s --max-time 2 "http://127.0.0.1:$CDP_PORT/json/version" > /dev/null 2>&1; }

# Как выставляется «пользователь сейчас здесь».
#
#   real     — окно поднимается по-настоящему, как это делает человек. Проверка
#              тогда захватывает и то, как расширение публикует фокус, — но
#              прогон забирает фокус себе, и работать рядом нельзя.
#   pretend  — подделывается строчка focused в файле окна. Никому не мешает и
#              потому стоит по умолчанию; настоящую смену фокуса не проверяет.
#
# Выбор держится в файле, а не в переменной: команды стенда зовутся по одной, и
# переменная впереди каждой из них — лишний вопрос о правах на каждый вызов.
#   bash .probe/devhost.sh focus-mode real | pretend
PROBE_FOCUS="${PROBE_FOCUS:-$(cat "$ROOT/.probe/focus-mode" 2>/dev/null || echo pretend)}"

# Вывести вперёд окно такой-то папки, или увести редактор целиком (none).
look_at() {
	if [ "$PROBE_FOCUS" = "pretend" ]; then
		if [ "$1" = "none" ]; then
			PROBE_CWD="$PROBE_CWD1" "${CHECK[@]}" pretend off > /dev/null
			PROBE_CWD="$PROBE_CWD2" "${CHECK[@]}" pretend off > /dev/null
		else
			# Фокус один на всех: назначая его окну, остальные уводим в фон.
			PROBE_CWD="$1" "${CHECK[@]}" pretend on > /dev/null
		fi
		return 0
	fi
	if [ "$1" = "none" ]; then
		# «Редактора перед глазами нет» — единственное место, где фокус всё-таки
		# подделывается. По-настоящему увести его недолго, а вот вернуть нельзя:
		# из фона приложение себя вперёд не выводит, это решает система по
		# действию человека, и следующая клетка упиралась бы в это, а не в хук.
		# Хук судит по тем же файлам окон, а проверка «щелчок вывел окно вперёд»
		# в таких клетках и не спрашивается.
		PROBE_CWD="$PROBE_CWD1" "${CHECK[@]}" pretend off > /dev/null
		PROBE_CWD="$PROBE_CWD2" "${CHECK[@]}" pretend off > /dev/null
		return 0
	else
		# Открытие уже открытой папки поднимает её окно и ничего не заводит.
		"$CODE" "${ARGS[@]}" "$1" > /dev/null 2>&1
	fi
	# Расширение пишет фокус на своём событии, и оно приходит не мгновенно.
	# Полсекунды сверху — редактору на то, чтобы разобраться с окнами: сразу
	# после переключения он ещё не готов вывести вперёд соседнее окно по просьбе.
	sleep 0.5
	for try in $(seq 1 40); do
		sleep 0.3
		if [ "$1" = "none" ]; then
			"${CHECK[@]}" focus | grep -q "в фокусе" || return 0
		else
			"${CHECK[@]}" focus | grep "в фокусе" | grep -q "$(basename "$1")" && return 0
		fi
		# Занятый редактор глотает просьбу молча — сразу после ответа в чате он
		# занят надолго, — поэтому просим снова, пока ждём.
		case "$try" in
		7|14|21|28) [ "$1" != "none" ] && "$CODE" "${ARGS[@]}" "$1" > /dev/null 2>&1 ;;
		esac
		# А когда редактора нет на экране вовсе — предыдущая клетка уводила взгляд
		# в сторону, — сам он вперёд не выйдет: это решает система, и просить её
		# приходится отдельно.
		case "$try" in
		10|20|30) [ "$1" != "none" ] && open -b com.microsoft.VSCode ;;
		esac
	done
	echo "окно $1 так и не вышло вперёд"
	return 1
}

# Только процессы этого отладочного профиля, чужие окна VS Code не трогаются.
host_pids() { ps ax -o pid,command | grep "user-data-dir=$PROFILE" | grep -v grep | awk '{print $1}'; }

# Алерт живёт отдельным процессом и переживает окно, которое его открыло.
# Только панели стенда: рядом идёт обычная работа, и её алерт ждёт ответа —
# снимать его прогону не за чем.
kill_alerts() {
	for folder in "$PROBE_CWD1" "$PROBE_CWD2"; do
		pkill -f "claude-alert .*--folder $folder " 2>/dev/null
	done
	true
}

# Окно стенда числится активным, пока идёт ожидание. Одной записи мало:
# расширение переписывает файл окна на своих событиях — а событий во время
# живого ответа хватает, — и к проверке от подделки не осталось бы следа.
HOLD=""
hold_focus() {
	release_focus
	while :; do
		"${CHECK[@]}" pretend on > /dev/null 2>&1
		sleep 1
	done &
	HOLD=$!
}
release_focus() {
	[ -n "$HOLD" ] && kill "$HOLD" 2>/dev/null
	HOLD=""
}

# Алерт события «нужно разрешение» висит, пока его не нажмут, — и переживает
# сценарий. Оставленный на экране, он потом уводит в папку стенда: её открытым
# держит только профиль стенда, так что щелчок заводит новое окно.
# Только на сценарий целиком: его шаги вызывают этот же скрипт, и уборка внутри
# них снимала бы алерт, по которому шаг собирается щёлкнуть.
cleanup() { release_focus; kill_alerts; }
[ "${1:-}" = "case" ] && trap cleanup EXIT INT TERM

case "${1:-}" in
deps)
	mkdir -p "$EXTENSIONS"
	# Claude Code берётся уже установленный — вместе с патчем, который в нём есть.
	# Codex нужен не работающим, а зарегистрированным: сценарию хватает того,
	# что редактор знает его контейнер и пишет его id в состояние окна.
	# Colorizer берётся один, самый свежий: установленных версий рядом лежит
	# несколько, и профиль с ними всеми выбирал бы её сам.
	colorizer=$(ls -d "$HOME"/.vscode/extensions/local.claude-code-colorizer-* 2>/dev/null | sort -V | tail -1)
	for dir in "$HOME"/.vscode/extensions/anthropic.claude-code-* "$HOME"/.vscode/extensions/openai.chatgpt-* $colorizer; do
		[ -d "$dir" ] || continue
		target="$EXTENSIONS/$(basename "$dir")"
		# Именно перезапись: патч в установленном Claude Code меняется, а копия
		# со старым патчем молча гоняла бы прошлую версию.
		rm -rf "$target"
		cp -R "$dir" "$target"
		echo "положено: $(basename "$dir")"
	done
	"${CHECK[@]}" register "$EXTENSIONS"
	"${CHECK[@]}" seed "$PROFILE"
	echo "готово; своё расширение окно берёт из рабочего дерева, ставить его не нужно"
	;;

# Профиль в одном из двух видов. Патч Claude Code — это отчёты о поверхностях,
# и с ними хук отвечает точно; без них он работает на одних окнах и ярлыках
# вкладок. Обе дороги живые, и проверять надо обе.
flavour)
	want="${2:-patched}"
	# Выбор запоминается: пока он стоит, сценарии идут только в этом виде — иначе
	# каждый прогон гоняет оба. `flavour both` снимает выбор.
	if [ "$want" = "both" ]; then
		rm -f "$ROOT/.probe/flavour"
		echo "профиль: оба вида"
		exit 0
	fi
	echo "$want" > "$ROOT/.probe/flavour"
	exec bash "$0" profile "$want"
	;;

# Собрать профиль нужного вида, ничего не запоминая: этим прогон и переключает
# виды внутри себя, и запись здесь свела бы «оба» к последнему из них.
profile)
	want="${2:-patched}"
	bash "$0" deps > /dev/null || exit 1
	if [ "$want" = "plain" ]; then
		# Патч оставляет рядом исходные файлы — по ним копия возвращается к
		# нетронутому Claude Code, и отчитываться о чатах становится нечему.
		originals=$(find "$EXTENSIONS" -name '*.ccc-orig')
		[ -n "$originals" ] || { echo "в копии нет исходников патча: установленный Claude Code не пропатчен?"; exit 1; }
		for orig in $originals; do cp "$orig" "${orig%.ccc-orig}"; done
		rm -rf "$EXTENSIONS"/local.claude-code-colorizer-*
		"${CHECK[@]}" register "$EXTENSIONS" > /dev/null
	fi
	# Отчёты прошлого вида пережили бы смену профиля: файлы лежат в ~/.claude, а
	# не в нём, и мёртвыми их делает только смерть хоста.
	rm -f "$HOME/.claude/floating-alert/presence/"*.json
	echo "профиль: $want"
	;;

start)
	npm run compile 2>&1 | grep -E "error TS" && { echo "сборка упала"; exit 1; }
	npm run build:native > /dev/null 2>&1 || { echo "swiftc не собрал алерт"; exit 1; }
	if cdp_up; then echo "окно уже запущено (CDP на $CDP_PORT)"; exit 0; fi
	# Пустой профиль встречает приветствием и предложением войти в Copilot, а
	# диалог поверх окна съедает всё, что уходит в палитру.
	mkdir -p "$PROFILE/User"
	cat > "$PROFILE/User/settings.json" <<-'JSON'
	{
	  "workbench.startupEditor": "none",
	  "workbench.welcomePage.walkthroughs.openOnInstall": false,
	  "chat.commandCenter.enabled": false,
	  "update.mode": "none",
	  "update.showReleaseNotes": false,
	  "telemetry.telemetryLevel": "off",
	  "extensions.autoUpdate": false,
	  // Патч поднимает на старте последнюю сессию, а она общая на всю машину:
	  // свежее окно стенда встречало бы чат из рабочего окна, и сценарий начинал
	  // бы гонять чужую сессию вместо своей.
	  "claudeCodeColorizer.loadLastSessionOnStartup": false,
	  // Claude Code запоминает, куда открывать чат, и после работы в панели
	  // открывает вкладкой туда же. Стенду нужны обе поверхности: панель он
	  // открывает своей командой, а «вкладкой» должно значить вкладкой.
	  "claudeCode.preferredLocation": "editor"
	}
	JSON
	mkdir -p "$PROBE_CWD"
	# Профиль помнит открытые вкладки и панели, и «свежее» окно поднималось бы
	# с чатами прошлого прогона. Логин Claude Code лежит в ~/.claude и цел.
	rm -rf "$PROFILE/User/workspaceStorage" "$PROFILE/User/History"
	"$CODE" "${ARGS[@]}" --remote-debugging-port="$CDP_PORT" \
		--extensionDevelopmentPath="$ROOT" --new-window "$PROBE_CWD" \
		--disable-workspace-trust --skip-welcome --skip-release-notes --disable-updates \
		> "$ROOT/.probe/devhost.log" 2>&1 &
	# Проверять раз в две секунды значит терять их же на пустом месте: окно
	# поднимается неровно, и опрос почаще ловит его сразу.
	for _ in $(seq 1 120); do sleep 0.5; cdp_up && break; done
	cdp_up || { echo "окно не поднялось за 60с, см. .probe/devhost.log"; exit 1; }
	sleep 1
	"${CHECK[@]}" escape > /dev/null 2>&1
	echo "окно готово, CDP на $CDP_PORT"
	;;

# Второе окно того же редактора: один профиль, один порт отладки — как у
# пользователя, у которого просто два окна.
#
# Без --extensionDevelopmentPath: с ним запуск уходит в никуда, окна не будет.
# Расширение из рабочего дерева второму окну и так достаётся — редактор держит
# его для всего приложения, а не для окна, которым его открыли.
second)
	mkdir -p "$PROBE_CWD2"
	"$CODE" "${ARGS[@]}" --new-window "$PROBE_CWD2" --disable-workspace-trust > /dev/null 2>&1 &
	for _ in $(seq 1 30); do
		sleep 0.5
		PROBE_CWD="$PROBE_CWD2" "${CHECK[@]}" focus 2>/dev/null | grep -q "probe-2" && break
	done
	PROBE_CWD="$PROBE_CWD2" "${CHECK[@]}" focus | grep -q "probe-2" || {
		echo "второе окно не поднялось"; exit 1
	}
	echo "второе окно готово"
	;;

stop)
	# Сначала окна просят закрыться сами: убитое окно редактор считает упавшим и
	# встречает диалогом «Reopen», который ждёт мышку. Просить надо каждое —
	# команда доходит до того окна, чью папку ей называют.
	if cdp_up; then
		# Перед просьбой — Escape: открытая палитра или подсказка съедает команду,
		# окно остаётся жить, и дальше его добивает сигнал.
		for folder in "$PROBE_CWD2" "$PROBE_CWD"; do
			PROBE_CWD="$folder" "${CHECK[@]}" escape > /dev/null 2>&1
			PROBE_CWD="$folder" "${CHECK[@]}" command "Close Window" > /dev/null 2>&1
			sleep 1
		done
		for _ in $(seq 1 15); do cdp_up || break; sleep 1; done
	fi
	for pid in $(host_pids); do kill "$pid" 2>/dev/null; done
	# Редактор закрывается не мгновенно, а start считает живой CDP признаком
	# уже поднятого окна и молча ничего не делает.
	for _ in $(seq 1 15); do cdp_up || break; sleep 1; done
	for pid in $(host_pids); do kill -9 "$pid" 2>/dev/null; done
	kill_alerts
	# Чаты живых прогонов оба агента пишут туда же, куда пользовательские.
	# Убираются они последними: пока окно живо, оно заводит их заново. У второго
	# окна свои — по его папке.
	"${CHECK[@]}" clean
	PROBE_CWD="$PROBE_CWD2" "${CHECK[@]}" clean
	rm -rf "$PROBE_CWD2"
	echo "окно закрыто"
	;;

restart)
	bash "$0" stop; bash "$0" start
	;;

surfaces|focus|alerts|targets|shot|front|codex|containers|pretend|panel|active|expected)
	"${CHECK[@]}" "$@"
	;;

# Вывести окно вперёд по-настоящему: открытием его папки. Отладчик поднимает
# окно только внутри процесса, а редактор рисует вебвью лишь в том окне, что
# на экране, — без этого в чат просто некуда печатать.
raise-window)
	"$CODE" "${ARGS[@]}" "${2:-$PROBE_CWD}" > /dev/null 2>&1
	sleep 1
	;;

# Что со вторым окном: поднять, открыть в нём панель и сказать, что вышло.
second-check)
	export PROBE_CWD="$PROBE_CWD2"
	bash "$0" raise-window "$PROBE_CWD2"
	bash "$0" panel-shown
	"${CHECK[@]}" panel
	"${CHECK[@]}" surfaces
	;;

raise)
	# Окно события должно быть в фокусе, иначе хук приписывает событие другому
	# окну с этой же папкой. Через `open` или `code` сюда не попасть — они
	# говорят с обычным профилем и заводят второе окно на ту же папку, — а вот
	# CDP поднимает именно то окно, к которому подключён.
	# CDP поднимает окно внутри своего процесса, но приложение в системе этим не
	# активируется: у стенда свой профиль, то есть отдельный процесс редактора.
	# Снаружи его не поднять — `open` уводит фокус на рабочее окно, а System
	# Events отвечает "Not authorised to send Apple events".
	# Свежее окно поднимается активным, так что рычаг на крайний случай —
	# перезапуск. Состояние он и так сбрасывает: сценарии начинаются с него.
	focused() { "${CHECK[@]}" focus | grep -q "в фокусе.*workspace"; }
	"${CHECK[@]}" front > /dev/null 2>&1
	for _ in $(seq 1 10); do focused && exit 0; sleep 1; done
	bash "$0" restart > /dev/null
	"${CHECK[@]}" front > /dev/null 2>&1
	for _ in $(seq 1 15); do focused && exit 0; sleep 1; done
	echo "окно так и не получило фокус"; exit 1
	;;

command)
	[ -n "${3:-}" ] && export PROBE_CWD="$3"
	"${CHECK[@]}" command "${2:?нужно название команды}"
	;;

sidebar)  "${CHECK[@]}" command "Claude Code: Open in Side Bar" ;;
# Поверх редактора — чат или что угодно другое. Вкладки перебираются, пока окно
# не скажет, что сверху нужное: гадать по числу переключений нельзя, порядок
# вкладок меняется от прогона к прогону.
chat-tab) "${CHECK[@]}" focus-tab chat ;;
code-tab) "${CHECK[@]}" focus-tab code ;;
# Панель в нужное положение, чем бы она ни была до того: щелчок по алерту сам
# её открывает, и следующая проверка иначе смотрела бы на другое состояние.
# Видно ли сейчас чат в боковой полосе окна такой-то папки, и что в этих полосах
# вообще стоит.
panel)
	[ -n "${2:-}" ] && export PROBE_CWD="$2"
	"${CHECK[@]}" panel
	;;
bars)
	[ -n "${2:-}" ] && export PROBE_CWD="$2"
	"${CHECK[@]}" bars
	;;
hide-chat)
	[ -n "${2:-}" ] && export PROBE_CWD="$2"
	"${CHECK[@]}" hide-chat
	;;
# Вывести вперёд окно такой-то папки (или увести редактор целиком: none) и
# дождаться, пока оно само об этом скажет.
look)
	look_at "${2:-$PROBE_CWD}"
	;;
# Нажать висящий алерт события такой-то папки — его же кодом.
press)
	[ -n "${2:-}" ] && export PROBE_CWD="$2"
	"${CHECK[@]}" press
	;;
# Ответить с висящего алерта и проверить, что из этого вышло.
accept)
	[ -n "${2:-}" ] && export PROBE_CWD="$2"
	"${CHECK[@]}" accept
	;;
# Выражение в главном фрейме окна такой-то папки — чтобы разбираться с разметкой
# редактора, не угадывая её.
eval)
	[ -n "${3:-}" ] && export PROBE_CWD="$3"
	"${CHECK[@]}" eval "${2:?нужно выражение}"
	;;
# Как выставлять «пользователь сейчас здесь» во всех дальнейших прогонах.
focus-mode)
	case "${2:-}" in
	real|pretend) echo "${2}" > "$ROOT/.probe/focus-mode"; echo "фокус: ${2}" ;;
	*) echo "фокус: $PROBE_FOCUS (real | pretend)" ;;
	esac
	;;
panel-hidden|panel-shown)
	# Папку можно назвать прямо здесь: команды для второго окна иначе пришлось бы
	# звать с переменной впереди, а это лишний вопрос о правах на каждый вызов.
	[ -n "${2:-}" ] && export PROBE_CWD="$2"
	# Команда палитры доходит только до окна, которое и правда впереди: у окна в
	# фоне палитра не открывается вовсе, и переключать было бы нечего. Фокус тут
	# ничего не решает — состояние выставляется до события или уже после алерта.
	[ "$PROBE_FOCUS" = "real" ] && { look_at "$PROBE_CWD" || exit 1; }
	want="скрыта"; [ "$1" = "panel-shown" ] && want="видима"
	# Попыток с запасом: в только что поднятом окне Claude Code ещё грузится, и
	# первые команды уходят в пустоту.
	# Прятать надо ту полосу, в которой чат сейчас и стоит, — а стоять он может
	# в любой из двух, и в обеих сразу. Этим занимается сама проверка.
	if [ "$want" = "скрыта" ]; then
		"${CHECK[@]}" hide-chat
		exit $?
	fi
	# Попыток с запасом: в только что поднятом окне Claude Code ещё грузится, и
	# первые команды уходят в пустоту.
	for _ in $(seq 1 20); do
		[ "$("${CHECK[@]}" panel)" = "$want" ] && { echo "панель: $want"; exit 0; }
		bash "$0" sidebar > /dev/null
		sleep 0.5
	done
	echo "панель не встала в положение: $want"; exit 1
	;;
# Событие в окне такой-то папки. Фокус при этом не трогается: он уже расставлен,
# и в проверках про два окна именно он и есть предмет.
event)
	folder="$2"; session="$3"; want="$4"; surface="$5"
	kill_alerts
	PROBE_CWD="$folder" "${CHECK[@]}" forget > /dev/null
	PROBE_CWD="$folder" "${CHECK[@]}" fire permission "$session" > /dev/null
	if [ "$want" = "silence" ]; then
		PROBE_CWD="$folder" "${CHECK[@]}" expect silence || exit 1
	else
		PROBE_CWD="$folder" "${CHECK[@]}" expect alert || exit 1
		PROBE_CWD="$folder" bash "$0" panel-hidden > /dev/null || exit 1
		PROBE_CWD="$folder" "${CHECK[@]}" press > /dev/null || exit 1
		PROBE_CWD="$folder" "${CHECK[@]}" landed "$session" "$surface" || exit 1
	fi
	;;

# Состояние клетки в окне такой-то папки: панель скрыта или видна, поверх
# редактора чат или код.
cell-state)
	export PROBE_CWD="$2"
	# Причина провала говорится вслух: клетка иначе падает молча, и остаётся
	# гадать, панель это не встала или вкладка не поднялась.
	bash "$0" "panel-$3" > /dev/null || { echo "панель не встала: $3"; exit 1; }
	bash "$0" "$4-tab" || { echo "поверх редактора не встало: $4"; exit 1; }
	;;

# Один чат в окне — в панели или вкладкой, — и больше ничего. Печатает его
# сессию; ею и стреляют события.
seed-one)
	export PROBE_CWD="$2"; kind="$3"
	# Пока окно позади, редактор не рисует его вебвью и печатать в чат некуда.
	"$CODE" "${ARGS[@]}" "$PROBE_CWD" > /dev/null 2>&1
	sleep 1
	# Настоящий файл, чтобы было чем перекрыть чат: несохранённая вкладка не даёт
	# окну закрыться и оставляет «окно завершилось неожиданно».
	echo "просто код, чтобы было чем перекрыть чат" > "$PROBE_CWD/code.txt"
	if [ "$kind" = "sidebar" ]; then
		bash "$0" panel-shown > /dev/null || exit 1
		"${CHECK[@]}" ask claude "напиши слово один" > /dev/null || exit 1
		session=$("${CHECK[@]}" wait-session sidebar 20) || exit 1
		# Чему-то поверх редактора быть надо: клетки говорят «чат на экране» через
		# то, что лежит сверху, а пустому редактору это сказать нечем.
		"$CODE" "${ARGS[@]}" "$PROBE_CWD/code.txt" > /dev/null 2>&1; sleep 1
	else
		bash "$0" tab > /dev/null
		"${CHECK[@]}" wait-surface tab 15 > /dev/null || exit 1
		"${CHECK[@]}" ask claude-tab "напиши слово два" > /dev/null || exit 1
		# Чат открывается соседней группой, и она заперта — код ушёл бы в первую,
		# а чат остался бы на экране.
		"${CHECK[@]}" unlock > /dev/null
		"$CODE" "${ARGS[@]}" "$PROBE_CWD/code.txt" > /dev/null 2>&1; sleep 1
		session=$("${CHECK[@]}" wait-session tab 25) || exit 1
		bash "$0" panel-hidden > /dev/null || exit 1
	fi
	echo "$session" | tee "$ROOT/.probe/one-$kind-$(basename "$2")"
	;;

# Пара чатов в окне: один в панели, другой вкладкой, у каждого своя сессия.
# Печатает их идентификаторы — по ним и стреляют события.
seed)
	export PROBE_CWD="$2"
	# Окно выводится вперёд по-настоящему: пока оно позади, редактор не
	# отрисовывает его вебвью, и печатать в чат просто некуда. Через отладчик
	# этого не добиться — он поднимает окно внутри процесса; поднимает открытие
	# его же папки.
	"$CODE" "${ARGS[@]}" "$PROBE_CWD" > /dev/null 2>&1
	sleep 1
	bash "$0" panel-shown > /dev/null || exit 1
	"${CHECK[@]}" ask claude "напиши слово один" > /dev/null || exit 1
	seed_sidebar=$("${CHECK[@]}" wait-session sidebar 20) || exit 1

	bash "$0" tab > /dev/null
	"${CHECK[@]}" wait-surface tab 5 > /dev/null || exit 1
	"${CHECK[@]}" ask claude-tab "напиши слово два" > /dev/null || exit 1
	# Чат открывается соседней группой, и она заперта — файл ушёл бы в первую, а
	# чат остался бы на экране. Со снятым замком он ложится к чату в одни вкладки,
	# и «поверх» снова что-то значит.
	"${CHECK[@]}" unlock > /dev/null
	# Настоящий файл, а не пустая вкладка: несохранённая вкладка не даёт окну
	# закрыться — на выходе оно спрашивает про сохранение, не дожидается ответа и
	# умирает от сигнала, оставляя после себя «окно завершилось неожиданно».
	echo "просто код, чтобы было чем перекрыть чат" > "$PROBE_CWD/code.txt"
	"$CODE" "${ARGS[@]}" "$PROBE_CWD/code.txt" > /dev/null 2>&1; sleep 1
	# Вкладка сперва отчитывается сессией панели и поправляется, когда её чат
	# заговорит сам; ждём именно её собственную.
	seed_tab=$("${CHECK[@]}" wait-session tab 25 "$seed_sidebar") || exit 1
	# Ответов тут не ждут: чаты обоих окон отвечают разом, и ждать их лучше
	# потом — сразу все четыре, а не по очереди.
	echo "$seed_sidebar $seed_tab" | tee "$ROOT/.probe/seed-$(basename "$2")"
	;;

# Одно событие: при каком окне, для какой сессии, чего от него ждут и — когда
# ждут алерт — куда обязан привести щелчок.
#
# Событие берётся из тех, что висят до ответа: у «задача готова» алерт гаснет
# через три секунды, и нажимать было бы уже нечего.
cell)
	# Где пользователь (папка окна или none), из какого окна событие, чьё оно и
	# чего от него ждут.
	here="$2"; folder="$3"; session="$4"; want="$5"; surface="$6"
	export PROBE_CWD="$folder"
	kill_alerts
	"${CHECK[@]}" forget > /dev/null
	look_at "$here"
	"${CHECK[@]}" fire permission "$session" > /dev/null
	if [ "$want" = "silence" ]; then
		"${CHECK[@]}" expect silence || exit 1
	else
		"${CHECK[@]}" expect alert || exit 1
		# Ответ с панели — на том же алерте, поэтому первым: он её гасит, и
		# событие поднимается заново для проверки щелчка. Кнопку даёт только
		# окно с colorizer'ом, то есть профиль с патчем.
		if [ "${PROBE_FLAVOUR:-patched}" = "patched" ]; then
			"${CHECK[@]}" accept || exit 1
			"${CHECK[@]}" forget > /dev/null
			"${CHECK[@]}" fire permission "$session" > /dev/null
			"${CHECK[@]}" expect alert || exit 1
		fi
		# Цель уводится с экрана до щелчка: иначе проверка сошлась бы и без него —
		# сессия и так на месте, а щелчок мог не сработать вовсе.
		#
		# При честном фокусе так нельзя: чтобы что-то спрятать в окне события,
		# его надо вывести вперёд, а расширение на это гасит его же алерты —
		# нажимать станет нечего. Там щелчок и проверяется по-другому: он обязан
		# вывести окно события вперёд, а не только показать чат.
		if [ "$PROBE_FOCUS" = "pretend" ]; then
			bash "$0" panel-hidden > /dev/null || exit 1
			[ "$surface" = "tab" ] && { bash "$0" code-tab > /dev/null || exit 1; }
		fi
		# Место, куда Claude Code открывает чат по команде, он переписывает сам —
		# и открытая в клетке панель делает «вкладкой» пустым словом.
		[ "$surface" = "tab" ] && "${CHECK[@]}" prefer editor > /dev/null
		"${CHECK[@]}" press || exit 1
		# Когда редактора на экране не было вовсе, вывести его вперёд — дело
		# системы, и разрешение на это она даёт по настоящему щелчку, которого
		# прогону взять негде.
		[ "$here" = "none" ] && away=away || away=here
		"${CHECK[@]}" landed "$session" "$surface" "$away" || exit 1
	fi
	;;
# Команда палитры открывает последнюю сессию, а её может и не быть. Кнопка в
# списке сессий заводит вкладку с новой в любом случае, а сам список открывается
# только иконкой в activity bar: его контейнер палитре не виден.
tab)      "${CHECK[@]}" bar "Claude Code" > /dev/null; sleep 1
          "${CHECK[@]}" click "New session" ;;
sessions) "${CHECK[@]}" bar "Claude Code" ;;
hide)     "${CHECK[@]}" command "View: Toggle Secondary Side Bar Visibility" ;;
explorer) "${CHECK[@]}" command "View: Show Explorer" ;;
# Логин Codex стенду не нужен: панель открывается и без него, а сценарию важно
# только то, какой контейнер после этого числится выбранным.
codexbar) "${CHECK[@]}" command "Codex: Open Codex Sidebar" ;;

fire)
	[ -n "${5:-}" ] && export PROBE_CWD="$5"
	kill_alerts
	"${CHECK[@]}" fire "${2:-stop}" "${3:-}" "${4:-}"
	sleep 1
	"${CHECK[@]}" alerts
	;;

case)
	# Каждый сценарий идёт дважды: с патчем Claude Code и без него. Хук отвечает
	# по-разному — отчёты о поверхностях против окон и ярлыков вкладок, — и
	# проверка одного вида ничего не говорит о другом.
	#
	# Кроме прогона одной клетки: он возвращается к уже поднятому окну, каким бы
	# оно ни было, и второй вид только погасил бы его.
	if [ -z "${PROBE_FLAVOUR:-}" ] && [ -z "${3:-}" ]; then
		status=0
		chosen=$(cat "$ROOT/.probe/flavour" 2>/dev/null || echo "patched plain")
		for flavour in $chosen; do
			echo "=== профиль: $flavour"
			bash "$0" profile "$flavour" > /dev/null || exit 1
			PROBE_FLAVOUR="$flavour" bash "$0" "$@" || status=1
		done
		# Прошло — за собой убираем: окна стенда, его чаты и записки прогона.
		# Упало — оставляем всё как есть, иначе к упавшей клетке не вернуться.
		if [ "$status" = 0 ]; then
			bash "$0" stop > /dev/null
			rm -f "$ROOT/.probe"/one-* "$ROOT/.probe"/seed*.log "$ROOT/.probe/matrix-state"
			echo "== чисто: окна закрыты, чаты стенда убраны"
		else
			echo "== окна оставлены: bash .probe/devhost.sh case ${2:-} \"<кусок описания>\""
		fi
		exit "$status"
	fi

	# Сессии и панели копятся от прогона к прогону, и сценарий начинает смотреть
	# на чужое состояние — поэтому каждый идёт со свежего окна.
	#
	# Кроме прогона одной клетки: `case <сценарий> <кусок описания>` берёт уже
	# поднятые окна и заведённые чаты, чтобы вернуться к упавшей клетке, а не
	# гонять сценарий заново.
	if [ -n "${3:-}" ]; then
		only="$3"
	else
		only=""
		bash "$0" restart > /dev/null
		# Окон всегда два: у пользователя их столько же, и «фокуса нет» тогда
		# значит не пустоту, а соседнее окно — как оно и бывает на самом деле.
		bash "$0" second > /dev/null || exit 1
	fi
	export PROBE_OTHER="$PROBE_CWD2"
	case "${2:-}" in
	codex)
		# Что решает судьбу алерта Codex: панель, выбранная в боковой полосе.
		# Сам чат Codex ни о чём не сообщает, поэтому сценарий переключает
		# контейнеры и смотрит, совпадает ли молчание с тем, что выбран Codex.
		echo "== событие Codex"
		# Фокус не забирается: окно числится активным по своему файлу, а панели
		# переключаются через CDP. Прогон не мешает тому, кто работает рядом.
		"${CHECK[@]}" pretend on

		bash "$0" codexbar > /dev/null; sleep 3
		echo "-- открыта панель Codex"
		chosen=$("${CHECK[@]}" containers)
		echo "$chosen"
		case "$chosen" in
		*codex*) ;;
		*)
			echo "панель Codex не открылась — есть ли он в профиле? bash .probe/devhost.sh deps"
			exit 1
			;;
		esac
		bash "$0" fire stop "" codex > /dev/null
		"${CHECK[@]}" expect silence || exit 1

		bash "$0" sidebar > /dev/null; sleep 3
		echo "-- та же полоса переключена на чат Claude Code"
		"${CHECK[@]}" containers
		bash "$0" fire stop "" codex > /dev/null
		"${CHECK[@]}" expect alert "agent=codex" || exit 1

		bash "$0" codexbar > /dev/null; sleep 3
		# Панель Codex снова выбрана: значит следующая проверка показывает именно
		# потерю окна, а не панель.
		echo "-- панель Codex выбрана, но окна нет перед глазами"
		"${CHECK[@]}" pretend off
		bash "$0" fire permission "" codex > /dev/null
		"${CHECK[@]}" expect alert "agent=codex" || exit 1
		;;
	accept)
		# Ответ прямо с панели, на главных путях, где она всплывает: чат в
		# панели и чат вкладкой, пользователь в соседнем окне и вовсе вне
		# редактора. Кнопку даёт окно с colorizer'ом, поэтому только этот вид
		# профиля.
		echo "== ответ с панели"
		bash "$0" seed "$PROBE_CWD1" > "$ROOT/.probe/seed-1.log" 2>&1 \
			|| { echo "окно не засеялось:"; tail -3 "$ROOT/.probe/seed-1.log"; exit 1; }
		seeded=$(cat "$ROOT/.probe/seed-$(basename "$PROBE_CWD1")")
		in_panel=${seeded% *}; in_tab=${seeded#* }
		echo "-- панель ${in_panel:0:8}, вкладка ${in_tab:0:8}"

		export PROBE_CWD="$PROBE_CWD1"
		"${CHECK[@]}" wait-answer "$in_panel" 40 > /dev/null || exit 1
		"${CHECK[@]}" wait-answer "$in_tab" 40 > /dev/null || exit 1
		kill_alerts

		# Второе окно должно быть готово до первой же проверки: расширение
		# выбрасывает просьбу, пришедшую пока окно поднимается, и проверка
		# упёрлась бы в это, а не в кнопку.
		for _ in $(seq 1 30); do
			PROBE_CWD="$PROBE_CWD2" "${CHECK[@]}" focus 2>/dev/null | grep -q "probe-2" && break
			sleep 1
		done

		for here in second none; do
			case "$here" in
			second) at="$PROBE_CWD2" ;;
			none)   at=none ;;
			esac
			for surface in sidebar tab; do
				case "$surface" in
				sidebar) session="$in_panel"; state="hidden" ;;
				tab)     session="$in_tab";   state="shown" ;;
				esac
				echo "-- ответ на чат в ${surface}, пользователь в ${here}"
				bash "$0" cell-state "$PROBE_CWD1" "$state" code \
					|| { echo "не выставилось состояние"; exit 1; }
				kill_alerts
				"${CHECK[@]}" forget > /dev/null
				look_at "$at" || exit 1
				"${CHECK[@]}" fire permission "$session" > /dev/null
				"${CHECK[@]}" expect alert || exit 1
				"${CHECK[@]}" accept || exit 1
			done
		done
		;;
	sidebar|tab|mixed)
		# Что открыто в окнах, то и проверяется: только чат в панели, только чат
		# вкладкой, или и то и другое разом. Окон всегда два, и событие приходит
		# из каждого, пока пользователь то в нём самом, то в соседнем, то вовсе
		# вне редактора.
		#
		# Тишина положена ровно тогда, когда пользователь в окне события и эта
		# самая сессия у него на экране. Всё прочее — алерт: в профиле с
		# colorizer'ом на нём сперва отвечают кнопкой, а затем — щелчок, который
		# обязан привести в её окно и её поверхность.
		kind="${2}"
		case "$kind" in
		sidebar) surfaces="sidebar"; echo "== два окна, чат в панели" ;;
		tab)     surfaces="tab";     echo "== два окна, чат вкладкой" ;;
		mixed)   surfaces="sidebar tab"; echo "== два окна, чат и в панели, и вкладкой" ;;
		esac

		if [ -n "$only" ]; then
			echo "-- только клетки со словами: $only"
		else
			for folder in "$PROBE_CWD1" "$PROBE_CWD2"; do
				for surface in $surfaces; do
					bash "$0" seed-one "$folder" "$surface" > "$ROOT/.probe/seed.log" 2>&1 \
						|| { echo "$(basename "$folder") не засеялось ($surface):"; tail -3 "$ROOT/.probe/seed.log"; exit 1; }
					echo "-- $(basename "$folder"), $surface: $(cut -c1-8 < "$ROOT/.probe/one-$surface-$(basename "$folder")")"
				done
			done
			# Чаты ещё отвечают, и каждый закончит своим Stop — настоящий алерт
			# посреди первых же проверок.
			for folder in "$PROBE_CWD1" "$PROBE_CWD2"; do
				for surface in $surfaces; do
					session=$(cat "$ROOT/.probe/one-$surface-$(basename "$folder")")
					PROBE_CWD="$folder" "${CHECK[@]}" wait-answer "$session" 40 > /dev/null || exit 1
					# И названия чата: без отчётов о поверхностях вкладку узнают
					# только по нему, и до него сессия во вкладке неотличима от
					# сессии в панели.
					PROBE_CWD="$folder" "${CHECK[@]}" wait-title "$session" 60 > /dev/null || exit 1
				done
			done
			kill_alerts
		fi

		# Со смешанным окном проверяется только то, чего в двух первых сценариях
		# нет: две поверхности разом, где легко спутать, чей это чат. Значит
		# пользователь всегда в окне события — в чужом окне обе сессии одинаково
		# не на экране, и это уже проверено, — а на экране всегда та поверхность,
		# которая не своя для события.
		[ "$kind" = "mixed" ] && wheres="first" || wheres="first second none"

		for from in first second; do
			case "$from" in
			first)  folder="$PROBE_CWD1" ;;
			second) folder="$PROBE_CWD2" ;;
			esac
			for here in $wheres; do
				# В смешанном сценарии пользователь всегда там же, откуда событие.
				[ "$kind" = "mixed" ] && here="$from"
				case "$here" in
				first)  at="$PROBE_CWD1" ;;
				second) at="$PROBE_CWD2" ;;
				none)   at=none ;;
				esac
				for surface in $surfaces; do
					session=$(cat "$ROOT/.probe/one-$surface-$(basename "$folder")")
					# Состояние окна события: где чат этой сессии и видно ли его.
					# У панели это она сама, у вкладки — что лежит поверх.
					for state in on off; do
						if [ "$surface" = "sidebar" ]; then
							[ "$state" = on ] && panel=shown || panel=hidden
							# В смешанном окне поверх редактора лежит чужой чат —
							# вкладка соседней сессии: своей сессии она не своя, и
							# принять её за неё как раз и есть чего бояться.
							[ "$kind" = "mixed" ] && top=chat || top=code
						else
							# То же с другой стороны: панель открыта и показывает
							# чат соседней сессии, а спрашивают про вкладку.
							[ "$kind" = "mixed" ] && panel=shown || panel=hidden
							[ "$state" = on ] && top=chat || top=code
						fi
						name="событие из ${from}, пользователь в ${here}, чат в ${surface} ${state}"
						case "$name" in *"$only"*) ;; *) continue ;; esac
						echo "-- $name"

						# Состояние выставляется заново перед каждой проверкой:
						# щелчок по алерту сам открывает панель или вкладку.
						bash "$0" cell-state "$folder" "$panel" "$top" \
							|| { echo "не выставилось состояние клетки"; exit 1; }
						want=alert
						[ "$here" = "$from" ] && [ "$state" = on ] && want=silence
						# Без отчётов о поверхностях панель для расширения невидима
						# вовсе: открыта она или спрятана, знать неоткуда, и окно
						# перед глазами — единственное, на что тут можно опереться.
						if [ "${PROBE_FLAVOUR:-}" = "plain" ] && [ "$surface" = "sidebar" ] \
							&& [ "$here" = "$from" ]; then
							want=silence
						fi
						bash "$0" cell "$at" "$folder" "$session" "$want" "$surface" || exit 1
					done
				done
			done
		done
		;;
	live-claude)
		# Настоящий чат в окне стенда: сессию он заводит только на первом
		# сообщении, и Stop-хук в конце ответа присылает сам Claude Code.
		# Панель при этом на экране — значит алерта быть не должно.
		echo "== настоящее событие от Claude Code"
		bash "$0" sidebar > /dev/null; sleep 2
		"${CHECK[@]}" ask claude "ответь одним словом: ok"
		session=$("${CHECK[@]}" wait-session sidebar 10) || exit 1
		echo "-- чат завёл сессию ${session:0:8}, ответ пошёл"
		"${CHECK[@]}" surfaces
		kill_alerts
		hold_focus
		"${CHECK[@]}" wait-answer "$session" 20 || { release_focus; exit 1; }
		"${CHECK[@]}" expect silence || { release_focus; exit 1; }
		release_focus
		;;
	live-codex)
		# Единственный сценарий, где событие настоящее: его присылает сам Codex
		# своим Stop-хуком. Остальные обходятся подделкой — она проверяет решение
		# хука, а этот проверяет, что до хука вообще доходит живой агент.
		# Событие присылает сам Codex, работающий в панели окна стенда, — своим
		# Stop-хуком в конце ответа. Пока он отвечает, панель уступает место чату
		# Claude Code: значит к моменту события чата Codex на экране нет.
		echo "== настоящее событие от Codex"
		bash "$0" codexbar > /dev/null; sleep 3
		# Пауза в самом задании: ответ приходит быстрее, чем стенд успевает увести
		# панель, и Stop заставал бы чат Codex ещё на экране — то есть проверял бы
		# не тот случай.
		"${CHECK[@]}" ask codex "выполни sleep 2, потом ответь одним словом: ok"
		bash "$0" sidebar > /dev/null; sleep 2
		echo "-- ответ идёт, а полоса уже переключена на чат Claude Code"
		"${CHECK[@]}" containers
		kill_alerts
		hold_focus
		# На прогретой панели алерт приходит через секунду после ответа, так что
		# ждать тут нечего: длинный срок скрыл бы поломку, а не пережил её.
		"${CHECK[@]}" wait-codex 10 || { release_focus; exit 1; }
		"${CHECK[@]}" expect alert "agent=codex" 5 || { release_focus; exit 1; }
		release_focus
		;;
	*)
		echo "сценарии: matrix | codex | live-codex | live-claude"; exit 1
		;;
	esac
	;;

*)
	sed -n '2,30p' "$0"
	;;
esac
