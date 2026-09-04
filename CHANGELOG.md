# Changelog

## 1.0.0

First release.

- Floating alerts above every window — full-screen apps and other Spaces
  included — for permission requests, `AskUserQuestion` and finished tasks.
- A click on an alert opens the project it came from; alerts for a window you
  are already looking at are skipped and dismissed.
- The status bar bell wires the hooks into `~/.claude/settings.json` and takes
  them out again, leaving hooks of other extensions alone.
- Per-kind switches and a timeout for the finished-task alert in the settings.
