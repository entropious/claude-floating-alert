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

/**
 * Tell the hook script whether this window — not just VS Code — is focused, and
 * what it has open.
 *
 * That is the whole of what a window publishes about itself. What is showing
 * inside it is deliberately absent: a side bar is closed to every API, and the
 * ways around that — the titles of chat tabs, the view container recorded in
 * the layout state — answered a question nobody could check, and answered it
 * wrong often enough to send a click into somebody else's chat.
 */
function publishFocus(focused: boolean): void {
  try {
    fs.mkdirSync(FOCUS_DIR, { recursive: true });
    fs.writeFileSync(
      FOCUS_FILE,
      JSON.stringify({
        pid: process.pid,
        window: WINDOW_ID,
        focused,
        folders: workspacePaths(),
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
