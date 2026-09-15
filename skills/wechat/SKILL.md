---
name: wechat
description: "Ask the human a question and wait for the answer, send them a notification, or pick up messages they sent on their own, via WeChat (Weixin; ask-human-on-wechat). Use when: blocked on a decision, approval of a risky step, or information only the human has; a long task finished or failed; checking for new instructions from the human; first-time WeChat setup."
---

## Setup (once, by the human)

Require Node.js >= 22, WeChat on the human's phone, and network access to
`ilinkai.weixin.qq.com`. Resolve all commands relative to this skill folder.
Ask the human to run this in their OWN terminal:

```sh
node scripts/setup.mjs
```

Never run setup as the agent, handle credentials, request tokens in chat, or
read or write the config on the human's behalf.

1. Setup prints a QR code in the terminal and the same link as a fallback URL if the terminal cannot render it.
2. Scan it with WeChat and confirm on the phone. WeChat may show a number to type back into the terminal.
3. Send the new bot chat any message. This identifies the WeChat user to contact; only that user is heard afterwards.
4. Setup sends a test message. Reply to it to verify receiving.
5. Setup prints the config path.

There is no token to obtain: QR login creates a bot bound to the scanning
WeChat account and stores its token in `$ASK_HUMAN_DIR/wechat.json`
(default `~/.config/ask-human/wechat.json`, mode `0600`). Re-running setup replaces it.
State lives in `$ASK_HUMAN_DIR/wechat/`: read cursor and latest conversation
token (`state.json`), `poll.lock`, and `history.log`. Deleting `state.json` or
`poll.lock` is safe; they are rebuilt on the next call.

## Notify

```sh
node scripts/notify.mjs --title "<project>: <task>" "<message>"
```

Put the project or task in `--title` so the human can distinguish sessions.
It becomes the first line; WeChat has no subject.
Supply the message as an argument, or on stdin when the argument is absent.
Repeat `--choice "<label>"` to append a numbered list; WeChat has no buttons.
Text is sent as plain text exactly as given: `* _ [ ] < > &` need no escaping.
Messages longer than 4000 characters are split at line/word boundaries
(hard-split when neither exists) and delivered in order, never truncated.
Exit `0` means every part was delivered.

## Ask

Send ONE self-contained question: context, options, and what happens if nobody answers.

```sh
node scripts/notify.mjs --title "<project>: <task>" --choice "Proceed" --choice "Pause" "Validation passed. Proceed with the next step or pause? Without an answer in 3600 seconds, I will pause."
node scripts/inbox.mjs --wait 3600
```

Accept either the number or the label as an answer to a numbered list.
If the answer looks unfinished, call `inbox --wait` again; the human may send
several messages. Drain the inbox after every answer.
On exit `124`, either wait again with a longer `--wait`, or follow the default
announced in the question and notify the human of what you did.

## Inbox

```sh
node scripts/inbox.mjs
node scripts/inbox.mjs --wait SEC
```

Without `--wait`, return at once, exit `0` even when empty.
With `--wait`, return as soon as something arrives, after a roughly 2-second
grace period to collect a burst; exit `124` if nothing arrived within the wait.
Print unread messages oldest first, then mark them read.
Each message is one block; separate blocks with a `---` line:

```text
[YYYY-MM-DD HH:MM] re: "<first line of the quoted message>"
<message text>
---
[YYYY-MM-DD HH:MM]
<message text>
```

Timestamps use local time. Include ` re: "..."` only when the human used
WeChat's quote/reply on a message; print message text verbatim below the header.
Receive only text: voice contributes its transcript if WeChat provides one;
an image or file contributes its caption, if any. Ignore everyone except the user captured at setup.
Drain the inbox after every answer and before reporting a task done, so a
"stop" or "also do X" is never lost.

Every block printed is also appended to `$ASK_HUMAN_DIR/wechat/history.log`
(same format), and the read cursor advances only after a block was written, so
an interrupted call redelivers instead of dropping. If an `inbox` output was
lost, read the tail of `history.log`; do not ask the human to repeat.
`ASK_HUMAN_DEBUG=1` dumps the raw messages to stderr for protocol debugging.

## Failure modes

| Exit | Meaning and action |
| --- | --- |
| `0` | Success, including an empty inbox without `--wait`. |
| `1` | Usage error or API failure; stderr is one line starting `wechat: `. Report the error. |
| `2` | Not configured. Ask the human to run `node scripts/setup.mjs` in their own terminal. Never request tokens in chat or read/write the config yourself. |
| `124` | `--wait` elapsed with nothing received. Wait again or use the announced default and send a follow-up notification. |

On `wechat: bot token expired or revoked — run setup.mjs again` (exit `1`),
ask the human to re-run setup in their own terminal.
Rate limits and transient failures are handled inside the scripts, never by
you: HTTP `429` is retried honoring `Retry-After`, and network or `5xx` errors
during `--wait` are retried with backoff, both until the call's own deadline
(`--wait SEC`; about 30 s for `notify` and for `inbox` without `--wait`). Only
then do you see exit `1`, or `124` when nothing arrived meanwhile.
Concurrent inbox processes in one `$ASK_HUMAN_DIR` share `wechat/poll.lock`:
the second waits; the lock has a heartbeat, becomes stale after 30 seconds, and
is released when the process is interrupted. `inbox` without `--wait` gives up
after 5 seconds on a held lock and exits `0` with no output.

One `$ASK_HUMAN_DIR` is one conversation: whichever inbox drains first takes
the unread messages. Give parallel agent sessions separate `$ASK_HUMAN_DIR`
values, each with its own QR login (setup once per directory).
Whether one login can serve several directories is unverified: `getupdates`
may consume the cursor server-side. Do not share `wechat.json` between directories.

Load [the protocol note](references/ilink-bot-api.md) only when API details are needed.