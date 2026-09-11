import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import {
  ASK_DIR,
  BINARY,
  CONFIG_FILE,
  FOCUS_DIR,
  HOOK_SCRIPT,
  INSTALL_DIR,
  RUN_DIR,
  hooksInstalled,
  installHooks,
  uninstallHooks,
} from "./hooks";

/** Per-window socket path, shared with the terminals this window spawns. */
const WINDOW_ID = process.env.VSCODE_IPC_HOOK_CLI || "";
const FOCUS_FILE = path.join(FOCUS_DIR, `${process.pid}.json`);
const ASK_FILE = path.join(ASK_DIR, `${process.pid}.json`);

let statusItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext): void {
  // The alert window is a Mach-O binary. Marketplace only offers the extension
  // to macOS, but a hand-installed VSIX lands anywhere.
  if (process.platform !== "darwin") {
    vscode.window.showErrorMessage("Claude Floating Alert works on macOS (Apple Silicon) only.");
    return;
  }

  try {
    syncPayload(context);
  } catch (error) {
    vscode.window.showErrorMessage(`Claude Floating Alert: could not install the alert window — ${error}`);
  }
  writeRuntimeConfig();
  bootstrapHooks(context);

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.name = "Claude Floating Alert";
  statusItem.command = "claudeFloatingAlert.toggleHooks";
  context.subscriptions.push(statusItem);
  refreshStatus();

  findStateDatabase(context);
  publishFocus(vscode.window.state.focused);
  if (vscode.window.state.focused) dismissOwnPanels();

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeFloatingAlert.toggleHooks", toggleHooks),
    vscode.commands.registerCommand("claudeFloatingAlert.test", showTestAlert),
    vscode.commands.registerCommand("claudeFloatingAlert.showLog", showLog),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("claudeFloatingAlert")) writeRuntimeConfig();
    }),
    vscode.window.onDidChangeWindowState((state) => {
      publishFocus(state.focused);
      if (state.focused) dismissOwnPanels();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => publishFocus(vscode.window.state.focused)),
    vscode.window.registerUriHandler(revealHandler()),
    vscode.window.tabGroups.onDidChangeTabs(() => publishFocus(vscode.window.state.focused)),
    vscode.window.onDidChangeActiveTextEditor(() => publishFocus(vscode.window.state.focused)),
    vscode.window.tabGroups.onDidChangeTabGroups(() => publishFocus(vscode.window.state.focused)),
    watchAsks(),
    { dispose: forgetFocus }
  );
}

export function deactivate(): void {
  // Hooks stay wired on purpose: they are what makes alerts work while VS Code
  // is in the background. Removing them is an explicit user action.
  forgetFocus();
}

function workspacePaths(): string[] {
  return (vscode.workspace.workspaceFolders || []).map((folder) => folder.uri.fsPath);
}

/** View type of a Claude Code chat tab, as the tab API reports it. */
const CHAT_VIEW_TYPE = "claudeVSCodePanel";

function isChatTab(tab: vscode.Tab): boolean {
  const input = tab.input as { viewType?: string } | undefined;
  return typeof input?.viewType === "string" && input.viewType.includes(CHAT_VIEW_TYPE);
}

/** A Codex chat opened as an editor: its own custom editor, on its own scheme. */
const CODEX_EDITOR = "chatgpt.conversationEditor";
const CODEX_SCHEME = "openai-codex";

function isCodexTab(tab: vscode.Tab): boolean {
  const input = tab.input as { viewType?: string; uri?: vscode.Uri } | undefined;
  if (typeof input?.viewType === "string" && input.viewType.includes(CODEX_EDITOR)) return true;
  return input?.uri?.scheme === CODEX_SCHEME;
}

/** Whether a Codex chat is the tab on top — the one case where its chat is
 *  visible to an API outside Codex itself. */
function codexTabActive(): boolean {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (isCodexTab(tab) && tab.isActive && group.isActive) return true;
    }
  }
  return false;
}

/**
 * Titles of the chat tabs in this window, and the one on top (empty when the
 * user is looking at something else). Chat tabs are labelled after the session,
 * which is how the hook tells the chat you are watching from those running in
 * the background.
 */
function chatTabs(): { titles: string[]; active: string } {
  const titles: string[] = [];
  let active = "";
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (!isChatTab(tab)) continue;
      titles.push(tab.label.trim());
      if (tab.isActive && group.isActive) active = tab.label.trim();
    }
  }
  return { titles, active };
}

/**
 * Where VS Code keeps the layout state of this window, `state.vscdb` next to the
 * storage directory of every extension in the workspace. It holds the one thing
 * about a panel of another extension that is knowable — which view container the
 * side bars are set to — and it is written within a second of a change.
 */
let stateDatabase = "";

function findStateDatabase(context: vscode.ExtensionContext): void {
  const own = context.storageUri?.fsPath;
  if (!own) return;
  const file = path.join(path.dirname(own), "state.vscdb");
  if (fs.existsSync(file)) stateDatabase = file;
}

/**
 * The extension that can answer a request without anyone opening the chat: it
 * tells the chat to take the first option. Only where it is installed does the
 * alert offer that button, so its presence travels with the window state.
 */
const COLORIZER = "local.claude-code-colorizer";
const ACCEPT_COMMAND = "claudeCodeColorizer.acceptFirstOption";

function canAccept(): boolean {
  return vscode.extensions.getExtension(COLORIZER) !== undefined;
}

/** What a clicked alert can ask of the window holding its chat. */
interface Ask {
  action?: string;
  agent?: string;
  session?: string;
  tab?: boolean;
}

/**
 * Watch for what a clicked alert leaves for this window, and do it. The file is
 * taken away before anything runs, so a slow command cannot collect the same
 * request twice.
 */
function watchAsks(): vscode.Disposable {
  let watcher: fs.FSWatcher | undefined;
  let poll: NodeJS.Timeout | undefined;
  const look = (): void => {
    const ask = takeAsk();
    if (ask) void obey(ask);
  };
  // Watching a directory is not a promise: the system coalesces events and
  // drops them under load, and a request nobody hears is a button that did
  // nothing. So the file is also looked at now and then — but only while an
  // alert could be on screen to press. The hook says when that is: it writes a
  // file per panel it raises, next door. After a stretch with nothing new the
  // looking stops, since the panel it was for is long answered or gone.
  let until = 0;
  const stop = (): void => {
    if (poll) clearInterval(poll);
    poll = undefined;
    // The same moment, said to the panels: a button that outlives the listening
    // promises an answer nobody is waiting for, so it goes when this does.
    for (const alert of ownPanels()) {
      try {
        process.kill(alert.pid, "SIGHUP");
      } catch {}
    }
  };
  const arm = (): void => {
    until = Date.now() + ASK_WATCH_MS;
    if (poll) return;
    poll = setInterval(() => {
      look();
      if (Date.now() > until) stop();
    }, ASK_POLL_MS);
  };
  let alerts: fs.FSWatcher | undefined;
  try {
    fs.mkdirSync(ASK_DIR, { recursive: true });
    fs.mkdirSync(RUN_DIR, { recursive: true });
    // A window that died with a request waiting would answer the moment it
    // comes back, long after the alert it belonged to.
    forgetAsk();
    watcher = fs.watch(ASK_DIR, look);
    alerts = fs.watch(RUN_DIR, arm);
  } catch {}
  return {
    dispose: () => {
      watcher?.close();
      alerts?.close();
      if (poll) clearInterval(poll);
      forgetAsk();
    },
  };
}

/** How long a request can go unheard when the watcher misses it. */
const ASK_POLL_MS = 1000;
/**
 * How long an alert stays worth looking out for after the hook raised one —
 * the same stretch the panel offers its answer button for, since after that
 * there is nothing left to press.
 */
const ASK_WATCH_MS = 5 * 60 * 1000;

/**
 * Takes this window's request away, and says what it was.
 *
 * The file goes only once it has been read whole: a watcher fires on the
 * creation as readily as on the writing, and a request thrown away half-written
 * is a button that did nothing. What cannot be parsed is left where it is, for
 * the next look to find finished.
 */
function takeAsk(): Ask | null {
  let raw = "";
  try {
    raw = fs.readFileSync(ASK_FILE, "utf-8");
  } catch {
    return null;
  }
  let ask: Ask;
  try {
    ask = JSON.parse(raw);
  } catch {
    return null;
  }
  forgetAsk();
  return ask;
}

function forgetAsk(): void {
  try {
    fs.unlinkSync(ASK_FILE);
  } catch {}
}

async function obey(ask: Ask): Promise<void> {
  // Answering leaves everything where it is: the point of that button is to
  // take the first option without going to the chat at all.
  if (ask.action === "accept") {
    const ran = await run(ACCEPT_COMMAND);
    // Written down because there is nothing else to see: the command answers
    // inside a chat webview, and a button that did nothing looks exactly like
    // one whose request never arrived.
    note({ ask: "accept", command: ACCEPT_COMMAND, ran });
    // And said out loud, since the alert is already gone and the request it was
    // about is still waiting in the chat.
    if (!ran) {
      cry("Accept did not go through", `${ACCEPT_COMMAND} would not run in this window.`);
    }
    return;
  }
  await reveal(ask.agent || "claude", ask.session || "", ask.tab === true);
  note({ ask: "reveal", session: ask.session || "", tab: ask.tab === true });
}

/**
 * Say on an alert of its own that something asked of this window did not
 * happen. The panel that asked is gone by then — it closes on the press — and a
 * notice inside the editor would be behind whatever the user went to instead.
 */
function cry(title: string, body: string): void {
  const folder = vscode.workspace.workspaceFolders?.[0];
  try {
    execFile(BINARY, [
      "--subtitle", folder ? path.basename(folder.uri.fsPath) : "Claude Code",
      "--title", title,
      "--body", body,
      "--accent", "red",
      "--timeout", "0",
      "--log-file", path.join(INSTALL_DIR, "log.jsonl"),
    ]);
  } catch {}
}

/** One line in the log the hook keeps, about what this window was asked to do. */
function note(what: Record<string, unknown>): void {
  try {
    fs.appendFileSync(
      path.join(INSTALL_DIR, "log.jsonl"),
      `${JSON.stringify({ at: new Date().toISOString(), window: process.pid, ...what })}\n`
    );
  } catch {}
}

/** Tell the hook script whether this window — not just VS Code — is focused. */
function publishFocus(focused: boolean): void {
  const chats = chatTabs();
  try {
    fs.mkdirSync(FOCUS_DIR, { recursive: true });
    fs.writeFileSync(
      FOCUS_FILE,
      JSON.stringify({
        pid: process.pid,
        window: WINDOW_ID,
        focused,
        folders: workspacePaths(),
        chatTabs: chats.titles,
        activeChat: chats.active,
        codexTab: codexTabActive(),
        accept: canAccept(),
        state: stateDatabase,
        at: new Date().toISOString(),
      })
    );
  } catch {}
}

function forgetFocus(): void {
  try {
    fs.unlinkSync(FOCUS_FILE);
  } catch {}
}

function isInside(cwd: string, folder: string): boolean {
  return cwd === folder || cwd.startsWith(`${folder}${path.sep}`);
}

/**
 * Bring forward the chat a clicked alert asked for. Raising the window is the
 * alert's own doing; what is inside it belongs to whoever lives there.
 */
async function reveal(agent: string, session: string, tab: boolean): Promise<boolean> {
  if (agent === "codex") {
    // Codex takes no session anywhere: its panel opens on whatever chat it was
    // left on, which is the one the alert came from. The command reveals the
    // container and focuses the view itself, in whichever side bar this editor
    // puts the panel — a `<view>.focus` of our own would only be the same work
    // again, and the one for the side bar the panel is not in costs a wait on
    // the extension activation of a command that is missing.
    return run("chatgpt.openSidebar");
  }
  if (tab) return run("claude-vscode.editor.open", session || undefined);
  // A side bar chat has no tab to reveal, and the reveal command would open a
  // second copy of it in the editor. The side bar command focuses its own view,
  // so nothing else is needed here either.
  return run("claude-vscode.sidebar.open");
}

/**
 * Handles the link a clicked panel opens, which is the way in when the hook
 * found no window to address by name:
 *
 *   vscode://entro.claude-floating-alert/reveal?agent=claude&session=<id>&cwd=<path>&tab=1
 *
 * VS Code hands the link to whichever window it likes, so the folder in it says
 * whose chat this is about, and a window that does not hold that folder leaves
 * the link alone.
 */
function revealHandler(): vscode.UriHandler {
  return {
    async handleUri(uri: vscode.Uri): Promise<void> {
      if (uri.path !== "/reveal") return;
      const query = new URLSearchParams(uri.query);
      const cwd = query.get("cwd") || "";
      if (!cwd || !workspacePaths().some((folder) => isInside(cwd, folder))) return;
      await reveal(query.get("agent") || "claude", query.get("session") || "", query.get("tab") === "1");
    },
  };
}

/** Run a command of another extension, which may or may not be there. */
async function run(command: string, ...args: unknown[]): Promise<boolean> {
  try {
    await vscode.commands.executeCommand(command, ...args);
    return true;
  } catch {
    return false;
  }
}

/**
 * Close the panels raised by sessions of this window: their alert is answered
 * by the user looking here. Panels of other windows stay up.
 */
/** The panels raised by sessions of this window, by process. */
function ownPanels(): { pid: number; file: string }[] {
  let files: string[] = [];
  try {
    files = fs.readdirSync(RUN_DIR);
  } catch {
    return [];
  }
  const folders = workspacePaths();
  const mine: { pid: number; file: string }[] = [];
  for (const name of files) {
    const file = path.join(RUN_DIR, name);
    let panel: { pid?: number; cwd?: string; window?: string };
    try {
      panel = JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch {
      continue;
    }
    const ours = WINDOW_ID && panel.window
      ? panel.window === WINDOW_ID
      : !!panel.cwd && folders.some((folder) => isInside(panel.cwd!, folder));
    if (ours && panel.pid) mine.push({ pid: panel.pid, file });
  }
  return mine;
}

function dismissOwnPanels(): void {
  for (const panel of ownPanels()) {
    const file = panel.file;
    try {
      process.kill(panel.pid, "SIGTERM");
    } catch {}
    try {
      fs.unlinkSync(file);
    } catch {}
  }
}

/**
 * Wire the hooks once, right after install; the toggle owns them afterwards.
 *
 * The key carries the set of agents that bootstrap covers. An install that
 * predates Codex has the older key and is wired again, once, so that its Codex
 * registrations appear — unless the user has turned the hooks off, which is an
 * answer bootstrap does not overrule.
 */
function bootstrapHooks(context: vscode.ExtensionContext): void {
  if (context.globalState.get<boolean>("bootstrapped.codex")) return;
  const wired = hooksInstalled();
  const before = context.globalState.get<boolean>("bootstrapped");
  try {
    // Wired already: an older install, brought up to date. Never wired: a fresh
    // one. Wired once and switched off since: left as the user put it.
    if (wired ? before : !before) void askCodexToTrust(installHooks());
    context.globalState.update("bootstrapped", true);
    context.globalState.update("bootstrapped.codex", true);
  } catch (error) {
    vscode.window.showErrorMessage(`Claude Floating Alert: could not write the hooks — ${error}`);
  }
}

function refreshStatus(): void {
  const on = hooksInstalled();
  statusItem.text = on ? "$(bell) Claude Alert" : "$(bell-slash) Claude Alert";
  statusItem.tooltip = on
    ? "Hooks are wired in ~/.claude/settings.json. Click to turn them off."
    : "Hooks are not wired. Click to turn the floating alerts on.";
  statusItem.show();
}

/**
 * Writing `~/.codex/hooks.json` is only half of it: Codex keeps a hash of every
 * hook it has been shown and skips, without a word, the ones that are new or
 * changed. Nothing here can grant that trust — it is the point of the mechanism
 * — so the one useful thing is to say where it is granted.
 */
async function askCodexToTrust(written: { codex: boolean }): Promise<void> {
  if (!written.codex) return;
  const open = "Open Codex";
  const answer = await vscode.window.showInformationMessage(
    "Claude Floating Alert wired its hooks into Codex. Codex runs them only once you trust them: open its panel, then Hooks in the settings.",
    open
  );
  if (answer === open) await run("chatgpt.openSidebar");
}

async function toggleHooks(): Promise<void> {
  try {
    // The status bar item is the feedback for switching off; switching on has
    // the Codex notice, which the toggle is the usual way to reach.
    if (hooksInstalled()) {
      uninstallHooks();
    } else {
      void askCodexToTrust(installHooks());
    }
  } catch (error) {
    vscode.window.showErrorMessage(`Claude Floating Alert: could not update settings.json — ${error}`);
  }
  refreshStatus();
}

/**
 * Open the log the hook keeps: one line per event, with the windows and reports
 * the decision was made on. An alert that fired when it should not have, or
 * never came, is explained by nothing else.
 */
async function showLog(): Promise<void> {
  const file = path.join(INSTALL_DIR, "log.jsonl");
  if (!fs.existsSync(file)) {
    vscode.window.showInformationMessage(
      "Claude Floating Alert: no events yet — the log is written as they arrive."
    );
    return;
  }
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  await vscode.window.showTextDocument(document, { preview: false });
}

function showTestAlert(): void {
  if (!fs.existsSync(BINARY)) {
    vscode.window.showErrorMessage(
      "Claude Floating Alert: the alert window is missing. Reload the window to reinstall it."
    );
    return;
  }
  const folder = vscode.workspace.workspaceFolders?.[0];
  execFile(
    BINARY,
    [
      "--subtitle", folder ? path.basename(folder.uri.fsPath) : "Claude Code",
      "--title", "Test alert",
      "--body", "This is how the alert looks above every other app.",
      "--accent", "orange",
      "--timeout", "8",
    ],
    (error) => {
      // The binary is arm64: an Intel Mac cannot run it at all.
      if (error) {
        vscode.window.showErrorMessage(
          `Claude Floating Alert: the alert window would not run (Apple Silicon required) — ${error.message}`
        );
      }
    }
  );
}

/** Copy the hook script and the alert binary into the stable install dir. */
function syncPayload(context: vscode.ExtensionContext): void {
  fs.mkdirSync(path.join(INSTALL_DIR, "bin"), { recursive: true });

  const sourceHook = path.join(context.extensionPath, "hooks", "claude-floating-alert.js");
  const sourceBinary = path.join(context.extensionPath, "bin", "claude-alert");

  fs.copyFileSync(sourceHook, HOOK_SCRIPT);
  fs.chmodSync(HOOK_SCRIPT, 0o755);

  const installed = fs.existsSync(BINARY) ? fs.readFileSync(BINARY) : null;
  if (!installed || !installed.equals(fs.readFileSync(sourceBinary))) {
    fs.copyFileSync(sourceBinary, BINARY);
  }
  fs.chmodSync(BINARY, 0o755);
}

/**
 * Mirror VS Code settings into the JSON the hook script reads. Unset settings
 * come back as the defaults declared in package.json, so none are repeated here.
 */
function writeRuntimeConfig(): void {
  const config = vscode.workspace.getConfiguration("claudeFloatingAlert");
  const runtime = {
    stop: { timeout: config.get<number>("stop.timeout") },
  };
  try {
    fs.mkdirSync(INSTALL_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(runtime, null, 2)}\n`);
  } catch {}
}
