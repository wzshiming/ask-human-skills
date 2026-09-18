import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(
      `wechat: ${String(message)
        .replace(/^wechat: /, '')
        .replace(/[\r\n\u2028\u2029]+/g, ' ')}`,
    );
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
  return {
    dir,
    configFile: path.join(dir, 'wechat.json'),
    stateDir,
    stateFile: path.join(stateDir, 'state.json'),
    lockFile: path.join(stateDir, 'poll.lock'),
    historyFile: path.join(stateDir, 'history.log'),
    sessionsDir: path.join(stateDir, 'sessions'),
    recoveryDir: path.join(stateDir, 'recovery'),
  };
}

function writeJson(file, value) {
  const temporary = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } catch (error) {
    throw new CliError(error.message);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function loadConfig() {
  try {
    const config = JSON.parse(fs.readFileSync(paths().configFile, 'utf8'));
    if (['token', 'baseUrl', 'userId'].every(key => typeof config?.[key] === 'string' && config[key])) return config;
  } catch {}
  throw new CliError(`wechat: not configured — run: node ${SETUP_SCRIPT}`, EXIT.NOT_CONFIGURED);
}

export function saveConfig(cfg) {
  writeJson(paths().configFile, cfg);
}

export function loadState() {
  try {
    const state = JSON.parse(fs.readFileSync(paths().stateFile, 'utf8'));
    if (typeof state?.cursor === 'string' && typeof state.contextToken === 'string') return state;
  } catch {}
  return { cursor: '', contextToken: '' };
}

export function saveState(state) {
  writeJson(paths().stateFile, state);
}

export function resetState() {
  const { lockFile, sessionsDir, recoveryDir } = paths();
  fs.rmSync(lockFile, { force: true });
  fs.rmSync(sessionsDir, { recursive: true, force: true });
  fs.rmSync(recoveryDir, { recursive: true, force: true });
  saveState({ cursor: '', contextToken: '' });
}

export function sessionKey(title = '') {
  if (/[\r\n]/.test(title)) throw new CliError('wechat: --title must be a single line');
  return createHash('sha256').update(title).digest('hex').slice(0, 16);
}

const sessionDir = key => path.join(paths().sessionsDir, key);

export function registerSession(title = '') {
  const key = sessionKey(title);
  const file = path.join(sessionDir(key), 'title.json');
  if (!fs.existsSync(file)) writeJson(file, { title });
  return key;
}

export function sessions() {
  const list = [];
  let keys = [];
  try {
    keys = fs.readdirSync(paths().sessionsDir);
  } catch {
    return list;
  }
  for (const key of keys) {
    let title;
    try {
      title = JSON.parse(fs.readFileSync(path.join(sessionDir(key), 'title.json'), 'utf8')).title;
    } catch {}
    if (typeof title !== 'string') continue;
    let since = 0;
    try {
      const waiter = path.join(sessionDir(key), 'waiter.json');
      if (Date.now() - fs.statSync(waiter).mtimeMs <= 30000)
        since = Number(JSON.parse(fs.readFileSync(waiter, 'utf8')).since) || 0;
    } catch {}
    list.push({ key, title, since });
  }
  return list;
}

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, Math.max(0, milliseconds)));
const expiredMessage = 'wechat: bot token expired or revoked — run setup.mjs again';
function cliError(error) {
  if (error instanceof CliError || error.name === 'AbortError') return error;
  return Object.assign(new CliError(error.message), { cause: error });
}

const holds = new Set();
function onSignal(signal) {
  for (const release of [...holds]) release();
  process.exit(signal === 'SIGINT' ? 130 : 143);
}

function displace(file, judged) {
  const displaced = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.stale`;
  fs.renameSync(file, displaced);
  try {
    const moved = fs.statSync(displaced);
    if (moved.dev !== judged.dev || moved.ino !== judged.ino || moved.mtimeMs !== judged.mtimeMs) {
      try {
        fs.linkSync(displaced, file);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      return false;
    }
    return true;
  } finally {
    fs.unlinkSync(displaced);
  }
}

function acquire(file, content = JSON.stringify({ pid: process.pid, since: Date.now() }), stealLive = true) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let fd;
  for (;;) {
    try {
      fd = fs.openSync(file, 'wx', 0o600);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const judged = fs.statSync(file);
        let pid;
        try {
          pid = JSON.parse(fs.readFileSync(file, 'utf8')).pid;
        } catch {}
        const known = Number.isInteger(pid) && pid > 0;
        const dead = known && !alive(pid);
        if (!stealLive && known && !dead) return undefined;
        if (!dead && Date.now() - judged.mtimeMs <= 30000) return undefined;
        if (!displace(file, judged)) return undefined;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
  const touch = () => {
    try {
      const now = new Date();
      fs.futimesSync(fd, now, now);
    } catch {}
  };
  if (content) fs.writeSync(fd, content);
  touch();
  const heartbeat = setInterval(touch, 5000);
  heartbeat.unref();
  const held = () => {
    try {
      const current = fs.statSync(file);
      const owned = fs.fstatSync(fd);
      return current.dev === owned.dev && current.ino === owned.ino;
    } catch {
      return false;
    }
  };
  const release = () => {
    clearInterval(heartbeat);
    if (!holds.delete(release)) return;
    if (!holds.size) for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, onSignal);
    try {
      if (held()) displace(file, fs.fstatSync(fd));
    } catch {}
    fs.closeSync(fd);
  };
  if (!holds.size) for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, onSignal);
  holds.add(release);
  return { release, held };
}

export async function withLock(fn, { deadline = Date.now() + 5000, file = paths().lockFile, stealLive = true } = {}) {
  let lock;
  try {
    for (;;) {
      if (Date.now() >= deadline)
        throw new CliError(`wechat: another inbox process holds ${path.basename(file)}`, EXIT.TIMEOUT);
      lock = acquire(file, undefined, stealLive);
      if (lock?.held()) break;
      lock?.release();
      await sleep(Math.min(500, deadline - Date.now()));
    }
    return await fn(lock);
  } catch (error) {
    throw cliError(error);
  } finally {
    lock?.release();
  }
}

export function headers(token) {
  return {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    Authorization: `Bearer ${token}`,
    'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString('base64'),
  };
}

async function request(url, endpoint, options, { timeoutMs, deadline, token = '' }) {
  const redact = text => (token ? String(text).replaceAll(token, '***') : String(text));
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new DOMException('Request deadline elapsed', 'AbortError');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, remaining));
    let retryAfter;
    try {
      const response = await fetch(url, { ...options(), signal: controller.signal });
      if (response.status === 401) throw new CliError(expiredMessage);
      if (response.status === 429) {
        // rate limits are absorbed here so the agent never has to handle them
        const seconds = Number(response.headers.get('Retry-After') ?? 2);
        retryAfter = Math.min(Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 2000, 60000);
        await response.body?.cancel();
        if (Date.now() + retryAfter > deadline)
          throw Object.assign(new CliError(`wechat: ${endpoint} rate limited (HTTP 429), try again later`), {
            status: 429,
          });
      } else {
        if (!response.ok)
          throw Object.assign(
            new CliError(
              `wechat: ${endpoint} HTTP ${response.status}: ${redact((await response.text()).slice(0, 200))}`,
            ),
            { status: response.status },
          );
        let result;
        try {
          result = await response.json();
        } catch {
          throw new CliError(`wechat: ${endpoint} returned invalid JSON`);
        }
        if (result?.ret === -14 || result?.errcode === -14) throw new CliError(expiredMessage);
        if ((result?.ret != null && result.ret !== 0) || (result?.errcode != null && result.errcode !== 0)) {
          throw new CliError(
            `wechat: ${endpoint} ret=${result.ret} errcode=${result.errcode} ${redact(result.errmsg ?? '')}`,
          );
        }
        return result;
      }
    } catch (error) {
      throw cliError(error);
    } finally {
      clearTimeout(timer);
    }
    await sleep(retryAfter);
  }
}

export async function apiPost(baseUrl, endpoint, body, { token, timeoutMs = 15000, deadline = Date.now() + 600000 }) {
  try {
    const url = new URL(endpoint, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
    return await request(
      url,
      endpoint,
      () => ({ method: 'POST', headers: headers(token), body: JSON.stringify(body) }),
      { timeoutMs, deadline, token },
    );
  } catch (error) {
    throw cliError(error);
  }
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
    const msg = {
      from_user_id: '',
      to_user_id: cfg.userId,
      client_id: `ask-human-${Date.now()}-${randomBytes(8).toString('hex')}`,
      message_type: 2,
      message_state: 2,
      item_list: [{ type: 1, text_item: { text: chunk } }],
    };
    if (contextToken) msg.context_token = contextToken;
    await apiPost(cfg.baseUrl, 'ilink/bot/sendmessage', { msg }, { token: cfg.token });
  }
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

export function formatInbox(items) {
  const pad = number => String(number).padStart(2, '0');
  return (
    items
      .map(item => {
        const date = new Date(item.time);
        const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
        return `[${stamp}]${item.re ? ` re: "${item.re}"` : ''}\n${item.text}`;
      })
      .join('\n---\n') + (items.length ? '\n' : '')
  );
}

export async function fetchUpdates(cfg, cursor, timeoutMs, deadline) {
  try {
    const result = await apiPost(
      cfg.baseUrl,
      'ilink/bot/getupdates',
      { get_updates_buf: cursor || '' },
      { token: cfg.token, timeoutMs, deadline },
    );
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

const alive = pid => {
  try {
    return process.kill(pid, 0);
  } catch (error) {
    return error.code === 'EPERM';
  }
};

const withQueue = (key, fn, deadline) =>
  withLock(fn, { file: path.join(sessionDir(key), 'queue.lock'), deadline, stealLive: false });

async function enqueue(key, items, held, deadline) {
  const lines = items.map(item => `${JSON.stringify(item)}\n`).join('');
  try {
    return await withQueue(
      key,
      () => {
        if (!held()) return false;
        const fd = fs.openSync(path.join(sessionDir(key), 'queue.jsonl'), 'a+', 0o600);
        try {
          const size = fs.fstatSync(fd).size;
          const tail = Buffer.alloc(1);
          if (size && fs.readSync(fd, tail, 0, 1, size - 1) && tail[0] !== 10) fs.writeSync(fd, '\n');
          fs.appendFileSync(fd, lines);
        } finally {
          fs.closeSync(fd);
        }
        return true;
      },
      deadline,
    );
  } catch (error) {
    if (error.exitCode === EXIT.TIMEOUT) throw new CliError(error.message);
    throw error;
  }
}

// moves queue.jsonl and dead consumers' claims under this pid; returns the claim files oldest first
function claimQueue(key, deadline) {
  const dir = sessionDir(key);
  return withQueue(
    key,
    () => {
      const older = [];
      for (const name of fs.readdirSync(dir)) {
        const owner = /^queue\.jsonl\.(\d+)(\.|$)/.exec(name)?.[1];
        if (!owner) continue;
        if (Number(owner) === process.pid) {
          older.push(name);
          continue;
        }
        if (alive(Number(owner))) continue;
        const taken = `queue.jsonl.${process.pid}.${name.slice('queue.jsonl.'.length)}`;
        try {
          fs.renameSync(path.join(dir, name), path.join(dir, taken));
          older.push(taken);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      const files = older
        .map(name => ({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
        .sort((a, b) => a.mtime - b.mtime)
        .map(entry => path.join(dir, entry.name));
      const queue = path.join(dir, 'queue.jsonl');
      const fresh = `${queue}.${process.pid}`;
      if (fs.existsSync(queue)) {
        if (fs.existsSync(fresh)) {
          const aside = `${fresh}.${Date.now()}`;
          fs.renameSync(fresh, aside);
          files[files.indexOf(fresh)] = aside;
        }
        fs.renameSync(queue, fresh);
        files.push(fresh);
      }
      return files;
    },
    deadline,
  );
}

async function dequeue(key, handOver, deadline) {
  const files = await claimQueue(key, deadline);
  const items = [];
  const corrupt = new Set();
  for (const file of files) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const item = JSON.parse(line);
        if (
          typeof item?.text !== 'string' ||
          !Number.isFinite(item.time) ||
          !Number.isFinite(new Date(item.time).getTime()) ||
          typeof item.re !== 'string' ||
          typeof item.from !== 'string' ||
          typeof item.contextToken !== 'string'
        ) {
          corrupt.add(file);
          continue;
        }
        items.push(item);
      } catch {
        corrupt.add(file);
      }
    }
  }
  if (items.length) await handOver(items);
  for (const file of files) {
    if (corrupt.has(file)) {
      const destination = path.join(sessionDir(key), `queue.jsonl.corrupt.${randomBytes(16).toString('hex')}`);
      fs.renameSync(file, destination);
      process.stderr.write(`${new CliError(`corrupt queue preserved at ${destination}`).message}\n`);
    } else fs.unlinkSync(file);
  }
}

function route(items, key) {
  const known = sessions();
  const latest = known.filter(session => session.since).sort((a, b) => b.since - a.since)[0];
  const targets = [];
  for (const item of items) {
    const target = (item.re && known.find(session => session.title === item.re)?.key) || latest?.key || key;
    if (targets.at(-1)?.[0] === target) targets.at(-1)[1].push(item);
    else targets.push([target, [item]]);
  }
  return targets;
}

function publishRecovery(items, key) {
  const name = `${String(Date.now()).padStart(16, '0')}-${String(process.hrtime.bigint()).padStart(24, '0')}-${randomBytes(8).toString('hex')}.json`;
  writeJson(path.join(paths().recoveryDir, name), { targets: [...route(items, key)] });
}

async function replayRecovery(held, deadline) {
  const { recoveryDir } = paths();
  let names;
  try {
    names = fs.readdirSync(recoveryDir);
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
  for (const name of names.filter(name => /^\d{16}-\d{24}-[a-f0-9]{16}\.json$/.test(name)).sort()) {
    if (!held()) return false;
    if (Date.now() >= deadline) throw new CliError('wechat: recovery deadline elapsed');
    const file = path.join(recoveryDir, name);
    const batch = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (
      !Array.isArray(batch.targets) ||
      !batch.targets.every(
        target =>
          Array.isArray(target) && target.length === 2 && /^[a-f0-9]{16}$/.test(target[0]) && Array.isArray(target[1]),
      )
    )
      throw new CliError(`wechat: invalid recovery batch ${file}`);
    appendHistory(batch.targets.flatMap(([, items]) => items));
    for (const [target, items] of batch.targets) {
      if (!held() || !(await enqueue(target, items, held, deadline)) || !held()) return false;
    }
    if (!held()) return false;
    fs.unlinkSync(file);
  }
  return true;
}

export async function drain(cfg, { waitSec = 0, since = 0, onItems, title = '' } = {}) {
  const key = registerSession(title);
  const started = Date.now();
  const deadline = started + (waitSec > 0 ? waitSec * 1000 : 5000);
  const items = [];
  let poll;
  let waiter;
  let succeeded = false;
  let lastError;
  let backoff = 2000;
  let graceEnd = 0;
  const endTime = () => Math.min(graceEnd || deadline, deadline);
  const reclaim = async () => {
    poll?.release();
    for (;;) {
      const end = endTime();
      if (Date.now() >= end) throw new CliError('wechat: another inbox process holds poll.lock');
      poll = acquire(paths().lockFile);
      if (poll?.held()) break;
      poll?.release();
      await sleep(Math.min(500, end - Date.now()));
    }
  };
  const recover = async () => {
    while (!poll.held() || !(await replayRecovery(() => poll.held(), endTime()))) await reclaim();
  };
  const handOver = async received => {
    items.push(...received);
    await onItems?.(received);
    if (waitSec > 0 && !graceEnd) graceEnd = Date.now() + 2000;
  };
  try {
    for (;;) {
      if (Date.now() >= endTime()) break;
      try {
        await dequeue(key, handOver, endTime());
      } catch (error) {
        if (error.exitCode !== EXIT.TIMEOUT) throw error;
        if (waitSec === 0) throw new CliError(error.message);
        break;
      }
      const end = endTime();
      if (waitSec === 0 ? items.length : Date.now() >= end) break;
      if (waiter && !waiter.held()) {
        waiter.release();
        waiter = undefined;
      }
      if (waitSec > 0)
        waiter ??= acquire(
          path.join(sessionDir(key), 'waiter.json'),
          JSON.stringify({ pid: process.pid, since: started }),
        );
      if (poll && !poll.held()) {
        poll.release();
        poll = undefined;
      }
      poll ??= acquire(paths().lockFile);
      if (!poll?.held()) {
        if (waitSec === 0) break;
        await sleep(Math.min(500, end - Date.now()));
        continue;
      }
      await recover();
      await dequeue(key, handOver, endTime());
      if (waitSec === 0 ? items.length : Date.now() >= endTime()) break;
      if (!poll.held()) continue;
      const originalPoll = poll;
      const now = Date.now();
      const state = loadState();
      let result;
      try {
        const timeout = Math.min(endTime() - now, waitSec === 0 ? 4000 : 40000);
        result = await fetchUpdates(cfg, state.cursor, timeout, endTime());
      } catch (error) {
        if (!(error instanceof CliError) || error.message === expiredMessage) throw error;
        await recover();
        await dequeue(key, handOver, endTime());
        if (items.length) break;
        if (waitSec === 0) {
          if (error.status === 429) break;
          throw error;
        }
        if (graceEnd) break;
        lastError = error;
        await sleep(Math.min(backoff, deadline - Date.now()));
        backoff = Math.min(backoff * 2, 30000);
        continue;
      }
      succeeded = true;
      backoff = 2000;
      const received = humanMessages(result.msgs, cfg.userId).filter(item => item.time >= since);
      if (received.length) publishRecovery(received, key);
      await recover();
      if (poll === originalPoll && poll.held()) {
        state.cursor = result.cursor;
        if (received.at(-1)?.contextToken) state.contextToken = received.at(-1).contextToken;
        saveState(state);
      }
      if (Date.now() >= endTime()) break;
      await dequeue(key, handOver, endTime());
      if (waitSec === 0) break;
      if (!received.length && Date.now() - now < 1000) await sleep(Math.min(1000, endTime() - Date.now()));
    }
    if (waitSec > 0 && !items.length) {
      if (!succeeded && lastError && lastError.status !== 429) throw lastError;
      throw new CliError(`wechat: no message received within ${waitSec} s`, EXIT.TIMEOUT);
    }
    return items;
  } catch (error) {
    throw cliError(error);
  } finally {
    waiter?.release();
    poll?.release();
  }
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
          throw new CliError('wechat: too many wrong codes — try again later');
        case 'expired':
          if (refreshes++ >= 3) throw new CliError('wechat: QR code expired too many times — try again');
          qrcode = '';
          continue;
        case 'scaned_but_redirect':
          if (result.redirect_host) pollBase = `https://${result.redirect_host}`;
          break;
        case 'binded_redirect':
          throw new CliError('wechat: this bot is already bound to another client — log it out there first');
        case 'confirmed':
          if (!result.bot_token || !result.ilink_bot_id) throw new CliError('wechat: incomplete login confirmation');
          return {
            token: result.bot_token,
            baseUrl: result.baseurl || base,
            botId: result.ilink_bot_id,
            userId: result.ilink_user_id || '',
          };
        default:
          throw new CliError(`wechat: unknown login status: ${result.status}`);
      }
      if (pollIntervalMs > 0) await sleep(Math.min(pollIntervalMs, deadline - Date.now()));
    }
    throw new CliError('wechat: login timed out');
  } catch (error) {
    throw cliError(error);
  }
}
