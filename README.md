# Claude Floating Alert

When Claude Code needs an answer, it says so inside the VS Code window — which
is no help once you have switched to another app. This extension shows the same
event as a small alert drawn above every window, full-screen apps and other
Spaces included: permission requests, questions, and finished tasks. A click on
the alert brings up the project it came from.

macOS only, Apple Silicon.

## The three alerts

**Permission needed** — Claude wants to run a tool. Stays on screen until you
answer.

<img src="media/alert-permission.png" width="460" alt="Permission needed — Bash · rm -rf build">

**A question** — `AskUserQuestion` is waiting for your choice. Also stays until
you answer.

<img src="media/alert-question.png" width="460" alt="Claude asked a question — which database should the worker write to?">

**Task finished** — closes itself after three seconds.

<img src="media/alert-stop.png" width="460" alt="Claude is done — task finished, waiting for you">

The alert has no buttons: a click anywhere on it opens the matching folder in
VS Code and dismisses it. You never see one for a window you are already looking
at.

## How it works

1. On activation the extension copies the hook script and the alert binary into
   `~/.claude/floating-alert/` — a stable path that extension updates do not
   break.
2. The bell button in the status bar adds the hooks to `~/.claude/settings.json`
   or removes them. A backup `settings.json.floating-alert.bak` is written
   before the first change.
3. Claude Code runs `claude-floating-alert.js` on an event; the script spawns
   the alert as a detached process and exits immediately, so the CLI never
   blocks.
4. Every VS Code window publishes its focus state to
   `~/.claude/floating-alert/focus/<pid>.json`, and the hook writes live panel
   data to `run/<session>.json`. A window is matched to a session by
   `VSCODE_IPC_HOOK_CLI` — the window's unique socket, shared with the terminals
   it spawns — falling back to a folder match when the session was not started
   from a terminal. That way a window only ever dismisses its own alerts.

Three events are wired: `PermissionRequest`, `PreToolUse` (matcher
`AskUserQuestion`) and `Stop`. Hooks belonging to other extensions are left
untouched — Claude Code runs every matching group.

## What it reads, and what leaves your machine

Nothing leaves your machine. The extension makes no network calls of any kind:
there is no telemetry, no crash reporting, no update check.

Locally it reads two things. Claude Code hands the hook the event payload — the
tool name, the question text, the working directory. And to put the alert next
to the right editor tab, the hook opens the session transcript at
`~/.claude/projects/<project>/<session>.jsonl` and takes two values from it: the
title Claude generated for the session, and the first message you sent. Both are
compared against VS Code tab labels and then discarded. See
[`sessionMarks`](hooks/claude-floating-alert.js) for the exact code.

One thing worth knowing: the alert is drawn above every application, and it
shows the folder name plus the tool or question text. On a shared screen or a
recording, that is visible to everyone watching. Each alert kind has its own
switch in the settings if you would rather keep one of them off.

## Commands

- `Claude Floating Alert: Toggle Hooks` — same as the status bar bell
- `Claude Floating Alert: Show Test Alert`

## Settings

| Setting | Default | |
|---|---|---|
| `claudeFloatingAlert.permission.enabled` | `true` | Alert when Claude asks for permission |
| `claudeFloatingAlert.question.enabled` | `true` | Alert on `AskUserQuestion` |
| `claudeFloatingAlert.stop.enabled` | `true` | Alert when a task finishes |
| `claudeFloatingAlert.stop.timeout` | `3` | Seconds before the finished-task alert closes (`0` keeps it up) |

Permission and question alerts ignore the timeout: they stay until you answer
them or return to the window they came from.

## Development

```sh
npm install
npm run watch          # TypeScript
npm run build:native   # rebuild bin/claude-alert from the Swift source
npm run package        # → claude-floating-alert-darwin-arm64-1.0.0.vsix
```

Building the binary needs the Xcode Command Line Tools. Users do not — the
compiled binary ships inside the `.vsix`.

## License

MIT
