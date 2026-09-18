---
name: ask-human
description: "Ask the human a question and wait for the answer, send them a notification, or pick up messages they sent on their own, over the messaging channel the human set up. Use when: blocked on a decision, approval of a risky step, or information only the human has; a long task finished or failed; checking for new instructions from the human; first-time channel setup."
---

Commands below are relative to this skill folder; run them as `node <skill-dir>/scripts/<name>.mjs`. `notify` and
`inbox` talk to the one channel the human connected at setup; which channel that is never matters here. `--title` is
the session key: pick one stable single-line title per agent session, `<project>: <task>`, and pass the same value to
every `notify` and `inbox` of that session.

## Notify

```sh
node scripts/notify.mjs --title "<project>: <task>" "<message>"
```

Put the project or task in `--title` so the human can distinguish sessions. It becomes the first line of the message;
a title with a line break exits `1`. When another session is waiting for an answer under a different title, the line
`Reply by quoting this message; other questions are open.` is appended, so the human learns how to address this
session without being told. Supply the message as an argument, or on stdin when the argument is absent. Repeat
`--choice "<label>"` to append a numbered list; there are no buttons. Text arrives exactly as given: `* _ [ ] < > &`
need no escaping. Messages longer than the channel allows are split at line/word boundaries (hard-split when neither
exists) and delivered in order, never truncated. Exit `0` means every part was delivered.

## Ask

Send ONE self-contained question: context, options, and what happens if nobody answers.
Drain the inbox first (same title, no `--wait`), then ask and wait under that title.
Wait 4 hours (`--wait 14400`; there is no upper limit) unless the task dictates otherwise; announce the deadline you use.

```sh
node scripts/notify.mjs --title "<project>: <task>" --choice "Proceed" --choice "Pause" "Validation passed. Proceed with the next step or pause? Without an answer in 4 hours, I will pause."
node scripts/inbox.mjs --wait 14400 --title "<project>: <task>"
```

Run `inbox --wait` as an ordinary foreground command in your terminal tool and let it run until the announced
deadline. If the tool moves it to the background, keep that handle and act on the tool's completion notification;
never start a second `inbox` for the title or shorten the wait. If the tool cannot wait that long, repeat shorter
waits until the original deadline: a `124` does not restart the 4 hours. Accept either the number or the label as an
answer to a numbered list. If the answer looks unfinished, call `inbox --wait` again; the human may send several
messages. Drain the inbox after every answer. On exit `124` at the deadline, follow the default announced in the
question and notify the human of what you did, draining once more before that `notify` and again before reporting
done. A late quoted reply fetched by any inbox is queued for this title.

## Inbox

```sh
node scripts/inbox.mjs --title "<project>: <task>"
node scripts/inbox.mjs --wait SEC --title "<project>: <task>"
```

Without `--wait`, exit `0` even when empty: replies queued for this title are printed without a network call; when
none are queued and another inbox is already polling, exit `0` immediately, otherwise make one bounded poll. Local
queue contention retries for at most 5 seconds, then exits `1` without fetching newer messages ahead of the queued
replies. With `--wait`, return as soon as something arrives for this title, after a roughly 2-second grace period to
collect a burst; exit `124` if nothing arrived within the wait. Print unread messages oldest first, then mark them
read. Each message is one block; separate blocks with a `---` line:

```text
[YYYY-MM-DD HH:MM] re: "<first line of the quoted message>"
<message text>
---
[YYYY-MM-DD HH:MM]
<message text>
```

Timestamps use local time. Include ` re: "..."` only when the human used the channel's quote/reply on a message; print
message text verbatim below the header. Only text is received: a voice message contributes its transcript when the
channel provides one, other media only the text sent along with it, if any. Everyone except the human paired at setup
is ignored. Drain the inbox after every answer, before every `notify` and before reporting a task done, so a "stop" or
"also do X" is never lost.

Routing: one login serves every agent session on the machine, and the inbox that is polling sorts each message into a
per-title queue. A reply quoting a message whose first line is a title any session here has used goes to that title,
waiting or not. Anything else — unquoted, or quoting unknown text or a later part of a split message — goes to the
most recently started `inbox --wait` (not the latest `notify`), else to the poller itself. Two inboxes with the same
title compete for one queue; an untitled inbox is a session of its own, not a catch-all.

Interrupted delivery may print a block twice. Every received message stays stored on the human's machine: if an
`inbox` output was lost, or stderr carries the warning `ask-human: corrupt queue preserved as <file>`, tell the
human so they can recover it as their channel guide describes; do not ask them to repeat the answer and do not look
for those files yourself.

## Failure modes

| Exit  | Meaning and action                                                                                                                                                                                                  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`   | Success, including an empty inbox without `--wait`.                                                                                                                                                                 |
| `1`   | Usage, storage or messaging-service failure, including queue contention beyond the local budget; stderr starts `ask-human: `. Report the error.                                                                     |
| `2`   | Not configured or invalid configuration; stderr names the README to follow. Ask the human to run setup as described there, in their own terminal; see below.                                                        |
| `124` | `--wait` elapsed with nothing for this title. Wait again up to the announced deadline, or use the announced default and send a follow-up notification; keep draining, a late quoted reply is queued for this title. |

Setup is the human's job, also when they ask for first-time setup: point them to the Setup section of
[README.md](README.md) — the file and section stderr names on exit `2` and on `ask-human: credentials expired or revoked`
(exit `1`) — to run in their own terminal. Never run setup yourself, handle or request credentials or tokens in chat,
read or write the configuration, or load the guides under `channels/`; nothing there is needed at runtime. Setup
discards the channel's unread replies before login, and a running process keeps the channel it started with, so ask
the human to let `inbox --wait` calls finish or stop them before re-running setup or switching channels.
Rate limits and transient failures are handled inside the scripts, never by you: HTTP `429` is retried honoring
`Retry-After`, and network or `5xx` errors during `--wait` are retried with backoff, both until the call's own
deadline. The no-wait inbox has a 5-second budget; `notify` allows up to 10 minutes of rate-limit retries per message
part. An exhausted no-wait rate limit can return `0` empty; storage or messaging-service failure returns `1`, and an
empty expired wait returns `124`. Concurrent inbox processes share one poller: one fetches while the others read their
own queues, and `inbox` without `--wait` exits `0` at once, with nothing, when its queue is empty and another process
is polling. Queue files left by a dead process are picked up by the next inbox of that title.
