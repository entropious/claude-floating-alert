import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** Marker that identifies hook entries owned by this extension. */
const HOOK_SCRIPT_NAME = "claude-floating-alert.js";

export const CLAUDE_DIR = path.join(os.homedir(), ".claude");
export const SETTINGS_FILE = path.join(CLAUDE_DIR, "settings.json");
/** Stable install root: extension upgrades change extensionPath, this does not. */
export const INSTALL_DIR = path.join(CLAUDE_DIR, "floating-alert");
export const HOOK_SCRIPT = path.join(INSTALL_DIR, HOOK_SCRIPT_NAME);
export const BINARY = path.join(INSTALL_DIR, "bin", "claude-alert");
export const CONFIG_FILE = path.join(INSTALL_DIR, "config.json");
/** One file per live alert panel: which session and folder it belongs to. */
export const RUN_DIR = path.join(INSTALL_DIR, "run");
/** One file per VS Code window: its folders and whether it is focused. */
export const FOCUS_DIR = path.join(INSTALL_DIR, "focus");

interface HookEntry {
  type: string;
  command: string;
}
interface HookGroup {
  matcher?: string;
  hooks: HookEntry[];
}
type Settings = Record<string, any>;

/** event name in settings.json → [hook kind passed to the script, matcher] */
const WIRING: Array<{ event: string; kind: string; matcher?: string }> = [
  { event: "PermissionRequest", kind: "permission" },
  { event: "PreToolUse", kind: "question", matcher: "AskUserQuestion" },
  { event: "Stop", kind: "stop" },
];

function commandFor(kind: string): string {
  return `node "${HOOK_SCRIPT}" ${kind}`;
}

function isOurs(entry: HookEntry): boolean {
  return typeof entry?.command === "string" && entry.command.includes(HOOK_SCRIPT_NAME);
}

function readSettings(): Settings {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function writeSettings(settings: Settings): void {
  const backup = `${SETTINGS_FILE}.floating-alert.bak`;
  if (fs.existsSync(SETTINGS_FILE) && !fs.existsSync(backup)) {
    fs.copyFileSync(SETTINGS_FILE, backup);
  }
  fs.writeFileSync(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`);
}

export function hooksInstalled(): boolean {
  const hooks = readSettings().hooks as Record<string, HookGroup[]> | undefined;
  if (!hooks) return false;
  return Object.values(hooks).some((groups) =>
    (groups || []).some((group) => (group.hooks || []).some(isOurs))
  );
}

/**
 * Add our hook entries next to whatever is already wired up (Claude Notifier
 * and friends keep working — Claude Code runs every matching group).
 */
export function installHooks(): void {
  const settings = readSettings();
  const hooks: Record<string, HookGroup[]> = settings.hooks || {};

  for (const { event, kind, matcher } of WIRING) {
    const groups = hooks[event] || [];
    const cleaned = groups
      .map((group) => ({ ...group, hooks: (group.hooks || []).filter((h) => !isOurs(h)) }))
      .filter((group) => group.hooks.length > 0);
    cleaned.push({
      ...(matcher ? { matcher } : {}),
      hooks: [{ type: "command", command: commandFor(kind) }],
    });
    hooks[event] = cleaned;
  }

  settings.hooks = hooks;
  writeSettings(settings);
}

export function uninstallHooks(): void {
  const settings = readSettings();
  const hooks = settings.hooks as Record<string, HookGroup[]> | undefined;
  if (!hooks) return;

  for (const event of Object.keys(hooks)) {
    const groups = (hooks[event] || [])
      .map((group) => ({ ...group, hooks: (group.hooks || []).filter((h) => !isOurs(h)) }))
      .filter((group) => group.hooks.length > 0);
    if (groups.length > 0) {
      hooks[event] = groups;
    } else {
      delete hooks[event];
    }
  }

  if (Object.keys(hooks).length > 0) {
    settings.hooks = hooks;
  } else {
    delete settings.hooks;
  }
  writeSettings(settings);
}
