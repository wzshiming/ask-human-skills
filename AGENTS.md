# ask-human-skills

One agent skill, `skills/ask-human`, that lets an AI agent reach its human through a messaging channel, with two primitives: `notify` (agent → human) and `inbox` (human → agent). Asking a question is `notify` followed by `inbox --wait`; there is no separate `ask` script. Channels are adapters inside the skill (`wechat` today). The human runs the interactive setup once for the channel they want; the runtime scripts then talk to that one channel — no router, no fan-out, no per-call channel flag.

Everything in the repo is in English (docs, code, commits), regardless of the conversation language.

## Layout

```
skills/ask-human/
├── SKILL.md              # name == folder; runtime instructions for the agent
├── README.md             # for the human: requirements, install, setup walkthrough; not loaded with the skill
├── scripts/
│   ├── setup.mjs         # interactive; the human runs `setup.mjs CHANNEL` once per channel
│   ├── notify.mjs        # send a message to the human
│   ├── inbox.mjs         # receive the human's messages
│   ├── _lib.mjs          # channel-neutral core, imported by the CLIs and the adapters
│   ├── _<channel>.mjs    # one adapter per channel (_wechat.mjs)
│   └── _<helper>.mjs     # optional private helpers (_qr.mjs)
└── references/           # optional protocol notes per channel, loaded on demand
tests/                    # node --test; not shipped with the skill
```

- The skill is installed by copying `skills/ask-human/` alone — `npx skills add <owner>/<repo>@ask-human` does exactly that. Scripts import only their `./_*.mjs` siblings and Node built-ins; never the repo root or `tests/`.
- `name` is `ask-human` and must equal the folder name.
- `CHANNELS` in `_lib.mjs` is the registry: a channel exists once `_<channel>.mjs` implements the adapter contract and its name is listed there. Every channel receives as well as sends; notify-only channels and native buttons are unsupported until an adapter implements them and this file says so.

## Runtime

- Node.js ≥ 22, ESM `.mjs`, built-ins only (`fetch`, `node:fs`, `node:crypto`, `node:readline/promises`, `parseArgs` from `node:util`). No `package.json`, no `npm install`, no build step, no TypeScript.
- Invoke as `node <skill-dir>/scripts/<name>.mjs`; don't rely on the exec bit.
- `notify` and `inbox` read the active channel once at start from `$ASK_HUMAN_DIR/config.json` (`{"channel":"wechat"}`, written by setup). A missing or invalid pointer, or a `<channel>.json` that is absent or incomplete, is exit `2`; nothing is inferred from stray `<channel>.json` files and no older layout is read.
- Errors: one line on stderr prefixed `ask-human: `, non-zero exit. Recoverable queue corruption is quarantined with a one-line warning; valid messages can still exit 0. Nothing on stdout except what `inbox` prints and setup's interactive dialogue.

## Script contract

| Script                                           | Input                                  | Success                                                                                                                                                                                     |
| ------------------------------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setup.mjs CHANNEL`                              | channel name, then interactive prompts | channel state reset, login and pairing done, test message delivered and answered, `<channel>.json` and `config.json` written, `Config written to <path>; active channel: <channel>` printed |
| `notify.mjs [--title T] [--choice X]… [MESSAGE]` | `MESSAGE` arg, or stdin when absent    | exit 0 once delivered                                                                                                                                                                       |
| `inbox.mjs [--wait SEC] [--title T]`             | —                                      | unread messages for that title on stdout, oldest first, then marked read; exit 0                                                                                                            |

Exit codes: `0` ok · `1` usage (`setup.mjs` without a valid channel prints `usage: setup.mjs CHANNEL — channels: …` with `(configured)`/`(active)` markers; there is no interactive picker), storage or API failure · `2` not configured (stderr says `run: node <skill-dir>/scripts/setup.mjs <channel>`) · `124` `--wait SEC` elapsed with nothing received.

- Input is plain UTF-8 text. The adapter does whatever escaping its channel needs so text containing `* _ [ ] < > &` arrives verbatim. Messages over the adapter's `textLimit` are split in order at line/word boundaries, never truncated.
- `--title` becomes the first line of the message (no channel has a native subject yet). It is also the session key: the same single-line title on `notify` and `inbox` routes the human's replies to the session that asked; omitted on both, there is one untitled session.
- `--choice X` (repeatable): appended as a numbered list; the human answers with the number or the label, and SKILL.md tells the agent to accept both.
- `inbox` without `--wait` returns at once, exit 0 even when empty. With `--wait` it returns as soon as something has arrived for its title, after a ~2 s grace period so a burst of messages comes back together. Only messages from the identity captured at setup count; anyone else is ignored. Only text is received; a media message contributes its caption or transcript, if any.
- Output: one block per message, blocks separated by a `---` line. A block is a header `[YYYY-MM-DD HH:MM]` (local time), followed by ` re: "<first line of the message being replied to>"` when the human used reply/quote, then the text verbatim on the following lines.
- Channel extras go in additional flags documented in SKILL.md; never reuse the flags above with another meaning.

## Core and adapters

- `_lib.mjs` owns everything channel-neutral: `CHANNELS`, `useChannel`/`channel`, `activeChannel`, `paths`, config and state files, `request` (timeouts, `429`/`Retry-After` and deadline retries, token redaction), `formatOutgoing`/`splitText`/`send` (ordered chunk delivery), `formatInbox`, `poll.lock`/`queue.lock`, recovery batches, `history.log`, per-title routing and `drain`.
- An adapter `_<channel>.mjs` exports `label`, `textLimit` (UTF-16 code units per message), `configKeys` (each must be a non-empty string in `<channel>.json`, else exit `2`) and three functions:
  - `setup({ out, ask })` — logs in, captures the human's identity, sends the test message and waits for the reply, then returns the config object. The driver persists credentials and the active pointer after `setup` resolves and prints the config path; polling can write state during setup.
  - `send(cfg, state, chunk, { deadline })` — delivers one already-split chunk to the captured identity.
  - `fetch(cfg, state, { timeoutMs, deadline, since = 0 })` — returns `{ items: [{ time, from, text, re }], state }`: `time` in ms since the epoch, `text` verbatim, `re` the first line of the quoted message or `""`. Items older than `since` are dropped BEFORE the new `state` is derived, so a filtered pass still keeps the conversation context. `state` is opaque to the core (WeChat stores `cursor` and `contextToken`).
- Adapters own protocol escaping, identity filtering, conversation context, cursor handling and error mapping. Mark permanent failures (revoked token, HTTP `401`, iLink `-14`) with `fatal: true` on the `CliError` so `drain` fails at once instead of backing off; anything transient is thrown plainly and retried by the core within the deadline.
- Adapters import only `./_lib.mjs`, their own `./_<helper>.mjs` files and Node built-ins. Helpers may export extra functions for tests.

## Config, state and secrets

- `$ASK_HUMAN_DIR` (default `~/.config/ask-human`) holds `config.json` (the active-channel pointer), `<channel>.json` (credentials, mode `0600`, replaced on re-run) and a state dir `<channel>/` with `state.json` (opaque adapter state), `poll.lock`, `history.log`, `recovery/` and `sessions/<key>/` (the title, its queue of unread replies and the waiter marker).
- `setup.mjs CHANNEL` removes that channel's lock, sessions and recovery batches and empties its state BEFORE login; other channels' files are untouched. Credentials and the pointer are written only after the test reply arrived. There is no migration from earlier layouts: the human re-runs setup; the agent never writes config.
- Setup captures both the credential and the human's identity (chat/user/channel id) — usually by having the human message the bot — then sends a test message and waits for the human to answer it so `inbox` is verified too. `notify` talks only to that identity and `inbox` listens only to it.
- Only human-run setup captures or changes credentials; runtime scripts load them internally. SKILL.md must instruct the agent: on exit `2`, ask the human to run `setup.mjs <channel>` in their own terminal (walkthrough in README.md); never request tokens in chat or read or write the config directly.
- No real tokens, IDs or addresses anywhere in the repo, tests and examples included; use obvious placeholders.

## Receiving

- Asking is composed by the agent: `notify` the question, then `inbox --wait 14400` with the same `--title` (four hours is the recommended wait; the question announces the deadline and the default taken when nobody answers; the CLI imposes no upper cap). If the answer looks unfinished, call `inbox --wait` again — the human may send several messages. Drain the inbox (same title, no `--wait`) after every answer, before every `notify`, before reporting a task done, and again after a `124`, so a "stop", an "also do X" or a reply sent after the wait expired is never lost.
- Within one `$ASK_HUMAN_DIR`, each channel has one login and one polling `inbox` at a time serving every agent session on the machine; sessions are told apart by `--title` only, so each session uses a unique stable single-line title for both `notify` and `inbox`. The poller sorts each message into a per-title queue: a reply that quotes a message whose first line is a known title goes to that title, waiting or not; anything else goes to the most recently started waiting `inbox` (never the latest `notify`), or to the poller itself when nobody waits. While another session is waiting, `notify` appends a line asking the human to reply by quoting. A process keeps the channel it started with, so the docs tell the human to let waits finish before re-running setup or switching channels. Whether one credential may also serve several independent state directories depends on the channel: where reads consume server-side (iLink `getupdates`, unverified) do not share it; where they don't, one credential can serve several dirs, each using the `re:` quote to skip what wasn't addressed to it. SKILL.md says which case applies.
- Concurrent `inbox` processes on one dir must not race the channel: one holds `<channel>/poll.lock` (heartbeat; stale after 30 s) while fetching and advancing the cursor; verify ownership after takeover and before shared writes. The others read their own queue meanwhile, and without `--wait` exit 0 when it is empty and another inbox is polling. Queue contention respects the caller's deadline; no-wait uses a bounded budget and reports storage failure with exit 1, not 124. Release only owned locks and waiter markers on SIGINT/SIGTERM.
- Advance the cursor only after the messages it covers have been appended to `<channel>/history.log` (same block format) and either written to stdout or stored in their destination queue. Interrupted delivery may repeat a block; recover lost output from `history.log`. Preserve malformed queue records for recovery and warn instead of silently discarding them. Rate limits and transient failures are the script's job, never the agent's: honor `429`/`Retry-After` and back off on network/5xx errors until the call's own deadline (`--wait SEC`; a bounded budget for `notify` and for `inbox` without `--wait`), so the agent only ever sees `0`, `124`, or a final `1` once that budget is spent.

## SKILL.md

```yaml
---
name: ask-human
description: "Ask the human a question and wait for the answer, send them a notification, or pick up messages they sent on their own, over the messaging channel the human set up (currently WeChat). Use when: blocked on a decision, approval of a risky step, or information only the human has; a long task finished or failed; checking for new instructions from the human; first-time channel setup."
---
```

Quote the description (it contains colons), keep it ≤ 1024 chars, name the available channels and keep the "Use when:" triggers — it is all the agent sees before loading the skill. Required sections, in order:

- **Notify** — exact command; put the project or task in `--title` so the human can tell sessions apart, and reuse it for `inbox`.
- **Ask** — the `notify` + `inbox --wait` sequence under one title; send one self-contained question (context, options, what happens if nobody answers); what to do on `124`.
- **Inbox** — exact command; drain after every answer, before every `notify` and before reporting a task done.
- **Failure modes** — every exit code, rate limits, and per channel whether one login can serve several directories. On `2` (not configured) and on a first-time setup request: `node <skill-dir>/scripts/setup.mjs <channel>` run by the human in their own terminal, pointing to README.md; never run setup or read or write the config directly.

Paths inside SKILL.md are relative to the skill folder. SKILL.md carries only what the agent needs at runtime; prerequisites, install and the setup walkthrough live in README.md.

## README.md

For the human; not loaded with the skill. Required content: requirements (runtime, then per channel: app, network access); install with `npx skills add <owner>/<repo>@ask-human -g`, with copying the skill folder into the agent's skills directory as the fallback, plus an instruction the human can paste to the agent that installs the skill, forbids running setup or touching `$ASK_HUMAN_DIR`, and names the `setup.mjs <channel>` command to hand back; the setup walkthrough per channel, worded to match what the adapter prints, noting that `setup.mjs` without a channel lists them and exits `1`; the files under `$ASK_HUMAN_DIR`; parallel sessions (shared directory and login, unique titles, quoting when several questions are open); troubleshooting for the exit codes the human must act on. No agent instructions, no real tokens or IDs.

## Checks

- `make check` — `node --check` on every `skills/*/scripts/*.mjs`.
- `make test` — `node --test 'tests/*.test.mjs'` (a glob, not the directory: Node 22 and 24 reject a directory argument); mock `fetch` and point `$ASK_HUMAN_DIR` at a temp dir; tests never hit a real API or the real config.
- `make fmt` / `make fmt-check` — Prettier (pinned in the Makefile, run through `npx`; nothing is installed into the repo), config in `.prettierrc`. Format before committing; CI fails on unformatted files.
- CI (`.github/workflows/ci.yml`) runs `check` and `test` on Node 22 and the current LTS, and `fmt-check`, on every push to `master` and every pull request.
- Before landing a change to the core or an adapter, smoke-test `setup.mjs <channel>`, `notify` and `inbox --wait` against your own account and note the result in the PR.

## Adding a channel

1. Add `scripts/_<channel>.mjs` implementing the adapter exports above (private helpers as `scripts/_<helper>.mjs`) and append the name to `CHANNELS`.
2. Verify through the CLIs: escaping, splitting, `--choice`, the `re:` quote, title routing, `--wait` (including `124`), `fatal` errors and every exit code.
3. Add `tests/<channel>.test.mjs`; extend README.md (requirements, setup walkthrough, files, troubleshooting) and the Failure modes of SKILL.md where the channel differs; add `references/<channel>-<api>.md` only for protocol notes.
4. Run `make all`, smoke-test for real.
5. One channel per PR. Commit subjects: `<channel>: <imperative summary>` for adapter-only changes, `ask-human: …` for the core, CLIs or skill docs, `repo:` for cross-cutting changes.
