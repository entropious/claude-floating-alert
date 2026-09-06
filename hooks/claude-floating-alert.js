#!/usr/bin/env node
// Claude Floating Alert — hook entry point.
//
// Claude Code pipes the hook payload as JSON on stdin; the event kind comes in
// as argv[2] (permission | question | stop). The panel is
// spawned detached so the hook returns immediately and never blocks the CLI.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const HOME = os.homedir();
const ROOT = path.join(HOME, ".claude", "floating-alert");
const BINARY = path.join(ROOT, "bin", "claude-alert");
const RUN_DIR = path.join(ROOT, "run");
const FOCUS_DIR = path.join(ROOT, "focus");
/** Optional: whether the chat is on screen, reported by a patched Claude Code. */
const PRESENCE_DIR = path.join(ROOT, "presence");
const CONFIG_FILE = path.join(ROOT, "config.json");
/** Deep link a clicked panel opens to bring its chat forward. */
const REVEAL_URL = "vscode://entro.claude-floating-alert/reveal";

const VSCODE_BUNDLE_ID = "com.microsoft.VSCode";
/** Per-window socket path: the same value in the window's terminals and its
 *  extension host, which is what ties a session to the window that runs it. */
const WINDOW_ID = process.env.VSCODE_IPC_HOOK_CLI || "";

/** Kinds that wait for an answer: they outrank the purely informational ones. */
const BLOCKING = new Set(["permission", "question"]);

/** How much of a transcript's tail to scan for the session title. */
const TITLE_SCAN_BYTES = 512 * 1024;

/** How much of its head to scan for the first thing the user said. */
const HEAD_SCAN_BYTES = 64 * 1024;

/** Label a chat tab carries until Claude names the session. */
const UNTITLED_TAB = "Claude Code";

const DEFAULTS = {
  permission: { enabled: true, accent: "orange", timeout: 0 },
  question: { enabled: true, accent: "purple", timeout: 0 },
  stop: { enabled: true, accent: "green", timeout: 3 },
};

function readConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    const merged = {};
    for (const key of Object.keys(DEFAULTS)) {
      merged[key] = { ...DEFAULTS[key], ...(raw[key] || {}) };
    }
    return merged;
  } catch {
    return DEFAULTS;
  }
}

function truncate(value, max) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** As much text as the panel can wrap across its five body lines. */
const BODY_MAX = 300;

/** Human-readable summary of what the tool is about to do. */
function toolDetail(input) {
  const tool = input.tool_name || "";
  const args = input.tool_input || {};
  if (tool === "Bash" && args.command) return truncate(args.command, BODY_MAX);
  if (args.file_path) return truncate(args.file_path.replace(HOME, "~"), BODY_MAX);
  if (args.pattern) return truncate(args.pattern, BODY_MAX);
  if (args.url) return truncate(args.url, BODY_MAX);
  if (args.description) return truncate(args.description, BODY_MAX);
  return "";
}

function workspaceName(cwd) {
  if (!cwd) return "Claude Code";
  return path.basename(cwd) || cwd;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The panel still on screen for this session, if any. */
function livePanel(sessionId) {
  if (!sessionId) return null;
  try {
    const panel = JSON.parse(fs.readFileSync(path.join(RUN_DIR, `${sessionId}.json`), "utf-8"));
    return panel.pid && isAlive(panel.pid) ? panel : null;
  } catch {
    return null;
  }
}

function killPrevious(sessionId) {
  const panel = livePanel(sessionId);
  if (panel) {
    try {
      process.kill(panel.pid, "SIGTERM");
    } catch {}
  }
  try {
    fs.unlinkSync(path.join(RUN_DIR, `${sessionId}.json`));
  } catch {}
}

/** Leave a trace the VS Code window can find when it wants the panel gone. */
function rememberPanel(sessionId, pid, cwd, kind) {
  if (!sessionId) return;
  try {
    fs.mkdirSync(RUN_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(RUN_DIR, `${sessionId}.json`),
      JSON.stringify({ pid, cwd, kind, window: WINDOW_ID })
    );
  } catch {}
}

function isInside(cwd, folder) {
  return cwd === folder || cwd.startsWith(`${folder}${path.sep}`);
}

function readSlice(file, from, length) {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(fd, buffer, 0, length, from);
    return buffer.subarray(0, read).toString("utf-8");
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * What the chat tab of this session can be called. A tab starts out with the
 * default label, is renamed to the first thing the user said, and ends up with
 * the title Claude generates — and the transcript trails the tab, so all three
 * have to be considered.
 */
function sessionMarks(cwd, sessionId) {
  if (!cwd || !sessionId) return {};
  const file = path.join(HOME, ".claude", "projects", cwd.replace(/[/.]/g, "-"), `${sessionId}.jsonl`);
  let head;
  let tail;
  try {
    const { size } = fs.statSync(file);
    head = readSlice(file, 0, Math.min(size, HEAD_SCAN_BYTES));
    const from = Math.max(0, size - TITLE_SCAN_BYTES);
    tail = from === 0 ? head : readSlice(file, from, size - from);
  } catch {
    return {};
  }

  let aiTitle = "";
  // The entry is rewritten as the title changes, so the last one wins.
  for (const line of tail.split("\n")) {
    if (!line.includes('"ai-title"')) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === "ai-title" && entry.aiTitle) aiTitle = String(entry.aiTitle).trim();
    } catch {}
  }

  let firstMessage = "";
  for (const line of head.split("\n")) {
    if (!line.includes('"type":"user"')) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type !== "user" || entry.isSidechain) continue;
      const content = (entry.message || {}).content;
      const text = typeof content === "string"
        ? content
        : (content || []).map((part) => (part && part.text) || "").join(" ");
      firstMessage = text.replace(/\s+/g, " ").trim();
      if (firstMessage) break;
    } catch {}
  }

  return { aiTitle, firstMessage };
}

/** Whether a tab with this label belongs to the session behind these marks. */
function tabBelongs(label, marks) {
  const clean = label.replace(/…$/, "").trim();
  if (!clean) return false;
  if (marks.aiTitle && clean === marks.aiTitle) return true;
  // A renamed-to-first-message tab: VS Code shows a shortened version of it.
  if (marks.firstMessage && marks.firstMessage.startsWith(clean)) return true;
  // The default label only counts while the chat has nothing to be named after.
  return clean === UNTITLED_TAB && !marks.aiTitle && !marks.firstMessage;
}

/** Every live VS Code window this session could belong to. */
function windowsFor(cwd) {
  let files = [];
  try {
    files = fs.readdirSync(FOCUS_DIR);
  } catch {
    return [];
  }
  const windows = [];
  for (const name of files) {
    let state;
    try {
      state = JSON.parse(fs.readFileSync(path.join(FOCUS_DIR, name), "utf-8"));
    } catch {
      continue;
    }
    if (!isAlive(state.pid)) continue;
    if (WINDOW_ID ? state.window === WINDOW_ID : cwd && (state.folders || []).some((f) => isInside(cwd, f))) {
      windows.push(state);
    }
  }
  return windows;
}

/** What one VS Code window last published about itself, if it is still alive. */
function windowState(pid) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(FOCUS_DIR, `${pid}.json`), "utf-8"));
    return isAlive(state.pid) ? state : null;
  } catch {
    return null;
  }
}

/** The focused VS Code window this session belongs to, if it is focused at all. */
function focusedWindow(cwd) {
  for (const state of windowsFor(cwd)) {
    if (state.focused) return state;
  }
  return null;
}

/**
 * What a Claude Code patched with the presence payload says about the chats of
 * one window: one entry per surface, each naming its session, whether it is a
 * tab or the side bar, and whether it is on screen. The file is written by the
 * extension host of that window, which is the process the focus file names too.
 *
 * Returns null whenever nobody is reporting — an unpatched Claude Code, a
 * Claude Code that has not started yet, a host that died and left its file
 * behind — and the caller then falls back to what it can work out on its own.
 */
function chatSurfaces(pid) {
  let state;
  try {
    state = JSON.parse(fs.readFileSync(path.join(PRESENCE_DIR, `${pid}.json`), "utf-8"));
  } catch {
    return null;
  }
  if (!isAlive(state.pid)) return null;
  // The sessions list is a webview of its own and names a session without ever
  // showing it; a report that predates the distinction marks nothing.
  return (state.surfaces || []).filter((surface) => surface.chat !== false);
}

/** The surfaces holding one session, across every reporting window. */
function surfacesOf(sessionId) {
  if (!sessionId) return [];
  let files = [];
  try {
    files = fs.readdirSync(PRESENCE_DIR);
  } catch {
    return [];
  }
  const found = [];
  for (const name of files) {
    const pid = Number(path.basename(name, ".json"));
    const surfaces = chatSurfaces(pid);
    if (!surfaces) continue;
    for (const surface of surfaces) {
      if (surface.session === sessionId) found.push({ ...surface, pid });
    }
  }
  return found;
}

/**
 * True when this very chat is in front of the user, so the event needs no
 * panel. A chat sitting in a background tab of the focused window is not: its
 * tab is labelled after the session, and another tab is on top.
 */
/**
 * The folder a window has open around this session, which is what `open` needs
 * to raise that window. Handing it the session's own directory instead makes
 * VS Code open a second window whenever the two differ — a session started in a
 * subdirectory, a worktree, or a multi-root workspace.
 */
function windowFolder(cwd, sessionId) {
  // A window that reports this very session holds the chat, whatever its
  // folders say — the surest answer there is, when someone is reporting.
  for (const surface of surfacesOf(sessionId)) {
    const state = windowState(surface.pid);
    const folder = state && (state.folders || []).find((candidate) => isInside(cwd, candidate));
    if (folder) return folder;
  }
  // Nested folders can each be open in a window of their own — a sub-project, a
  // worktree — so the closest folder around the session is the right window.
  let closest = "";
  for (const state of windowsFor(cwd)) {
    for (const folder of state.folders || []) {
      if (isInside(cwd, folder) && folder.length > closest.length) closest = folder;
    }
  }
  // With no window to raise the answer is empty: a folder no window has open
  // would open a new one.
  return closest;
}

/**
 * True when some window has this chat open as a tab. Revealing a tab and
 * opening the side bar are different commands, and asking for the wrong one
 * opens a second copy of the chat in the editor.
 */
function sessionIsInTab(cwd, sessionId) {
  const reported = surfacesOf(sessionId);
  if (reported.length > 0) {
    // A session can sit in a tab and in the side bar at once. The link has to
    // name the one the user last worked in, not whichever exists.
    const latest = reported.reduce((best, surface) =>
      (surface.activeAt || 0) > (best.activeAt || 0) ? surface : best
    );
    return latest.kind === "tab";
  }

  const marks = sessionMarks(cwd, sessionId);
  return windowsFor(cwd).some((state) =>
    (state.chatTabs || []).some((label) => tabBelongs(label, marks))
  );
}

function sessionIsWatched(cwd, sessionId) {
  const window = focusedWindow(cwd);
  if (!window) return false;

  // A patched Claude Code names the session behind every surface, so the answer
  // is exact: this chat is in front of the user, or it is not.
  const reported = chatSurfaces(window.pid);
  if (reported) {
    return reported.some((surface) => surface.session === sessionId && surface.visible);
  }

  const marks = sessionMarks(cwd, sessionId);
  const own = (window.chatTabs || []).filter((label) => tabBelongs(label, marks));
  // The chat is open as a tab: only the tab on top is in front of the user.
  if (own.length > 0) return own.includes(window.activeChat);
  // Otherwise the chat lives in the side bar, which the tab API cannot see —
  // the focused window is the best signal there is.
  return true;
}

function compose(kind, input) {
  const cwd = input.cwd || "";
  const subtitle = workspaceName(cwd);
  switch (kind) {
    case "permission":
      return {
        subtitle,
        title: "Permission needed",
        body: [input.tool_name, toolDetail(input)].filter(Boolean).join(" · "),
      };
    case "question":
      return {
        subtitle,
        title: "Claude asked a question",
        body: truncate((input.tool_input || {}).question || "Your choice is needed", BODY_MAX),
      };
    default:
      return { subtitle, title: "Claude is done", body: "Task finished, waiting for you." };
  }
}

/** Why an event produced no panel — silence is the normal case, and the reasons
 *  for it are spread across windows, surfaces and panels of other events. */
function explain(reason) {
  if (process.env.CFA_DEBUG) process.stderr.write(`claude-floating-alert: ${reason}\n`);
}

function main(kind, input) {
  const cwd = input.cwd || "";
  const session = input.session_id;

  // An unknown kind means a stale hook entry from an older install.
  const config = readConfig()[kind];
  if (!config || !config.enabled) return explain(`kind ${kind} is off`);
  if (!fs.existsSync(BINARY)) return explain("no alert binary installed");

  if (sessionIsWatched(cwd, session)) return explain("the chat is in front of the user");

  // A self-closing panel must not replace one that waits for an answer.
  const previous = livePanel(session);
  if (previous && BLOCKING.has(previous.kind) && !BLOCKING.has(kind)) {
    return explain(`a ${previous.kind} alert is still waiting for an answer`);
  }

  const { subtitle, title, body } = compose(kind, input);
  // The folder raises the window that has it open; the link then tells that
  // window which chat to bring forward. Without a window to receive it the link
  // would make VS Code open an empty one, so it is only sent when one is there.
  const link = windowsFor(cwd).length
    ? `${REVEAL_URL}?${new URLSearchParams({
        session: session || "",
        cwd,
        tab: sessionIsInTab(cwd, session) ? "1" : "0",
      })}`
    : "";

  killPrevious(session);

  const child = spawn(
    BINARY,
    [
      "--subtitle", subtitle,
      "--title", title,
      "--body", body,
      "--accent", config.accent,
      "--timeout", String(config.timeout),
      "--folder", windowFolder(cwd, session),
      "--url", link,
      "--bundle-id", VSCODE_BUNDLE_ID,
    ],
    { detached: true, stdio: "ignore" }
  );
  child.unref();
  rememberPanel(session, child.pid, cwd, kind);
}

let raw = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
  const kind = process.argv[2] || "";
  let input = {};
  try {
    input = JSON.parse(raw);
  } catch {}
  try {
    main(kind, input);
  } catch {}
  process.exit(0);
});
