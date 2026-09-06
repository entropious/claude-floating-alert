# Working on this repository

A VS Code extension that puts an alert above every window when Claude Code needs
the user. macOS on Apple Silicon only — the alert is a Swift binary shipped
inside the `.vsix`.

## The three moving parts

| | |
|---|---|
| `src/` → `out/` | The extension. Publishes window focus, installs the hooks, handles the `vscode://` link a clicked alert opens. |
| `hooks/claude-floating-alert.js` | Runs as a Claude Code hook, decides whether an alert is warranted, spawns it detached. Plain Node, no build step. |
| `native/ClaudeAlert.swift` → `bin/claude-alert` | The panel itself: `NSPanel` at `.screenSaver` level, `.accessory` policy. Built by `npm run build:native`. |

They meet in `~/.claude/floating-alert/`, which the extension fills on
activation: the hook script, the binary, `config.json` (settings mirrored for
the hook), `focus/<pid>.json` (one per window), `run/<session>.json` (one per
live alert). The path is stable across extension updates, which is the point.

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
- **Hooks of other extensions are left alone**, and `~/.claude/settings.json` is
  backed up before the first change.

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
```

Worth knowing before extending it:

- Palette commands need the focus out of the chat webview first — the stand
  clicks the status bar, because the middle of the window may be a chat tab and
  the text would end up in Claude's input.
- View containers (the sessions list) have no palette command; `bar <label>`
  clicks the activity bar icon instead.
- Panel contents live in a nested iframe, so `peek` and `click` search every
  frame of a webview target.
- `Page.bringToFront` raises the window inside its own process, but cannot
  activate that process in the system — the stand waits for a click when the
  scenario needs real focus.

## Conventions

Comments explain the current behaviour and the reason behind a decision that
looks odd — never what the code used to do. Prose in commits and comments is
English; the debug stand under `.probe/` is Russian, matching how it is used.
