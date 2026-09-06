import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** Marker that identifies hook entries owned by this extension. */
const HOOK_SCRIPT_NAME = "claude-floating-alert.js";

export const CLAUDE_DIR = path.join(os.homedir(), ".claude");
export const SETTINGS_FILE = path.join(CLAUDE_DIR, "settings.json");
/** Codex keeps its hooks in a file of their own, in the same shape. */
export const CODEX_HOOKS_FILE = path.join(os.homedir(), ".codex", "hooks.json");
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

/**
 * Where an agent keeps its hooks. Claude Code shares one settings file with
 * everything else it is configured with, so its hooks live under a key of that
 * file; Codex has a file for hooks alone, in the very same shape.
 */
interface Agent {
  /** Passed to the hook script; a Claude Code registration passes nothing. */
  id: string;
  file: string;
  wiring: Array<{ event: string; kind: string; matcher?: string }>;
}

const AGENTS: Agent[] = [
  {
    id: "",
    file: SETTINGS_FILE,
    wiring: [
      { event: "PermissionRequest", kind: "permission" },
      { event: "PreToolUse", kind: "question", matcher: "AskUserQuestion" },
      { event: "Stop", kind: "stop" },
    ],
  },
  {
    id: "codex",
    file: CODEX_HOOKS_FILE,
    // Codex has no AskUserQuestion; the tool it asks with is request_user_input,
    // and the registration is harmless while that tool is still experimental —
    // an event that never fires runs nothing.
    wiring: [
      { event: "PermissionRequest", kind: "permission" },
      { event: "PreToolUse", kind: "question", matcher: "request_user_input" },
      { event: "Stop", kind: "stop" },
    ],
  },
];

function commandFor(kind: string, agent: string): string {
  return `node "${HOOK_SCRIPT}" ${kind}${agent ? ` --agent ${agent}` : ""}`;
}

function isOurs(entry: HookEntry): boolean {
  return typeof entry?.command === "string" && entry.command.includes(HOOK_SCRIPT_NAME);
}

function readFile(file: string): Settings {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return {};
  }
}

function writeFile(file: string, settings: Settings): void {
  const backup = `${file}.floating-alert.bak`;
  if (fs.existsSync(file) && !fs.existsSync(backup)) {
    fs.copyFileSync(file, backup);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
}

/** Wired for Claude Code is what the status bar reports: Codex follows it. */
export function hooksInstalled(): boolean {
  const hooks = readFile(SETTINGS_FILE).hooks as Record<string, HookGroup[]> | undefined;
  if (!hooks) return false;
  return Object.values(hooks).some((groups) =>
    (groups || []).some((group) => (group.hooks || []).some(isOurs))
  );
}

/**
 * Add our hook entries next to whatever is already wired up (Claude Notifier
 * and friends keep working — both agents run every matching group).
 *
 * Codex is only wired where it is already set up: creating `~/.codex` for
 * someone who has no Codex would leave a file behind that nothing reads.
 *
 * Returns whether Codex was among the agents written to, which the caller says
 * out loud: writing the file is not enough for Codex to run anything.
 */
export function installHooks(): { codex: boolean } {
  let codex = false;
  for (const agent of AGENTS) {
    if (agent.id && !fs.existsSync(path.dirname(agent.file))) continue;
    if (agent.id === "codex") codex = true;
    const settings = readFile(agent.file);
    const hooks: Record<string, HookGroup[]> = settings.hooks || {};

    for (const { event, kind, matcher } of agent.wiring) {
      const groups = hooks[event] || [];
      const cleaned = groups
        .map((group) => ({ ...group, hooks: (group.hooks || []).filter((h) => !isOurs(h)) }))
        .filter((group) => group.hooks.length > 0);
      cleaned.push({
        ...(matcher ? { matcher } : {}),
        hooks: [{ type: "command", command: commandFor(kind, agent.id) }],
      });
      hooks[event] = cleaned;
    }

    settings.hooks = hooks;
    writeFile(agent.file, settings);
  }
  return { codex };
}

export function uninstallHooks(): void {
  for (const agent of AGENTS) {
    if (!fs.existsSync(agent.file)) continue;
    const settings = readFile(agent.file);
    const hooks = settings.hooks as Record<string, HookGroup[]> | undefined;
    if (!hooks) continue;

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
    writeFile(agent.file, settings);
  }
}
