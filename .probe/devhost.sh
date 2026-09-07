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
#   bash .probe/devhost.sh case matrix      все сочетания панели, вкладок и двух окон
#   bash .probe/devhost.sh case matrix <кусок описания>
#                                           только эти клетки, на уже поднятом окне
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

# Только процессы этого отладочного профиля, чужие окна VS Code не трогаются.
host_pids() { ps ax -o pid,command | grep "user-data-dir=$PROFILE" | grep -v grep | awk '{print $1}'; }

# Алерт живёт отдельным процессом и переживает окно, которое его открыло.
kill_alerts() { pkill -f "floating-alert/bin/claude-alert" 2>/dev/null; true; }

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
	for dir in "$HOME"/.vscode/extensions/anthropic.claude-code-* "$HOME"/.vscode/extensions/openai.chatgpt-*; do
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
	  "extensions.autoUpdate": false
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
		PROBE_CWD="$PROBE_CWD2" "${CHECK[@]}" command "Close Window" > /dev/null 2>&1
		sleep 1
		"${CHECK[@]}" command "Close Window" > /dev/null 2>&1
		for _ in $(seq 1 10); do cdp_up || break; sleep 1; done
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
panel-hidden|panel-shown)
	want="скрыта"; [ "$1" = "panel-shown" ] && want="видима"
	# Попыток с запасом: в только что поднятом окне Claude Code ещё грузится, и
	# первые команды уходят в пустоту.
	for _ in $(seq 1 20); do
		[ "$("${CHECK[@]}" panel)" = "$want" ] && { echo "панель: $want"; exit 0; }
		if [ "$want" = "видима" ]; then bash "$0" sidebar > /dev/null; else bash "$0" hide > /dev/null; fi
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
		PROBE_CWD="$folder" "${CHECK[@]}" press "$PROFILE" "$EXTENSIONS" > /dev/null || exit 1
		PROBE_CWD="$folder" "${CHECK[@]}" landed "$session" "$surface" || exit 1
	fi
	;;

# Состояние клетки в окне такой-то папки: панель скрыта или видна, поверх
# редактора чат или код.
cell-state)
	export PROBE_CWD="$2"
	bash "$0" "panel-$3" > /dev/null || exit 1
	bash "$0" "$4-tab" > /dev/null || exit 1
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
	"${CHECK[@]}" command "File: New Untitled Text File" > /dev/null; sleep 1
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
	if [ "$here" = "none" ]; then
		# Ни одного окна перед глазами — свёрнуты все.
		PROBE_CWD="$PROBE_CWD1" "${CHECK[@]}" pretend off > /dev/null
		PROBE_CWD="$PROBE_CWD2" "${CHECK[@]}" pretend off > /dev/null
	else
		# Фокус один на всех: назначая его окну, остальные уводим в фон.
		PROBE_CWD="$here" "${CHECK[@]}" pretend on > /dev/null
	fi
	"${CHECK[@]}" fire permission "$session" > /dev/null
	if [ "$want" = "silence" ]; then
		"${CHECK[@]}" expect silence || exit 1
	else
		"${CHECK[@]}" expect alert || exit 1
		# Цель уводится с экрана до щелчка: иначе проверка сошлась бы и без него —
		# сессия и так на месте, а щелчок мог не сработать вовсе.
		bash "$0" panel-hidden > /dev/null || exit 1
		[ "$surface" = "tab" ] && { bash "$0" code-tab > /dev/null || exit 1; }
		"${CHECK[@]}" press "$PROFILE" "$EXTENSIONS" > /dev/null || exit 1
		"${CHECK[@]}" landed "$session" "$surface" || exit 1
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
	kill_alerts
	"${CHECK[@]}" fire "${2:-stop}" "${3:-}" "${4:-}"
	sleep 1
	"${CHECK[@]}" alerts
	;;

case)
	# Сессии и панели копятся от прогона к прогону, и сценарий начинает смотреть
	# на чужое состояние — поэтому каждый идёт со свежего окна.
	#
	# Кроме прогона одной клетки: `case matrix <кусок описания>` переиспользует
	# уже поднятое окно и заведённые сессии, чтобы вернуться к упавшей клетке, а
	# не гонять всю матрицу заново.
	# Запомненные сессии годятся, только если их там все четыре: файл мог
	# остаться от прежнего устройства матрицы.
	if [ -n "${3:-}" ] && grep -q second_tab "$ROOT/.probe/matrix-state" 2>/dev/null; then
		. "$ROOT/.probe/matrix-state"
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
	matrix)
		# Всё, от чего зависит судьба алерта: из какого окна пришло событие, где
		# в этот момент пользователь, видна ли панель того окна и что у него
		# поверх редактора. Сессий четыре — в каждом окне своя панель и своя
		# вкладка, — и событие приходит от любой из них.
		#
		# Тишина положена ровно тогда, когда пользователь в окне события и эта
		# самая сессия у него на экране. Всё прочее — алерт, и тогда щелчок
		# обязан привести в её окно и её поверхность.
		echo "== матрица: два окна, четыре сессии"
		if [ -n "$only" ]; then
			echo "-- только клетки со словами: $only"
		else
			# По очереди: печатать можно только в то окно, что сейчас впереди.
			# Зато ответы всех четырёх чатов ждутся потом разом.
			bash "$0" seed "$PROBE_CWD1" > "$ROOT/.probe/seed-1.log" 2>&1 \
				|| { echo "первое окно не засеялось:"; tail -3 "$ROOT/.probe/seed-1.log"; exit 1; }
			bash "$0" seed "$PROBE_CWD2" > "$ROOT/.probe/seed-2.log" 2>&1 \
				|| { echo "второе окно не засеялось:"; tail -3 "$ROOT/.probe/seed-2.log"; exit 1; }

			seeded=$(cat "$ROOT/.probe/seed-$(basename "$PROBE_CWD1")")
			first_sidebar=${seeded% *}; first_tab=${seeded#* }
			echo "-- первое окно: панель ${first_sidebar:0:8}, вкладка ${first_tab:0:8}"

			seeded=$(cat "$ROOT/.probe/seed-$(basename "$PROBE_CWD2")")
			second_sidebar=${seeded% *}; second_tab=${seeded#* }
			echo "-- второе окно: панель ${second_sidebar:0:8}, вкладка ${second_tab:0:8}"

			# Все четыре чата ещё отвечают, и каждый закончит своим Stop —
			# настоящий алерт посреди первых же проверок.
			PROBE_CWD="$PROBE_CWD1" "${CHECK[@]}" wait-answer "$first_sidebar" 40 > /dev/null || exit 1
			PROBE_CWD="$PROBE_CWD1" "${CHECK[@]}" wait-answer "$first_tab" 40 > /dev/null || exit 1
			PROBE_CWD="$PROBE_CWD2" "${CHECK[@]}" wait-answer "$second_sidebar" 40 > /dev/null || exit 1
			PROBE_CWD="$PROBE_CWD2" "${CHECK[@]}" wait-answer "$second_tab" 40 > /dev/null || exit 1
			kill_alerts

			# Сессии запоминаются, чтобы к упавшей клетке можно было вернуться, не
			# поднимая окна и не заводя чаты заново.
			printf 'first_sidebar=%s\nfirst_tab=%s\nsecond_sidebar=%s\nsecond_tab=%s\n' \
				"$first_sidebar" "$first_tab" "$second_sidebar" "$second_tab" \
				> "$ROOT/.probe/matrix-state"
		fi

		for from in first second; do
			case "$from" in
			first)  folder="$PROBE_CWD1"; in_panel="$first_sidebar";  in_tab="$first_tab" ;;
			second) folder="$PROBE_CWD2"; in_panel="$second_sidebar"; in_tab="$second_tab" ;;
			esac

			for here in first second none; do
				case "$here" in
				first)  at="$PROBE_CWD1" ;;
				second) at="$PROBE_CWD2" ;;
				none)   at=none ;;
				esac

				for panel in shown hidden; do
					for top in chat code; do
						name="событие из ${from}, пользователь в ${here}, панель ${panel}, поверх ${top}"
						case "$name" in *"$only"*) ;; *) continue ;; esac
						echo "-- $name"

						# Состояние выставляется заново перед каждой проверкой:
						# щелчок по алерту сам открывает панель или вкладку.
						bash "$0" cell-state "$folder" "$panel" "$top" || exit 1
						want=alert
						[ "$here" = "$from" ] && [ "$panel" = shown ] && want=silence
						bash "$0" cell "$at" "$folder" "$in_panel" "$want" sidebar || exit 1

						bash "$0" cell-state "$folder" "$panel" "$top" || exit 1
						want=alert
						[ "$here" = "$from" ] && [ "$top" = chat ] && want=silence
						bash "$0" cell "$at" "$folder" "$in_tab" "$want" tab || exit 1
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
