# iLink Bot API

## Sources

- `co-pine/wx-robot-ilink`: `src/weixin/{auth,api,types}.ts`.
- `@tencent-weixin/openclaw-weixin` 2.4.8: `src/api/api.ts`, `src/auth/login-qr.ts`, `src/monitor/monitor.ts`, `src/messaging/{send,inbound}.ts`, README "Backend API Protocol".
- Local behavior: `../scripts/_wechat.mjs` (protocol) on top of `../scripts/_lib.mjs` (shared core). These are client-derived protocol notes, not a server compatibility guarantee.

## Login (QR)

Login base is fixed: `https://ilinkai.weixin.qq.com`.

```text
GET /ilink/bot/get_bot_qrcode?bot_type=3
Response: { qrcode, qrcode_img_content }
GET /ilink/bot/get_qrcode_status?qrcode=<url-encoded>[&verify_code=<digits>]
Header: iLink-App-ClientVersion: 1
```

`qrcode` is the polling handle; `qrcode_img_content` is the URL encoded into
the displayed QR. Status polling long-polls for roughly 35 seconds.

| `status`              | Meaning or action                                                                  |
| --------------------- | ---------------------------------------------------------------------------------- |
| `wait`                | Keep polling.                                                                      |
| `scaned`              | Scanned; confirm on the phone. Spelling is part of the protocol.                   |
| `confirmed`           | Login complete; read the account fields below.                                     |
| `expired`             | Fetch a new QR; this client permits three refreshes.                               |
| `scaned_but_redirect` | Set the polling base to `https://<redirect_host>` when provided.                   |
| `need_verifycode`     | Ask for the number displayed in WeChat; send it as `verify_code`.                  |
| `verify_code_blocked` | Too many wrong codes; fail and try again later.                                    |
| `binded_redirect`     | Already bound to another client; fail and ask the human to log it out there first. |

`confirmed` carries `bot_token`, `ilink_bot_id` (format `<hex>@im.bot`),
`baseurl` (this account's API base), and `ilink_user_id` (the scanner, format
`<id>@im.wechat`, the same identity space as inbound `from_user_id`).
The client falls back to the login base when `baseurl` is absent; QR login
has an overall eight-minute deadline.

## Account API

POST to the account's `baseurl`, with these headers:

```text
Content-Type: application/json
AuthorizationType: ilink_bot_token
Authorization: Bearer <token>
X-WECHAT-UIN: <base64 of the decimal string of a random uint32>
```

```text
POST <baseurl>/ilink/bot/getupdates
Request: { get_updates_buf }
Response: { ret, errcode?, errmsg?, msgs?, get_updates_buf?, longpolling_timeout_ms? }
```

Start with an empty `get_updates_buf`; retain the returned buffer for the next
request. Whether reads consume messages server-side is unverified; do not
share one login across independent state directories. Within one directory a
single inbox process polls on behalf of every session (see below). Whether the
server retains messages while nobody polls is also unverified.

```text
POST <baseurl>/ilink/bot/sendmessage
Request: { msg: { from_user_id: "", to_user_id, client_id, message_type: 2,
  message_state: 2, item_list: [{ type: 1, text_item: { text } }], context_token? } }
Response: { ret, errmsg? }
```

## Inbound Message Shape

- Fields: `from_user_id`, `message_type`, `create_time_ms`, `item_list`, `context_token`.
- `message_type: 1` is from a user; `2` is from the bot. Own sends can echo back; ignore them and all other users.
- `item_list[].type`: `1` TEXT, `2` IMAGE, `3` VOICE, `4` FILE, `5` VIDEO.
- Text is `item_list[].text_item.text`; voice may carry `voice_item.text` as a transcript. No transcript means no received text.
- An item's `ref_msg.title` contains quoted text; `ref_msg.message_item` contains the quoted item. The client uses the title, falling back to `message_item.text_item.text`, and keeps its first line for `re:`.
- `context_token` is issued per inbound message. Echo the latest token from the selected user on every outbound send; it is distinct from the bot's authentication token.
- This skill persists the cursor and latest conversation token locally. The inbox holding `poll.lock` polls for every session in the directory. Each fetched batch is saved under `recovery/` with routing fixed at receipt: a `re:` first line equal to a known title goes to that title's `sessions/<sha256(title)[:16]>/queue.jsonl`, anything else to the most recently started waiting inbox or to the poller itself. The poller appends history and destination queues before advancing the cursor, then removes the distributed batch. Recovery does not restore an older cursor or conversation token. Images, files, and video are not received as content.
- `ASK_HUMAN_DEBUG=1` makes `inbox` write the raw `msgs` array to stderr.

## Error Codes and Limits

- `ret: 0` indicates success; nonzero `ret` or `errcode` is an API failure.
- `ret: -14`, `errcode: -14`, or HTTP `401` means a stale/revoked bot token: ask the human to re-run setup.
- API errors become one-line stderr messages prefixed `ask-human: `; stale tokens exit `1` with `ask-human: bot token expired or revoked — run: node <skill-dir>/scripts/setup.mjs wechat`. The bot token is redacted from any echoed response text.
- Long-polling is roughly 35 seconds; updates may return `longpolling_timeout_ms`.
- Text is limited to 4000 characters per message. The client counts JavaScript UTF-16 code units, prefers line/word splits, and avoids splitting surrogate pairs on hard cuts.
- HTTP `429` is retried honoring numeric `Retry-After` seconds (default 2, capped at 60 per retry) until the call's deadline: the `--wait` window, 5 seconds for an inbox without `--wait`, or 10 minutes per `notify` part. HTTP-date `Retry-After` is not parsed.
- During inbox waits, network and `5xx` errors are retried with exponential backoff (2 s doubling to 30 s); expired-token errors fail immediately.

## Not Implemented

- Media upload and download (`getuploadurl`, CDN, AES), voice files, images, video.
- Typing indicator (`getconfig`, `sendtyping`), `notifystart`/`notifystop`.
- Group chats; the bot only talks to the user captured at setup.
- Markdown or rich-text formatting; everything is sent as plain text.

Media upload/download, typing indicators, group chats, and `notifystart`/`notifystop`.
