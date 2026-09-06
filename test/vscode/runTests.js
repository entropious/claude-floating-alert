#!/usr/bin/env node
"use strict";

// Runs the extension in a real extension host.
//
//   node test/vscode/runTests.js
//
// The host is the VS Code already installed on this machine, driven through its
// own `code` CLI with a private profile — nothing is downloaded, and a copy the
// system already trusts asks for no permissions. HOME points at a sandbox for
// the run, so activation writes its files there and the real ~/.claude is never
// touched. The sandbox starts with a Claude Code settings file holding someone
// else's hook, which the extension must leave in place.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..", "..");
const SANDBOX = path.join(ROOT, ".tmp", "vscode-test");
const REPORT = path.join(SANDBOX, "report.txt");

const CLI = [
  "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
  "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code",
].find((candidate) => fs.existsSync(candidate));

function makeSandbox() {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  const home = path.join(SANDBOX, "home");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });

  // The editor looks for the login keychain under HOME and stops to ask when it
  // is not there. Point it back at the real one: the run needs nothing from it,
  // it only needs the question not to be asked.
  fs.mkdirSync(path.join(home, "Library"), { recursive: true });
  try {
    fs.symlinkSync(
      path.join(process.env.HOME || "", "Library", "Keychains"),
      path.join(home, "Library", "Keychains")
    );
  } catch (e) {
    /* without it the editor may ask about the keychain, nothing worse */
  }
  fs.writeFileSync(
    path.join(home, ".claude", "settings.json"),
    JSON.stringify(
      {
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "node /opt/someone-elses-notifier.js" }] }],
        },
      },
      null,
      2
    )
  );
  return home;
}

function waitForReport(ms) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (fs.existsSync(REPORT)) {
        const report = fs.readFileSync(REPORT, "utf-8");
        // The first line lands before the tests run; wait for the verdict.
        if (/passed|failed/.test(report)) return resolve(report);
      }
      if (Date.now() - started > ms) return resolve(null);
      setTimeout(tick, 200);
    };
    tick();
  });
}

async function main() {
  if (!CLI) throw new Error("no VS Code installed to run the extension host in");
  const home = makeSandbox();

  const host = spawn(
    CLI,
    [
      `--extensionDevelopmentPath=${ROOT}`,
      `--extensionTestsPath=${path.join(__dirname, "index.js")}`,
      `--user-data-dir=${path.join(SANDBOX, "user-data")}`,
      `--extensions-dir=${path.join(SANDBOX, "extensions")}`,
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      "--disable-updates",
      // With HOME moved, the login keychain is not where the editor looks for
      // it, and it would stop to ask about that instead of running the tests.
      "--password-store=basic",
    ],
    { env: { ...process.env, HOME: home, CFA_TEST_REPORT: REPORT }, stdio: "ignore" }
  );

  const report = await waitForReport(120000);
  host.kill();

  if (report === null) {
    console.error("the host produced no report");
    process.exit(1);
  }
  process.stdout.write(report);
  process.exit(/failed/.test(report) ? 1 : 0);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
