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
live alert), `rules.json` (the allow rules of the settings files, parsed once) and
`log.jsonl` (one line per event, with what the decision was made on). The path
is stable across extension updates, which is the point.

What a `Bash` permission alert says about the command it carries — the list of
commands above it, what each is named, and what the colours mean — is spelled
out in [`docs/command-colours.md`](docs/command-colours.md).

## A click raises a window, and stops there

`open -b <bundle> <folder>`, and nothing else. What to show inside that window
is not decided here, because from out here it cannot be: no API says which chat
a side bar holds, and the ways around that — the titles of chat tabs, the view
container in the layout state, the session in a transcript — answered a question
nobody could check, and answered it wrong often enough to land a click in
someone else's chat.

Whoever lives inside the window can do better, having seen the request as it was
made, and that is where revealing a chat belongs. The panel takes `--report` and
says a press on standard output, so a caller that raised it can act on it.

## Two agents, one hook

Codex fires the same three events from `~/.codex/hooks.json`, in the same file
shape as `~/.claude/settings.json`, with a payload carrying the same
`session_id`, `cwd` and `tool_input`. Its registrations pass `--agent codex`,
and that argument is the only thing telling the two apart: it names the agent on
the alert. Everything past that is the same for both — the window is raised, and
what is inside it is its own business.

**Writing the file is not enough.** Codex keeps a hash of every hook it has been
shown and runs only the ones the user has trusted; a new or changed entry is
skipped in silence, with nothing in the logs to say so. Trust is granted in the
Codex UI (its panel → settings → Hooks) and nowhere else — the extension says so
once, right after wiring, and `.probe/devhost.sh codex` reports whether it has
been granted. Codex takes a flag to run untrusted hooks anyway; it defeats the
mechanism, and neither the extension nor the stand uses it.

## The one question

**Is the user already looking at this chat?** An alert that fires while they read
the answer is noise; one that does not fire when they are away is a missed turn.

The answer is a window, not a chat: `sessionIsWatched` asks whether a window
with this folder is in front, and nothing more. Everything finer was tried and
taken back out — surface reports from a patched Claude Code, chat tab titles
matched against the session transcript, the view container a side bar is set to.
Each was right most of the time and wrong in a way that could not be noticed
from here, and a click that lands in the wrong chat is worse than one that only
raises a window.

So the trade is stated plainly: **a chat in a background tab of a focused window
counts as watched**, and gets no alert. What a window publishes about itself is
just as small — `focus/<pid>.json` with its pid, socket, folders and focus.

Anything better belongs to whoever is inside the window: it sees the request as
it is made, knows which chat it came from, and can raise a panel of its own with
`--report`.

## Rules learned the hard way

- **Never open a window.** `open -b <bundle> <folder>` creates one when no
  window has that folder open, so `windowFolder` returns `""` rather than a
  guess, and the binary then only activates the app.
- **Nested folders both match.** A session in `a/b` fits a window on `a` and a
  window on `a/b`; the closest folder wins, not the first one found.
- **Which chat a window is showing is not knowable from out here.** Every way of
  working it out was tried and removed; do not bring one back without a way to
  tell when it is wrong.
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
