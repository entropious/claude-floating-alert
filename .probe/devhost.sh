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
#   bash .probe/devhost.sh case hidden      сценарий: чат в панели скрыт → ждём алерт
#   bash .probe/devhost.sh case tab         сценарий: чат во вкладке за другой → ждём алерт
#   bash .probe/devhost.sh case watched     сценарий: чат перед глазами → алерта быть не должно
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
export PROBE_CWD="$(dirname "$ROOT")/.claude-floating-alert-probe"
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
	for _ in $(seq 1 30); do sleep 2; cdp_up && break; done
	cdp_up || { echo "окно не поднялось за 60с, см. .probe/devhost.log"; exit 1; }
	sleep 3
	"${CHECK[@]}" escape > /dev/null 2>&1
	echo "окно готово, CDP на $CDP_PORT"
	;;

stop)
	for pid in $(host_pids); do kill "$pid" 2>/dev/null; done
	# Редактор закрывается не мгновенно, а start считает живой CDP признаком
	# уже поднятого окна и молча ничего не делает.
	for _ in $(seq 1 15); do cdp_up || break; sleep 1; done
	for pid in $(host_pids); do kill -9 "$pid" 2>/dev/null; done
	kill_alerts
	# Чаты живых прогонов оба агента пишут туда же, куда пользовательские.
	# Убираются они последними: пока окно живо, оно заводит их заново.
	"${CHECK[@]}" clean
	echo "окно закрыто"
	;;

restart)
	bash "$0" stop; bash "$0" start
	;;

surfaces|focus|alerts|targets|shot|front|codex|containers|pretend)
	"${CHECK[@]}" "$@"
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
	bash "$0" restart > /dev/null
	case "${2:-}" in
	hidden)
		echo "== чат в боковой панели, панель скрыта"
		bash "$0" sidebar > /dev/null; sleep 2
		# Сессию чат заводит только на первом сообщении, а без неё событие
		# некому приписать: отчёты чата такой сессии не знают, и любая проверка
		# выродилась бы в «алерт на выдуманный id».
		"${CHECK[@]}" ask "ответь одним словом: ok"
		session=$("${CHECK[@]}" wait-session sidebar 10) || exit 1
		bash "$0" hide > /dev/null; sleep 2
		"${CHECK[@]}" surfaces
		# Фокус подделывается последним: расширение переписывает файл окна на
		# смене вкладок и папок, и подделка до этих шагов не дожила бы.
		"${CHECK[@]}" pretend on
		bash "$0" fire stop "$session" > /dev/null
		"${CHECK[@]}" expect alert || exit 1
		;;
	tab)
		echo "== чат вкладкой, поверх него другая вкладка"
		bash "$0" tab > /dev/null; sleep 4
		session=$("${CHECK[@]}" session tab) || { echo "вкладка чата не открылась"; exit 1; }
		"${CHECK[@]}" command "File: New Untitled Text File" > /dev/null; sleep 2
		# Новый файл открывается соседней группой, и чат остаётся на экране —
		# а он должен уйти за вкладку, иначе проверять нечего.
		"${CHECK[@]}" command "View: Join All Editor Groups" > /dev/null; sleep 2
		"${CHECK[@]}" surfaces
		"${CHECK[@]}" pretend on
		bash "$0" fire stop "$session" > /dev/null
		"${CHECK[@]}" expect alert || exit 1
		;;
	watched)
		echo "== чат перед глазами"
		bash "$0" sidebar > /dev/null; sleep 2
		"${CHECK[@]}" ask "ответь одним словом: ok"
		session=$("${CHECK[@]}" wait-session sidebar 10) || exit 1
		"${CHECK[@]}" surfaces
		"${CHECK[@]}" pretend on
		bash "$0" fire stop "$session" > /dev/null
		"${CHECK[@]}" expect silence || exit 1
		;;
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
	blur)
		# Пишут в чат боковой панели и тут же уходят в код: панель остаётся на
		# экране, активной становится вкладка редактора. Ответ приходит уже туда
		# — и алерта быть не должно, чат ведь виден.
		echo "== пишут в боковую панель, фокус уходит в код"
		bash "$0" sidebar > /dev/null; sleep 2
		"${CHECK[@]}" ask claude "напиши слово ok"
		session=$("${CHECK[@]}" wait-session sidebar 10) || exit 1
		"${CHECK[@]}" command "File: New Untitled Text File" > /dev/null; sleep 2
		echo "-- активна вкладка с кодом, чат сбоку остался"
		"${CHECK[@]}" surfaces
		kill_alerts
		hold_focus
		"${CHECK[@]}" wait-answer "$session" 20 || { release_focus; exit 1; }
		"${CHECK[@]}" expect silence || { release_focus; exit 1; }
		release_focus
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
		echo "сценарии: hidden | tab | watched | blur | codex | live-codex | live-claude"; exit 1
		;;
	esac
	;;

*)
	sed -n '2,30p' "$0"
	;;
esac
