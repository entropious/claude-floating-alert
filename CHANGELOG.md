# Changelog

## 2.0.2

- Weight survives the markup: a caller can hand over bold text — command names,
  say — and it is drawn bold. The panel still sets the size itself.
- How tall the text will be is measured on what will be drawn rather than on the
  plain copy of it, so the arrow that unfolds a long command appears where a
  caller hands the line over as markup only.

## 2.0.1

- Text handed over already coloured is set a couple of points larger than plain
  text: 14 for the command, 15 for the list above it. It is the thing the alert
  is read for, and colours help only once the words are legible.

## 2.0.0

- A click brings the window forward and stops there. Which chat to show inside
  it is no longer worked out here: a side bar is closed to every API, and the
  ways around that — the titles of chat tabs matched against session
  transcripts, the view container in the layout state, reports of what is on
  screen — pointed at the wrong chat often enough to be worse than not pointing
  at all. Gone with them: the `ask/<pid>.json` channel, the `vscode://` link and
  the answer button, which needed that channel to answer anything.
- The alert stays down only while a window with that folder is in front. A chat
  in a background tab of a focused window therefore counts as watched and raises
  nothing — the trade for never landing a click in someone else's chat.
- A window publishes only its pid, socket, folders and focus. Chat tab titles,
  the layout state and the rest are not read at all, and session transcripts are
  never opened.
- Codex is decided the same way, by the window in front; its panel and tabs are
  no longer inspected either.

## 1.8.0

- The panel draws text it is handed already coloured: `--body-html` for the
  command and `--commands-html` for the list above it. It understands no shell
  grammar and no editor theme, so a caller that reads the line properly — with
  a shell grammar, against the palette of the active theme — can hand over
  marked-up text instead. Only the colours are taken from the markup; the type
  sizes stay the panel's own.
- With `--report`, what was pressed is said on standard output as well as left
  in a file. A caller that started the panel itself then needs nothing arranged:
  the answer comes back down the pipe it already holds, and no window has to
  watch a directory for it.

## 1.7.4

- A click goes to the window holding the chat, whatever folder the session is
  working in. `cd` inside a chat moves its working directory, and the click then
  went to whichever window had that folder open.
- A window that was merely told about a session no longer answers for it: it
  took clicks meant for the window showing the chat, and, while focused, passed
  for the chat being watched — so no alert appeared at all.

## 1.7.3

- The alert draws on a solid background. Blended with the window behind it, the
  body text and the colours of the commands were unreadable over a light editor.

## 1.3.0

- An alert that waits for an answer — a permission request or a question — now
  has a close button. Until now the only way to get rid of one was to click it,
  and a click goes to the chat; the button dismisses the panel and leaves the
  chat where it is. Alerts that fade on their own carry no button.

## 1.2.1

- No more alert over the chat being answered in. A surface report that never
  mentions a session used to count as proof the chat is not on screen; it is
  only ever proof about the surfaces it names, so an unmentioned session now
  falls back to the tabs and the window.
- The fallback no longer mistakes a side bar chat for a tab in the background:
  a session whose transcript cannot be read has no marks to match tab labels
  against, and a tab still carrying the default label is no longer taken for
  it. A click aims at the side bar in that case rather than at a stranger's tab.

## 1.2.0

- Codex raises the same alerts. Its hooks go into `~/.codex/hooks.json` — where
  Codex is set up — next to whatever is already wired there, and the alert says
  which of the two agents is waiting. A click opens the Codex panel, which
  returns to the chat it was left on.
- A Codex alert is skipped only while its chat is on screen: its own editor tab,
  or the panel the side bar is set to. A side bar closed altogether is the one
  case that still counts as watched — nothing reports it.
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
