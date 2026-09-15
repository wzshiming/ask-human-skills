import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(`wechat: ${String(message).replace(/^wechat: /, '').replace(/[\r\n\u2028\u2029]+/g, ' ')}`);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

export const EXIT = { OK: 0, FAIL: 1, NOT_CONFIGURED: 2, TIMEOUT: 124 };
export const SETUP_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'setup.mjs');
export const CHUNK_LIMIT = 4000;

export function paths() {
  const dir = process.env.ASK_HUMAN_DIR || path.join(os.homedir(), '.config', 'ask-human');
  const stateDir = path.join(dir, 'wechat');
  return { dir, configFile: path.join(dir, 'wechat.json'), stateDir,
    stateFile: path.join(stateDir, 'state.json'), lockFile: path.join(stateDir, 'poll.lock'),
    historyFile: path.join(stateDir, 'history.log') };
}

function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 });
    fs.chmodSync(`${file}.tmp`, 0o600);
    fs.renameSync(`${file}.tmp`, file);
  } catch (error) { throw new CliError(error.message); }
}

export function loadConfig() {
  try {
    const config = JSON.parse(fs.readFileSync(paths().configFile, 'utf8'));
    if (['token', 'baseUrl', 'userId'].every(key => typeof config?.[key] === 'string' && config[key])) return config;
  } catch {}
  throw new CliError(`wechat: not configured — run: node ${SETUP_SCRIPT}`, EXIT.NOT_CONFIGURED);
}

export function saveConfig(cfg) { writeJson(paths().configFile, cfg); }

export function loadState() {
  try {
    const state = JSON.parse(fs.readFileSync(paths().stateFile, 'utf8'));
    if (typeof state?.cursor === 'string' && typeof state.contextToken === 'string') return state;
  } catch {}
  return { cursor: '', contextToken: '' };
}

export function saveState(state) { writeJson(paths().stateFile, state); }

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, Math.max(0, milliseconds)));
const expiredMessage = 'wechat: bot token expired or revoked — run setup.mjs again';
function cliError(error) {
  if (error instanceof CliError || error.name === 'AbortError') return error;
  return Object.assign(new CliError(error.message), { cause: error });
}

export async function withLock(fn, { deadline = Date.now() + 5000 } = {}) {
  const { stateDir, lockFile } = paths();
  let heartbeat;
  let held = false;
  const release = () => {
    clearInterval(heartbeat);
    if (!held) return;
    held = false;
    try { fs.unlinkSync(lockFile); } catch {}
  };
  const onSignal = signal => { release(); process.exit(signal === 'SIGINT' ? 130 : 143); };
  try {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    while (!held) {
      if (Date.now() > deadline) throw new CliError('wechat: another inbox process holds the poll lock', EXIT.TIMEOUT);
      try {
        fs.closeSync(fs.openSync(lockFile, 'wx', 0o600));
        held = true;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try {
          if (Date.now() - fs.statSync(lockFile).mtimeMs > 30000) {
            // rename first so only one waiter takes over a stale lock
            fs.renameSync(lockFile, `${lockFile}.stale`);
            fs.unlinkSync(`${lockFile}.stale`);
            continue;
          }
        } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        await sleep(500);
      }
    }
    heartbeat = setInterval(() => {
      try { const now = new Date(); fs.utimesSync(lockFile, now, now); } catch {}
    }, 5000);
    heartbeat.unref();
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, onSignal);
    return await fn();
  } catch (error) { throw cliError(error); }
  finally {
    for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, onSignal);
    release();
  }
}

export function headers(token) {
  return { 'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token',
    Authorization: `Bearer ${token}`,
    'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString('base64') };
}

async function request(url, endpoint, options, { timeoutMs, deadline, token = '' }) {
  const redact = text => (token ? String(text).replaceAll(token, '***') : String(text));
  for (;;) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let retryAfter;
    try {
      const response = await fetch(url, { ...options(), signal: controller.signal });
      if (response.status === 401) throw new CliError(expiredMessage);
      if (response.status === 429) {
        // rate limits are absorbed here so the agent never has to handle them
        const seconds = Number(response.headers.get('Retry-After') ?? 2);
        retryAfter = Math.min(Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 2000, 60000);
        await response.body?.cancel();
        if (Date.now() + retryAfter > deadline) throw Object.assign(new CliError(`wechat: ${endpoint} rate limited (HTTP 429), try again later`), { status: 429 });
      } else {
        if (!response.ok) throw Object.assign(new CliError(`wechat: ${endpoint} HTTP ${response.status}: ${redact((await response.text()).slice(0, 200))}`), { status: response.status });
        let result;
        try { result = await response.json(); } catch { throw new CliError(`wechat: ${endpoint} returned invalid JSON`); }
        if (result?.ret === -14 || result?.errcode === -14) throw new CliError(expiredMessage);
        if ((result?.ret != null && result.ret !== 0) || (result?.errcode != null && result.errcode !== 0)) {
          throw new CliError(`wechat: ${endpoint} ret=${result.ret} errcode=${result.errcode} ${redact(result.errmsg ?? '')}`);
        }
        return result;
      }
    } catch (error) { throw cliError(error); }
    finally { clearTimeout(timer); }
    await sleep(retryAfter);
  }
}

export async function apiPost(baseUrl, endpoint, body, { token, timeoutMs = 15000, deadline = Date.now() + 600000 }) {
  try {
    const url = new URL(endpoint, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
    return await request(url, endpoint, () => ({ method: 'POST', headers: headers(token), body: JSON.stringify(body) }), { timeoutMs, deadline, token });
  } catch (error) { throw cliError(error); }
}

export async function apiGet(url, { headers = {}, timeoutMs = 15000, deadline = Date.now() + 600000 } = {}) {
  return request(url, String(url), () => ({ method: 'GET', headers }), { timeoutMs, deadline });
}

export function formatOutgoing({ title = '', message = '', choices = [] }) {
  return `${title ? `${title}\n` : ''}${message}${choices.length ? `\n\n${choices.map((choice, index) => `${index + 1}. ${choice}`).join('\n')}` : ''}`.trimEnd();
}

export function splitText(text, limit = CHUNK_LIMIT) {
  if (!Number.isInteger(limit) || limit < 1) throw new CliError('wechat: invalid text chunk limit');
  const chunks = [];
  while (text.length > limit) {
    let cut = text.lastIndexOf('\n', limit);
    if (cut < 0) cut = text.lastIndexOf(' ', limit);
    const separator = cut >= 0;
    if (!separator) {
      cut = limit;
      if (/[\uD800-\uDBFF]/.test(text[cut - 1]) && /[\uDC00-\uDFFF]/.test(text[cut])) cut--;
      if (!cut) throw new CliError('wechat: text chunk limit cannot fit a surrogate pair');
    }
    chunks.push(text.slice(0, cut));
    text = text.slice(cut + (separator ? 1 : 0));
  }
  chunks.push(text);
  const kept = chunks.filter(chunk => chunk.trim());
  return kept.length ? kept : [''];
}

export async function sendText(cfg, text, { contextToken = '' } = {}) {
  for (const chunk of splitText(text)) {
    const msg = { from_user_id: '', to_user_id: cfg.userId,
      client_id: `ask-human-${Date.now()}-${randomBytes(8).toString('hex')}`,
      message_type: 2, message_state: 2, item_list: [{ type: 1, text_item: { text: chunk } }] };
    if (contextToken) msg.context_token = contextToken;
    await apiPost(cfg.baseUrl, 'ilink/bot/sendmessage', { msg }, { token: cfg.token });
  }
}

export function humanMessages(msgs, userId) {
  const items = [];
  for (const msg of msgs) {
    if (msg.message_type !== 1 || (userId && msg.from_user_id !== userId)) continue;
    const parts = msg.item_list ?? [];
    const text = parts.flatMap(item => [item.text_item?.text, item.voice_item?.text]).filter(text => typeof text === 'string' && text).join('\n');
    if (!text) continue;
    const ref = parts.find(item => item.ref_msg)?.ref_msg;
    const re = (ref?.title || ref?.message_item?.text_item?.text || '').split(/\r?\n/)[0];
    items.push({ time: msg.create_time_ms ?? Date.now(), from: msg.from_user_id, text, re, contextToken: msg.context_token ?? '' });
  }
  return items;
}

export function formatInbox(items) {
  const pad = number => String(number).padStart(2, '0');
  return items.map(item => {
    const date = new Date(item.time);
    const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    return `[${stamp}]${item.re ? ` re: "${item.re}"` : ''}\n${item.text}`;
  }).join('\n---\n') + (items.length ? '\n' : '');
}

export async function fetchUpdates(cfg, cursor, timeoutMs, deadline) {
  try {
    const result = await apiPost(cfg.baseUrl, 'ilink/bot/getupdates', { get_updates_buf: cursor || '' }, { token: cfg.token, timeoutMs, deadline });
    if (process.env.ASK_HUMAN_DEBUG && result.msgs?.length) process.stderr.write(`${JSON.stringify(result.msgs)}\n`);
    return { msgs: result.msgs ?? [], cursor: result.get_updates_buf || cursor };
  } catch (error) {
    if (error.name === 'AbortError') return { msgs: [], cursor };
    throw error;
  }
}

function appendHistory(items) {
  const { historyFile } = paths();
  const separator = fs.existsSync(historyFile) && fs.statSync(historyFile).size ? '---\n' : '';
  fs.appendFileSync(historyFile, separator + formatInbox(items), { mode: 0o600 });
}

export async function drain(cfg, { waitSec = 0, since = 0, onItems } = {}) {
  const deadline = Date.now() + (waitSec > 0 ? waitSec * 1000 : 5000);
  return withLock(async () => {
    const state = loadState();
    const items = [];
    let succeeded = false;
    let lastError;
    let backoff = 2000;
    let graceEnd = 0;
    while (waitSec === 0 || Date.now() < (graceEnd || deadline)) {
      const started = Date.now();
      try {
        const timeout = graceEnd ? graceEnd - started : waitSec === 0 ? 4000 : Math.min(deadline - started, 40000);
        const result = await fetchUpdates(cfg, state.cursor, timeout, graceEnd || (waitSec === 0 ? started + 30000 : deadline));
        succeeded = true;
        backoff = 2000;
        const received = humanMessages(result.msgs, cfg.userId).filter(item => item.time >= since);
        if (received.length) {
          items.push(...received);
          // hand over before the cursor moves so an interrupted call redelivers
          appendHistory(received);
          await onItems?.(received);
          if (received.at(-1).contextToken) state.contextToken = received.at(-1).contextToken;
        }
        state.cursor = result.cursor;
        saveState(state);
        if (waitSec === 0) break;
        if (items.length && !graceEnd) graceEnd = Date.now() + 2000;
        if (!received.length && Date.now() - started < 1000) await sleep(Math.min(1000, (graceEnd || deadline) - Date.now()));
      } catch (error) {
        if (!(error instanceof CliError) || error.message === expiredMessage) throw error;
        if (waitSec === 0) { if (error.status === 429) break; throw error; }
        if (graceEnd) break;
        lastError = error;
        await sleep(Math.min(backoff, deadline - Date.now()));
        backoff = Math.min(backoff * 2, 30000);
      }
    }
    saveState(state);
    if (waitSec > 0 && !items.length) {
      if (!succeeded && lastError && lastError.status !== 429) throw lastError;
      throw new CliError(`wechat: no message received within ${waitSec} s`, EXIT.TIMEOUT);
    }
    return items;
  }, { deadline }).catch(error => {
    // no-wait must exit 0: whoever holds the lock is draining the same inbox
    if (waitSec === 0 && error.exitCode === EXIT.TIMEOUT) return [];
    throw error;
  });
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
        if (!result?.qrcode || !result.qrcode_img_content) throw new CliError('wechat: invalid QR login response');
        qrcode = result.qrcode;
        pollBase = base;
        code = '';
        scanned = false;
        await onQr(result.qrcode_img_content);
      }
      if (Date.now() >= deadline) break;
      let result;
      try {
        result = await apiGet(`${pollBase}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}${code ? `&verify_code=${encodeURIComponent(code)}` : ''}`,
          { headers: { 'iLink-App-ClientVersion': '1' }, timeoutMs: 35000 });
      } catch (error) {
        // timeouts, network errors and gateway 5xx are routine during the 35 s long-poll
        const transient = error.name === 'AbortError' || error.status >= 500 || (error.cause && !(error.cause instanceof SyntaxError));
        if (!transient) throw error;
        result = { status: 'wait' };
      }
      if (Date.now() >= deadline) break;
      switch (result.status) {
        case 'wait': break;
        case 'scaned':
          if (!scanned) { await out('Scanned — confirm on your phone.'); scanned = true; }
          code = '';
          break;
        case 'need_verifycode':
          code = await ask('Enter the number shown in WeChat: ');
          continue;
        case 'verify_code_blocked': throw new CliError('wechat: too many wrong codes — try again later');
        case 'expired':
          if (refreshes++ >= 3) throw new CliError('wechat: QR code expired too many times — try again');
          qrcode = '';
          continue;
        case 'scaned_but_redirect':
          if (result.redirect_host) pollBase = `https://${result.redirect_host}`;
          break;
        case 'binded_redirect': throw new CliError('wechat: this bot is already bound to another client — log it out there first');
        case 'confirmed':
          if (!result.bot_token || !result.ilink_bot_id) throw new CliError('wechat: incomplete login confirmation');
          return { token: result.bot_token, baseUrl: result.baseurl || base, botId: result.ilink_bot_id, userId: result.ilink_user_id || '' };
        default: throw new CliError(`wechat: unknown login status: ${result.status}`);
      }
      if (pollIntervalMs > 0) await sleep(Math.min(pollIntervalMs, deadline - Date.now()));
    }
    throw new CliError('wechat: login timed out');
  } catch (error) { throw cliError(error); }
}