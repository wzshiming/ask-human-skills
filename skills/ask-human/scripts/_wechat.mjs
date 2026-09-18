import { randomBytes } from 'node:crypto';
import { CliError, SETUP_SCRIPT, cliError, drain, request, send as deliver } from './_lib.mjs';
import { qrMatrix, renderQr } from './_qr.mjs';

export const label = 'WeChat';
export const textLimit = 4000;
export const configKeys = ['token', 'baseUrl', 'userId'];

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, Math.max(0, milliseconds)));
const expired = () =>
  Object.assign(new CliError(`bot token expired or revoked — run: node ${SETUP_SCRIPT} wechat`), { fatal: true });

export function headers(token) {
  return {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    Authorization: `Bearer ${token}`,
    'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString('base64'),
  };
}

async function api(url, options, { token = '', timeoutMs, deadline }) {
  let result;
  try {
    result = await request(url, options, { timeoutMs, deadline, redact: token });
  } catch (error) {
    throw error.status === 401 ? expired() : error;
  }
  if (result?.ret === -14 || result?.errcode === -14) throw expired();
  if ((result?.ret != null && result.ret !== 0) || (result?.errcode != null && result.errcode !== 0)) {
    const detail = String(result.errmsg ?? '');
    throw new CliError(
      `${new URL(url).pathname} ret=${result.ret} errcode=${result.errcode} ${token ? detail.replaceAll(token, '***') : detail}`,
    );
  }
  return result;
}

export async function apiPost(baseUrl, endpoint, body, { token, timeoutMs = 15000, deadline = Date.now() + 600000 }) {
  const url = `${baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`}${endpoint}`;
  return api(url, () => ({ method: 'POST', headers: headers(token), body: JSON.stringify(body) }), {
    token,
    timeoutMs,
    deadline,
  });
}

export async function apiGet(url, { headers = {}, timeoutMs = 15000, deadline = Date.now() + 600000 } = {}) {
  return api(url, () => ({ method: 'GET', headers }), { timeoutMs, deadline });
}

export async function send(cfg, state, chunk, { deadline } = {}) {
  const msg = {
    from_user_id: '',
    to_user_id: cfg.userId,
    client_id: `ask-human-${Date.now()}-${randomBytes(8).toString('hex')}`,
    message_type: 2,
    message_state: 2,
    item_list: [{ type: 1, text_item: { text: chunk } }],
  };
  if (typeof state?.contextToken === 'string' && state.contextToken) msg.context_token = state.contextToken;
  await apiPost(cfg.baseUrl, 'ilink/bot/sendmessage', { msg }, { token: cfg.token, deadline });
}

export function humanMessages(msgs, userId) {
  const items = [];
  for (const msg of msgs) {
    if (msg.message_type !== 1 || (userId && msg.from_user_id !== userId)) continue;
    const parts = msg.item_list ?? [];
    const text = parts
      .flatMap(item => [item.text_item?.text, item.voice_item?.text])
      .filter(text => typeof text === 'string' && text)
      .join('\n');
    if (!text) continue;
    const ref = parts.find(item => item.ref_msg)?.ref_msg;
    const re = (ref?.title || ref?.message_item?.text_item?.text || '').split(/\r?\n/)[0];
    items.push({
      time: msg.create_time_ms ?? Date.now(),
      from: msg.from_user_id,
      text,
      re,
      contextToken: msg.context_token ?? '',
    });
  }
  return items;
}

export async function fetch(cfg, state, { timeoutMs, deadline, since = 0 }) {
  const cursor = typeof state?.cursor === 'string' ? state.cursor : '';
  const contextToken = typeof state?.contextToken === 'string' ? state.contextToken : '';
  let result;
  try {
    result = await apiPost(
      cfg.baseUrl,
      'ilink/bot/getupdates',
      { get_updates_buf: cursor },
      { token: cfg.token, timeoutMs, deadline },
    );
  } catch (error) {
    if (error.name === 'AbortError') return { items: [], state: { cursor, contextToken } };
    throw error;
  }
  if (process.env.ASK_HUMAN_DEBUG && result.msgs?.length) process.stderr.write(`${JSON.stringify(result.msgs)}\n`);
  const received = humanMessages(result.msgs ?? [], cfg.userId).filter(item => item.time >= since);
  return {
    items: received.map(({ contextToken: _, ...item }) => item),
    state: {
      cursor: result.get_updates_buf || cursor,
      contextToken: received.at(-1)?.contextToken || contextToken,
    },
  };
}

export async function login({ out, ask, onQr, pollIntervalMs = 1000 }) {
  const base = 'https://ilinkai.weixin.qq.com';
  const deadline = Date.now() + 8 * 60 * 1000;
  let pollBase = base;
  let qrcode;
  let code = '';
  let scanned = false;
  let refreshes = 0;
  try {
    while (Date.now() < deadline) {
      if (!qrcode) {
        const result = await apiGet(`${base}/ilink/bot/get_bot_qrcode?bot_type=3`);
        if (!result?.qrcode || !result.qrcode_img_content) throw new CliError('invalid QR login response');
        qrcode = result.qrcode;
        pollBase = base;
        code = '';
        scanned = false;
        await onQr(result.qrcode_img_content);
      }
      if (Date.now() >= deadline) break;
      let result;
      try {
        result = await apiGet(
          `${pollBase}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}${code ? `&verify_code=${encodeURIComponent(code)}` : ''}`,
          { headers: { 'iLink-App-ClientVersion': '1' }, timeoutMs: 35000 },
        );
      } catch (error) {
        // timeouts, network errors and gateway 5xx are routine during the 35 s long-poll
        const transient =
          error.name === 'AbortError' || error.status >= 500 || (error.cause && !(error.cause instanceof SyntaxError));
        if (!transient) throw error;
        result = { status: 'wait' };
      }
      if (Date.now() >= deadline) break;
      switch (result.status) {
        case 'wait':
          break;
        case 'scaned':
          if (!scanned) {
            await out('Scanned — confirm on your phone.');
            scanned = true;
          }
          code = '';
          break;
        case 'need_verifycode':
          code = await ask('Enter the number shown in WeChat: ');
          continue;
        case 'verify_code_blocked':
          throw new CliError('too many wrong codes — try again later');
        case 'expired':
          if (refreshes++ >= 3) throw new CliError('QR code expired too many times — try again');
          qrcode = '';
          continue;
        case 'scaned_but_redirect':
          if (result.redirect_host) pollBase = `https://${result.redirect_host}`;
          break;
        case 'binded_redirect':
          throw new CliError('this bot is already bound to another client — log it out there first');
        case 'confirmed':
          if (!result.bot_token || !result.ilink_bot_id) throw new CliError('incomplete login confirmation');
          return {
            token: result.bot_token,
            baseUrl: result.baseurl || base,
            botId: result.ilink_bot_id,
            userId: result.ilink_user_id || '',
          };
        default:
          throw new CliError(`unknown login status: ${result.status}`);
      }
      if (pollIntervalMs > 0) await sleep(Math.min(pollIntervalMs, deadline - Date.now()));
    }
    throw new CliError('login timed out');
  } catch (error) {
    throw cliError(error);
  }
}

export async function setup({ out, ask }) {
  out('WeChat setup for ask-human. Scan the QR code with WeChat and confirm on your phone.');
  const cfg = await login({
    out,
    ask,
    onQr: url => {
      out(renderQr(qrMatrix(url)).slice(0, -1));
      out(`If the QR code above is not scannable, open this URL in a browser and scan it there:\n${url}\n`);
    },
  });
  out(`Logged in (bot ${cfg.botId}). Now send the bot any message in WeChat \u2014 it appears as a new chat there.`);
  const first = await drain(cfg, { waitSec: 600, since: Date.now() - 60_000 });
  cfg.userId ||= first[0].from;
  out(`Paired with WeChat user ${cfg.userId}.`);
  await deliver(cfg, 'ask-human: WeChat is connected. Reply to this message to finish setup.');
  out('Test message sent. Reply to it in WeChat (waiting up to 10 minutes)\u2026');
  const reply = await drain(cfg, { waitSec: 600 });
  out(`Reply received: ${JSON.stringify(reply[0].text.split('\n')[0])}`);
  return cfg;
}
