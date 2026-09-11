"use strict";

// Runs inside a real extension host: VS Code loads the extension from source
// and hands control here. HOME points at a sandbox for the duration, so the
// activation writes its files there and never touches the real ~/.claude.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vscode = require("vscode");

const ID = "entro.claude-floating-alert";

// Proof that the host reached this file at all, replaced by the report itself.
try {
  if (process.env.CFA_TEST_REPORT) fs.writeFileSync(process.env.CFA_TEST_REPORT, "loaded, but run() never finished\n");
} catch (e) {
  /* nothing to report to */
}
const ROOT = path.join(os.homedir(), ".claude", "floating-alert");

function until(predicate, ms) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (predicate() || Date.now() - started > ms) return resolve(predicate());
      setTimeout(tick, 50);
    };
    tick();
  });
}

async function run() {
  // The host's console does not reach the terminal, so the report is a file
  // the runner prints once VS Code is gone.
  const lines = [];
  const say = (line) => {
    lines.push(line);
    if (process.env.CFA_TEST_REPORT) fs.writeFileSync(process.env.CFA_TEST_REPORT, lines.join("\n") + "\n");
  };

  const failures = [];
  const check = async (name, body) => {
    try {
      await body();
      say(`  ok  ${name}`);
    } catch (error) {
      failures.push(name);
      say(`FAIL  ${name}\n      ${error.message}`);
    }
  };

  const extension = vscode.extensions.getExtension(ID);
  if (!extension) {
    say(`FAIL  ${ID} was not loaded by the host`);
    throw new Error(`${ID} was not loaded by the host`);
  }
  await extension.activate();

  await check("activates", () => {
    assert.ok(extension.isActive);
  });

  await check("publishes the focus state of this window", async () => {
    const file = path.join(ROOT, "focus", `${process.pid}.json`);
    await until(() => fs.existsSync(file), 5000);
    const state = JSON.parse(fs.readFileSync(file, "utf-8"));
    assert.strictEqual(state.pid, process.pid);
    assert.ok(Array.isArray(state.folders), "folders should be published");
    assert.ok("focused" in state, "focus should be published");
  });

  await check("installs the alert binary, executable", () => {
    const binary = path.join(ROOT, "bin", "claude-alert");
    assert.ok(fs.existsSync(binary), "the binary should be copied out of the package");
    assert.ok(fs.statSync(binary).mode & 0o111, "the binary should be executable");
  });

  await check("installs the hook script, executable", () => {
    const hook = path.join(ROOT, "claude-floating-alert.js");
    assert.ok(fs.existsSync(hook));
    assert.ok(fs.statSync(hook).mode & 0o111);
  });

  await check("mirrors the settings into the config the hook reads", () => {
    const config = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf-8"));
    assert.strictEqual(config.stop.timeout, 3, "the declared default should come through");
  });

  await check("wires its hooks into the Claude Code settings", () => {
    const settings = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude", "settings.json"), "utf-8"));
    const wired = [];
    for (const [event, groups] of Object.entries(settings.hooks || {})) {
      for (const group of groups) {
        for (const hook of group.hooks || []) {
          if (String(hook.command).includes("floating-alert")) wired.push(event);
        }
      }
    }
    for (const event of ["Stop", "PermissionRequest", "PreToolUse"]) {
      assert.ok(wired.includes(event), `${event} should be wired`);
    }
  });

  await check("wires its hooks into the Codex hooks file too", () => {
    const settings = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".codex", "hooks.json"), "utf-8"));
    const ours = Object.entries(settings.hooks || {}).flatMap(([event, groups]) =>
      groups.flatMap((group) => (group.hooks || []).filter((hook) => String(hook.command).includes("floating-alert")).map(() => event))
    );
    for (const event of ["Stop", "PermissionRequest", "PreToolUse"]) {
      assert.ok(ours.includes(event), `${event} should be wired for Codex`);
    }
    const commands = Object.values(settings.hooks)
      .flat()
      .flatMap((group) => group.hooks || [])
      .map((hook) => String(hook.command))
      .filter((command) => command.includes("floating-alert"));
    assert.ok(
      commands.every((command) => command.includes("--agent codex")),
      "a Codex registration has to say so, or the alert speaks of Claude"
    );
    const stop = settings.hooks.Stop.flatMap((group) => group.hooks || []);
    assert.ok(
      stop.some((hook) => String(hook.command).includes("someone-elses-notifier")),
      "the Codex hook planted before activation should still be there"
    );
  });

  await check("leaves hooks of other extensions alone", () => {
    const settings = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude", "settings.json"), "utf-8"));
    const stop = settings.hooks.Stop.flatMap((group) => group.hooks || []);
    assert.ok(
      stop.some((hook) => String(hook.command).includes("someone-elses-notifier")),
      "the hook planted before activation should still be there"
    );
  });

  await check("registers its commands", async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("claudeFloatingAlert.toggleHooks"));
    assert.ok(commands.includes("claudeFloatingAlert.test"));
    assert.ok(commands.includes("claudeFloatingAlert.showLog"));
  });

  // What a clicked alert leaves for this window, and what becomes of it.
  const askFile = path.join(ROOT, "ask", `${process.pid}.json`);
  const leaveAsk = (text) => {
    // The panel that leaves a request was raised by the hook, and the hook says
    // so next door — which is what tells the window to start looking out for
    // one. Writing only the request would be a panel nobody raised.
    fs.mkdirSync(path.join(ROOT, "run"), { recursive: true });
    fs.writeFileSync(
      path.join(ROOT, "run", "test-session.json"),
      JSON.stringify({ pid: process.pid, cwd: os.tmpdir(), kind: "permission" })
    );
    fs.mkdirSync(path.dirname(askFile), { recursive: true });
    fs.writeFileSync(askFile, text);
  };

  await check("takes the request a clicked alert leaves", async () => {
    leaveAsk(JSON.stringify({ action: "accept" }));
    assert.ok(await until(() => !fs.existsSync(askFile), 5000), "the request should be taken");
  });

  await check("says on an alert of its own when the answer would not run", async () => {
    const log = path.join(ROOT, "log.jsonl");
    const before = fs.existsSync(log) ? fs.readFileSync(log, "utf-8") : "";
    leaveAsk(JSON.stringify({ action: "accept" }));
    await until(() => !fs.existsSync(askFile), 5000);
    const written = await until(() => {
      const now = fs.existsSync(log) ? fs.readFileSync(log, "utf-8") : "";
      return now.length > before.length && now.slice(before.length).includes('"ask":"accept"');
    }, 5000);
    assert.ok(written, "the attempt should be written down");
    const line = JSON.parse(fs.readFileSync(log, "utf-8").trim().split("\n").pop());
    // Nothing here answers requests in a chat, so the command is missing — and
    // that is the case the user is told about.
    assert.strictEqual(line.ran, false, "a missing command is not a run one");
  });

  await check("leaves a half-written request alone until it is whole", async () => {
    leaveAsk('{"action": "acce');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.ok(fs.existsSync(askFile), "an unreadable request must not be thrown away");
    leaveAsk(JSON.stringify({ action: "accept" }));
    assert.ok(await until(() => !fs.existsSync(askFile), 5000), "and taken once it is whole");
  });

  await check("takes its hooks back out again, from both agents", async () => {
    await vscode.commands.executeCommand("claudeFloatingAlert.toggleHooks");
    for (const file of [
      path.join(os.homedir(), ".claude", "settings.json"),
      path.join(os.homedir(), ".codex", "hooks.json"),
    ]) {
      const settings = JSON.parse(fs.readFileSync(file, "utf-8"));
      const mine = Object.values(settings.hooks || {})
        .flat()
        .flatMap((group) => group.hooks || [])
        .filter((hook) => String(hook.command).includes("floating-alert"));
      assert.strictEqual(mine.length, 0, `the toggle should clear ${path.basename(file)}`);
    }
  });

  // The alerts these checks caused are real panels, and the ones that wait for
  // an answer wait for ever. They came from the sandbox copy of the binary,
  // which is what names them here.
  //
  // Twice, a moment apart: a panel is started detached, and one asked for just
  // now may not be running yet when the first sweep goes through.
  for (const wait of [300, 1200]) {
    await new Promise((resolve) => setTimeout(resolve, wait));
    try {
      require("child_process").execFileSync("pkill", ["-f", path.join(ROOT, "bin", "claude-alert")]);
    } catch (e) {
      /* none left on screen */
    }
  }

  say(failures.length ? `\n${failures.length} failed` : "\nall passed");
  if (failures.length) throw new Error(`${failures.length} extension host test(s) failed`);
}

module.exports = { run };
