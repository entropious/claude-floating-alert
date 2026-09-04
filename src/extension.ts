import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import {
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

let statusItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext): void {
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

  publishFocus(vscode.window.state.focused);
  if (vscode.window.state.focused) dismissOwnPanels();

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeFloatingAlert.toggleHooks", toggleHooks),
    vscode.commands.registerCommand("claudeFloatingAlert.test", showTestAlert),
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
 * Bring forward the chat a clicked panel asked for. `open` can only raise the
 * window; revealing the chat tab inside it is up to the Claude Code extension,
 * whose command takes the session id.
 */
/**
 * Handles the link a clicked panel opens: `open` can only raise the window,
 * bringing the chat itself forward is up to whoever lives inside it.
 *
 *   vscode://entro.claude-floating-alert/reveal?session=<id>&cwd=<path>&tab=1
 */
function revealHandler(): vscode.UriHandler {
  return {
    async handleUri(uri: vscode.Uri): Promise<void> {
      if (uri.path !== "/reveal") return;
      const query = new URLSearchParams(uri.query);
      const cwd = query.get("cwd") || "";
      // The link lands in one window; ignore it unless the chat belongs here.
      if (!cwd || !workspacePaths().some((folder) => isInside(cwd, folder))) return;

      if (query.get("tab") === "1") {
        await run("claude-vscode.editor.open", query.get("session") || undefined);
        return;
      }
      // A side bar chat has no tab to reveal, and the reveal command would open
      // a second copy of it in the editor. Open the side bar, then focus the
      // view in case it was open all along and opening it was a no-op.
      await run("claude-vscode.sidebar.open");
      await run("claudeVSCodeSidebarSecondary.focus");
    },
  };
}

/** Run a command of another extension, which may or may not be there. */
async function run(command: string, ...args: unknown[]): Promise<void> {
  try {
    await vscode.commands.executeCommand(command, ...args);
  } catch {}
}

/**
 * Close the panels raised by sessions of this window: their alert is answered
 * by the user looking here. Panels of other windows stay up.
 */
function dismissOwnPanels(): void {
  let files: string[] = [];
  try {
    files = fs.readdirSync(RUN_DIR);
  } catch {
    return;
  }
  const folders = workspacePaths();
  for (const name of files) {
    const file = path.join(RUN_DIR, name);
    let panel: { pid?: number; cwd?: string; window?: string };
    try {
      panel = JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch {
      continue;
    }
    const mine = WINDOW_ID && panel.window
      ? panel.window === WINDOW_ID
      : !!panel.cwd && folders.some((folder) => isInside(panel.cwd!, folder));
    if (!mine || !panel.pid) continue;
    try {
      process.kill(panel.pid, "SIGTERM");
    } catch {}
    try {
      fs.unlinkSync(file);
    } catch {}
  }
}

/** Wire the hooks once, right after install; the toggle owns them afterwards. */
function bootstrapHooks(context: vscode.ExtensionContext): void {
  if (context.globalState.get<boolean>("bootstrapped")) return;
  try {
    if (!hooksInstalled()) installHooks();
    context.globalState.update("bootstrapped", true);
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

async function toggleHooks(): Promise<void> {
  try {
    // The status bar item is the feedback: no notification needed.
    if (hooksInstalled()) {
      uninstallHooks();
    } else {
      installHooks();
    }
  } catch (error) {
    vscode.window.showErrorMessage(`Claude Floating Alert: could not update settings.json — ${error}`);
  }
  refreshStatus();
}

function showTestAlert(): void {
  if (!fs.existsSync(BINARY)) {
    vscode.window.showErrorMessage(
      "Claude Floating Alert: the alert window is missing. Reload the window to reinstall it."
    );
    return;
  }
  const folder = vscode.workspace.workspaceFolders?.[0];
  execFile(BINARY, [
    "--subtitle", folder ? path.basename(folder.uri.fsPath) : "Claude Code",
    "--title", "Test alert",
    "--body", "This is how the alert looks above every other app.",
    "--accent", "orange",
    "--timeout", "8",
  ]);
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
    permission: { enabled: config.get<boolean>("permission.enabled"), accent: "orange", timeout: 0 },
    question: { enabled: config.get<boolean>("question.enabled"), accent: "purple", timeout: 0 },
    stop: {
      enabled: config.get<boolean>("stop.enabled"),
      accent: "green",
      timeout: config.get<number>("stop.timeout"),
    },
  };
  try {
    fs.mkdirSync(INSTALL_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(runtime, null, 2)}\n`);
  } catch {}
}
