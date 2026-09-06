// Управление Extension Development Host через CDP.
// Используется из devhost.sh; напрямую: node .probe/devhost-check.js <команда>
//
//   targets                список CDP-таргетов окна
//   command <название>     выполнить команду VS Code через палитру
//   eval <выражение>       произвольный код в контексте workbench
//   surfaces               что расширение Claude Code пишет о своих чатах
//   focus                  что окна пишут о своём фокусе
//   alerts                 живые процессы алерта и с какими аргументами
//   fire <kind> [session]  прогнать хук так, будто событие пришло от Claude Code
//   shot [файл]            снимок окна средствами самого редактора

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const PORT = process.env.CDP_PORT || 9333;
const ROOT = path.join(os.homedir(), ".claude", "floating-alert");

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return res.json();
}

/** Главное окно редактора: палитра и DOM живут здесь. */
async function workbenchTarget() {
  const list = await targets();
  const found = list.find(
    (t) => (t.url || "").includes("workbench") && t.webSocketDebuggerUrl
  );
  if (!found) throw new Error("окно не найдено: bash .probe/devhost.sh start");
  return found;
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
  await new Promise((done) => setTimeout(done, 600));
  await send(target.webSocketDebuggerUrl, key("\r", "Enter", 13, 0));
  await new Promise((done) => setTimeout(done, 600));
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

function alerts() {
  const out = spawnSync("pgrep", ["-fl", "claude-alert"], { encoding: "utf-8" }).stdout || "";
  const lines = out.split("\n").filter((line) => line.includes("--title"));
  if (!lines.length) return console.log("алертов на экране нет");
  for (const line of lines) console.log(line);
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

/** Событие в том виде, в каком его присылает Claude Code. */
function fire(kind, session) {
  const payload = {
    session_id: session || sessionHere() || "00000000-0000-4000-8000-000000000000",
    cwd: workspace(),
    tool_name: "Bash",
    tool_input: { command: "rm -rf build", question: "Проверка стенда?" },
  };
  const hook = path.join(ROOT, "claude-floating-alert.js");
  execFileSync("node", [hook, kind], {
    input: JSON.stringify(payload),
    stdio: ["pipe", "inherit", "inherit"],
    // Хук молчит по многим причинам сразу; пусть скажет, по какой именно.
    env: { ...process.env, CFA_DEBUG: "1" },
  });
  console.log(`хук отработал: ${kind}`);
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
      for (const state of readAll(path.join(ROOT, "presence"))) {
        if (!alive(state.pid)) continue;
        const found = (state.surfaces || []).find(
          (surface) => surface.kind === kind && surface.chat !== false && surface.session
        );
        if (found) return console.log(found.session);
      }
      console.error(`нет поверхности вида ${kind}`);
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
      fire(rest[0] || "stop", rest[1]);
      break;
    default:
      console.error("команды: targets | command | eval | surfaces | focus | alerts | fire");
      process.exit(1);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
