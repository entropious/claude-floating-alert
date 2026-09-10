# What a permission alert says about a command

A permission request for `Bash` carries a shell line, and the question it asks
is rarely about the whole of it: most of what it runs is routine, and one part
is not. The alert answers that first, above the line itself.

Everything below applies to `Bash` permission requests only. Other tools, other
kinds of event, and Codex keep the plain body they always had.

## The line above the command

    Bash: [rm, curl, git status, npm run]

- **What is listed.** Every command the line runs, in the order it runs them,
  without arguments. One entry per name; a repeat adds nothing.
- **The order.** What has not been allowed yet comes first, the allowed ones
  after. That first group is what the answer hangs on.
- **How an entry is named.** Where a rule in the settings allows it, the entry
  is named the way that rule is written, up to two words: `Bash(git status*)`
  shows as `git status`. Where nothing allows it, the entry is the command
  itself — `git`, whatever follows it.
- **What the two words mean.** The command and what narrows it. The rest of a
  rule is flags and paths, and those are in the line below.

## The colours

| | |
|---|---|
| red | not allowed by any rule |
| teal | allowed, and anything the list says nothing about |
| brackets, commas | the plain text colour |
| the tool's name | the plain text colour, and green when every entry is allowed |

The same colouring runs through the command below the list: the word a command
starts with is red where it is not allowed and teal where it is. A name that
stands for both — `git status` allowed beside `git push` that is not — is red in
the line: the colour there cannot tell two uses apart, and red is the honest
half. In the list they stay separate, `git` beside `git status`.

The rest of the highlighting is unchanged: options in the bright text colour,
quoted text green, variables purple, comments and the punctuation between
commands dimmed.

## Where "allowed" comes from

The four settings files Claude Code itself reads, in this order:

    ~/.claude/settings.json
    ~/.claude/settings.local.json
    <project>/.claude/settings.json
    <project>/.claude/settings.local.json

From each, the `permissions.allow` entries of the form `Bash(...)`. A rule
ending in `*` matches a command that starts with the rest of it; a rule without
one matches that command exactly. **The whole command is matched, not its
name** — `Bash(git status*)` says nothing about `git push`.

The rules are read and parsed once, not once per event: what they came to is
kept in `~/.claude/floating-alert/rules.json` beside the moment each file was
last written, and an event only checks those moments. A file that changed is
read again, the rest are not touched.

## How the line is taken apart

- Commands are separated by `|`, `&`, `;`, a newline, and brackets of either
  kind. A separator inside quotes belongs to an argument and is left alone.
- Variables set in front of a command — `NODE_ENV=production npm test` — are
  skipped; the command is what follows them.
- A command given by path is named by its last component: `/usr/bin/open` is
  `open`.

## Why it looks the way it does

- The list sits between the title and the command, with a gap under it: it is a
  line **about** the command, and without the gap the two read as one paragraph.
- The tool's name moved onto that line — `Bash: [...]` — so the command below
  starts with itself. Where there is no list, the name stays in front of the
  command as before.
