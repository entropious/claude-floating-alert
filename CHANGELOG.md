# Changelog

## Unreleased

- Codex raises the same alerts. Its hooks go into `~/.codex/hooks.json` — where
  Codex is set up — next to whatever is already wired there, and the alert says
  which of the two agents is waiting. A click opens the Codex panel; the chat
  inside it is beyond reach, so a focused window counts as a chat being watched.
- Codex runs a hook only once it is trusted, and skips an untrusted one without
  a word, so the wiring is followed by a notice saying where that is granted.
- The per-kind switches are gone. The bell in the status bar turns every alert
  on and off, and `claudeFloatingAlert.stop.timeout` is the only setting left.

## 1.1.2

- A session in a nested folder raises the window closest around it. With the
  same folder open in two windows — a sub-project, a worktree — the alert used
  to pick whichever window listed it first.
- `CFA_DEBUG=1` makes the hook report why it produced no alert.

## 1.1.1

- A clicked alert opens the chat where the session was last worked in. A session
  open in a tab and in the side bar at once used to raise the tab, even when it
  sat behind other tabs and the side bar was the one being used.
- The sessions list no longer counts as a chat on screen: it names a session
  without ever showing it.

## 1.1.0

- A chat that is not on screen no longer counts as watched. Where a Claude Code
  patched with a presence payload reports its chat surfaces, the session behind
  each one is known by id, so an alert is skipped only when that very chat is
  visible — a side bar showing another view, or a chat tab behind other tabs, is
  not. Without such a report everything works as before.
- The window a clicked alert raises is picked by the session it holds, falling
  back to a folder match.

## 1.0.0

First release.

- Floating alerts above every window — full-screen apps and other Spaces
  included — for permission requests, `AskUserQuestion` and finished tasks.
- A click on an alert opens the project it came from; alerts for a window you
  are already looking at are skipped and dismissed.
- The status bar bell wires the hooks into `~/.claude/settings.json` and takes
  them out again, leaving hooks of other extensions alone.
- Per-kind switches and a timeout for the finished-task alert in the settings.
