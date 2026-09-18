# wechat

Your agent notifies you, asks questions, and reads your replies over WeChat through a bot created by QR login
using the Tencent iLink bot API. [SKILL.md](SKILL.md) is loaded by the agent; this README is for you.

## Requirements

- Node.js 22 or newer on the machine where the agent runs.
- WeChat on your phone.
- Network access to `ilinkai.weixin.qq.com`.

No npm install or build step is needed.

## Install

```sh
npx skills add wzshiming/ask-human-skills@wechat -g
```

The [skills CLI](https://github.com/vercel-labs/skills) detects the agents installed on the machine, keeps one copy
at `~/.agents/skills/wechat/` and symlinks it into the skills directory of each detected agent that reads elsewhere,
such as `~/.claude/skills/wechat/`. `-g` installs for your user; without it the skill goes into the current project.
`-a <agent>` picks agents by hand, `npx skills update wechat` upgrades later.
The CLI sends anonymous install telemetry; `DISABLE_TELEMETRY=1` turns it off.

Without `npx`, copy `skills/wechat/` from a checkout into the skills directory your agent loads from, keeping the
folder name `wechat` (`tests/` is not shipped), for example:

```sh
git clone --depth 1 https://github.com/wzshiming/ask-human-skills /tmp/ask-human-skills
mkdir -p ~/.claude/skills && cp -R /tmp/ask-human-skills/skills/wechat ~/.claude/skills/
```

## Install via the agent

Or paste this into the agent's chat; it installs the skill and hands setup back to you.

```text
Install the wechat skill: run `npx skills add wzshiming/ask-human-skills@wechat -g -y`.
If npx is unavailable, clone https://github.com/wzshiming/ask-human-skills and copy only skills/wechat/ into the
skills directory you load from, keeping the folder name wechat/.
Do not run scripts/setup.mjs.
Do not read or write anything under ~/.config/ask-human (or ASK_HUMAN_DIR, if set) — setup is mine to run.
When done, print the exact `node <installed path>/scripts/setup.mjs` command for me to run in my own terminal.
```

## Setup (in your own terminal)

Run [scripts/setup.mjs](scripts/setup.mjs) yourself; the agent must never run it.
It asks for no token: QR login creates a bot bound to your WeChat account.

```sh
node ~/.agents/skills/wechat/scripts/setup.mjs
```

That is the path after `npx skills add -g`; with another install location use `<skills-dir>/wechat/scripts/setup.mjs`.

1. Setup prints a QR code and a fallback URL. If the terminal cannot render a scannable code,
   open the printed URL in a browser and scan the page. Login must finish within 8 minutes,
   otherwise setup exits with `wechat: login timed out` and has to be run again.
2. Scan with WeChat and confirm on your phone. WeChat may show a number; enter it in the terminal
   at the prompt `Enter the number shown in WeChat:`.
3. Setup prints `Logged in (bot <bot-id>).` and asks you to send the bot any message in WeChat.
   The bot appears as a new chat. Send it any message to identify yourself as the only person the scripts
   talk to and listen to; setup waits up to 10 minutes. Setup prints `Paired with WeChat user <user-id>.`.
4. Setup sends `ask-human: WeChat is connected. Reply to this message to finish setup.`
   Reply to that message in WeChat. Setup waits up to 10 minutes for your reply.
5. Setup prints `Reply received: <reply>`, then `Config written to <path>`, and exits.

Re-run setup any time to re-pair; it replaces the previous config, resets the local read cursor and clears the
per-title queues and recovery batches, so stop any running inbox calls first.
Also re-run it when the agent reports `wechat: bot token expired or revoked`.

## Files

`ASK_HUMAN_DIR` defaults to `~/.config/ask-human` and holds:

- `wechat.json`: bot token and your WeChat user id, created by setup with mode `0600`.
  Never paste its contents into a chat.
- `wechat/state.json`: read cursor and latest conversation token.
- `wechat/poll.lock`: held by the one inbox call that is polling WeChat for everyone.
- `wechat/history.log`: every message the agent received, in the same block format the agent sees.
  This is the recovery record if agent output was lost.
- `wechat/recovery/`: fetched batches awaiting distribution; the next poller resumes them before fetching again.
- `wechat/sessions/<key>/`: one folder per `--title` the agent has used: `title.json` (the title), `queue.jsonl`
  (replies routed to that title and not yet read; `queue.jsonl.<pid>` while a call is reading them),
  `waiter.json` (present while an inbox call is waiting) and `queue.lock` for the short local writes.
  Malformed records are kept in `queue.jsonl.corrupt.<random>`; a warning identifies the recovery file.

Delete `wechat/state.json` or `wechat/poll.lock` only when no inbox is running; they are rebuilt on the next call.
`wechat/sessions/` and `wechat/recovery/` hold unread replies; deleting them discards those replies.

## Parallel agent sessions

All agent sessions on the machine share one `ASK_HUMAN_DIR`, one QR login and one bot; set up once.
The agent tells sessions apart by the `--title` it puts on every message and inbox call, so each session uses
a unique, stable title such as `<project>: <task>`. A reply that quotes a question goes to the session that
asked it; a message sent without quoting goes to the session that most recently started waiting. When several
questions are open, a question ends with `Reply by quoting this message; other questions are open.`: use
WeChat's quote/reply on the question you are answering. A quoted reply to a session that is not currently waiting
stays in that session's queue until it reads it.

A different `ASK_HUMAN_DIR` (another machine, or a deliberately separate conversation) needs its own setup run
with that variable set; the agent process must run with the same value:

```sh
ASK_HUMAN_DIR=~/.config/ask-human-b node ~/.agents/skills/wechat/scripts/setup.mjs
```

Do not copy `wechat.json` between directories. Whether one login can serve several directories is unverified
because reading may consume the server-side cursor.

## Troubleshooting

- The agent reports exit `2` / not configured: run the setup command it printed in your own terminal.
- `bot token expired or revoked` (exit `1`): run setup again.
- QR not scannable in the terminal: open the printed URL in a browser and scan the page.
- The agent lost an answer: the tail of `history.log` has it; there is no need to resend.
- You answered after the agent's wait had expired: quote the question if other sessions are open; the reply is
  queued for that title as soon as any inbox call polls and stays there until the agent runs `inbox` with the
  same title, so ask the agent to check its inbox rather than resending. Whether WeChat keeps messages for the
  bot while nobody is polling is unverified.
- The answer reached the wrong session: an unquoted message goes to the session that most recently started
  waiting; when several questions are open, answer each by quoting it.
