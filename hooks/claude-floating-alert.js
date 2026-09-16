#!/usr/bin/env node
// Claude Floating Alert — hook entry point.
//
// The agent pipes the hook payload as JSON on stdin; the event kind comes in
// as argv[2] (permission | question | stop), and `--agent codex` marks the
// registrations Codex runs — a bare invocation is Claude Code. The panel is
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
/**
 * Where a clicked panel leaves what it wants done — reveal this chat, answer
 * this request — one file per window, named after its extension host.
 *
 * A deep link says the same thing, but goes to whichever window VS Code hands
 * it to: the last active one, which at the moment of a click is by definition
 * not the one with the chat, or there would have been no alert. That window
 * sees a folder that is not its own and does nothing.
 */
const ASK_DIR = path.join(ROOT, "ask");
/** The same request as a link, for when no window could be named. */
const REVEAL_URL = "vscode://entro.claude-floating-alert/reveal";
/** The Bash rules of the settings files, as they were when last read. */
const RULES_FILE = path.join(ROOT, "rules.json");
/**
 * One line per event, and what the decision was made on. An alert that should
 * not have appeared — or one that never did — leaves nothing else behind: the
 * hook is spawned by the agent, and its output goes nowhere anyone reads.
 */
const LOG_FILE = path.join(ROOT, "log.jsonl");
/** Enough lines to cover a session's worth of events, and no growth after that. */
const LOG_LINES = 200;

const VSCODE_BUNDLE_ID = "com.microsoft.VSCode";
/** Per-window socket path: the same value in the window's terminals and its
 *  extension host, which is what ties a session to the window that runs it. */
const WINDOW_ID = process.env.VSCODE_IPC_HOOK_CLI || "";

/** Kinds that wait for an answer: they outrank the purely informational ones. */
const BLOCKING = new Set(["permission", "question"]);

/** The tools that are a question to the user rather than a thing being done. */
const QUESTION_TOOLS = new Set(["AskUserQuestion", "request_user_input"]);

/**
 * A question the agent asks reaches the permission hook too — asking is what it
 * needs permission for — and would then be shown as a permission request, in
 * the colour of one. It is a question whichever event carried it.
 */
function questionKind(kind, input) {
  return kind === "permission" && QUESTION_TOOLS.has(input.tool_name) ? "question" : kind;
}

/** Agents whose hooks land here, and the name the panel calls them by. */
const AGENTS = { claude: "Claude", codex: "Codex" };

/** Which agent fired this event: Codex registrations pass `--agent codex`. */
function agentId(argv) {
  const at = argv.indexOf("--agent");
  const id = at >= 0 ? argv[at + 1] : "";
  return Object.prototype.hasOwnProperty.call(AGENTS, id) ? id : "claude";
}

/** How much of a transcript's tail to scan for the session title. */
const TITLE_SCAN_BYTES = 512 * 1024;

/** How much of its head to scan for the first thing the user said. */
const HEAD_SCAN_BYTES = 64 * 1024;

/** Label a chat tab carries until Claude names the session. */
const UNTITLED_TAB = "Claude Code";

const DEFAULTS = {
  permission: { accent: "orange", timeout: 0 },
  question: { accent: "purple", timeout: 0 },
  stop: { accent: "green", timeout: 3 },
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
/**
 * Commands whose second word is a subcommand rather than an argument: `git add`
 * and `git commit` are different things, and one word says nothing about which
 * was asked for. For everything else the second word is a file or a flag, and
 * it has no place in a name.
 */
const SUBCOMMANDED = new Set([
  "git", "npm", "npx", "yarn", "pnpm", "bun", "deno",
  "docker", "kubectl", "helm", "cargo", "go", "gh", "brew",
  "pip", "pip3", "apt", "apt-get", "systemctl", "launchctl",
  "aws", "gcloud", "terraform", "dotnet", "mvn", "gradle", "tuist",
]);
/**
 * As much of a command as the panel takes when unfolded. It shows the first
 * lines of it and grows to the rest on a click, so what goes across is the
 * whole thing — line breaks and all, since a command is read by its shape.
 */
const COMMAND_MAX = 2000;

/** Keeps the text as it was written, cutting it off where it gets absurd. */
function clip(value, max) {
  const text = String(value || "").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * The commands a shell line runs, in order and without their arguments, each
 * with whether it is one the user has already allowed.
 *
 * What is asked for is often a whole pipeline, and its first words are what
 * says whether it is routine or not — reading that off five wrapped lines of a
 * command takes longer than the answer is worth.
 */
function commandsIn(command, cwd) {
  const rules = allowRules(cwd);
  const seen = new Map();
  const found = [];
  // Everything that ends one command and starts another. Quotes are left
  // alone: a separator inside them belongs to an argument, not to the line.
  for (const piece of splitCommands(String(command || ""))) {
    const words = commandWords(piece);
    // A line may set variables before what it runs: `FOO=bar npm test`.
    while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
    if (words.length === 0) continue;
    const name = path.basename(words[0]);
    if (!name) continue;
    // Named the way the rule that allows it is written: what stands in the
    // settings is `git status`, and calling it `git` would promise more than
    // has been allowed. Without a rule the command names itself — with its
    // subcommand where it has one, since `git add` and `git commit` are not
    // the same request.
    const rule = rules.find((one) => matchesRule(piece.trim(), one));
    const subcommand = rule ? "" : subcommandOf([name, ...words.slice(1)]);
    const label = rule ? ruleLabel(rule) : subcommand ? `${name} ${subcommand}` : name;
    // One name, one place in the list, and the line is only as settled as its
    // least settled use of it.
    const already = seen.get(label);
    if (already) {
      already.allowed = already.allowed && Boolean(rule);
      continue;
    }
    const one = { name: label, allowed: Boolean(rule) };
    seen.set(label, one);
    found.push(one);
  }
  // What has not been allowed goes first: that is the part of the line the
  // answer hangs on, and the allowed ones are there for completeness.
  return [...found.filter((one) => !one.allowed), ...found.filter((one) => one.allowed)];
}

/**
 * Splits a shell line on what separates one command from the next.
 *
 * Quotes and backslashes are left alone: a separator inside them belongs to an
 * argument, not to the line. Nor is every `&` a separator — the one in `2>&1`
 * names a file descriptor, and splitting there left `1` looking like a command.
 */
/**
 * Skips a heredoc whole and says where it ended.
 *
 * The label stands right after the `<<`, quoted or not; the body starts on the
 * next line and runs to a line holding the label alone. An unterminated heredoc
 * swallows the rest, which is what it does when run.
 */
function skipHeredoc(text, from) {
  let at = from + 2;
  if (text[at] === "-") at += 1;
  while (text[at] === " " || text[at] === "\t") at += 1;

  let quote = "";
  if (text[at] === "'" || text[at] === '"') {
    quote = text[at];
    at += 1;
  }
  const start = at;
  while (at < text.length && !/[\s;|&()<>]/.test(text[at]) && text[at] !== quote) at += 1;
  const label = text.slice(start, at);
  if (quote && text[at] === quote) at += 1;
  if (!label) return at - 1;

  const body = text.indexOf("\n", at);
  if (body === -1) return text.length;
  const rest = text.slice(body + 1);
  const end = new RegExp(`^[ \\t]*${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*$`, "m").exec(rest);
  return end ? body + 1 + end.index + end[0].length : text.length;
}

function splitCommands(line) {
  const pieces = [];
  let piece = "";
  let quote = "";
  for (let at = 0; at < line.length; at += 1) {
    const char = line[at];
    if (quote) {
      if (char === quote) quote = "";
      piece += char;
      continue;
    }
    if (char === "\\") {
      piece += char + (line[at + 1] || "");
      at += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      piece += char;
      continue;
    }
    // The body of a heredoc is fed to a command, not run: its words look like
    // any others and would fill the list with the prose of a commit message.
    // The command it is fed to ends at it.
    if (char === "<" && line[at + 1] === "<") {
      at = skipHeredoc(line, at);
      pieces.push(piece);
      piece = "";
      continue;
    }
    if ("|&;\n(){}".includes(char)) {
      if (char === "&" && /[<>]\s*$/.test(piece)) {
        piece += char;
        continue;
      }
      pieces.push(piece);
      piece = "";
      continue;
    }
    piece += char;
  }
  pieces.push(piece);
  return pieces;
}

/**
 * The words of one command, with what the shell would have taken off already
 * taken off: a backslash before a space holds the word together — a path like
 * `/Applications/Visual\ Studio\ Code.app/…` is one word — and redirections
 * belong to no command at all.
 */
function commandWords(piece) {
  const words = [];
  let word = "";
  let quote = "";
  const keep = () => {
    if (word) words.push(word);
    word = "";
  };
  for (let at = 0; at < piece.length; at += 1) {
    const char = piece[at];
    if (quote) {
      if (char === quote) quote = "";
      else word += char;
      continue;
    }
    if (char === "\\") {
      word += piece[at + 1] || "";
      at += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      keep();
      continue;
    }
    word += char;
  }
  keep();
  // `2>&1`, `> out.txt`, `< in`: the redirection itself, and the file it names.
  const out = [];
  for (let at = 0; at < words.length; at += 1) {
    if (/^\d*[<>]/.test(words[at])) {
      if (/[<>]$/.test(words[at])) at += 1;
      continue;
    }
    out.push(words[at]);
  }
  return out;
}

/**
 * The Bash rules the user has allowed, from every settings file Claude Code
 * reads: their own, this project's, and the local overrides of each.
 */
function allowRules(cwd) {
  const files = [
    path.join(HOME, ".claude", "settings.json"),
    path.join(HOME, ".claude", "settings.local.json"),
    ...(cwd ? [path.join(cwd, ".claude", "settings.json"), path.join(cwd, ".claude", "settings.local.json")] : []),
  ];
  // Parsed once and kept: settings change rarely, and every event would
  // otherwise read and walk four files to learn the same thing again. What is
  // checked each time is only when each file was last written.
  const kept = readJson(RULES_FILE) || {};
  const rules = [];
  let changed = false;
  for (const file of files) {
    let at = 0;
    try {
      at = fs.statSync(file).mtimeMs;
    } catch {}
    const known = kept[file];
    if (known && known.at === at) {
      rules.push(...known.rules);
      continue;
    }
    const found = bashRules(file);
    kept[file] = { at, rules: found };
    rules.push(...found);
    changed = true;
  }
  if (changed) {
    try {
      fs.mkdirSync(ROOT, { recursive: true });
      fs.writeFileSync(RULES_FILE, JSON.stringify(kept));
    } catch {}
  }
  return rules;
}

/** The Bash rules of one settings file. */
function bashRules(file) {
  const settings = readJson(file);
  if (!settings) return [];
  const rules = [];
  for (const rule of (settings.permissions || {}).allow || []) {
    const match = /^Bash\((.*)\)$/.exec(String(rule));
    if (match) rules.push(match[1]);
  }
  return rules;
}

/**
 * A JSON file, parsed once. The same settings are asked about for every command
 * of a line, and reading four files apiece is work with one answer.
 */
const parsed = new Map();

function readJson(file) {
  if (parsed.has(file)) return parsed.get(file);
  let value = null;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {}
  parsed.set(file, value);
  return value;
}

/**
 * How a rule reads in the list: the way it is written, whole. It is the rule
 * that allowed the command, and a rule cut short says less than it is — `npm
 * run` does not name the script `Bash(npm run package*)` was written for, and
 * reads as a permission that does not exist.
 */
function ruleLabel(rule) {
  return rule.replace(/\*$/, "").trim();
}

/**
 * The subcommand of a command that has them: the first word after the name that
 * names an action rather than a file. Flags are passed over along with what they
 * take — `git -C .. push` still pushes.
 */
function subcommandOf(words) {
  if (!SUBCOMMANDED.has(words[0])) return "";
  for (let at = 1; at < words.length; at += 1) {
    if (/^[A-Za-z][\w-]*$/.test(words[at])) return words[at];
  }
  return "";
}

/** Whether one command matches an allow rule, which may end in a wildcard. */
function matchesRule(command, rule) {
  if (!rule.endsWith("*")) return command === rule;
  return command.startsWith(rule.slice(0, -1).trimEnd());
}

/** Human-readable summary of what the tool is about to do. */
function toolDetail(input) {
  const tool = input.tool_name || "";
  const args = input.tool_input || {};
  if (tool === "Bash" && args.command) return clip(args.command, COMMAND_MAX);
  if (args.file_path) return truncate(args.file_path.replace(HOME, "~"), BODY_MAX);
  if (args.pattern) return truncate(args.pattern, BODY_MAX);
  if (args.url) return truncate(args.url, BODY_MAX);
  if (args.description) return truncate(args.description, BODY_MAX);
  return "";
}

/**
 * The question being asked. One call can carry several of them; the first is
 * the one the chat shows first, and the rest follow it there.
 */
function questionText(input) {
  const args = input.tool_input || {};
  if (Array.isArray(args.questions) && args.questions.length > 0) {
    return args.questions[0].question || "";
  }
  return args.question || "";
}

function workspaceName(cwd, agent) {
  if (!cwd) return AGENTS[agent];
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
function rememberPanel(sessionId, pid, cwd, kind, agent) {
  if (!sessionId) return;
  try {
    fs.mkdirSync(RUN_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(RUN_DIR, `${sessionId}.json`),
      JSON.stringify({ pid, cwd, kind, agent, window: WINDOW_ID })
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
 *
 * Null when the transcript cannot be read at all. A session with no marks and a
 * session nothing is known about look the same from here, and treating the
 * second as the first let any tab still carrying the default label pass for
 * this session's own — a side bar chat then counted as a tab in the background,
 * and answering in it raised an alert.
 */
function sessionMarks(cwd, sessionId) {
  if (!cwd || !sessionId) return null;
  const file = path.join(HOME, ".claude", "projects", cwd.replace(/[/.]/g, "-"), `${sessionId}.jsonl`);
  let head;
  let tail;
  try {
    const { size } = fs.statSync(file);
    head = readSlice(file, 0, Math.min(size, HEAD_SCAN_BYTES));
    const from = Math.max(0, size - TITLE_SCAN_BYTES);
    tail = from === 0 ? head : readSlice(file, from, size - from);
  } catch {
    return null;
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

/** Every VS Code window that is still running, whatever it has open. */
function liveWindows() {
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
    if (isAlive(state.pid)) windows.push(state);
  }
  return windows;
}

/**
 * Every live VS Code window this session could belong to.
 *
 * The window socket names one window exactly, and where both sides have it that
 * is the answer. Only one side usually does: a session started in a terminal of
 * a window carries it, the extension host of that window does not — VS Code
 * puts it in terminals, not in the host — so a socket that matches nothing is
 * no answer at all, and the folders decide instead. Letting it veto them left
 * every terminal-started session without a window, and so with an alert for
 * every event, chat in front or not.
 */
function windowsFor(cwd) {
  const live = liveWindows();
  const named = WINDOW_ID ? live.filter((state) => state.window === WINDOW_ID) : [];
  if (named.length > 0) return named;
  return cwd ? live.filter((state) => (state.folders || []).some((f) => isInside(cwd, f))) : [];
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
function presenceOf(pid) {
  let state;
  try {
    state = JSON.parse(fs.readFileSync(path.join(PRESENCE_DIR, `${pid}.json`), "utf-8"));
  } catch {
    return null;
  }
  return isAlive(state.pid) ? state : null;
}

/** Every extension host that is reporting its chats right now. */
function reportingPids() {
  let files = [];
  try {
    files = fs.readdirSync(PRESENCE_DIR);
  } catch {
    return [];
  }
  return files.map((name) => Number(path.basename(name, ".json"))).filter((pid) => pid > 0);
}

function chatSurfaces(pid, all) {
  const state = presenceOf(pid);
  if (!state) return null;
  // The sessions list is a webview of its own and names a session without ever
  // showing it; a report that predates the distinction marks nothing. Whoever
  // asks for everything wants that entry too — naming a session without showing
  // it still says the session exists, which silence does not.
  return all ? state.surfaces || [] : (state.surfaces || []).filter((surface) => surface.chat !== false);
}

/**
 * The surfaces holding one session, across every reporting window — those that
 * named the session themselves, and only those.
 *
 * A report may also carry a guess, marked as such: a surface told about a
 * session it is not the one showing. Two windows then answer for the same chat,
 * and since the reports are read in pid order, which is to say at random, a
 * guess wins half the time — sending the click to a window that never held the
 * chat, or calling it watched while the real one sits behind a browser. Nothing
 * is decided on a guess; the log keeps them for when a decision looks wrong.
 */
function surfacesOf(sessionId, all) {
  if (!sessionId) return [];
  const found = [];
  for (const pid of reportingPids()) {
    const surfaces = chatSurfaces(pid, all);
    if (!surfaces) continue;
    for (const surface of surfaces) {
      if (surface.session === sessionId && !surface.guessed) found.push({ ...surface, pid });
    }
  }
  return found;
}

/**
 * Whether the window of one extension host has focus.
 *
 * Only our own file answers this. The report of a patched Claude Code carries
 * the same flag, but writes it on chat events, and leaving for another window
 * is not one: it goes on saying "focused" until that chat is touched again, and
 * believing it is how an alert gets swallowed for a window nobody is looking
 * at. A window with no file of ours is not known to be in front, and silence
 * needs certainty.
 */
function windowFocused(pid) {
  const state = windowState(pid);
  return state ? !!state.focused : false;
}

/**
 * What a patched Claude Code says about this session, across every window it
 * reports: `true` when the chat is on screen in a window that has focus,
 * `false` when the reports cover the session and put it nowhere like that.
 *
 * `null` means they answer nothing about it, and the caller then works it out
 * on its own. Every way of answering nothing ends here: nobody reporting, a
 * report that never names this session, and a report that names it only behind
 * something out of sight while a chat on screen has yet to say whose it is —
 * the side bar a chat has just been moved into says nothing until that chat
 * next speaks, and the bar it came from goes on naming the session.
 */
function reportedWatch(sessionId) {
  const surfaces = surfacesOf(sessionId, true);
  if (surfaces.length === 0) return null;
  for (const surface of surfaces) {
    if (surface.chat === false || !surface.visible) continue;
    if (windowFocused(surface.pid)) return true;
  }
  for (const pid of reportingPids()) {
    if (!windowFocused(pid)) continue;
    const blind = (chatSurfaces(pid, false) || []).some(
      (surface) => surface.visible && !surface.session
    );
    if (blind) return null;
  }
  return false;
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
  // folders say — the surest answer there is, when someone is reporting. The
  // folder around the session is the one to name where the window has one, and
  // any folder of that window will do where it has not: a session that moved
  // into another project still lives in this window, and raising it is all the
  // folder is for.
  for (const surface of surfacesOf(sessionId)) {
    const state = windowState(surface.pid);
    if (!state) continue;
    const folders = state.folders || [];
    const around = folders.find((candidate) => isInside(cwd, candidate));
    if (around) return around;
    if (folders.length > 0) return folders[0];
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
 * The extension host to leave the request for: the window holding this chat.
 *
 * Same order as raising a window: a window reporting the session itself is the
 * sure answer, and without reports the closest folder around it wins.
 */
function askWindow(cwd, sessionId) {
  // A window reporting this very session holds the chat, and its folders have no
  // say in it: `cd` inside a chat moves the session's working directory, and a
  // session working in another project's folder belongs to its window all the
  // same. Matching the folders first sent those clicks to whichever window had
  // the folder the session had wandered into.
  for (const surface of surfacesOf(sessionId)) {
    if (windowState(surface.pid)) return surface.pid;
  }
  const windows = windowsFor(cwd);
  let best = null;
  let closest = -1;
  for (const state of windows) {
    for (const folder of state.folders || []) {
      if (isInside(cwd, folder) && folder.length > closest) {
        closest = folder.length;
        best = state;
      }
    }
  }
  return best ? best.pid : 0;
}

/**
 * True when some window has this chat open as a tab. Revealing a tab and
 * opening the side bar are different commands, and asking for the wrong one
 * opens a second copy of the chat in the editor.
 */
function sessionIsInTab(cwd, sessionId) {
  const reported = surfacesOf(sessionId);
  if (reported.length > 0) {
    // A session can sit in a tab and in the side bar at once, and then the tab
    // on top of its window is where it is being worked in. That comes first
    // because the times cannot settle it: every surface of a window is stamped
    // in the same write, so a session showing in both has the same moment
    // against each — and the winner would be whichever the report lists first,
    // which is a side bar.
    if (reported.some((surface) => surface.kind === "tab" && surface.active)) return true;
    // Otherwise the one worked in last, where those do differ.
    const latest = reported.reduce((best, surface) =>
      (surface.activeAt || 0) > (best.activeAt || 0) ? surface : best
    );
    return latest.kind === "tab";
  }

  const marks = sessionMarks(cwd, sessionId);
  // Without a transcript no label can be tied to this session, and a guess here
  // sends the click into someone else's chat. The side bar is the safer miss.
  if (!marks) return false;
  return windowsFor(cwd).some((state) =>
    (state.chatTabs || []).some((label) => tabBelongs(label, marks))
  );
}

function sessionIsWatched(cwd, sessionId, agent) {
  if (agent === "codex") {
    const window = focusedWindow(cwd);
    return window ? codexIsWatched(window) : false;
  }

  // A patched Claude Code names the session behind every surface, and where it
  // does the answer is exact — whichever window that turns out to be. It is
  // asked first for that reason: our own way of finding the window can come up
  // empty where the report is certain, and one source failing must never cost
  // the other.
  const reported = reportedWatch(sessionId);
  if (reported !== null) return reported;

  // Nothing reported about this session. Everything from here is what can be
  // worked out without help: the window in front, and the labels of its tabs.
  const window = focusedWindow(cwd);
  if (!window) return false;

  const marks = sessionMarks(cwd, sessionId);
  // Nothing to match tabs against: the window is the only thing left to go on.
  if (!marks) return true;
  const own = (window.chatTabs || []).filter((label) => tabBelongs(label, marks));
  // The chat is open as a tab: only the tab on top is in front of the user.
  if (own.length > 0) return own.includes(window.activeChat);
  // Otherwise the chat is taken to live in the side bar, which no API can see
  // into, and a focused window stands for it. That only holds while there is
  // one window it could be: with the same folder open twice, the focused one
  // may be the other, and the side bar in front may be showing another chat.
  return windowsFor(cwd).length === 1;
}

/** The view containers Codex puts its panel in, as the layout state names them. */
const CODEX_CONTAINERS = [
  "workbench.view.extension.codexSecondaryViewContainer",
  "workbench.view.extension.codexViewContainer",
];

/**
 * Which view container each side bar of a window is set to, read out of the
 * layout state VS Code keeps for that window. No API tells an extension what
 * another extension's panel is doing; this is the one thing recorded about it,
 * and it is written within a second of the user switching panels.
 *
 * What it does not record is whether the side bar is open at all: the entry
 * keeps naming the last container through a hidden side bar. So a match means
 * "the panel would be showing", not "it is on screen".
 */
function chosenContainers(state) {
  if (!state) return [];
  try {
    const out = require("child_process").execFileSync(
      "/usr/bin/sqlite3",
      [
        "-readonly",
        state,
        "select value from ItemTable where key in ('workbench.auxiliarybar.activepanelid','workbench.sidebar.activeviewletid')",
      ],
      { encoding: "utf-8", timeout: 2000 }
    );
    return out.split("\n").map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * True when the Codex chat is in front of the user. A chat opened as an editor
 * tab answers exactly — the tab API sees it. For the panel the answer is the
 * container the side bars are set to, and with nothing readable at all the
 * focused window has to stand for the chat, as it does for a Claude side bar.
 */
function codexIsWatched(window) {
  if (window.codexTab) return true;
  const chosen = chosenContainers(window.state);
  if (chosen.length === 0) return true;
  return chosen.some((container) => CODEX_CONTAINERS.includes(container));
}

function compose(kind, input, agent) {
  const cwd = input.cwd || "";
  const subtitle = workspaceName(cwd, agent);
  const name = AGENTS[agent];
  switch (kind) {
    case "permission":
      return {
        subtitle,
        title: `${name} needs permission`,
        body: [input.tool_name, toolDetail(input)].filter(Boolean).join(" · "),
      };
    case "question":
      return {
        subtitle,
        title: `${name} asked a question`,
        body: truncate(questionText(input) || "Your choice is needed", BODY_MAX),
      };
    default:
      return { subtitle, title: `${name} is done`, body: "Task finished, waiting for you." };
  }
}

/** Why an event produced no panel — silence is the normal case, and the reasons
 *  for it are spread across windows, surfaces and panels of other events. */
function explain(reason) {
  outcome = reason;
  if (process.env.CFA_DEBUG) process.stderr.write(`claude-floating-alert: ${reason}\n`);
}

/** What this run decided, and why. Written out once the run is over. */
let outcome = "";

/**
 * Keep the event and everything it was judged on. Which windows were live, what
 * each said about itself, and what any patched Claude Code reported — the whole
 * answer, since a wrong decision is only ever explained by what went into it.
 */
function record(kind, input, agent) {
  const cwd = input.cwd || "";
  try {
    // Every live window, not only the ones whose folders fit the event: a
    // decision that went to the wrong window is explained by the window that was
    // passed over, and narrowing the record to the folder hides exactly that.
    const windows = liveWindows().map((state) => ({
      ...state,
      surfaces: chatSurfaces(state.pid, true),
    }));
    const line = JSON.stringify({
      at: new Date().toISOString(),
      kind,
      agent,
      session: input.session_id || "",
      cwd,
      tool: input.tool_name || "",
      hookWindow: WINDOW_ID,
      outcome: outcome || "alert",
      troubles,
      windows,
    });
    // Appended, not rewritten: the windows write their own lines here — what
    // they were asked to do and whether it ran — and a rewrite would drop
    // whatever landed between reading the file and writing it back.
    fs.mkdirSync(ROOT, { recursive: true });
    fs.appendFileSync(LOG_FILE, `${line}\n`);
    // Cutting it back to size is the one rewrite there is, and it happens
    // rarely enough that a line lost to it would be an old one.
    let kept = [];
    try {
      kept = fs.readFileSync(LOG_FILE, "utf-8").split("\n").filter(Boolean);
    } catch {}
    if (kept.length > LOG_LINES * 2) {
      fs.writeFileSync(LOG_FILE, `${kept.slice(-LOG_LINES).join("\n")}\n`);
    }
  } catch {}
}

/**
 * Work out one thing about the editor, and never let it cost the alert.
 *
 * Everything read here comes from files other processes write — windows,
 * reports, transcripts, the layout database — and a surprise in any of them
 * used to take the whole panel down with it: the run threw, the throw was
 * swallowed at the top, and the event passed in silence. An alert with a
 * missing detail is still an alert; no alert is a missed turn.
 */
function about(what, fallback, read) {
  try {
    return read();
  } catch (error) {
    const trouble = `could not tell ${what}: ${error}`;
    explain(trouble);
    // Said on the panel too: a detail quietly missing is how an alert starts
    // leading to the wrong place, and nobody reads a log they do not suspect.
    troubles.push(trouble);
    return fallback;
  }
}

/** What went wrong while this alert was being put together. */
let troubles = [];

/**
 * Throw away requests left for windows that are gone. A window takes its own
 * away when it starts, but one that never comes back leaves its file lying
 * there for the pid to come round again.
 */
function sweepAsks() {
  let names = [];
  try {
    names = fs.readdirSync(ASK_DIR);
  } catch {
    return;
  }
  for (const name of names) {
    const pid = Number(path.basename(name, ".json"));
    if (pid && isAlive(pid)) continue;
    try {
      fs.unlinkSync(path.join(ASK_DIR, name));
    } catch {}
  }
}

function main(kind, input, agent) {
  const cwd = input.cwd || "";
  const session = input.session_id;

  // An unknown kind means a stale hook entry from an older install.
  const config = readConfig()[kind];
  if (!config) return explain(`unknown kind ${kind}`);
  if (!fs.existsSync(BINARY)) return explain("no alert binary installed");

  // Silence needs certainty; anything short of it raises the alert.
  if (about("whether the chat is watched", false, () => sessionIsWatched(cwd, session, agent))) {
    return explain("the chat is in front of the user");
  }

  // A self-closing panel must not replace one that waits for an answer.
  const previous = about("what is already on screen", null, () => livePanel(session));
  if (previous && BLOCKING.has(previous.kind) && !BLOCKING.has(kind)) {
    return explain(`a ${previous.kind} alert is still waiting for an answer`);
  }

  const { subtitle, title, body } = compose(kind, input, agent);
  // The commands of a shell line, said plainly above it: what is being asked
  // for, and how much of it the user has already allowed.
  const commands =
    kind === "permission" && input.tool_name === "Bash"
      ? about("which commands are asked for", [], () =>
          commandsIn((input.tool_input || {}).command, cwd)
        )
      : [];
  const inTab = about(
    "which surface holds the chat",
    false,
    () => agent !== "codex" && sessionIsInTab(cwd, session)
  );
  // The folder raises the window that has it open; what to bring forward inside
  // it is said separately, and to that window by name. The window is named by
  // the process of its extension host, which is what watches for the request.
  const target = about("which window holds the chat", 0, () => askWindow(cwd, session));
  about("which requests are stale", null, sweepAsks);
  const askFile = target ? path.join(ASK_DIR, `${target}.json`) : "";
  const click = target
    ? JSON.stringify({ action: "reveal", agent, session: session || "", tab: inTab })
    : "";

  // The link is the way in when no window could be named. It is not sent
  // alongside a request: VS Code hands a link to the window it likes, brings
  // that one forward to receive it, and the window just raised for the chat
  // loses the front again — to the very window the user was leaving.
  //
  // And only where some window has the folder open: a link nobody claims makes
  // VS Code open an empty window for it.
  const link =
    !target && windowsFor(cwd).length
      ? `${REVEAL_URL}?${new URLSearchParams({
          agent,
          session: session || "",
          cwd,
          // A Codex chat is opened by its panel, which takes no session: the
          // flag stays out of the link rather than carrying an answer nobody
          // uses.
          ...(agent === "codex" ? {} : { tab: inTab ? "1" : "0" }),
        })}`
      : "";

  // A permission request can be granted from the alert itself, where the window
  // holding the chat has the extension that tells it to take the first option.
  // Everything else gets no such button: a finished task has nothing to answer,
  // a Codex chat is beyond that extension, and a question has to be read before
  // it can be answered — taking its first option blind is not an answer.
  const canAccept =
    kind === "permission" && agent !== "codex" && target && windowState(target)?.accept;
  const accept = canAccept ? JSON.stringify({ action: "accept" }) : "";

  killPrevious(session);

  const child = spawn(
    BINARY,
    [
      "--subtitle", subtitle,
      "--title", title,
      "--body", [body, ...troubles].filter(Boolean).join("\n⚠ "),
      // Allowed ones are marked apart from the rest: the panel colours them.
      "--commands", commands.map((one) => `${one.allowed ? "+" : "-"}${one.name}`).join(","),
      "--accent", config.accent,
      "--timeout", String(config.timeout),
      "--folder", windowFolder(cwd, session),
      "--url", link,
      "--ask-file", askFile,
      "--ask-click", click,
      "--ask-accept", accept,
      // The way to the whole story, offered only when there is one to tell.
      "--log-file", troubles.length > 0 ? LOG_FILE : "",
      "--bundle-id", VSCODE_BUNDLE_ID,
    ],
    { detached: true, stdio: "ignore" }
  );
  child.unref();
  rememberPanel(session, child.pid, cwd, kind, agent);
}

/**
 * The last resort: a panel with nothing on it but what went wrong. No windows
 * are consulted and no link is offered — whatever was needed for those is what
 * just failed.
 */
function cryOut(kind, agent, error) {
  try {
    spawn(
      BINARY,
      [
        "--subtitle", AGENTS[agent] || AGENTS.claude,
        "--title", `${AGENTS[agent] || AGENTS.claude}: ${kind || "event"}`,
        "--body", `The alert could not be put together — ${error}`,
        "--accent", "red",
        "--timeout", "0",
        "--bundle-id", VSCODE_BUNDLE_ID,
      ],
      { detached: true, stdio: "ignore" }
    ).unref();
  } catch {
    /* nothing left to try: the binary itself is what could not be started */
  }
}

let raw = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
  let input = {};
  try {
    input = JSON.parse(raw);
  } catch {}
  const kind = questionKind(process.argv[2] || "", input);
  const agent = agentId(process.argv);
  try {
    main(kind, input, agent);
  } catch (error) {
    explain(`the hook itself failed: ${error}`);
    // Whatever broke, the event still happened and the user is still waiting.
    // A bare panel saying so beats the silence that a swallowed error used to
    // leave — the agent is stopped either way, and nobody watches a log.
    cryOut(kind, agent, String(error));
  }
  record(kind, input, agent);
  process.exit(0);
});
