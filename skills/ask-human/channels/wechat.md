# WeChat

ask-human reaches you in WeChat through a bot that setup creates for your account by QR login, using Tencent's
iLink bot API. The bot appears as a new chat: the agent's messages arrive there, and only your replies in that chat
are read. Install the skill first as described in the [README](../README.md); this guide covers only the channel.

## Requirements

- WeChat on your phone, logged in to the account that will talk to the agent.
- HTTPS access from the agent's machine to `ilinkai.weixin.qq.com`.

## Setup

Run setup yourself, in your own terminal; it asks for no token:

```sh
node ~/.agents/skills/ask-human/scripts/setup.mjs wechat
```

That is the path after `npx skills add -g`; with another install location use
`<skills-dir>/ask-human/scripts/setup.mjs wechat`.

1. Setup prints `WeChat setup for ask-human. Scan the QR code with WeChat and confirm on your phone.`, then a QR
   code and a fallback URL. If the terminal cannot render a scannable code, open the URL in a browser and scan the
   page. An expired code is replaced up to three times; login must finish within 8 minutes, otherwise setup exits
   with `ask-human: login timed out` and has to be run again.
2. Scan with WeChat and confirm on your phone; setup reports `Scanned`. WeChat may show a number: enter it at the
   prompt `Enter the number shown in WeChat:`.
3. Setup prints `Logged in (bot <bot-id>).` and asks you to send the bot any message in WeChat. The bot appears as
   a new chat; that first message pairs your WeChat account as the only one the scripts talk to and listen to.
   Setup waits up to 10 minutes, then prints `Paired with WeChat user <user-id>.`.
4. Setup sends `ask-human: WeChat is connected. Reply to this message to finish setup.` and prints
   `Test message sent.`; reply to that message in WeChat within 10 minutes.
5. Setup prints `Reply received: "<first line of your reply>"`, then
   `Config written to <ASK_HUMAN_DIR>/wechat.json; active channel: wechat`, and exits `0`.

Before login, setup deletes this channel's local read cursor, per-title queues and recovery batches, so stop running
inbox calls first; unread replies in those queues are lost. The credentials and the active-channel pointer are
written only after your reply arrives, so an interrupted setup leaves the previous ones in place. Re-run setup any
time to re-pair, and whenever the agent reports `ask-human: credentials expired or revoked`. A `wechat.json` from
the earlier `wechat` skill is not reused: without `config.json` the agent sees `not configured`, so run setup once
after installing.

Other login failures exit `1` with their reason: too many wrong codes (retry later), a QR code that expired too many
times, or a bot already bound to another client (log it out there first).

## What travels over WeChat

- Outgoing messages longer than 4000 characters (UTF-16 code units) are split at line or word boundaries and
  delivered in order. Only the first part begins with the agent's `--title`; quote that part when replying so your
  answer reaches the right session.
- Only your messages in the bot chat count, matched by the WeChat user id captured at setup; anyone else is
  ignored. Only text is received: the text of a message, and the transcript of a voice message when WeChat supplies
  one. Images, files and stickers are dropped unless the message also carries text, which then arrives on its own.
  A quote/reply reaches the agent as `re: "<first line of the quoted message>"`.
- Whether WeChat keeps messages for the bot while no inbox call is polling is unverified; when you can, reply while
  the agent waits, and quote the question when several are open.

## Files

Under `ASK_HUMAN_DIR` (default `~/.config/ask-human`):

- `config.json`: `{"channel":"wechat"}` while WeChat is the active channel.
- `wechat.json`: bot token, API base URL, bot id and your WeChat user id, mode `0600`. Never paste its contents into
  a chat, and never copy it to another directory or machine.
- `wechat/state.json`: read cursor and latest conversation token.
- `wechat/poll.lock`: held by the one inbox call that is polling WeChat for everyone.
- `wechat/history.log`: every message received, in the block format the agent sees. If the agent lost an answer, its
  tail has it; there is no need to resend.
- `wechat/recovery/`: fetched batches awaiting distribution; the next poller resumes them before fetching again.
  `ask-human: invalid recovery batch <file>` (exit `1`) names a batch in this folder that cannot be replayed; polling
  stays blocked until you move that file out of the folder. Keep the copy, it holds fetched replies.
- `wechat/sessions/<key>/`: one folder per `--title` the agent has used: `title.json` (the title), `queue.jsonl`
  (replies routed to that title and not yet read; `queue.jsonl.<pid>` while a call is reading them), `waiter.json`
  (present while an inbox call is waiting) and `queue.lock` for the short local writes. Malformed records are moved
  to `queue.jsonl.corrupt.<random>`; the warning `ask-human: corrupt queue preserved as <file>` gives the file name,
  and the folder holding it is the one whose `title.json` matches the agent's title.

Delete `wechat/state.json` or `wechat/poll.lock` only when no inbox call is running; they are rebuilt on the next
call. `wechat/sessions/` and `wechat/recovery/` hold unread replies; deleting them discards those replies.

## Sharing the login

All agent sessions using one `ASK_HUMAN_DIR` share this one QR login and bot; they are told apart by title, and when
several questions are open you answer each with WeChat's quote/reply on the question, as the
[README](../README.md#parallel-agent-sessions) explains. A separate `ASK_HUMAN_DIR` needs its own `setup.mjs wechat`
run and gets its own bot: do not copy `wechat.json`. Whether one login could serve several directories is unverified,
because reading updates may consume the server-side cursor.

## Troubleshooting

- QR not scannable in the terminal: open the printed URL in a browser and scan the page.
- `ask-human: credentials expired or revoked` (exit `1`): the bot token was rejected (HTTP 401 or iLink `-14`); run
  setup again.
- `ask-human: messaging service ...` (exit `1`): a request could not be completed. HTTP 429 is retried within the
  call's budget; `inbox --wait` also retries transient failures. Other failures can return immediately. Check access
  to `ilinkai.weixin.qq.com` before retrying.
- To see what iLink actually returns, run an inbox call yourself with `ASK_HUMAN_DEBUG=1`; it prints the raw message
  batches to stderr. This is for your own troubleshooting only: the output contains user ids, conversation tokens and
  message content, so do not have the agent enable it, and redact it before sharing.

Protocol details are in [wechat-ilink-bot-api.md](../references/wechat-ilink-bot-api.md).
