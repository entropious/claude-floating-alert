# Working on this repository

A VS Code extension that puts an alert above every window when Claude Code or
Codex needs the user. macOS on Apple Silicon only — the alert is a Swift binary
shipped inside the `.vsix`.

## The three moving parts

| | |
|---|---|
| `src/` → `out/` | The extension. Publishes window focus, installs the hooks, handles the `vscode://` link a clicked alert opens. |
| `hooks/claude-floating-alert.js` | Runs as a hook of either agent, decides whether an alert is warranted, spawns it detached. Plain Node, no build step. |
| `native/ClaudeAlert.swift` → `bin/claude-alert` | The panel itself: `NSPanel` at `.screenSaver` level, `.accessory` policy. Built by `npm run build:native`. |

They meet in `~/.claude/floating-alert/`, which the extension fills on
activation: the hook script, the binary, `config.json` (settings mirrored for
the hook), `focus/<pid>.json` (one per window), `run/<session>.json` (one per
live alert). The path is stable across extension updates, which is the point.

## Two agents, one hook

Codex fires the same three events from `~/.codex/hooks.json`, in the same file
shape as `~/.claude/settings.json`, with a payload carrying the same
`session_id`, `cwd` and `tool_input`. Its registrations pass `--agent codex`,
and that argument is the only thing telling the two apart: it names the agent on
the alert and puts `agent=codex` in the link, which sends a click to the Codex
panel (`chatgpt.openSidebar`) instead of a Claude chat.

**Writing the file is not enough.** Codex keeps a hash of every hook it has been
shown and runs only the ones the user has trusted; a new or changed entry is
skipped in silence, with nothing in the logs to say so. Trust is granted in the
Codex UI (its panel → settings → Hooks) and nowhere else — the extension says so
once, right after wiring, and `.probe/devhost.sh codex` reports whether it has
been granted. Codex takes a flag to run untrusted hooks anyway; it defeats the
mechanism, and neither the extension nor the stand uses it.

Everything below about deciding whether the chat is watched is about Claude Code
alone. A Codex chat sits in a webview of another extension, and nothing reports
the session behind it, so `codexIsWatched` answers a coarser question — is the
Codex chat on screen at all — from three things:

1. **A chat tab.** Codex opens chats as editors too (`chatgpt.conversationEditor`
   on the `openai-codex` scheme), and the tab API sees those exactly.
2. **The chosen view container.** VS Code records which container each side bar
   is set to in the layout state of the window (`state.vscdb`, next to the
   extension storage `context.storageUri` points into), and writes it within a
   second of a change. Another container means the Codex panel is not showing.
3. **Window focus**, when neither of those is readable.

What no source gives is whether the side bar is open: the entry keeps naming the
last container while the bar is hidden, and `auxiliaryBar.hidden` is only written
when the window closes. A chat behind a closed side bar therefore counts as
watched. There is no API for this and no plan for one
(microsoft/vscode#321409), and the alternative — putting a view of our own into
the Codex container to watch its visibility — costs a permanent extra section in
someone else's panel and goes silent the moment it is collapsed.

There is also no surface to reveal on a click: `chatgpt.openSidebar` opens the
panel on whatever chat it was left on.

## The one hard question

Everything difficult here is one question: **is the user already looking at this
chat?** An alert that fires while they read the answer is noise; one that does
not fire when they are away is a missed turn.

Three sources answer it, in falling order of certainty:

1. **Surface reports** — `presence/<pid>.json`, if something is writing them.
   Each entry names a chat surface, the session behind it, whether it is a tab
   or the side bar, and whether it is on screen. Exact, per session.
2. **Tab labels** — `focus/<pid>.json` carries the chat tab titles of a window.
   `sessionMarks` reads the session transcript for the title Claude generated
   and the first user message, and `tabBelongs` matches those against the
   labels. Works without help, breaks when a tab is renamed.
3. **Window focus alone** — for a side bar chat with nothing else to go on, a
   focused window is taken to mean the chat is being watched.

`sessionIsWatched` walks exactly that order. **Every fallback must keep
working**: the reports are optional and absent for most users.

Where do reports come from? A locally patched Claude Code publishes them; the
patch is not part of this repository and cannot be assumed. Treat the format as
an interface: `{ session, kind: "tab"|"sidebar", id, chat, visible, active,
activeAt }`, `chat: false` meaning a surface that names a session without
showing it (the sessions list does that). A reader that finds no file, a dead
pid, or a field it does not know must fall through to 2 and 3.

## Rules learned the hard way

- **Never open a window.** `open -b <bundle> <folder>` creates one when no
  window has that folder open, so `windowFolder` returns `""` rather than a
  guess, and the binary then only activates the app.
- **Nested folders both match.** A session in `a/b` fits a window on `a` and a
  window on `a/b`; the closest folder wins, not the first one found.
- **A session can live in a tab and the side bar at once.** The link has to name
  the surface it was last worked in (`activeAt`), or a click lands in the wrong
  one.
- **Visibility is read at the moment of writing, never remembered.** A view
  restored with the window resolves hidden and no change event follows.
- **Hooks of other extensions are left alone**, and each hook file is backed up
  before the first change.
- **Codex is wired only where `~/.codex` exists.** Creating it for someone
  without Codex would leave a file nothing ever reads.

## Building and testing

```sh
npm run compile          # TypeScript
npm run build:native     # bin/claude-alert (needs the Xcode Command Line Tools)
npm run package          # → claude-floating-alert-darwin-arm64-<version>.vsix
npm test                 # hook logic in Node, then activation in a real host
```

`npm test` is two levels: `test/hook.test.js` drives the hook against staged
files, and `test/vscode/runTests.js` starts the installed VS Code as an
extension host with `HOME` pointed at a sandbox, so activation writes nowhere
real.

`CFA_DEBUG=1` makes the hook say why it stayed silent instead of leaving you to
guess.

## The debug stand

`.probe/devhost.sh` runs the extension in a real editor with its own profile and
its own folder, and drives it over CDP. Its own folder matters: an event is
attributed to the window that has that folder open, and with the repository root
the working window would answer instead of the stand.

```sh
bash .probe/devhost.sh deps            # put the installed Claude Code in the profile
bash .probe/devhost.sh start           # window with a clean profile, CDP on 9333
bash .probe/devhost.sh surfaces        # what Claude Code says about its chats
bash .probe/devhost.sh case watched    # chat on screen  → expect no alert
bash .probe/devhost.sh case hidden     # side bar hidden → expect an alert
bash .probe/devhost.sh case tab        # chat tab behind → expect an alert
bash .probe/devhost.sh case codex      # event from Codex, window focused or not
bash .probe/devhost.sh codex           # does Codex run our hooks, or is trust missing
```

Worth knowing before extending it:

- Palette commands need the focus out of the chat webview first — the stand
  clicks the status bar, because the middle of the window may be a chat tab and
  the text would end up in Claude's input.
- View containers (the sessions list) have no palette command; `bar <label>`
  clicks the activity bar icon instead.
- Panel contents live in a nested iframe, so `peek` and `click` search every
  frame of a webview target.
- An event is only attributed to a window that has focus, so the scenarios need
  the stand's window in front. `Page.bringToFront` raises it inside its own
  process but cannot activate that process in the system, and neither can `open`
  or `code` — they talk to the normal profile. What does work is that a freshly
  started window comes up active, so `raise` falls back to a restart, which the
  scenarios do anyway. **No scenario should ever ask the user to click.**

## Conventions

Comments explain the current behaviour and the reason behind a decision that
looks odd — never what the code used to do. Prose in commits and comments is
English; the debug stand under `.probe/` is Russian, matching how it is used.
