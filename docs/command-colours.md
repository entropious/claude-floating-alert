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
  is named the way that rule is written, whole: `Bash(npm run package*)` shows
  as `npm run package`. A rule cut short says less than it is, and `npm run`
  reads as a permission that does not exist.
- **Where nothing allows it,** the entry is the command and its subcommand where
  it has one — `git add`, `git commit`. One word says nothing about which
  request it was. Commands without subcommands name themselves: `rm`, `curl`.

## The colours

| | |
|---|---|
| red | not allowed by any rule |
| blue | allowed, and anything the list says nothing about |
| brackets, commas | the plain text colour |
| the tool's name | green when every entry is allowed, red when any is not |

The same colouring runs through the command below the list, on **the same words
the list names**: where the list says `git push`, both words are red in the line;
where it says `npm run package`, all three are blue. That is what makes the two
readable against each other — the eye finds the entry without reading the line.

A name used both ways — `git status` allowed beside a `git push` that is not —
keeps its own colour in each place, because the answer is looked up under the
name the list gave that command, not under its first word.

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
- The body of a heredoc is data, not commands, and is skipped whole. The label
  is taken from just after the `<<`, quoted or not; the body runs to a line
  holding the label alone. `<<-` with an indented terminator counts, and an
  unterminated one swallows the rest — which is what it does when run. The
  command it is fed to ends at it.
- A subcommand is looked for past the flags: `git -C .. push` is `git push`.

## Why it looks the way it does

- The list sits between the title and the command, with a gap under it: it is a
  line **about** the command, and without the gap the two read as one paragraph.
- The tool's name moved onto that line — `Bash: [...]` — so the command below
  starts with itself. Where there is no list, the name stays in front of the
  command as before.
