#!/usr/bin/env node
"use strict";

// Runs the hook the way Claude Code does — as a process, with the payload on
// stdin — against a throwaway home directory, and checks what it spawns.
//
// The alert binary is replaced with a script that records its arguments, so a
// test can tell whether an alert was raised and what link it carried without
// anything appearing on screen.
//
//   node test/hook.test.js
//
// The cases that matter here are the ones without a presence report: that is
// how the extension behaves wherever Claude Code is unpatched, and it has to
// keep working exactly as it did before presence existed.

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const HOOK = path.join(ROOT, "hooks", "claude-floating-alert.js");
const SANDBOX = path.join(ROOT, ".tmp", "hook-test");

const SESSION = "11111111-2222-3333-4444-555555555555";
const CWD = "/tmp/project-under-test";
const TAB_TITLE = "Fix the parser";

let failures = 0;

/** A home directory with the pieces the hook reads, and nothing else. */
function makeHome(options) {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  const home = path.join(SANDBOX, "home");
  const root = path.join(home, ".claude", "floating-alert");
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.mkdirSync(path.join(root, "focus"), { recursive: true });
  fs.mkdirSync(path.join(root, "run"), { recursive: true });

  // Stands in for the alert window: records its arguments and exits.
  const spawned = path.join(SANDBOX, "spawned.json");
  fs.writeFileSync(
    path.join(root, "bin", "claude-alert"),
    `#!/bin/sh\nnode -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))' ${spawned} "$@"\n`
  );
  fs.chmodSync(path.join(root, "bin", "claude-alert"), 0o755);

  // A live window, since the hook ignores windows whose process is gone.
  fs.writeFileSync(
    path.join(root, "focus", `${process.pid}.json`),
    JSON.stringify({
      pid: process.pid,
      window: "",
      focused: options.focused,
      folders: [CWD],
      chatTabs: options.chatTabs || [],
      activeChat: options.activeChat || "",
      at: new Date().toISOString(),
    })
  );

  if (options.presence) {
    const dir = path.join(root, "presence");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, folders: [CWD], surfaces: options.presence })
    );
  }

  // The transcript is what the tab-label fallback matches against.
  const projects = path.join(home, ".claude", "projects", CWD.replace(/[/.]/g, "-"));
  fs.mkdirSync(projects, { recursive: true });
  fs.writeFileSync(
    path.join(projects, `${SESSION}.jsonl`),
    JSON.stringify({ type: "user", message: { content: TAB_TITLE } }) + "\n"
  );

  return { home, spawned };
}

/** Runs the hook and returns the alert's arguments, or null if none was raised. */
function runHook(kind, options, agent) {
  const { home, spawned } = makeHome(options);
  const args = agent ? [HOOK, kind, "--agent", agent] : [HOOK, kind];
  const result = spawnSync(process.execPath, args, {
    input: JSON.stringify({ session_id: SESSION, cwd: CWD, tool_name: "Bash" }),
    env: { ...process.env, HOME: home, VSCODE_IPC_HOOK_CLI: "" },
    encoding: "utf-8",
  });
  assert.strictEqual(result.status, 0, "the hook must never fail the CLI");

  // The alert is detached, so give it a moment to record itself.
  for (let waited = 0; waited < 2000; waited += 25) {
    if (fs.existsSync(spawned)) return JSON.parse(fs.readFileSync(spawned, "utf-8"));
    spawnSync(process.execPath, ["-e", "setTimeout(()=>{},25)"]);
  }
  return null;
}

function flag(args, name) {
  const at = args.indexOf(name);
  return at === -1 ? null : args[at + 1];
}

function test(name, body) {
  try {
    body();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${name}\n      ${error.message}`);
  }
}

console.log("without a presence report");

test("alerts when the window is not focused", () => {
  const args = runHook("stop", { focused: false });
  assert.ok(args, "an alert should have been raised");
  assert.strictEqual(flag(args, "--folder"), CWD);
});

test("stays quiet for a side bar chat in the focused window", () => {
  assert.strictEqual(runHook("stop", { focused: true }), null);
});

test("alerts when the chat tab is not the one on top", () => {
  const args = runHook("permission", {
    focused: true,
    chatTabs: [TAB_TITLE],
    activeChat: "some other tab",
  });
  assert.ok(args, "an alert should have been raised");
  assert.match(flag(args, "--url"), /tab=1/, "the link should reveal the tab");
});

test("stays quiet when the chat tab is the one on top", () => {
  const args = runHook("permission", {
    focused: true,
    chatTabs: [TAB_TITLE],
    activeChat: TAB_TITLE,
  });
  assert.strictEqual(args, null);
});

test("links to the side bar when no tab holds the chat", () => {
  const args = runHook("stop", { focused: false });
  assert.match(flag(args, "--url"), /tab=0/);
});

test("raises no window of its own when nothing has the folder open", () => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  const home = path.join(SANDBOX, "home");
  const root = path.join(home, ".claude", "floating-alert");
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  const spawned = path.join(SANDBOX, "spawned.json");
  fs.writeFileSync(
    path.join(root, "bin", "claude-alert"),
    `#!/bin/sh\nnode -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))' ${spawned} "$@"\n`
  );
  fs.chmodSync(path.join(root, "bin", "claude-alert"), 0o755);

  spawnSync(process.execPath, [HOOK, "stop"], {
    input: JSON.stringify({ session_id: SESSION, cwd: CWD }),
    env: { ...process.env, HOME: home, VSCODE_IPC_HOOK_CLI: "" },
    encoding: "utf-8",
  });
  for (let waited = 0; waited < 2000; waited += 25) {
    if (fs.existsSync(spawned)) break;
    spawnSync(process.execPath, ["-e", "setTimeout(()=>{},25)"]);
  }
  const args = JSON.parse(fs.readFileSync(spawned, "utf-8"));
  assert.strictEqual(flag(args, "--folder"), "", "a folder no window has open would open a new one");
});

console.log("with a presence report");

test("stays quiet when the reported chat is visible", () => {
  const args = runHook("stop", {
    focused: true,
    presence: [{ session: SESSION, kind: "sidebar", chat: true, visible: true, activeAt: 2 }],
  });
  assert.strictEqual(args, null);
});

test("alerts when the reported chat is hidden", () => {
  const args = runHook("stop", {
    focused: true,
    presence: [{ session: SESSION, kind: "sidebar", chat: true, visible: false, activeAt: 2 }],
  });
  assert.ok(args, "a hidden chat is not one the user is looking at");
});

test("ignores the sessions list, which shows no chat", () => {
  const args = runHook("stop", {
    focused: true,
    presence: [{ session: SESSION, kind: "sidebar", chat: false, visible: true, activeAt: 2 }],
  });
  assert.ok(args, "the sessions list is not a chat on screen");
});

test("links to the surface the session was last worked in", () => {
  const args = runHook("stop", {
    focused: true,
    presence: [
      { session: SESSION, kind: "tab", chat: true, visible: false, activeAt: 1 },
      { session: SESSION, kind: "sidebar", chat: true, visible: false, activeAt: 9 },
    ],
  });
  assert.match(flag(args, "--url"), /tab=0/, "the side bar was the later of the two");
});

console.log("with Codex as the agent");

test("alerts for Codex when the window is not focused", () => {
  const args = runHook("stop", { focused: false }, "codex");
  assert.ok(args, "an alert should have been raised");
  assert.strictEqual(flag(args, "--title"), "Codex is done");
});

test("stays quiet for Codex while its window is focused", () => {
  // The chat sits in a panel nothing here can see into, so a focused window is
  // taken to mean the user is looking at it.
  assert.strictEqual(runHook("stop", { focused: true }, "codex"), null);
});

test("ignores the chat tabs of Claude Code when Codex fired", () => {
  const args = runHook("permission", { focused: false, chatTabs: [TAB_TITLE] }, "codex");
  assert.strictEqual(flag(args, "--title"), "Codex needs permission");
  const link = flag(args, "--url");
  assert.match(link, /agent=codex/, "the link has to name the agent to open the right panel");
  assert.doesNotMatch(link, /tab=/, "a Codex panel is opened by no tab flag");
});

fs.rmSync(SANDBOX, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
