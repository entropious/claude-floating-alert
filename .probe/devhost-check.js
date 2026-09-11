// Управление Extension Development Host через CDP.
// Используется из devhost.sh; напрямую: node .probe/devhost-check.js <команда>
//
//   targets                список CDP-таргетов окна
//   command <название>     выполнить команду VS Code через палитру
//   eval <выражение>       произвольный код в контексте workbench
//   surfaces               что расширение Claude Code пишет о своих чатах
//   focus                  что окна пишут о своём фокусе
//   alerts                 живые процессы алерта и с какими аргументами
//   fire <kind> [session] [agent]
//                          прогнать хук так, будто событие пришло от агента
//   codex                  запускает ли Codex наши хуки, и мешает ли доверие
//   containers             какой контейнер выбран в боковых панелях окна стенда
//   expect alert|silence [строка]
//                          вердикт сценария: висит ли алерт и то ли в нём
//   shot [файл]            снимок окна средствами самого редактора

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const PORT = process.env.CDP_PORT || 9333;
const ROOT = path.join(os.homedir(), ".claude", "floating-alert");
/** По одному файлу на живой алерт — так видно, что хук до него дошёл. */
const RUN_DIR = path.join(ROOT, "run");

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return res.json();
}

/** Главное окно редактора: палитра и DOM живут здесь. */
/**
 * Окно стенда, к которому обращены команды, — то, что открыто на PROBE_CWD.
 *
 * Окон бывает несколько, и по адресу их не различить: у всех workbench.html.
 * Зато заголовок называет папку, а папка у каждого своя — по ней и выбираем.
 */
async function workbenchTarget() {
  const list = (await targets()).filter((t) => (t.url || "").includes("workbench") && t.webSocketDebuggerUrl);
  if (!list.length) throw new Error("окно не найдено: bash .probe/devhost.sh start");
  if (list.length === 1) return list[0];
  const folder = path.basename(workspace());
  for (const candidate of list) {
    const title = await evaluate(candidate.webSocketDebuggerUrl, "document.title");
    // Последнее слово заголовка и есть папка. Сравнивать вхождением нельзя:
    // имя одной папки стенда — начало имени другой, и команда для первой
    // доставалась бы второй.
    if (typeof title === "string" && title.trim().split(/\s+/).pop() === folder) return candidate;
  }
  throw new Error(`среди окон нет открытого на ${folder}`);
}

/**
 * Содержимое панели лежит во вложенном iframe, а Runtime.evaluate работает в
 * главном фрейме таргета — так что документы приходится собирать вручную.
 */
const DOCS = `function docs() {
  const found = [document];
  for (const frame of document.querySelectorAll("iframe")) {
    try {
      const doc = frame.contentDocument;
      if (!doc) continue;
      found.push(doc);
      for (const inner of doc.querySelectorAll("iframe")) {
        try { if (inner.contentDocument) found.push(inner.contentDocument); } catch (e) {}
      }
    } catch (e) { /* чужой origin — читать нечего */ }
  }
  return found;
}`;

function send(wsUrl, messages, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("таймаут CDP"));
    }, timeoutMs);
    const results = [];
    let at = 0;

    const step = () => {
      if (at >= messages.length) {
        clearTimeout(timer);
        ws.close();
        return resolve(results[results.length - 1]);
      }
      ws.send(JSON.stringify({ id: at + 1, ...messages[at] }));
    };

    ws.onopen = step;
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== at + 1) return;
      if (msg.error) {
        clearTimeout(timer);
        ws.close();
        return reject(new Error(JSON.stringify(msg.error)));
      }
      // Runtime.evaluate отдаёт result.result.value, Page.captureScreenshot — result.data.
      results.push(msg.result?.result?.value !== undefined ? msg.result.result.value : msg.result?.data);
      at += 1;
      step();
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("ошибка соединения CDP"));
    };
  });
}

function evaluate(wsUrl, expression) {
  return send(wsUrl, [
    {
      method: "Runtime.evaluate",
      params: { expression, awaitPromise: true, returnByValue: true, userGesture: true },
    },
  ]);
}

function key(text, code, keyCode, modifiers) {
  return [
    { method: "Input.dispatchKeyEvent", params: { type: "keyDown", text, code, key: text, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers } },
    { method: "Input.dispatchKeyEvent", params: { type: "keyUp", code, key: text, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers } },
  ];
}

/**
 * Команда редактора через палитру: своего API у CDP для этого нет, а палитра
 * принимает всё, что расширения в неё кладут.
 */
async function command(name) {
  const target = await workbenchTarget();
  // Пока фокус внутри webview чата, горячая клавиша достаётся ему, а название
  // команды печатается в поле ввода Claude. Фокус возвращает клик по статусной
  // строке: середина окна — это редактор, где вкладкой может стоять тот же чат.
  const bar = await evaluate(
    target.webSocketDebuggerUrl,
    `(() => {
      const bar = document.querySelector(".statusbar");
      if (!bar) return null;
      const box = bar.getBoundingClientRect();
      return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
    })()`
  );
  const spot = bar || { x: 700, y: 300 };
  await send(target.webSocketDebuggerUrl, [
    { method: "Input.dispatchMouseEvent", params: { type: "mousePressed", ...spot, button: "left", clickCount: 1 } },
    { method: "Input.dispatchMouseEvent", params: { type: "mouseReleased", ...spot, button: "left", clickCount: 1 } },
  ]);
  // Cmd+Shift+P, название, Enter. Meta = 4, Shift = 8.
  await send(target.webSocketDebuggerUrl, [
    ...key("p", "KeyP", 80, 12),
    { method: "Input.insertText", params: { text: `>${name}` } },
  ]);
  // Палитре нужно успеть отфильтровать список, а команде — выполниться; больше
  // этого ждать нечего, а вызовов на прогон сотни.
  await new Promise((done) => setTimeout(done, 250));
  await send(target.webSocketDebuggerUrl, key("\r", "Enter", 13, 0));
  await new Promise((done) => setTimeout(done, 250));
  return `выполнено: ${name}`;
}

function readAll(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .map((name) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, name), "utf-8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function surfaces() {
  for (const state of readAll(path.join(ROOT, "presence"))) {
    const mark = alive(state.pid) ? "" : " (процесс мёртв)";
    console.log(`\n${state.folders.join(", ") || "без папки"} — pid ${state.pid}${mark}`);
    for (const surface of state.surfaces || []) {
      const seen = [
        surface.visible ? "видима" : "скрыта",
        surface.active ? "активна" : "не активна",
        surface.chat === false ? "не чат" : "чат",
      ].join(", ");
      console.log(`  ${surface.kind.padEnd(8)} ${String(surface.id).padEnd(30)} ${seen}`);
      console.log(`  ${" ".repeat(8)} сессия ${surface.session || "неизвестна"}`);
    }
    if (!(state.surfaces || []).length) console.log("  поверхностей нет (патч старый или не применён)");
  }
}

function focus() {
  for (const state of readAll(path.join(ROOT, "focus"))) {
    if (!alive(state.pid)) continue;
    console.log(
      `${state.focused ? "в фокусе " : "в фоне   "} pid ${String(state.pid).padEnd(7)} ${state.folders.join(", ")}`
    );
  }
}

/**
 * Забыть следы прошлых алертов. Проверка «алерта нет» смотрит и на них — иначе
 * она не отличила бы тишину от алерта, который уже успел погаснуть, — и след
 * соседней проверки сошёл бы за свой.
 */
/**
 * Нажать на висящий алерт — то есть сделать то же, что делает его щелчок:
 * поднять окно и отдать ему ссылку. Проверять саму ссылку мало, она лишь
 * намерение; ответ на неё даёт окно, и он бывает совсем другим.
 *
 * Ссылка уходит в редактор стенда, а не в обычный: у него свой профиль, и
 * `open` доставил бы её рабочему окну — там бы её и обработали.
 */
const CODE_CLI = "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code";

/**
 * Открыть сессию вкладкой в окне стенда — той же ссылкой, какую носит алерт.
 * Это единственный способ посадить одну сессию сразу в панель и во вкладку:
 * список сессий на щелчок открывает какую-то свою.
 */
function openTab(session, profile, extensions) {
  const url = `vscode://entro.claude-floating-alert/reveal?${new URLSearchParams({
    agent: "claude",
    session,
    cwd: workspace(),
    tab: "1",
  })}`;
  const result = spawnSync(
    CODE_CLI,
    [`--user-data-dir=${profile}`, `--extensions-dir=${extensions}`, "--open-url", url],
    { encoding: "utf-8" }
  );
  if (result.status !== 0) {
    console.error(`ссылка не доставлена: ${(result.stderr || "").trim().slice(0, 200)}`);
    process.exit(1);
  }
  console.log(`вкладкой открыта сессия ${session.slice(0, 8)}`);
}

/**
 * Нажать висящий алерт по-настоящему: его же кодом.
 *
 * Мышью щёлкнуть нечем — синтетическое нажатие требует прав Accessibility,
 * которых у прогона нет, — поэтому панели посылается сигнал, по которому она
 * делает ровно то же, что делает по щелчку. Проверяется таким образом её
 * собственное поведение: и просьба окну, и подъём окна.
 *
 * Панель зовёт редактор через `open`, а он ведёт к обычному профилю; чтобы
 * попасть в профиль стенда, ей подсовывается свой способ (CFA_OPEN) — на нём же
 * она и была запущена. Здесь остаётся только нажать и дождаться, пока она
 * доделает своё дело и уйдёт.
 */
async function press() {
  const line = alertLines()[0];
  if (!line) {
    console.error("на экране нет алерта, нажимать нечего");
    process.exit(1);
  }
  const pid = Number(line.trim().split(/\s+/)[0]);
  if (!pid) {
    console.error(`не разобрать номер процесса алерта: ${line.slice(0, 80)}`);
    process.exit(1);
  }
  try {
    process.kill(pid, "SIGUSR1");
  } catch (error) {
    console.error(`алерт не принял нажатие: ${error}`);
    process.exit(1);
  }
  // Панель гаснет сама, закончив дело; ждём именно этого, а не времени.
  // С чем панель осталась, с тем щелчок и работает: пустая папка — это «подними
  // приложение», а не «подними то окно», и по молчаливому провалу этого не видно.
  const folder = (line.match(/--folder (\S*)/) || [])[1] || "";
  const ask = (line.match(/--ask-file (\S*)/) || [])[1] || "";
  for (let waited = 0; waited < 10000; waited += 250) {
    if (!alive(pid)) {
      return console.log(`нажат алерт: папка ${folder || "—"}, просьба ${ask || "—"}`);
    }
    pause(250);
  }
  console.error("алерт не закрылся после нажатия");
  process.exit(1);
}

/**
 * Ответить с панели: нажать на висящем алерте кнопку ответа — её же кодом — и
 * проверить, что из этого вышло.
 *
 * Ответ не виден со стороны: команда уходит внутрь чата. Зато окно записывает
 * каждую исполненную просьбу в тот же лог, что и хук, и по этой записи видно и
 * что просьба дошла, и что команда нашлась. Остальное — обещание кнопки: панель
 * гаснет, и ни одно окно не выходит вперёд.
 */
async function accept() {
  const line = alertLines()[0];
  if (!line) {
    console.log("FAIL  на экране нет алерта, отвечать нечего");
    process.exitCode = 1;
    return;
  }
  const pid = Number(line.trim().split(/\s+/)[0]);
  const ask = (line.match(/--ask-accept (\{.*?\}) --/) || [])[1];
  if (!ask) {
    console.log("FAIL  алерт не предлагает ответа");
    process.exitCode = 1;
    return;
  }
  const front = (standWindow() || {}).pid;
  const file = (line.match(/--ask-file (\S*)/) || [])[1] || "";
  // По времени, а не по числу строк: лог подрезается, и счёт в нём сбивается.
  const since = new Date().toISOString();
  let written = false;
  try {
    process.kill(pid, "SIGUSR2");
  } catch (error) {
    console.log(`FAIL  алерт не принял ответ: ${error}`);
    process.exitCode = 1;
    return;
  }
  for (let waited = 0; waited < 8000; waited += 250) {
    // Видеть просьбу на диске важно не меньше, чем ответ окна: «панель не
    // написала» и «окно не прочло» — разные поломки, а следа они оставляют
    // один и тот же.
    if (file && fs.existsSync(file)) written = true;
    const done = logLines()
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return {};
        }
      })
      .find((entry) => entry.ask === "accept" && String(entry.at || "") >= since);
    if (done) {
      if (!done.ran) {
        console.log("FAIL  команда ответа не отработала в окне");
        process.exitCode = 1;
        return;
      }
      if (!alive(pid) && (standWindow() || {}).pid === front) {
        return console.log("  ok  ответ с панели");
      }
      console.log(
        alive(pid) ? "FAIL  панель не погасла после ответа" : "FAIL  ответ увёл окна вперёд"
      );
      process.exitCode = 1;
      return;
    }
    pause(250);
  }
  const now = file && fs.existsSync(file) ? "лежит непрочитанной" : "её нет";
  console.log(
    `FAIL  окно не отчиталось об ответе (просьба ${file || "—"}: ` +
      `${written ? "панель написала" : "панель не писала"}, сейчас ${now})`
  );
  process.exitCode = 1;
}

/** Строки лога хука — того же, куда окна пишут исполненные просьбы. */
function logLines() {
  try {
    return fs.readFileSync(path.join(ROOT, "log.jsonl"), "utf-8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Куда привёл щелчок: ждём, пока сессия окажется на экране, и говорим, в какой
 * поверхности. Ожидание короткое — окно уже поднято, речь про одну команду.
 */
/**
 * При честном фокусе щелчок обязан ещё и вывести вперёд окно события — но
 * спрашивать это можно не всегда.
 *
 * В подделке фокус назначается файлом, и проверять нечего. А когда редактор
 * был убран целиком, вперёд его выводит система, и разрешение на это она даёт
 * тому, с кем человек только что имел дело: настоящий щелчок по панели такое
 * разрешение даёт, а сигнал, которым панель нажимает прогон, — нет. Требовать
 * этого от прогона значит требовать того, чего он не умеет изобразить.
 */
let mustBeInFront = true;

function windowInFront() {
  let mode = "pretend";
  try {
    mode = fs.readFileSync(path.join(__dirname, "focus-mode"), "utf-8").trim();
  } catch {}
  if (mode !== "real" || !mustBeInFront) return true;
  return !!(standWindow() || {}).focused;
}

async function landed(session, kind, seconds) {
  if (!reporting()) return landedPlain(session, kind, seconds || 8);
  for (let waited = 0; waited < (seconds || 8) * 1000; waited += 250) {
    for (const state of readAll(path.join(ROOT, "presence"))) {
      if (!alive(state.pid)) continue;
      if (!(state.folders || []).includes(workspace())) continue;
      // И видима, и активна: вкладка чата за другой вкладкой тоже числится
      // живой, а щелчок обязан вывести её наверх, а не просто оставить.
      const found = (state.surfaces || []).find(
        (surface) =>
          surface.session === session &&
          surface.chat !== false &&
          surface.kind === kind &&
          surface.visible &&
          surface.active
      );
      if (found && windowInFront()) return console.log(`  ok  щелчок открыл ${kind}`);
    }
    pause(250);
  }
  console.log(`FAIL  щелчок не открыл ${kind} для ${session.slice(0, 8)}`);
  for (const state of readAll(path.join(ROOT, "presence"))) {
    if (!alive(state.pid) || !(state.folders || []).includes(workspace())) continue;
    for (const surface of state.surfaces || []) {
      console.log(`      ${surface.kind} ${surface.visible ? "видима" : "скрыта"} ${surface.session}`);
    }
  }
  whoIsInFront();
  process.exitCode = 1;
}

/**
 * Куда Claude Code открывает чат по команде «показать сессию».
 *
 * Он помнит последнее место сам и переписывает свою настройку каждый раз, когда
 * чат открывают в полосе, — а стенд открывает его там в каждой клетке. Поэтому
 * перед проверкой щелчка место назначается заново: иначе «открыть вкладкой»
 * означало бы «открыть там же, где было в прошлый раз».
 */
function prefer(where) {
  const file = path.join(__dirname, "vscode-user", "User", "settings.json");
  const key = '"claudeCode.preferredLocation"';
  let text;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {
    console.error(`нет настроек профиля стенда: ${file}`);
    process.exit(1);
  }
  const line = `${key}: ${JSON.stringify(where)}`;
  const has = new RegExp(`${key}\\s*:\\s*"[^"]*"`);
  const next = has.test(text)
    ? text.replace(has, line)
    : text.replace(/\}\s*$/, `,\n  ${line}\n}\n`);
  fs.writeFileSync(file, next);
  console.log(`чат открывается: ${where}`);
}

/** Что о фокусе говорят сами окна — чтобы провал не сводился к «не вышло». */
function whoIsInFront() {
  for (const state of readAll(path.join(ROOT, "focus"))) {
    if (!alive(state.pid)) continue;
    console.log(
      `      окно ${state.pid} ${state.focused ? "в фокусе" : "в фоне"} ` +
        `(${(state.folders || []).map((f) => path.basename(f)).join(", ")}), ${state.at}`
    );
  }
}

/** Отчитывается ли о чатах кто-нибудь в окне стенда. */
function reporting() {
  return readAll(path.join(ROOT, "presence")).some(
    (state) => alive(state.pid) && (state.folders || []).includes(workspace())
  );
}

/**
 * Куда привёл щелчок на непропатченном Claude Code, где о поверхностях не
 * отчитывается никто.
 *
 * Панель видно по разметке окна. Вкладку — по ярлыку: окно публикует тот, что
 * сейчас поверх, а сам ярлык Claude Code берёт из первого сообщения чата, и по
 * нему вкладка сходится со своей сессией — тем же способом, каким это делает
 * сам хук, когда отчётов нет.
 */
async function landedPlain(session, kind, seconds) {
  for (let waited = 0; waited < seconds * 1000; waited += 250) {
    if (kind === "sidebar") {
      if ((await chatBarShown()) && windowInFront()) return console.log("  ok  щелчок открыл sidebar");
    } else {
      if (tabHolds(session) && windowInFront()) return console.log("  ok  щелчок открыл tab");
    }
    pause(250);
  }
  console.log(`FAIL  щелчок не открыл ${kind} для ${session.slice(0, 8)}`);
  console.log(
    `      поверх редактора: ${(standWindow() || {}).activeChat || "не чат"}` +
      `, чат в полосе: ${(await chatBarShown()) ? "виден" : "нет"}` +
      `, окно впереди: ${windowInFront() ? "да" : "нет"}`
  );
  whoIsInFront();
  process.exitCode = 1;
}

/**
 * Держит ли вкладка поверх редактора именно эту сессию.
 *
 * Ярлык вкладки Claude Code сочиняет сам по первому сообщению чата — «напиши
 * слово два» становится «Слово два», — поэтому сравнивать их целиком нельзя.
 * Сходится по словам: все слова ярлыка должны найтись в первом сообщении, и
 * этого хватает, чтобы отличить чаты стенда друг от друга.
 */
function tabHolds(session) {
  const label = ((standWindow() || {}).activeChat || "").trim().toLowerCase();
  if (!label) return false;
  const first = firstMessage(session).toLowerCase();
  if (!first) return false;
  return label
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 2)
    .every((word) => first.includes(word));
}

/** Первое сообщение чата — то, из чего Claude Code делает ярлык его вкладки. */
function firstMessage(session) {
  const file = path.join(
    os.homedir(),
    ".claude",
    "projects",
    workspace().replace(/[/.]/g, "-"),
    `${session}.jsonl`
  );
  try {
    for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
      if (!line.includes('"type":"user"')) continue;
      const content = JSON.parse(line).message.content;
      if (typeof content === "string") return content;
      // Сообщение приходит и списком кусков — текст тогда лежит в них.
      if (Array.isArray(content)) {
        return content
          .map((piece) => (piece && typeof piece.text === "string" ? piece.text : ""))
          .join(" ")
          .trim();
      }
      return "";
    }
  } catch {}
  return "";
}

function forget() {
  let names = [];
  try {
    names = fs.readdirSync(RUN_DIR);
  } catch {
    return console.log("следов нет");
  }
  for (const name of names) {
    try {
      fs.unlinkSync(path.join(RUN_DIR, name));
    } catch {}
  }
  console.log(`забыто следов: ${names.length}`);
}

/**
 * Панели, поднятые событиями стенда, — и только они.
 *
 * Рядом идёт обычная работа, и её алерты висят на том же экране: посчитанные
 * за свои, они превращали чужой запрос разрешения в «алерт был» там, где
 * проверялась тишина. Отбор по папке: её событие и назвало.
 */
function alertLines() {
  const out = spawnSync("pgrep", ["-fl", "claude-alert"], { encoding: "utf-8" }).stdout || "";
  return out
    .split("\n")
    .filter((line) => line.includes("--title"))
    .filter((line) => line.includes(`--folder ${workspace()} `));
}

function alerts() {
  const lines = alertLines();
  if (!lines.length) return console.log("алертов на экране нет");
  for (const line of lines) console.log(line);
}

function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Вердикт сценария: сам сценарий говорит, сошлось или нет, и уходит с кодом
 * возврата — иначе результат приходится сверять глазами по строчке «ожидание».
 *
 * Алерт — отдельный процесс, и появляется он не мгновенно; ожидания «алерта
 * нет» это тоже касается, поэтому ждут обе стороны, просто ответ на «нет»
 * известен только по истечении срока.
 */
function expect(want, contains, seconds = 1) {
  // Алерт живёт своей жизнью: у события «задача готова» он гаснет через
  // несколько секунд, и к моменту проверки на экране его уже нет. След
  // остаётся в run/ — по нему и видно, что алерт был.
  const since = Date.now() - 2000;
  const traces = () => {
    try {
      return fs
        .readdirSync(RUN_DIR)
        .map((name) => path.join(RUN_DIR, name))
        .filter((file) => fs.statSync(file).mtimeMs >= since)
        // След чужого алерта — от работы, идущей рядом, — тишиной стенда не
        // считается и в его проверки попадать не должен.
        .filter((file) => {
          try {
            return JSON.parse(fs.readFileSync(file, "utf-8")).cwd === workspace();
          } catch {
            return false;
          }
        });
    } catch {
      return [];
    }
  };
  let lines = [];
  let left = [];
  for (let waited = 0; waited < seconds * 1000; waited += 50) {
    lines = alertLines();
    left = traces();
    if (lines.length || left.length) break;
    pause(50);
  }
  const shown = lines.length > 0 || left.length > 0;
  const matched =
    !contains ||
    lines.some((line) => line.includes(contains)) ||
    left.some((file) => fs.readFileSync(file, "utf-8").includes(contains.replace("agent=", "")));
  const good = want === "alert" ? shown && matched : !shown;
  console.log(good ? `  ok  ${want === "alert" ? "алерт" : "тишина"}` : `FAIL  ждали: ${want}${contains ? ` (${contains})` : ""}`);
  if (!good) {
    for (const line of lines) console.log(`      ${line}`);
    process.exitCode = 1;
  }
}

/**
 * Вывести наверх вкладку чата или любую другую, кликнув по самой вкладке.
 *
 * Через палитру это не делается: пока фокус в вебвью чата, горячая клавиша
 * достаётся ему, и команда уходит в поиск по чату — окно стенда обрастало
 * пустыми вкладками «Search» вместо переключения.
 */
async function focusTab(kind) {
  const window = standWindow();
  const chats = (window && window.chatTabs) || [];
  const target = await workbenchTarget();
  const expression = `(() => {
    var chats = ${JSON.stringify(chats)};
    var isChat = function (tab) {
      var label = (tab.getAttribute("aria-label") || tab.innerText || "").trim();
      return chats.some(function (name) {
        var clean = name.replace(/…$/, "");
        return clean && label.indexOf(clean) !== -1;
      });
    };
    // Только группа, в которой лежит чат: в соседней он всё равно на экране, и
    // вкладка оттуда ничего бы не перекрыла.
    var groups = [].slice.call(document.querySelectorAll(".editor-group-container"));
    // А если чата во вкладках нет вовсе — он в панели, — то любая группа, где
    // вкладки есть: перекрывать нечего, но «поверх редактора код» значит то же.
    var group = groups.filter(function (candidate) {
      return [].slice.call(candidate.querySelectorAll(".tabs-container .tab")).some(isChat);
    })[0] || groups.filter(function (candidate) {
      return candidate.querySelectorAll(".tabs-container .tab").length > 0;
    })[0];
    if (!group) return "";
    var tabs = [].slice.call(group.querySelectorAll(".tabs-container .tab"));
    var mine = tabs.filter(function (tab) {
      return ${JSON.stringify(kind)} === "chat" ? isChat(tab) : !isChat(tab);
    });
    if (!mine.length) return null;
    var hit = mine[0];
    var box = hit.getBoundingClientRect();
    return {
      label: (hit.getAttribute("aria-label") || hit.innerText || "").trim().slice(0, 60),
      // Уже наверху — клик ничего не изменит, а ожидание после него съедает
      // секунду на каждой клетке.
      already: hit.classList.contains("active"),
      x: Math.round(box.left + box.width / 2),
      y: Math.round(box.top + box.height / 2),
    };
  })()`;
  const hit = await evaluate(target.webSocketDebuggerUrl, expression);
  if (!hit) {
    console.error(`вкладки вида ${kind} в окне нет`);
    process.exit(1);
  }
  if (hit.already) return console.log(`поверх и так: ${hit.label}`);
  // Настоящий клик, а не hit.click(): редактор слушает мышь, а вызванный из
  // скрипта click вкладку подсвечивает, но наверх не выводит.
  await send(target.webSocketDebuggerUrl, [
    { method: "Input.dispatchMouseEvent", params: { type: "mousePressed", x: hit.x, y: hit.y, button: "left", clickCount: 1 } },
    { method: "Input.dispatchMouseEvent", params: { type: "mouseReleased", x: hit.x, y: hit.y, button: "left", clickCount: 1 } },
  ]);
  // Отчёт о поверхностях догоняет клик не мгновенно, а следующим шагом идёт
  // проверка, которая по нему и судит.
  pause(500);
  console.log(`поверх: ${hit.label}`);
}

/**
 * Снять замок с группы, в которой открыт чат. Claude Code открывает вкладку
 * чата в запертой группе, и любой файл после этого уходит в соседнюю — чат
 * остаётся на экране, и перекрыть его нечем.
 */
async function unlockGroup() {
  const window = standWindow();
  const chats = (window && window.chatTabs) || [];
  const target = await workbenchTarget();
  const expression = `(() => {
    var chats = ${JSON.stringify(chats)};
    var isChat = function (tab) {
      var label = (tab.getAttribute("aria-label") || tab.innerText || "").trim();
      return chats.some(function (name) {
        var clean = name.replace(/…$/, "");
        return clean && label.indexOf(clean) !== -1;
      });
    };
    var groups = [].slice.call(document.querySelectorAll(".editor-group-container"));
    var group = groups.filter(function (candidate) {
      return [].slice.call(candidate.querySelectorAll(".tabs-container .tab")).some(isChat);
    })[0];
    if (!group) return "группы чата нет";
    var lock = group.querySelector(".codicon-lock, .codicon-lock-small, [aria-label*='Unlock'], [title*='Unlock']");
    if (!lock) return "замка нет";
    var button = lock.closest("a, .action-item, .action-label") || lock;
    button.click();
    return "замок снят";
  })()`;
  console.log(await evaluate(target.webSocketDebuggerUrl, expression));
}

/**
 * Закрыть вкладку чата, щёлкнув по её крестику. Палитра тут не помощник:
 * фокус живёт в вебвью чата, и «закрыть редактор» ушло бы в его поиск.
 */
async function closeChatTab() {
  const window = standWindow();
  const chats = (window && window.chatTabs) || [];
  if (!chats.length) return console.log("вкладки чата и не было");
  const target = await workbenchTarget();
  const expression = `(() => {
    var chats = ${JSON.stringify(chats)};
    var tabs = [].slice.call(document.querySelectorAll(".tabs-container .tab"));
    var hit = tabs.filter(function (tab) {
      var label = (tab.getAttribute("aria-label") || tab.innerText || "").trim();
      return chats.some(function (name) {
        var clean = name.replace(/…$/, "");
        return clean && label.indexOf(clean) !== -1;
      });
    })[0];
    if (!hit) return null;
    var close = hit.querySelector(".codicon-close, .tab-close, .action-label");
    var box = (close || hit).getBoundingClientRect();
    return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
  })()`;
  const spot = await evaluate(target.webSocketDebuggerUrl, expression);
  if (!spot) return console.log("вкладки чата не нашлось");
  await send(target.webSocketDebuggerUrl, [
    { method: "Input.dispatchMouseEvent", params: { type: "mousePressed", ...spot, button: "left", clickCount: 1 } },
    { method: "Input.dispatchMouseEvent", params: { type: "mouseReleased", ...spot, button: "left", clickCount: 1 } },
  ]);
  console.log("вкладка чата закрыта");
}

/**
 * Куда положено вести щелчку: сессия живёт и в панели, и во вкладке, а ссылка
 * называет ту поверхность, где её работали последней. Матрице это не угадать —
 * порядок зависит от того, что делали до неё, — поэтому она спрашивает.
 */
function expected(session) {
  let best = null;
  for (const state of readAll(path.join(ROOT, "presence"))) {
    if (!alive(state.pid) || !(state.folders || []).includes(workspace())) continue;
    for (const surface of state.surfaces || []) {
      if (surface.session !== session || surface.chat === false) continue;
      if (!best || (surface.activeAt || 0) > (best.activeAt || 0)) best = surface;
    }
  }
  console.log(best ? best.kind : "нет");
}

/**
 * Видна ли сейчас боковая панель с чатом. Отчёт поверхностей отвечает точно, но
 * на непропатченном Claude Code его нет вовсе — а прогонять сценарии надо и
 * там. Тогда отвечает сама разметка окна: чат в боковой полосе — это её живой
 * контейнер с вебвью Claude Code внутри.
 */
async function panel() {
  for (const state of readAll(path.join(ROOT, "presence"))) {
    if (!alive(state.pid) || !(state.folders || []).includes(workspace())) continue;
    const shown = (state.surfaces || []).some(
      (surface) => surface.kind === "sidebar" && surface.chat !== false && surface.visible
    );
    return console.log(shown ? "видима" : "скрыта");
  }
  console.log((await chatBarShown()) ? "видима" : "скрыта");
}

/**
 * Тот же вопрос, но по разметке окна: стоит ли сейчас в какой-нибудь боковой
 * полосе чат Claude Code.
 *
 * Смотреть надо на заголовок полосы, а не на её содержимое: разметка вида
 * остаётся в дереве и скрытой, а вот подпись полосы всегда называет тот
 * контейнер, который в ней сейчас выбран, и у скрытой полосы её нет вовсе.
 */
async function chatBarShown() {
  const target = await workbenchTarget();
  return !!(await evaluate(target.webSocketDebuggerUrl, `(${barsProbe})("shown")`));
}

/** Разметка боковых полос глазами окна: что в них выбрано и видно ли их. */
const barsProbe = function (mode) {
  const seen = [];
  for (const part of document.querySelectorAll(".part.sidebar, .part.auxiliarybar")) {
    const style = getComputedStyle(part);
    const hidden = style.display === "none" || style.visibility === "hidden" || part.offsetWidth === 0;
    const title = part.querySelector(".composite.title .title-label, .composite.title h2");
    const label = (title ? title.textContent : "").trim();
    seen.push({ part: part.className, hidden, width: part.offsetWidth, label });
  }
  seen.push({ workbench: (document.querySelector(".monaco-workbench") || {}).className || "" });
  if (mode === "hide") {
    // Закрывается та полоса, в которой стоит чат, и её же средствами: у
    // вторичной для этого есть крестик в заголовке, а первичная закрывается
    // повторным щелчком по своей же иконке в activity bar. Команды палитры
    // тут не годятся — какая из них какую полосу переключает, от сборки к
    // сборке разное.
    const closed = [];
    for (const part of document.querySelectorAll(".part.sidebar, .part.auxiliarybar")) {
      const bar = seen.find((entry) => entry.part === part.className);
      if (!bar || bar.hidden || !/claude/i.test(bar.label)) continue;
      if (/auxiliarybar/.test(part.className)) {
        const close = part.querySelector('.composite.title [class*="auxiliarybar-close"]');
        if (close) {
          close.click();
          closed.push("auxiliary");
        }
      } else {
        const active = document.querySelector(".activitybar .action-item.checked .action-label");
        if (active) {
          active.click();
          closed.push("primary");
        }
      }
    }
    return closed.join(" ");
  }
  if (mode === "all") return JSON.stringify(seen, null, 1);
  const chat = seen.filter((bar) => bar.part && !bar.hidden && /claude/i.test(bar.label));
  if (mode === "which") return chat.map((bar) => (/auxiliarybar/.test(bar.part) ? "auxiliary" : "primary")).join(" ");
  return chat.length > 0;
}.toString();

/**
 * Убрать чат с боковых полос: та, что его показывает, закрывается.
 *
 * Какая команда какую полосу переключает — вопрос не праздный: имена в палитре
 * и части разметки называются по-разному, и промах отдал бы обратный ход. Так
 * что команда проверяется по факту: не помогла — идёт вторая.
 */
async function hideChatBars() {
  const target = await workbenchTarget();
  const which = () => evaluate(target.webSocketDebuggerUrl, `(${barsProbe})("which")`);
  for (let tries = 0; tries < 6; tries++) {
    if (!(await which())) return console.log("панель: скрыта");
    await evaluate(target.webSocketDebuggerUrl, `(${barsProbe})("hide")`);
    pause(400);
  }
  console.log(`панель: видима (${await which()})`);
  process.exitCode = 1;
}

/** Окно стенда, каким оно себя опубликовало. */
function standWindow() {
  return readAll(path.join(ROOT, "focus")).find(
    (window) => alive(window.pid) && (window.folders || []).includes(workspace())
  );
}

/**
 * Что сейчас поверх редактора: чат (и какой) или что-то другое. Матрице этого
 * не подсмотреть иначе — переключать вкладки вслепую значит проверять не то
 * состояние, которое собирались.
 */
function active() {
  const window = standWindow();
  if (!window) {
    console.error("окно стенда не найдено");
    process.exit(1);
  }
  console.log(window.activeChat ? `чат: ${window.activeChat}` : "не чат");
}

/**
 * Какой контейнер выбран в боковых панелях окна стенда — то самое, по чему хук
 * судит о чате Codex. Читается из состояния окна, путь к которому окно само и
 * публикует.
 */
function containers() {
  const state = (readAll(path.join(ROOT, "focus")).find(
    (window) => alive(window.pid) && (window.folders || []).includes(workspace())
  ) || {}).state;
  if (!state) return console.log("окно стенда не публикует состояние");
  const out = spawnSync(
    "/usr/bin/sqlite3",
    [
      "-readonly",
      state,
      "select key || ' = ' || value from ItemTable where key in ('workbench.auxiliarybar.activepanelid','workbench.sidebar.activeviewletid')",
    ],
    { encoding: "utf-8" }
  ).stdout;
  console.log((out || "").trim() || "панели ещё не переключали — в состоянии пусто");
}

/** Папка события: у отладочного окна она своя, чтобы рабочее окно с той же
 *  папкой не перехватывало проверку на себя. */
function workspace() {
  return process.env.PROBE_CWD || process.cwd();
}

/** Сессия, которую окно этой папки держит в своих чатах. */
function sessionHere() {
  const cwd = workspace();
  let best = { length: -1, session: "" };
  for (const state of readAll(path.join(ROOT, "presence"))) {
    if (!alive(state.pid)) continue;
    // Папка стенда лежит внутри проекта, поэтому подходит и рабочее окно —
    // выигрывает то, чья папка ближе к ней.
    for (const folder of state.folders || []) {
      if (cwd !== folder && !cwd.startsWith(folder + path.sep)) continue;
      const named = (state.surfaces || []).find((surface) => surface.session);
      if (named && folder.length > best.length) best = { length: folder.length, session: named.session };
    }
  }
  return best.session;
}

/**
 * Кто ответит на событие с папкой стенда. Папка стенда лежит внутри проекта, а
 * значит рабочему окну она тоже подходит — и если в фокусе оно, проверка
 * молча уходит не туда: отвечает окно с установленным расширением, а не то,
 * что собрано из рабочего дерева.
 */
function windowForProbe() {
  const cwd = workspace();
  const suited = readAll(path.join(ROOT, "focus")).filter(
    (state) =>
      alive(state.pid) &&
      (state.folders || []).some((folder) => cwd === folder || cwd.startsWith(folder + path.sep))
  );
  const focused = suited.find((state) => state.focused);
  const stand = suited.find((state) => (state.folders || []).includes(cwd));
  return { focused, stand, suited };
}

/** Событие в том виде, в каком его присылает агент. */
function fire(kind, session, agent) {
  const { focused, stand } = windowForProbe();
  if (stand && focused && focused.pid !== stand.pid) {
    console.error(
      `событие перехватит чужое окно (pid ${focused.pid}: ${focused.folders.join(", ")}).\n` +
        "перейдите в окно стенда — иначе проверяется установленное расширение, а не рабочее дерево"
    );
    process.exit(1);
  }
  const payload = {
    session_id: session || (agent ? "" : sessionHere()) || "00000000-0000-4000-8000-000000000000",
    cwd: workspace(),
    tool_name: "Bash",
    tool_input: { command: "rm -rf build", question: "Проверка стенда?" },
  };
  const hook = path.join(ROOT, "claude-floating-alert.js");
  execFileSync("node", agent ? [hook, kind, "--agent", agent] : [hook, kind], {
    input: JSON.stringify(payload),
    stdio: ["pipe", "inherit", "inherit"],
    env: {
      ...process.env,
      // Хук молчит по многим причинам сразу; пусть скажет, по какой именно.
      CFA_DEBUG: "1",
      // Алерт зовёт редактор через `open`, а тот ведёт к обычному профилю: щелчок
      // открыл бы папку стенда рабочим окном. Своя дорога ведёт в профиль стенда.
      CFA_OPEN: path.join(__dirname, "open-in-stand.sh"),
      // Сокет окна достаётся хуку от того, кто его запустил, — а запускают его
      // отсюда, из рабочего окна. С ним хук приписал бы событие стенда рабочему
      // окну: у настоящей сессии стенда сокет был бы его собственный.
      VSCODE_IPC_HOOK_CLI: "",
    },
  });
  console.log(`хук отработал: ${kind}${agent ? ` (${agent})` : ""}`);
}

/**
 * Запускается ли хук самим Codex. Записи в hooks.json — половина дела: Codex
 * держит их отключёнными, пока им не выдано доверие, и молча пропускает.
 *
 * Проверка идёт как есть, без обхода доверия: один прогон Codex и взгляд в его
 * конфиг. Доверие выдаётся только в самом Codex, и стенд лишь показывает,
 * выдано оно или нет.
 *
 * Прогон идёт в каталоге, который не открыт ни в одном окне: иначе алерт
 * подавится тем, что окно в фокусе, и молчание будет означать совсем другое.
 */
/**
 * Прописать скопированные расширения в реестр отладочного профиля. Редактор
 * держит список установленного в extensions.json и папку, которой там нет,
 * при следующем запуске сносит — Claude Code однажды прописался сам, Codex
 * так и исчезал между прогонами.
 *
 * Записи берутся из обычного профиля, где эти расширения установлены по-
 * настоящему, и отличаются только путём.
 */
function register(dir) {
  const source = path.join(os.homedir(), ".vscode", "extensions", "extensions.json");
  let installed = [];
  try {
    installed = JSON.parse(fs.readFileSync(source, "utf-8"));
  } catch {
    console.error(`не читается ${source}`);
    process.exit(1);
  }
  const copied = fs.readdirSync(dir).filter((name) => fs.statSync(path.join(dir, name)).isDirectory());
  const entries = [];
  for (const name of copied) {
    const entry = installed.find((item) => item.relativeLocation === name);
    if (!entry) {
      console.log(`  пропущено: ${name} — в обычном профиле такого нет`);
      continue;
    }
    entries.push({
      ...entry,
      location: { ...entry.location, path: path.join(dir, name) },
      relativeLocation: name,
    });
  }
  fs.writeFileSync(path.join(dir, "extensions.json"), JSON.stringify(entries, null, 2));
  console.log(`в реестре профиля: ${entries.map((e) => e.identifier.id).join(", ") || "пусто"}`);
}

/**
 * Выдать окно стенда за активное, не забирая фокус у того, кто работает.
 *
 * Подделывается ровно то, по чему судит хук, — строчка focused в файле окна.
 * Настоящий фокус подделать нечем: редактор узнаёт о нём от системы, а не из
 * страницы, и эмуляция фокуса через CDP держится до первой же сверки. Забирать
 * же фокус по-настоящему значит мешать работе при каждом прогоне.
 *
 * Расширение переписывает этот файл на своих событиях — смене фокуса, вкладок,
 * папок. Переключение панелей ни одного из них не вызывает, так что подделка
 * живёт ровно столько, сколько нужно сценарию.
 */
function pretend(active) {
  const focused = active !== "off";
  const files = [];
  for (const name of fs.readdirSync(path.join(ROOT, "focus"))) {
    const file = path.join(ROOT, "focus", name);
    try {
      const state = JSON.parse(fs.readFileSync(file, "utf-8"));
      if (!alive(state.pid)) continue;
      files.push({ file, state, mine: (state.folders || []).includes(workspace()) });
    } catch {}
  }
  const mine = files.find((entry) => entry.mine);
  if (!mine) {
    console.error("окно стенда не найдено: bash .probe/devhost.sh start");
    process.exit(1);
  }
  // Со свежей отметкой времени: расширение пишет её на каждом своём событии, и
  // подделка со старой выглядела бы записью, которую все прочие уже обогнали.
  fs.writeFileSync(mine.file, JSON.stringify({ ...mine.state, focused, at: new Date().toISOString() }));
  // Фокус один на всех: раз это окно вышло вперёд, остальные окна стенда ушли
  // назад. Иначе активными числились бы оба, и какое ответит на событие —
  // вопрос порядка файлов, а не того, куда смотрит пользователь.
  if (focused) {
    for (const entry of files) {
      if (entry.mine || !isStand(entry.state)) continue;
      fs.writeFileSync(
        entry.file,
        JSON.stringify({ ...entry.state, focused: false, at: new Date().toISOString() })
      );
    }
  }
  console.log(`окно ${path.basename(workspace())} числится ${focused ? "активным" : "фоновым"}`);
}

/** Окна стенда: их папки лежат рядом и начинаются одинаково. */
function isStand(state) {
  const mark = path.basename(workspace()).replace(/-\d+$/, "");
  return (state.folders || []).some((folder) => path.basename(folder).startsWith(mark));
}

/**
 * Написать в чат Claude Code, открытый в окне стенда. Отсюда берётся то, чего
 * подделкой не получить: настоящая сессия, которую чат заводит только на первом
 * сообщении, и настоящий Stop-хук в конце ответа.
 *
 * Поле ввода — обычный textarea внутри вебвью чата; текст вставляется в него
 * напрямую, потому что клавиатурный ввод ушёл бы в то окно, что сейчас в
 * фокусе, а стенд намеренно работает в фоне.
 */
/**
 * Вебвью нужной поверхности: у каждой свой CDP-таргет, и адрес фрейма называет
 * и расширение, и вид поверхности — вьюха боковой панели помечена purpose,
 * вкладка редактора нет. Чат в панели и чат во вкладке — разные сессии, и
 * писать нужно ровно в ту, о которой идёт речь.
 */
const PANELS = {
  claude: { mark: "extensionId=Anthropic.claude-code", view: true },
  "claude-tab": { mark: "extensionId=Anthropic.claude-code", view: false },
  codex: { mark: "extensionId=openai.chatgpt", view: true },
};

/**
 * Идентификаторы вебвью, живущих в окне стенда. Панель одного расширения есть
 * в каждом окне, и по одному лишь расширению их не различить — сообщение
 * уходило в чужое окно. Зато рамки вебвью висят в DOM своего окна, и адрес
 * рамки называет тот же id, что и адрес отладочной цели.
 */
async function ownWebviews() {
  const target = await workbenchTarget();
  const found = await evaluate(
    target.webSocketDebuggerUrl,
    `[].slice.call(document.querySelectorAll("iframe")).map(function (frame) { return frame.src || ""; })`
  );
  return (found || [])
    .map((src) => (String(src).match(/[?&]id=([^&]+)/) || [])[1])
    .filter(Boolean);
}

async function ask(text, who = "claude") {
  // Поле находит и фокусирует скрипт, а печатает CDP: редактор чата слушает
  // настоящий ввод, и подставленное из скрипта значение он не замечает.
  const focus = `(() => {
    ${DOCS};
    for (const doc of docs()) {
      // Поле чата — не textarea: это div с contenteditable="plaintext-only",
      // так что искать по contenteditable="true" бесполезно.
      const field = doc.querySelector("textarea, [role=textbox], [contenteditable]");
      if (!field) continue;
      field.focus();
      // В поле мог остаться прошлый текст — тогда к нему допишется новый.
      doc.getSelection().selectAllChildren(field);
      return field.tagName;
    }
    return "";
  })()`;
  const panel = PANELS[who];
  if (!panel) {
    console.error(`не знаю поверхность ${who}: ${Object.keys(PANELS).join(" | ")}`);
    process.exit(1);
  }
  // Панель могла только что открыться: её рамка появляется в окне не сразу, а
  // поле ввода внутри — ещё позже.
  for (let waited = 0; waited < 6000; waited += 500) {
    const mine = await ownWebviews();
    for (const target of await targets()) {
      const url = target.url || "";
      if (!url.startsWith("vscode-webview://") || !url.includes(panel.mark)) continue;
      if (url.includes("purpose=webviewView") !== panel.view) continue;
      if (!mine.some((id) => url.includes(`id=${id}`))) continue;
      const found = await evaluate(target.webSocketDebuggerUrl, focus);
      if (!found) continue;
      await send(target.webSocketDebuggerUrl, [
        { method: "Input.insertText", params: { text } },
        ...key("\r", "Enter", 13, 0),
      ]);
      return console.log(`отправлено в панель ${who} (${found}): ${text}`);
    }
    pause(500);
  }
  console.error(`панель ${who} не нашлась — открыта ли она в окне стенда?`);
  process.exit(1);
}

/**
 * Дождаться ответа в транскрипте сессии. Без этого проверка «алерта нет»
 * сошлась бы и тогда, когда событие вовсе не приходило: тишина одинаково
 * выглядит и при верном решении хука, и при несостоявшемся ответе.
 */
function waitAnswer(session, seconds) {
  const file = path.join(
    os.homedir(),
    ".claude",
    "projects",
    workspace().replace(/[/.]/g, "-"),
    `${session}.jsonl`
  );
  for (let waited = 0; waited < seconds * 1000; waited += 500) {
    try {
      const lines = fs.readFileSync(file, "utf-8").split("\n");
      if (lines.some((line) => line.includes('"type":"assistant"'))) {
        return console.log("ответ получен, значит Stop уже был");
      }
    } catch {}
    pause(500);
  }
  console.error(`за ${seconds} c ответа в транскрипте не появилось: ${file}`);
  process.exit(1);
}

/**
 * Дождаться, пока Claude Code придумает чату название.
 *
 * По нему он подписывает вкладку, и без отчётов о поверхностях хук только по
 * нему и узнаёт, чья это вкладка: пока названия нет, сессия во вкладке для него
 * ничем не отличается от сессии в панели.
 */
function waitTitle(session, seconds) {
  const file = path.join(
    os.homedir(),
    ".claude",
    "projects",
    workspace().replace(/[/.]/g, "-"),
    `${session}.jsonl`
  );
  for (let waited = 0; waited < seconds * 1000; waited += 500) {
    try {
      if (fs.readFileSync(file, "utf-8").includes('"ai-title"')) {
        return console.log("название чата готово");
      }
    } catch {}
    pause(500);
  }
  console.error(`за ${seconds} c чат так и не назвался: ${file}`);
  process.exit(1);
}

/**
 * Сессия чата нужного вида — и только в окне стенда: чаты рабочего окна тоже
 * попадают в отчёты, и взятая оттуда сессия увела бы проверку в чужое окно.
 */
function sessionOf(kind, other) {
  for (const state of readAll(path.join(ROOT, "presence"))) {
    if (!alive(state.pid)) continue;
    if (!(state.folders || []).includes(workspace())) continue;
    const found = (state.surfaces || []).find(
      (surface) =>
        surface.kind === kind && surface.chat !== false && surface.session && surface.session !== other
    );
    if (found) return found.session;
  }
  return sessionFromTranscript(other);
}

/**
 * Сессия чата на непропатченном Claude Code: о поверхностях там не отчитывается
 * никто, и единственный след свежего чата — стенограмма, которую он заводит на
 * папку окна. Берётся самая свежая и только что написанная: в той же папке
 * лежат чаты прошлых прогонов.
 *
 * Вид чата — панель это или вкладка — отсюда не виден, и знать его не нужно:
 * сценарии заводят их по очереди и передают уже известную сессию в `other`,
 * так что «свежая, но не эта» и есть вторая из них.
 */
function sessionFromTranscript(other) {
  const dir = path.join(os.homedir(), ".claude", "projects", workspace().replace(/[/.]/g, "-"));
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return "";
  }
  let session = "";
  let latest = Date.now() - 120000;
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const id = name.slice(0, -".jsonl".length);
    if (id === other) continue;
    let stat;
    try {
      stat = fs.statSync(path.join(dir, name));
    } catch {
      continue;
    }
    if (stat.mtimeMs > latest) {
      latest = stat.mtimeMs;
      session = id;
    }
  }
  return session;
}

/**
 * Дождаться ответа Codex — то есть того, после чего только и может прийти его
 * Stop-хук. Без этого ожиданием алерта пришлось бы накрывать и разговор с
 * моделью, и холодный старт его сервера, а по такому сроку уже не понять, что
 * именно не сработало.
 */
function waitCodex(seconds) {
  const probe = workspace();
  const sessions = path.join(os.homedir(), ".codex", "sessions");
  // Только то, что писалось сейчас: разговоры прошлых прогонов лежат там же и
  // ответили бы за этот, а проверка ушла бы ждать алерт, которого ещё нет.
  const since = Date.now() - 5000;
  const answered = () => {
    const walk = (dir) => {
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return false;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory() && walk(full)) return true;
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        let text = "";
        try {
          if (fs.statSync(full).mtimeMs < since) continue;
          text = fs.readFileSync(full, "utf-8");
        } catch {
          continue;
        }
        if (text.includes(`"cwd":"${probe}"`) && text.includes('"role":"assistant"')) return true;
      }
      return false;
    };
    return walk(sessions);
  };
  for (let waited = 0; waited < seconds * 1000; waited += 500) {
    if (answered()) return console.log("Codex ответил, дальше его Stop");
    pause(500);
  }
  console.error(`за ${seconds} c Codex не ответил`);
  process.exit(1);
}

/** Дождаться, пока поверхность нужного вида появится в окне: вкладка чата
 *  открывается не мгновенно, а печатать в неё сразу некуда. */
async function waitSurface(kind, seconds) {
  for (let waited = 0; waited < seconds * 1000; waited += 250) {
    for (const state of readAll(path.join(ROOT, "presence"))) {
      if (!alive(state.pid) || !(state.folders || []).includes(workspace())) continue;
      if ((state.surfaces || []).some((surface) => surface.kind === kind && surface.chat !== false)) {
        return console.log(`${kind} на месте`);
      }
    }
    // Без отчётов вкладку видно по окну — их публикует само расширение, —
    // а панель по разметке.
    if (!reporting()) {
      const shown =
        kind === "tab"
          ? ((standWindow() || {}).chatTabs || []).length > 0
          : await chatBarShown();
      if (shown) return console.log(`${kind} на месте`);
    }
    pause(250);
  }
  console.error(`за ${seconds} c не появилась поверхность вида ${kind}`);
  process.exit(1);
}

/**
 * Дождаться, пока чат заведёт сессию: до первого сообщения её просто нет.
 * `other` — сессия, которой у этой поверхности быть не должно: новая вкладка
 * какое-то время отчитывается сессией панели, пока её чат не заговорит сам.
 */
function waitSession(kind, seconds, other) {
  for (let waited = 0; waited < seconds * 1000; waited += 500) {
    const session = sessionOf(kind, other);
    if (session) return console.log(session);
    pause(500);
  }
  console.error(`за ${seconds} c чат стенда так и не завёл сессию вида ${kind}`);
  process.exit(1);
}

/**
 * Перенести в профиль стенда то, что расширения помнят про пользователя между
 * запусками: Codex в свежем профиле встречает онбордингом, а его не пройти ни
 * кликом, ни командой — чата за ним просто нет.
 *
 * Переносится только состояние самих расширений, вход остаётся общим: он лежит
 * в ~/.codex и ~/.claude, куда смотрят обе копии.
 */
function seed(profile) {
  const source = path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "Code",
    "User",
    "globalStorage",
    "state.vscdb"
  );
  const target = path.join(profile, "User", "globalStorage", "state.vscdb");
  if (!fs.existsSync(source)) return console.log("обычного профиля нет — переносить нечего");
  if (!fs.existsSync(target)) return console.log("профиль стенда ещё не создан: bash .probe/devhost.sh start");

  const keys = ["openai.chatgpt", "Anthropic.claude-code"];
  let moved = [];
  for (const key of keys) {
    const value = spawnSync("/usr/bin/sqlite3", ["-readonly", source, `select value from ItemTable where key='${key}'`], {
      encoding: "utf-8",
    }).stdout.trim();
    if (!value) continue;
    const write = spawnSync("/usr/bin/sqlite3", [target], {
      input: `insert or replace into ItemTable (key, value) values ('${key}', '${value.replace(/'/g, "''")}');`,
      encoding: "utf-8",
    });
    if (write.status === 0) moved.push(key);
  }
  console.log(`перенесено в профиль стенда: ${moved.join(", ") || "ничего"}`);
}

/**
 * Убрать чаты, которые живые прогоны наплодили в обоих агентах. Свои сессии
 * они пишут туда же, куда пишут пользовательские, и история обрастает
 * повторами «ответь одним словом: ok».
 *
 * Отбор строго по рабочей папке стенда: всё, что заведено из другого места, —
 * чужое, и его не трогают.
 */
function clean() {
  const probe = workspace();
  let removed = 0;

  const projects = path.join(os.homedir(), ".claude", "projects", probe.replace(/[/.]/g, "-"));
  if (fs.existsSync(projects)) {
    fs.rmSync(projects, { recursive: true, force: true });
    removed += 1;
  }

  // Codex держит чаты и файлом, и строкой в своей базе: панель читает базу, так
  // что без неё удалённые чаты остались бы в списке.
  const sessions = path.join(os.homedir(), ".codex", "sessions");
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".jsonl")) {
        try {
          // Не только сама папка стенда: проверка доверия работает во временном
          // подкаталоге внутри неё, и её сессии тоже наши.
          if (/"cwd":"([^"]*)"/.test(fs.readFileSync(full, "utf-8").slice(0, 4096)) && RegExp.$1.startsWith(probe)) {
            fs.rmSync(full);
            removed += 1;
          }
        } catch {}
      }
    }
  };
  walk(sessions);

  const db = path.join(os.homedir(), ".codex", "state_5.sqlite");
  if (fs.existsSync(db)) {
    spawnSync("/usr/bin/sqlite3", [db], {
      input: `delete from threads where cwd like '${probe.replace(/'/g, "''")}%';`,
      encoding: "utf-8",
    });
  }
  console.log(`убрано чатов стенда: ${removed}`);
}

function codexBinary() {
  return fs
    .readdirSync(path.join(os.homedir(), ".vscode", "extensions"))
    .filter((name) => name.startsWith("openai.chatgpt-"))
    .map((name) => path.join(os.homedir(), ".vscode", "extensions", name, "bin", "macos-aarch64", "codex"))
    .find((file) => fs.existsSync(file));
}

/**
 * Настоящее событие от Codex в папке стенда: хук дёргает сам Codex своим Stop,
 * а не стенд подделкой. Подделка проверила бы только разбор аргументов — а
 * вопрос в том, доходит ли до нас событие живого агента и что решает хук.
 *
 * Один короткий обмен с моделью на прогон; это цена того, что проверяется
 * настоящая цепочка.
 */
function codexRun() {
  const codex = codexBinary();
  if (!codex) {
    console.error("Codex не установлен");
    process.exit(1);
  }
  // Та же ловушка, что и у подделки: папка стенда лежит внутри проекта, и на
  // событие ответит рабочее окно, если в фокусе оно.
  const { focused, stand } = windowForProbe();
  if (stand && focused && focused.pid !== stand.pid) {
    console.error(`событие перехватит чужое окно (pid ${focused.pid}: ${focused.folders.join(", ")})`);
    process.exit(1);
  }
  const result = spawnSync(codex, ["exec", "--skip-git-repo-check", "reply with the single word ok"], {
    cwd: workspace(),
    encoding: "utf-8",
  });
  const out = `${result.stdout || ""}${result.stderr || ""}`;
  if (result.status !== 0) {
    console.error(`Codex не отработал:\n${out.trim().split("\n").slice(-5).join("\n")}`);
    process.exit(1);
  }
  // Хуков в выводе нет, когда Codex им не доверяет — молчание алерта тогда
  // означало бы совсем не то, что проверяет сценарий.
  if (!/hook: Stop/.test(out)) {
    console.error("Codex не запустил ни одного хука — доверие: bash .probe/devhost.sh codex");
    process.exit(1);
  }
  console.log("Codex отработал, его Stop-хук выполнен");
}

function codexTrust() {
  const codex = codexBinary();
  if (!codex) return console.log("Codex не установлен — проверять нечего");

  const hooksFile = path.join(os.homedir(), ".codex", "hooks.json");
  let ours = 0;
  try {
    const hooks = JSON.parse(fs.readFileSync(hooksFile, "utf-8")).hooks || {};
    for (const groups of Object.values(hooks)) {
      for (const group of groups) {
        ours += (group.hooks || []).filter((h) => String(h.command).includes("floating-alert")).length;
      }
    }
  } catch {}
  console.log(`наших записей в hooks.json:   ${ours}`);

  // Доверие Codex хранит хешем в своём конфиге; пока секции нет, не доверен
  // ни один хук — ни наш, ни чужой.
  let trusted = false;
  try {
    trusted = /trusted_hash/.test(fs.readFileSync(path.join(os.homedir(), ".codex", "config.toml"), "utf-8"));
  } catch {}
  console.log(`доверие в config.toml:        ${trusted ? "есть" : "нет ни одного"}`);

  // В папке стенда: репозиторий отпадает — его окно бывает в фокусе, и алерт
  // подавился бы; ~/.claude отпадает тоже — там боевые файлы расширения.
  const cwd = fs.mkdtempSync(path.join(workspace(), "probe-codex-"));
  let ran = null;
  try {
    const before = new Set(fs.readdirSync(RUN_DIR));
    try {
      execFileSync(codex, ["exec", "--skip-git-repo-check", "reply with the single word ok"], {
        cwd,
        stdio: ["ignore", "ignore", "ignore"],
      });
      ran = fs.readdirSync(RUN_DIR).some((name) => !before.has(name));
    } catch {
      console.log("Codex не отработал прогон — смотрите его вывод вручную");
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
  console.log(`хук от Codex:                 ${ran ? "отработал" : "молчит"}`);

  if (ours > 0 && !ran) {
    console.log(
      trusted
        ? "\nзаписи на месте и что-то доверено, но наш хук не запустился — смотрите Hooks в Codex поштучно."
        : "\nдиагноз: записи есть, доверия нет. Доверить можно только в самом Codex:"
    );
    if (!trusted) console.log("панель Codex → настройки → Hooks, либо `codex` в терминале — он спросит на старте.");
  }
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  switch (cmd) {
    case "targets":
      console.log((await targets()).map((t) => `${t.type}\t${t.url}`).join("\n"));
      break;
    case "command":
      console.log(await command(rest.join(" ")));
      break;
    case "eval": {
      const target = await workbenchTarget();
      console.log(JSON.stringify(await evaluate(target.webSocketDebuggerUrl, rest.join(" ")), null, 1));
      break;
    }
    case "peek": {
      // Панели Claude Code — отдельные CDP-таргеты; так видно, что в какой.
      for (const target of await targets()) {
        if (!(target.url || "").startsWith("vscode-webview://")) continue;
        const text = await evaluate(
          target.webSocketDebuggerUrl,
          `${DOCS};docs().map((d) => (d.body ? d.body.innerText : "")).join(" ").replace(/\\s+/g, " ").slice(0, 200)`
        );
        console.log(`\n${target.id}\n  ${text}`);
      }
      break;
    }
    case "click": {
      // Клик по элементу с этим текстом в той панели, где он нашёлся.
      const wanted = rest.join(" ");
      const expression = `(() => {
        ${DOCS};
        const wanted = ${JSON.stringify(wanted)};
        for (const doc of docs()) {
          const nodes = [...doc.querySelectorAll("button, a, [role=button], [role=option], li, div")];
          // Снизу вверх: у внешних узлов текст детей тоже свой, а нужен самый
          // глубокий, иначе клик уходит в контейнер.
          const hit = nodes.reverse().find((node) => (node.innerText || "").trim().startsWith(wanted));
          if (hit) { hit.click(); return (hit.innerText || "").trim().slice(0, 80); }
        }
        return "";
      })()`;
      for (const target of await targets()) {
        if (!(target.url || "").startsWith("vscode-webview://")) continue;
        const hit = await evaluate(target.webSocketDebuggerUrl, expression);
        if (hit) return console.log(`клик: ${hit}`);
      }
      console.error(`не нашлось: ${wanted}`);
      process.exit(1);
      break;
    }
    case "bar": {
      // Контейнеры боковой панели командами палитры не открываются: команды
      // вида workbench.view.extension.<id> в неё не попадают. Зато у каждой
      // иконки в activity bar есть подпись, по которой можно кликнуть.
      const wanted = rest.join(" ");
      const target = await workbenchTarget();
      const hit = await evaluate(
        target.webSocketDebuggerUrl,
        `(() => {
          const wanted = ${JSON.stringify(wanted)};
          const nodes = [...document.querySelectorAll(".activitybar [aria-label]")];
          const found = nodes.find((node) => (node.getAttribute("aria-label") || "").includes(wanted));
          if (!found) return "";
          found.click();
          return found.getAttribute("aria-label");
        })()`
      );
      if (!hit) {
        console.error(`в activity bar нет "${wanted}"`);
        process.exit(1);
      }
      console.log(`открыто: ${hit}`);
      break;
    }
    case "front": {
      // Хук молчит, пока окно события не в фокусе, так что сценарии начинаются
      // с того, что окно выводится вперёд.
      const target = await workbenchTarget();
      await send(target.webSocketDebuggerUrl, [{ method: "Page.bringToFront" }]);
      console.log("окно выведено вперёд");
      break;
    }
    case "escape": {
      const target = await workbenchTarget();
      await send(target.webSocketDebuggerUrl, key("", "Escape", 27, 0));
      console.log("escape отправлен");
      break;
    }
    case "shot": {
      const target = await workbenchTarget();
      const shot = await send(target.webSocketDebuggerUrl, [
        { method: "Page.captureScreenshot", params: { format: "png" } },
      ]);
      const file = rest[0] || path.join(__dirname, "shot.png");
      fs.writeFileSync(file, Buffer.from(shot, "base64"));
      console.log(file);
      break;
    }
    case "surfaces":
      surfaces();
      break;
    case "session": {
      // Сессия поверхности нужного вида — чтобы событие адресовать именно ей.
      const kind = rest[0] || "tab";
      const session = sessionOf(kind);
      if (session) return console.log(session);
      console.error(`в окне стенда нет поверхности вида ${kind}`);
      process.exit(1);
      break;
    }
    case "focus":
      focus();
      break;
    case "alerts":
      alerts();
      break;
    case "fire":
      fire(rest[0] || "stop", rest[1], rest[2]);
      break;
    case "codex":
      codexTrust();
      break;
    case "codexrun":
      codexRun();
      break;
    case "register":
      register(rest[0] || path.join(__dirname, "vscode-ext"));
      break;
    case "seed":
      seed(rest[0] || path.join(__dirname, "vscode-user"));
      break;
    case "clean":
      clean();
      break;
    case "pretend":
      pretend(rest[0] || "on");
      break;
    case "ask":
      await ask(rest.slice(1).join(" ") || "ответь одним словом: ok", rest[0] || "claude");
      break;
    case "wait-surface":
      await waitSurface(rest[0] || "tab", Number(rest[1]) || 5);
      break;
    case "wait-session":
      waitSession(rest[0] || "sidebar", Number(rest[1]) || 10, rest[2]);
      break;
    case "wait-answer":
      waitAnswer(rest[0], Number(rest[1]) || 20);
      break;
    case "wait-title":
      waitTitle(rest[0], Number(rest[1]) || 60);
      break;
    case "wait-codex":
      waitCodex(Number(rest[0]) || 30);
      break;
    case "containers":
      containers();
      break;
    case "active":
      active();
      break;
    case "focus-tab":
      await focusTab(rest[0] === "code" ? "code" : "chat");
      break;
    case "unlock":
      await unlockGroup();
      break;
    case "panel":
      await panel();
      break;
    case "bars": {
      const target = await workbenchTarget();
      console.log(await evaluate(target.webSocketDebuggerUrl, `(${barsProbe})("all")`));
      break;
    }
    case "hide-chat":
      await hideChatBars();
      break;
    case "expected":
      expected(rest[0]);
      break;
    case "close-chat":
      await closeChatTab();
      break;
    case "expect":
      expect(rest[0] || "alert", rest[1], Number(rest[2]) || 1);
      break;
    case "forget":
      forget();
      break;
    case "press":
      await press();
      break;
    case "accept":
      await accept();
      break;
    case "prefer":
      prefer(rest[0] === "panel" ? "panel" : "editor");
      break;
    case "open-tab":
      openTab(rest[0], rest[1] || path.join(__dirname, "vscode-user"), rest[2] || path.join(__dirname, "vscode-ext"));
      break;
    case "landed":
      // Третьим словом — было ли откуда выводить окно вперёд: «away» значит,
      // что редактора на экране не было вовсе.
      mustBeInFront = rest[2] !== "away";
      await landed(rest[0], rest[1] || "sidebar", 8);
      break;
    default:
      console.error(
        "команды: targets | command | eval | surfaces | focus | alerts | fire | codex | containers | expect"
      );
      process.exit(1);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
