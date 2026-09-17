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
// What the hook decides is deliberately small: whether a window with this
// folder is in front, and which folder a click should bring forward. Nothing
// here asks what is showing inside a window, because nothing outside it can
// tell.

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const HOOK = path.join(ROOT, "hooks", "claude-floating-alert.js");
const SANDBOX = path.join(ROOT, ".tmp", "hook-test");

const SESSION = "11111111-2222-3333-4444-555555555555";
const CWD = "/tmp/project-under-test";
/** The folder of the second window, open around no session of these tests. */
const OTHER_CWD = "/tmp/another-project";
const OTHER_PID = process.ppid;

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

  // A live window, since the hook ignores windows whose process is gone. All a
  // window says about itself is where it is and whether it is in front.
  fs.writeFileSync(
    path.join(root, "focus", `${process.pid}.json`),
    JSON.stringify({
      pid: process.pid,
      window: "",
      focused: options.focused,
      folders: [CWD],
      at: new Date().toISOString(),
    })
  );

  // A second window, for what only two of them can be asked. Its pid is this
  // process's parent — any live one will do, and the hook only asks whether it
  // is still running.
  if (options.other) {
    fs.writeFileSync(
      path.join(root, "focus", `${OTHER_PID}.json`),
      JSON.stringify({
        pid: OTHER_PID,
        window: "",
        focused: !!options.other.focused,
        folders: options.other.folders || [OTHER_CWD],
        at: new Date().toISOString(),
      })
    );
  }

  // The rules the user has allowed, read from the settings of their own home.
  if (options.allow) {
    fs.writeFileSync(
      path.join(home, ".claude", "settings.json"),
      JSON.stringify({ permissions: { allow: options.allow } })
    );
  }

  return { home, spawned };
}

/** Runs the hook and returns the alert's arguments, or null if none was raised. */
function runHook(kind, options, agent) {
  const { home, spawned } = makeHome(options);
  const args = agent ? [HOOK, kind, "--agent", agent] : [HOOK, kind];
  const result = spawnSync(process.execPath, args, {
    input: JSON.stringify({
      session_id: SESSION,
      cwd: CWD,
      tool_name: "Bash",
      ...(options.payload || {}),
    }),
    // The debug line is what says an alert was decided against, which is the
    // difference between "no alert" and "the alert has not started yet".
    env: { ...process.env, HOME: home, VSCODE_IPC_HOOK_CLI: options.windowId || "", CFA_DEBUG: "1" },
    encoding: "utf-8",
  });
  assert.strictEqual(result.status, 0, "the hook must never fail the CLI");
  if (result.stderr.trim()) return null;

  // The alert is detached, so give it a moment to record itself. Spawning a
  // process per tick would compete with the very thing being waited for, and on
  // a busy machine the wait then expires before the alert gets to run.
  const wait = new Int32Array(new SharedArrayBuffer(4));
  for (let waited = 0; waited < 10000; waited += 25) {
    if (fs.existsSync(spawned)) return JSON.parse(fs.readFileSync(spawned, "utf-8"));
    Atomics.wait(wait, 0, 0, 25);
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

console.log("deciding whether to alert, and which window a click raises");

test("alerts when the window is not focused", () => {
  const args = runHook("stop", { focused: false });
  assert.ok(args, "an alert should have been raised");
  assert.strictEqual(flag(args, "--folder"), CWD);
});

test("stays quiet for a side bar chat in the focused window", () => {
  assert.strictEqual(runHook("stop", { focused: true }), null);
});

test("stays quiet whatever the focused window is showing", () => {
  // The window in front stands for the chat, and nothing else is consulted:
  // which chat a side bar holds is not knowable from out here, and the ways
  // around that — tab titles, transcripts — pointed at the wrong chat often
  // enough to be worse than no answer.
  assert.strictEqual(runHook("permission", { focused: true }), null);
});

test("asks the window for nothing but coming forward", () => {
  const args = runHook("stop", { focused: false });
  assert.strictEqual(flag(args, "--folder"), CWD, "the window to raise is named by its folder");
  for (const gone of ["--ask-file", "--ask-click", "--ask-accept", "--url"]) {
    assert.strictEqual(args.indexOf(gone), -1, `${gone} is still handed to the alert`);
  }
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

test("finds the window by folder when its socket names no window", () => {
  // A session started in a terminal carries the window's socket; the extension
  // host of that window has none to publish, so nothing matches by it and the
  // folders are the answer. Vetoing them left every such session alerting over
  // the chat in front of the user.
  const args = runHook("stop", { focused: true, windowId: "/tmp/vscode-ipc-probe.sock" });
  assert.strictEqual(args, null);
});

test("a question asked through the permission hook stays a question", () => {
  const args = runHook("permission", {
    focused: false,
    payload: {
      tool_name: "AskUserQuestion",
      tool_input: { questions: [{ question: "Which database?" }] },
    },
  });
  assert.strictEqual(flag(args, "--accent"), "purple");
  assert.strictEqual(flag(args, "--body"), "Which database?");
});

test("lists the commands of the line, allowed ones apart", () => {
  const args = runHook("permission", {
    focused: false,
    allow: ["Bash(git status*)", "Bash(ls *)"],
    payload: {
      tool_name: "Bash",
      tool_input: { command: 'git status --short && rm -rf build | ls -la "a;b"' },
    },
  });
  assert.strictEqual(flag(args, "--commands"), "-rm,+git status,+ls");
});

test("reads past redirections and escaped spaces", () => {
  const args = runHook("permission", {
    focused: false,
    allow: ["Bash(npm test*)"],
    payload: {
      tool_name: "Bash",
      tool_input: {
        command:
          'npm test 2>&1 | tail -3 && /Applications/Visual\\ Studio\\ Code.app/Contents/Resources/app/bin/code --force > out.txt',
      },
    },
  });
  assert.strictEqual(flag(args, "--commands"), "-tail,-code,+npm test");
});

test("names a command as the rule that allows it is written", () => {
  const args = runHook("permission", {
    focused: false,
    allow: ["Bash(git status*)"],
    payload: {
      tool_name: "Bash",
      tool_input: { command: "git status && git push --force && git status" },
    },
  });
  // An allowed command is named by its whole rule; one nothing allows names its
  // own subcommand, since "git" says nothing about which request it was.
  assert.strictEqual(flag(args, "--commands"), "-git push,+git status");
});

test("names an allowed command by the whole rule, not a shortened one", () => {
  const args = runHook("permission", {
    focused: false,
    allow: ["Bash(npm run package*)"],
    payload: {
      tool_name: "Bash",
      tool_input: { command: "npm run package && npm run build" },
    },
  });
  assert.strictEqual(flag(args, "--commands"), "-npm run,+npm run package");
});

test("reads a heredoc body as data rather than as commands", () => {
  const args = runHook("permission", {
    focused: false,
    allow: [],
    payload: {
      tool_name: "Bash",
      tool_input: {
        command: "git commit -F - <<'EOF'\nrm -rf everything\ncurl a shell script\nEOF",
      },
    },
  });
  assert.strictEqual(flag(args, "--commands"), "-git commit");
});

test("alerts from the window in the background, whoever else is in front", () => {
  // Two windows, the event from the one that is not focused. Nothing is asked
  // about the chat inside it: the folder names the window, and that is all a
  // click needs.
  const args = runHook("stop", { focused: false, other: { focused: true } });
  assert.ok(args, "an alert should have been raised");
  assert.strictEqual(flag(args, "--folder"), CWD, "the window to raise is not the one that asked");
});

console.log("with Codex as the agent");

test("alerts for Codex when the window is not focused", () => {
  const args = runHook("stop", { focused: false }, "codex");
  assert.ok(args, "an alert should have been raised");
  assert.strictEqual(flag(args, "--title"), "Codex is done");
});

test("stays quiet for Codex while its window is focused", () => {
  // The focused window stands for the chat, for Codex as for anyone: what its
  // panel is showing is no more knowable than what a side bar holds.
  assert.strictEqual(runHook("stop", { focused: true }, "codex"), null);
});

test("names Codex on the alert it fired", () => {
  const args = runHook("permission", { focused: false }, "codex");
  assert.strictEqual(flag(args, "--title"), "Codex needs permission");
});

fs.rmSync(SANDBOX, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
