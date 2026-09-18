# ask-human

Your agent notifies you, asks questions, and reads your replies over a messaging channel you connect once by
running setup. One skill covers every channel; the available channels are listed under [Setup](#setup).
[SKILL.md](SKILL.md) is loaded by the agent and knows nothing channel-specific; this README and the channel guides
are for you.

## Requirements

- Node.js 22 or newer on the machine where the agent runs.
- Whatever the channel needs (app, account, network access) is listed in its guide under [Setup](#setup).

No npm install or build step is needed.

## Install

```sh
npx skills add wzshiming/ask-human-skills@ask-human -g
```

The [skills CLI](https://github.com/vercel-labs/skills) detects the agents installed on the machine, keeps one copy
at `~/.agents/skills/ask-human/` and symlinks it into the skills directory of each detected agent that reads
elsewhere, such as `~/.claude/skills/ask-human/`. `-g` installs for your user; without it the skill goes into the
current project. `-a <agent>` picks agents by hand, `npx skills update ask-human` upgrades later.
The CLI sends anonymous install telemetry; `DISABLE_TELEMETRY=1` turns it off.

Without `npx`, copy `skills/ask-human/` from a checkout into the skills directory your agent loads from, keeping the
folder name `ask-human` (`tests/` is not shipped), for example:

```sh
git clone --depth 1 https://github.com/wzshiming/ask-human-skills /tmp/ask-human-skills
mkdir -p ~/.claude/skills && cp -R /tmp/ask-human-skills/skills/ask-human ~/.claude/skills/
```

## Install via the agent

Or paste this into the agent's chat; it installs the skill and hands setup back to you.

```text
Install the ask-human skill: run `npx skills add wzshiming/ask-human-skills@ask-human -g -y`.
If npx is unavailable, clone https://github.com/wzshiming/ask-human-skills and copy only skills/ask-human/ into the
skills directory you load from, keeping the folder name ask-human/.
Do not run scripts/setup.mjs.
Do not read or write anything under ~/.config/ask-human (or ASK_HUMAN_DIR, if set) — setup is mine to run.
When done, print the path of the installed README.md and tell me to follow its Setup section in my own terminal.
```

## Setup

Setup is yours to run in your own terminal, once per channel you want; the agent must never run it, and no token
changes hands in chat. Pick a channel and follow its guide, which gives the exact command:

- [WeChat](channels/wechat.md)

The command is `node <skills-dir>/ask-human/scripts/setup.mjs <channel>` (`~/.agents/skills/ask-human/` after
`npx skills add -g`). Without a channel name it prints `ask-human: usage: setup.mjs CHANNEL — channels: ...`,
marking channels already `(configured)` and the `(active)` one, and exits `1`. The channel you set up last is the
one the agent uses. Let running inbox calls finish or stop them first: setup discards that channel's unread replies
before login, and a running agent process keeps the channel and pairing it started with, so it would go on
listening to the old one. Re-run setup whenever the agent reports `not configured`, `invalid configuration` or
`credentials expired or revoked`.

## Files

`ASK_HUMAN_DIR` defaults to `~/.config/ask-human`. `config.json` holds the active channel, `{"channel":"<channel>"}`,
written by setup after a successful run; each channel keeps its credentials in `<channel>.json` (mode `0600`; never
paste its contents into a chat) and its state in `<channel>/`. Setting up one channel leaves the others' files alone.
The channel guide lists the files, which of them may be deleted, and where received messages are kept.

## Parallel agent sessions

All agent sessions on the machine share one `ASK_HUMAN_DIR` and, per channel, one login; set up once.
The agent tells sessions apart by the `--title` it puts on every message and inbox call, so each session uses
a unique, stable title such as `<project>: <task>`. A reply that quotes a question goes to the session that
asked it; a message sent without quoting goes to the session that most recently started waiting. When several
questions are open, a question ends with `Reply by quoting this message; other questions are open.`: use your
app's quote/reply on the question you are answering. A quoted reply to a session that is not currently waiting
stays in that session's queue until it reads it.

A different `ASK_HUMAN_DIR` (another machine, or a deliberately separate conversation) needs its own setup run
with that variable set; the agent process must run with the same value:

```sh
ASK_HUMAN_DIR=~/.config/ask-human-b node ~/.agents/skills/ask-human/scripts/setup.mjs <channel>
```

Do not copy `<channel>.json` between directories; whether one login can serve several directories depends on the
channel, see its guide.

## Troubleshooting

- `ask-human: not configured` or `ask-human: invalid configuration` (exit `2`): run setup for a channel as described
  under [Setup](#setup). A credentials file left by an earlier install is not enough on its own.
- `ask-human: credentials expired or revoked` (exit `1`): run that channel's setup again.
- `ask-human: usage: setup.mjs CHANNEL` (exit `1`): add the channel name to the setup command.
- `ask-human: messaging service ...` (exit `1`): a request could not be completed. The scripts retry HTTP 429 within
  the call's budget; `inbox --wait` also retries transient failures. Other failures can return immediately. Check
  your network and the channel guide before retrying.
- The agent lost an answer, or reports a warning naming a preserved queue or recovery file: every received message
  is kept under `ASK_HUMAN_DIR`; the channel guide says where and how to recover it. There is no need to resend.
- You answered after the agent's wait had expired: quote the question if other sessions are open; the reply is
  queued for that title as soon as any inbox call polls and stays there until the agent runs `inbox` with the
  same title, so ask the agent to check its inbox rather than resending.
- The answer reached the wrong session: an unquoted message goes to the session that most recently started
  waiting; when several questions are open, answer each by quoting it.
