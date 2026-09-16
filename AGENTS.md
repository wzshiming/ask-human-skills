# ask-human-skills

Agent skills that let an AI agent reach its human through a messaging channel, with two primitives: `notify` (agent → human) and `inbox` (human → agent). Asking a question is `notify` followed by `inbox --wait`; there is no separate `ask` script. One skill per channel (`telegram`, `slack`, `discord`, `email`, …). Each skill has two phases: a one-time interactive setup in which the human logs in / pairs the channel, and the runtime scripts the agent calls afterwards. There is no shared router — the agent loads a channel skill directly, so every skill must work on its own.

Everything in the repo is in English (docs, code, commits), regardless of the conversation language.

## Layout

```
skills/
└── <channel>/
    ├── SKILL.md          # name == folder; setup + runtime instructions for the agent
    ├── scripts/
    │   ├── setup.mjs     # interactive; the human runs it once
    │   ├── notify.mjs    # send a message to the human
    │   ├── inbox.mjs     # receive the human's messages; omit only if the channel cannot receive
    │   └── _lib.mjs      # optional helpers, private to this skill
    └── references/       # optional API notes, loaded on demand
tests/                    # node --test; not shipped with the skills
```

- A skill is installed by copying its `skills/<channel>/` folder alone. Never import across skills or from a repo-level module; duplicate small helpers instead.
- `name` is the bare channel name and must equal the folder name.
- A channel with no reply path (desktop notifications, push-only services) ships without `inbox.mjs` and says "notify only" in its `description`.

## Runtime

- Node.js ≥ 22, ESM `.mjs`, built-ins only (`fetch`, `WebSocket`, `node:fs`, `node:readline/promises`, `parseArgs` from `node:util`). No `package.json`, no `npm install`, no build step, no TypeScript.
- Invoke as `node <skill-dir>/scripts/<name>.mjs`; don't rely on the exec bit.
- Errors: one line on stderr, non-zero exit. Nothing on stdout except what `inbox` prints.

## Script contract (same for every channel)

| Script                                           | Input                               | Success                                                                          |
| ------------------------------------------------ | ----------------------------------- | -------------------------------------------------------------------------------- |
| `setup.mjs`                                      | interactive prompts                 | config written, test message delivered and answered, config path printed         |
| `notify.mjs [--title T] [--choice X]… [MESSAGE]` | `MESSAGE` arg, or stdin when absent | exit 0 once delivered                                                            |
| `inbox.mjs [--wait SEC]`                         | —                                   | unread messages from the human on stdout, oldest first, then marked read; exit 0 |

Exit codes: `0` ok · `1` usage or API failure · `2` not configured (stderr says to run `setup.mjs`) · `124` `--wait SEC` elapsed with nothing received.

- Input is plain UTF-8 text. The script does all channel escaping (Markdown, HTML, mrkdwn) so text containing `* _ [ ] < > &` arrives verbatim. Messages over the channel limit are split in order, never truncated.
- `--title` becomes the subject/header where the channel has one, otherwise the first line.
- `--choice X` (repeatable): rendered as buttons where supported, otherwise appended as a numbered list; a press shows up in the inbox as the label text.
- `inbox` without `--wait` returns at once, exit 0 even when empty. With `--wait` it returns as soon as something has arrived, after a ~2 s grace period so a burst of messages comes back together. Only messages from the identity captured at setup count; anyone else is ignored. Only text is received; a media message contributes its caption, if any.
- Output: one block per message, blocks separated by a `---` line. A block is a header `[YYYY-MM-DD HH:MM]` (local time), followed by ` re: "<first line of the message being replied to>"` when the human used reply/thread, then the text verbatim on the following lines.
- Channel extras (silent delivery, formatting, …) go in additional flags documented in that SKILL.md; never reuse the flags above with another meaning.

## Config, state and secrets

- `$ASK_HUMAN_DIR` (default `~/.config/ask-human`) holds `<channel>.json` — written by `setup.mjs` with mode `0600`, overwritten on re-run — and a state dir `<channel>/` for the read cursor, `poll.lock`, `history.log`, and whatever `notify` must record for `inbox` to quote replies.
- Setup captures both the credential and the human's identity (chat/user/channel id) — usually by having the human message the bot — then sends a test message and, where a reply path exists, waits for the human to answer it so `inbox` is verified too. `notify` talks only to that identity and `inbox` listens only to it.
- Only `setup.mjs` touches secrets, and the human types them into the terminal. Every SKILL.md must instruct the agent: on exit `2`, ask the human to run setup in their own terminal; never request tokens in chat, never read or write the config on the human's behalf.
- No real tokens, IDs or addresses anywhere in the repo, tests and examples included; use obvious placeholders.

## Receiving

- Asking is composed by the agent: `notify` the question, then `inbox --wait 600`. If the answer looks unfinished, call `inbox --wait` again — the human may send several messages. Drain the inbox after every answer and before reporting a task done, so a "stop" or "also do X" is never lost.
- One `$ASK_HUMAN_DIR` is one conversation: `inbox` hands every unread message to whichever process drains first, so agents sharing a dir steal each other's answers. Parallel sessions each get their own `$ASK_HUMAN_DIR`. Where the server tracks the read cursor (Telegram `getUpdates`) that means a separate bot per session; where reads don't consume (Slack `conversations.history`, Discord `messages?after=`, IMAP UID search) one credential can serve several dirs and machines — each then sees every message and uses the `re:` quote to skip what wasn't addressed to it, so SKILL.md asks the human to reply to the specific message when several are open. SKILL.md says which case applies.
- Concurrent `inbox` processes on one dir must not race the channel: hold `<channel>/poll.lock` (heartbeat; stale after 30 s, taken over atomically) while fetching and advancing the cursor, wait when it is held, and release it on SIGINT/SIGTERM.
- Advance the cursor only after the messages it covers have been written to stdout and appended to `<channel>/history.log` (same block format), so an interrupted `inbox` redelivers instead of dropping; output the agent lost is recovered from the tail of `history.log`. Rate limits and transient failures are the script's job, never the agent's: honor `429`/`Retry-After` and back off on network/5xx errors until the call's own deadline (`--wait SEC`; a bounded budget for `notify` and for `inbox` without `--wait`), so the agent only ever sees `0`, `124`, or a final `1` once that budget is spent.

## SKILL.md

```yaml
---
name: <channel>
description: "Ask the human a question and wait for the answer, send them a notification, or pick up messages they sent on their own, via <Channel>. Use when: blocked on a decision, approval of a risky step, or information only the human has; a long task finished or failed; checking for new instructions from the human; first-time <Channel> setup."
---
```

Quote the description (it contains colons), keep it ≤ 1024 chars and keep the "Use when:" triggers — it is all the agent sees before loading the skill. Required sections, in order:

- **Setup (once, by the human)** — the command, what it prompts for, where to get the credential.
- **Notify** — exact command; put the project or task in `--title` so the human can tell sessions apart.
- **Ask** — the `notify` + `inbox --wait` sequence; send one self-contained question (context, options, what happens if nobody answers); what to do on `124`.
- **Inbox** — exact command; drain after every answer and before reporting a task done.
- **Failure modes** — every exit code, not-configured handling, rate limits, and whether one credential can serve several sessions.

Paths inside SKILL.md are relative to the skill folder.

## Checks

- `make check` — `node --check` on every `skills/*/scripts/*.mjs`.
- `make test` — `node --test tests/`; mock `fetch` and point `$ASK_HUMAN_DIR` at a temp dir; tests never hit a real API or the real config.
- `make fmt` / `make fmt-check` — Prettier (pinned in the Makefile, run through `npx`; nothing is installed into the repo), config in `.prettierrc`. Format before committing; CI fails on unformatted files.
- CI (`.github/workflows/ci.yml`) runs `check` and `test` on Node 22 and the current LTS, and `fmt-check`, on every push to `master` and every pull request.
- Before landing a channel change, smoke-test `setup`, `notify` and `inbox --wait` against your own account and note the result in the PR.

## Adding a channel

1. Create `skills/<channel>/` with the layout above.
2. Implement the contract; verify escaping, splitting, `--choice`, the `re:` quote, `--wait` (including `124`) and every exit code.
3. Write SKILL.md as specified; confirm `name` equals the folder name.
4. Add tests under `tests/`, run `make all`, smoke-test for real.
5. One channel per PR. Commit subjects: `<channel>: <imperative summary>`; `repo:` for cross-cutting changes.
