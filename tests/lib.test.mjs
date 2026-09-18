import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const lib = await import(new URL('../skills/ask-human/scripts/_lib.mjs', import.meta.url));
const originalFetch = globalThis.fetch;
const originalDir = process.env.ASK_HUMAN_DIR;
let tempDir;
let calls;
let responses;
const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const isError = (code, pattern) => error =>
  error instanceof lib.CliError && error.exitCode === code && pattern.test(error.message);

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-lib-test-'));
  process.env.ASK_HUMAN_DIR = tempDir;
  calls = [];
  responses = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), ...options });
    assert.ok(responses.length, 'Unexpected fetch: no scripted response');
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(url, options) : next;
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalDir === undefined) delete process.env.ASK_HUMAN_DIR;
  else process.env.ASK_HUMAN_DIR = originalDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('config and state use dynamic paths, secure atomic writes, and safe defaults', () => {
  assert.deepEqual(lib.EXIT, { OK: 0, FAIL: 1, NOT_CONFIGURED: 2, TIMEOUT: 124 });
  assert.equal(lib.CHUNK_LIMIT, 4000);
  assert.equal(
    lib.SETUP_SCRIPT,
    path.resolve(path.dirname(new URL('../skills/ask-human/scripts/_lib.mjs', import.meta.url).pathname), 'setup.mjs'),
  );
  assert.deepEqual(lib.paths(), {
    dir: tempDir,
    configFile: path.join(tempDir, 'wechat.json'),
    stateDir: path.join(tempDir, 'wechat'),
    stateFile: path.join(tempDir, 'wechat/state.json'),
    lockFile: path.join(tempDir, 'wechat/poll.lock'),
    historyFile: path.join(tempDir, 'wechat/history.log'),
    sessionsDir: path.join(tempDir, 'wechat/sessions'),
    recoveryDir: path.join(tempDir, 'wechat/recovery'),
  });
  assert.throws(() => lib.loadConfig(), isError(2, /setup\.mjs/));
  assert.deepEqual(lib.loadState(), { cursor: '', contextToken: '' });
  const config = {
    token: 'TOKEN_PLACEHOLDER',
    baseUrl: 'https://example.invalid',
    userId: 'USER_PLACEHOLDER',
    botId: 'BOT_PLACEHOLDER',
  };
  lib.saveConfig(config);
  assert.deepEqual(lib.loadConfig(), config);
  assert.equal(fs.statSync(lib.paths().configFile).mode & 0o777, 0o600);
  lib.saveConfig({ ...config, token: 'NEW_TOKEN_PLACEHOLDER' });
  assert.equal(lib.loadConfig().token, 'NEW_TOKEN_PLACEHOLDER');
  lib.saveState({ cursor: 'CURSOR_PLACEHOLDER', contextToken: 'CONTEXT_PLACEHOLDER' });
  assert.deepEqual(lib.loadState(), { cursor: 'CURSOR_PLACEHOLDER', contextToken: 'CONTEXT_PLACEHOLDER' });
  assert.equal(fs.statSync(lib.paths().stateFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(lib.paths().stateDir).mode & 0o777, 0o700);
  assert.equal(fs.existsSync(`${lib.paths().stateFile}.tmp`), false);
  fs.writeFileSync(lib.paths().configFile, '{');
  assert.throws(() => lib.loadConfig(), isError(2, /setup\.mjs/));
  for (const key of ['token', 'baseUrl', 'userId']) {
    lib.saveConfig({ ...config, [key]: '' });
    assert.throws(() => lib.loadConfig(), isError(2, /setup\.mjs/));
  }
  fs.writeFileSync(lib.paths().stateFile, '{');
  assert.deepEqual(lib.loadState(), { cursor: '', contextToken: '' });
  fs.writeFileSync(lib.paths().stateFile, '{"cursor":5,"contextToken":null}');
  assert.deepEqual(lib.loadState(), { cursor: '', contextToken: '' });
  process.env.ASK_HUMAN_DIR = path.join(tempDir, 'other');
  assert.equal(lib.paths().dir, path.join(tempDir, 'other'));
  assert.throws(() => lib.loadConfig(), isError(2, /setup\.mjs/));
});

test('overlapping registrations of the same title use independent temporary files', context => {
  const writeFile = fs.writeFileSync;
  let interleaved = false;
  context.mock.method(fs, 'writeFileSync', (...args) => {
    const result = writeFile(...args);
    if (!interleaved && String(args[0]).endsWith('.tmp')) {
      interleaved = true;
      lib.registerSession('Shared title');
    }
    return result;
  });
  const key = lib.sessionKey('Shared title');
  assert.equal(lib.registerSession('Shared title'), key);
  const directory = path.join(lib.paths().sessionsDir, key);
  assert.deepEqual(fs.readdirSync(directory), ['title.json']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'title.json'), 'utf8')), {
    title: 'Shared title',
  });
});

const cfg = { token: 'TOKEN_PLACEHOLDER', baseUrl: 'https://example.invalid/account', userId: 'USER_PLACEHOLDER' };
const incoming = (text, extra = {}) => ({
  from_user_id: cfg.userId,
  message_type: 1,
  create_time_ms: 1000,
  item_list: [{ type: 1, text_item: { text } }],
  ...extra,
});
const quoted = (text, title, extra = {}) =>
  incoming(text, { item_list: [{ type: 1, text_item: { text }, ref_msg: { title } }], ...extra });

test('headers use the four required fields and a base64 decimal uint32', () => {
  const result = lib.headers('TOKEN_PLACEHOLDER');
  assert.deepEqual(Object.keys(result).sort(), ['Authorization', 'AuthorizationType', 'Content-Type', 'X-WECHAT-UIN']);
  assert.equal(result['Content-Type'], 'application/json');
  assert.equal(result.AuthorizationType, 'ilink_bot_token');
  assert.equal(result.Authorization, 'Bearer TOKEN_PLACEHOLDER');
  const decoded = Buffer.from(result['X-WECHAT-UIN'], 'base64').toString();
  assert.match(decoded, /^(0|[1-9][0-9]*)$/);
  assert.ok(Number(decoded) <= 0xffffffff);
});

test('apiPost sends JSON to a trailing-slash base and apiGet handles status errors', async () => {
  responses.push(response({ ret: 0 }));
  assert.deepEqual(
    await lib.apiPost(cfg.baseUrl, 'ilink/bot/sendmessage', { msg: 'PLACEHOLDER' }, { token: cfg.token }),
    { ret: 0 },
  );
  assert.equal(calls[0].url, 'https://example.invalid/account/ilink/bot/sendmessage');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].body), { msg: 'PLACEHOLDER' });
  assert.equal(calls[0].headers.Authorization, `Bearer ${cfg.token}`);
  for (const scripted of [response({ ret: -14 }), response({ errcode: -14 }), response({}, 401)]) {
    responses.push(scripted);
    await assert.rejects(
      lib.apiPost(cfg.baseUrl, 'ilink/bot/sendmessage', {}, { token: cfg.token }),
      isError(1, /setup\.mjs/),
    );
  }
  responses.push(response({}, 429, { 'Retry-After': '0' }), response({ ret: 0 }));
  assert.deepEqual(await lib.apiGet('https://example.invalid/retry'), { ret: 0 });
  for (const scripted of [response({}, 500), response({ ret: 5, errmsg: 'bad\nrequest' }), response({ errcode: 6 })]) {
    responses.push(scripted);
    await assert.rejects(lib.apiGet('https://example.invalid/error'), error => {
      assert.ok(isError(1, /HTTP 500|ret=5|errcode=6/)(error));
      assert.equal(error.message.includes('\n'), false);
      return true;
    });
  }
  const before = calls.length;
  responses.push(response({}, 429, { 'Retry-After': '1' }));
  await assert.rejects(
    lib.apiGet('https://example.invalid/limited', { deadline: Date.now() + 500 }),
    isError(1, /HTTP 429/),
  );
  assert.equal(calls.length - before, 1);
  responses.push(
    response({}, 429, { 'Retry-After': '0' }),
    response({}, 429),
    response({}, 429, { 'Retry-After': '0' }),
    response({ ret: 0 }),
  );
  const started = Date.now();
  assert.deepEqual(await lib.apiGet('https://example.invalid/limited'), { ret: 0 });
  assert.ok(Date.now() - started >= 1900, 'missing Retry-After defaults to 2 s');
  assert.equal(calls.length - before, 5);
  responses.push(new Response('not JSON'));
  await assert.rejects(lib.apiGet('https://example.invalid/json'), isError(1, /invalid JSON/));
  responses.push(new Response('proxy saw Bearer TOKEN_PLACEHOLDER', { status: 500 }));
  await assert.rejects(lib.apiPost(cfg.baseUrl, 'ilink/bot/sendmessage', {}, { token: cfg.token }), error => {
    assert.equal(error.message.includes('TOKEN_PLACEHOLDER'), false);
    assert.match(error.message, /HTTP 500: proxy saw Bearer \*\*\*/);
    return true;
  });
  responses.push(new TypeError('network\nfailure'));
  await assert.rejects(lib.apiGet('https://example.invalid/network'), isError(1, /network failure/));
});

test('apiPost handles rate limiting and preserves AbortError including actual timeout', async () => {
  responses.push(response({}, 429, { 'Retry-After': '0' }), response({ ret: 0 }));
  await lib.apiPost(cfg.baseUrl, 'ilink/bot/sendmessage', {}, { token: cfg.token });
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].headers['X-WECHAT-UIN'], calls[1].headers['X-WECHAT-UIN']);
  for (const [scripted, pattern] of [
    [response({}, 500), /HTTP 500/],
    [response({ ret: 5 }), /ret=5/],
  ]) {
    responses.push(scripted);
    await assert.rejects(
      lib.apiPost(cfg.baseUrl, 'ilink/bot/sendmessage', {}, { token: cfg.token }),
      isError(1, pattern),
    );
  }
  const aborted = new DOMException('Request aborted', 'AbortError');
  responses.push(aborted);
  await assert.rejects(
    lib.apiPost(cfg.baseUrl, 'ilink/bot/sendmessage', {}, { token: cfg.token }),
    error => error === aborted,
  );
  responses.push(
    (_url, { signal }) =>
      new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
  );
  await assert.rejects(lib.apiGet('https://example.invalid/timeout', { timeoutMs: 5 }), { name: 'AbortError' });
});

test('rate-limit retries share the original no-wait inbox deadline', async context => {
  const started = Date.now();
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: started });
  responses.push(
    response({}, 429, { 'Retry-After': '4' }),
    (_url, { signal }) =>
      new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
  );
  let settled = false;
  const pending = lib.drain(cfg).then(items => {
    settled = true;
    return items;
  });
  await new Promise(resolve => setImmediate(resolve));
  context.mock.timers.tick(4000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 2);
  assert.equal(settled, false);
  context.mock.timers.tick(1000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, true, 'the second request must stop at the original five-second deadline');
  assert.deepEqual(await pending, []);
  assert.equal(Date.now() - started, 5000);
  assert.equal(fs.existsSync(lib.paths().lockFile), false);
});

test('withLock waits for a foreign lock and releases after success', async () => {
  fs.mkdirSync(lib.paths().stateDir);
  fs.writeFileSync(lib.paths().lockFile, 'FOREIGN_LOCK');
  const timer = setTimeout(() => fs.unlinkSync(lib.paths().lockFile), 200);
  try {
    const started = Date.now();
    assert.equal(await lib.withLock(() => 42), 42);
    assert.ok(Date.now() - started >= 190);
    assert.equal(fs.existsSync(lib.paths().lockFile), false);
  } finally {
    clearTimeout(timer);
  }
});

test('withLock takes over stale locks, times out on fresh locks, and releases on failure', async context => {
  fs.mkdirSync(lib.paths().stateDir);
  fs.writeFileSync(lib.paths().lockFile, 'STALE_LOCK');
  const old = new Date(Date.now() - 40000);
  fs.utimesSync(lib.paths().lockFile, old, old);
  const delays = context.mock.method(globalThis, 'setTimeout');
  assert.equal(await lib.withLock(() => 'acquired'), 'acquired');
  assert.equal(delays.mock.callCount(), 0);
  await assert.rejects(
    lib.withLock(() => {
      throw new Error('callback\nfailed');
    }),
    isError(1, /callback failed/),
  );
  assert.equal(fs.existsSync(lib.paths().lockFile), false);
  fs.writeFileSync(lib.paths().lockFile, 'FRESH_LOCK');
  await assert.rejects(
    lib.withLock(() => assert.fail('Lock must not be acquired'), { deadline: Date.now() + 300 }),
    isError(124, /poll\.lock/),
  );
  assert.equal(fs.existsSync(lib.paths().lockFile), true);
});

test('F1 stale takeover preserves a fresh replacement between stat and rename', async context => {
  const { stateDir, lockFile } = lib.paths();
  fs.mkdirSync(stateDir);
  fs.writeFileSync(lockFile, 'OLD_OWNER');
  const old = new Date(Date.now() - 40000);
  fs.utimesSync(lockFile, old, old);
  const rename = fs.renameSync;
  let replaced = false;
  context.mock.method(fs, 'renameSync', (source, destination) => {
    if (source === lockFile && !replaced) {
      replaced = true;
      rename(lockFile, `${lockFile}.previous`);
      fs.writeFileSync(lockFile, 'FRESH_OWNER');
    }
    return rename(source, destination);
  });
  await assert.rejects(
    lib.withLock(() => assert.fail('Fresh replacement must exclude the contender'), { deadline: Date.now() + 100 }),
    isError(124, /poll\.lock/),
  );
  assert.equal(replaced, true);
  assert.equal(fs.readFileSync(lockFile, 'utf8'), 'FRESH_OWNER');
});

test('F1 stale takeover preserves a heartbeat renewed between stat and rename', async context => {
  const { stateDir, lockFile } = lib.paths();
  fs.mkdirSync(stateDir);
  fs.writeFileSync(lockFile, 'RENEWED_OWNER');
  const old = new Date(Date.now() - 40000);
  fs.utimesSync(lockFile, old, old);
  const rename = fs.renameSync;
  context.mock.method(fs, 'renameSync', (source, destination) => {
    if (source === lockFile) fs.utimesSync(lockFile, new Date(), new Date());
    return rename(source, destination);
  });
  await assert.rejects(
    lib.withLock(() => assert.fail('Renewed heartbeat must exclude the contender'), { deadline: Date.now() + 100 }),
    isError(124, /poll\.lock/),
  );
  assert.equal(fs.readFileSync(lockFile, 'utf8'), 'RENEWED_OWNER');
});

test('F1 mismatched restoration never replaces a third-party lock', async context => {
  const { stateDir, lockFile } = lib.paths();
  fs.mkdirSync(stateDir);
  fs.writeFileSync(lockFile, 'OLD_OWNER');
  const old = new Date(Date.now() - 40000);
  fs.utimesSync(lockFile, old, old);
  const rename = fs.renameSync;
  const link = fs.linkSync;
  context.mock.method(fs, 'renameSync', (source, destination) => {
    if (source === lockFile) {
      rename(lockFile, `${lockFile}.previous`);
      fs.writeFileSync(lockFile, 'SECOND_OWNER');
    }
    return rename(source, destination);
  });
  let restored = false;
  context.mock.method(fs, 'linkSync', (source, destination) => {
    if (destination === lockFile) {
      restored = true;
      fs.writeFileSync(lockFile, 'THIRD_OWNER', { flag: 'wx' });
    }
    return link(source, destination);
  });
  await assert.rejects(
    lib.withLock(() => assert.fail('Third-party lock must exclude the contender'), { deadline: Date.now() + 100 }),
    isError(124, /poll\.lock/),
  );
  assert.equal(restored, true);
  assert.equal(fs.readFileSync(lockFile, 'utf8'), 'THIRD_OWNER');
  assert.deepEqual(fs.readdirSync(stateDir).sort(), ['poll.lock', 'poll.lock.previous']);
});

test('F1 fresh dead-owner lock is recovered immediately and records ownership', async context => {
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  const { stateDir, lockFile } = lib.paths();
  fs.mkdirSync(stateDir);
  fs.writeFileSync(lockFile, JSON.stringify({ pid: dead, since: Date.now() }));
  const delays = context.mock.method(globalThis, 'setTimeout');
  const started = Date.now();
  await lib.withLock(
    lock => {
      assert.equal(lock.held(), true);
      const record = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      assert.equal(record.pid, process.pid);
      assert.ok(record.since >= started);
      fs.renameSync(lockFile, `${lockFile}.previous`);
      fs.writeFileSync(lockFile, 'THIRD_OWNER');
      assert.equal(lock.held(), false);
    },
    { deadline: started + 1000 },
  );
  assert.equal(delays.mock.callCount(), 0);
  assert.equal(fs.readFileSync(lockFile, 'utf8'), 'THIRD_OWNER');
});

test('F1 withLock verifies ownership before entering protected code', async context => {
  const touch = fs.futimesSync;
  const { lockFile } = lib.paths();
  let displaced = false;
  context.mock.method(fs, 'futimesSync', (...args) => {
    const result = touch(...args);
    if (!displaced) {
      displaced = true;
      fs.renameSync(lockFile, `${lockFile}.previous`);
      fs.writeFileSync(lockFile, 'THIRD_OWNER');
    }
    return result;
  });
  await assert.rejects(
    lib.withLock(() => assert.fail('Displaced owner must not enter'), { deadline: Date.now() + 100 }),
    isError(124, /poll\.lock/),
  );
  assert.equal(fs.readFileSync(lockFile, 'utf8'), 'THIRD_OWNER');
});

test('F1 release preserves a replacement installed after its ownership check', async context => {
  const { lockFile } = lib.paths();
  const stat = fs.statSync;
  let releasing = false;
  let replaced = false;
  context.mock.method(fs, 'statSync', (...args) => {
    const result = stat(...args);
    if (args[0] === lockFile && releasing && !replaced) {
      replaced = true;
      fs.renameSync(lockFile, `${lockFile}.previous`);
      fs.writeFileSync(lockFile, 'THIRD_OWNER');
    }
    return result;
  });
  await lib.withLock(() => {
    releasing = true;
  });
  assert.equal(replaced, true);
  assert.equal(fs.readFileSync(lockFile, 'utf8'), 'THIRD_OWNER');
});

test('withLock refreshes its heartbeat and removes the timer on release', async context => {
  const now = Date.now();
  context.mock.timers.enable({ apis: ['Date', 'setInterval'], now });
  await lib.withLock(async () => {
    const before = fs.statSync(lib.paths().lockFile).mtimeMs;
    context.mock.timers.tick(5000);
    assert.ok(fs.statSync(lib.paths().lockFile).mtimeMs >= before + 4900);
  });
  assert.equal(fs.existsSync(lib.paths().lockFile), false);
  context.mock.timers.tick(5000);
  assert.equal(fs.existsSync(lib.paths().lockFile), false);
});

test('withLock release leaves a lock that another process took over in place', async () => {
  await lib.withLock(() => {
    fs.unlinkSync(lib.paths().lockFile);
    fs.writeFileSync(lib.paths().lockFile, 'NEW_OWNER');
  });
  assert.equal(fs.readFileSync(lib.paths().lockFile, 'utf8'), 'NEW_OWNER');
});

test('resetState removes the poll lock, all sessions and the cursor', () => {
  lib.registerSession('A');
  fs.mkdirSync(lib.paths().recoveryDir);
  fs.writeFileSync(path.join(lib.paths().recoveryDir, 'partial.tmp'), '{');
  fs.writeFileSync(lib.paths().lockFile, 'LOCK');
  lib.saveState({ cursor: 'CURSOR_PLACEHOLDER', contextToken: 'CONTEXT_PLACEHOLDER' });
  lib.resetState();
  assert.equal(fs.existsSync(lib.paths().sessionsDir), false);
  assert.equal(fs.existsSync(lib.paths().recoveryDir), false);
  assert.equal(fs.existsSync(lib.paths().lockFile), false);
  assert.deepEqual(lib.loadState(), { cursor: '', contextToken: '' });
});

test('formatOutgoing preserves plain text and adds title and numbered choices', () => {
  assert.equal(
    lib.formatOutgoing({ title: 'Task', message: '* _ [ ] < > &', choices: ['Yes', 'No'] }),
    'Task\n* _ [ ] < > &\n\n1. Yes\n2. No',
  );
  assert.equal(lib.formatOutgoing({ message: 'Message  \n' }), 'Message');
  assert.equal(lib.formatOutgoing({}), '');
});

test('splitText preserves ordering, prefers newlines, and never splits surrogate pairs', () => {
  const text = `${'a'.repeat(2999)}\n${'b'.repeat(2999)}\n${'c'.repeat(3000)}`;
  const chunks = lib.splitText(text);
  assert.deepEqual(chunks, ['a'.repeat(2999), 'b'.repeat(2999), 'c'.repeat(3000)]);
  assert.equal(chunks.join('\n'), text);
  assert.ok(chunks.every(chunk => chunk.length <= 4000));
  assert.deepEqual(lib.splitText('ab cd ef', 5), ['ab cd', 'ef']);
  assert.deepEqual(lib.splitText(`${'a'.repeat(4000)}\nb`), ['a'.repeat(4000), 'b']);
  assert.deepEqual(lib.splitText('\nabc', 2), ['ab', 'c']);
  assert.deepEqual(lib.splitText(`${'a'.repeat(4000)}\n`), ['a'.repeat(4000)]);
  assert.deepEqual(lib.splitText(''), ['']);
  const emoji = '\u{1f600}'.repeat(4500);
  const pieces = lib.splitText(emoji, 3999);
  assert.equal(pieces.join(''), emoji);
  assert.ok(pieces.every(piece => piece.length <= 3999 && piece.isWellFormed()));
  assert.throws(() => lib.splitText('\u{1f600}', 1), isError(1, /limit/));
});

test('humanMessages filters echoes and senders, extracts voice text and reply context', () => {
  const voice = incoming('', {
    context_token: 'CONTEXT_PLACEHOLDER',
    item_list: [
      { type: 2 },
      { type: 1, text_item: { text: 'Caption' }, ref_msg: { title: 'Quoted\nsecond line' } },
      { type: 3, voice_item: { text: 'Transcript' } },
    ],
  });
  const messages = [
    incoming('echo', { message_type: 2 }),
    incoming('stranger', { from_user_id: 'OTHER_USER_PLACEHOLDER' }),
    incoming('', { item_list: [{ type: 2 }] }),
    voice,
  ];
  assert.deepEqual(lib.humanMessages(messages, cfg.userId), [
    { time: 1000, from: cfg.userId, text: 'Caption\nTranscript', re: 'Quoted', contextToken: 'CONTEXT_PLACEHOLDER' },
  ]);
  assert.equal(lib.humanMessages(messages, '').length, 2);
  const fallback = incoming('Answer', {
    item_list: [
      { text_item: { text: 'Answer' }, ref_msg: { message_item: { text_item: { text: 'Fallback\nquote' } } } },
    ],
  });
  assert.equal(lib.humanMessages([fallback], cfg.userId)[0].re, 'Fallback');
});

test('formatInbox uses local minute timestamps, optional quotes, and trailing newline', () => {
  const time = new Date(2026, 0, 2, 3, 4).getTime();
  const date = new Date(time);
  const pad = number => String(number).padStart(2, '0');
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  assert.equal(
    lib.formatInbox([
      { time, text: 'First', re: 'Question' },
      { time, text: 'Second', re: '' },
    ]),
    `[${stamp}] re: "Question"\nFirst\n---\n[${stamp}]\nSecond\n`,
  );
  assert.equal(lib.formatInbox([]), '');
});

test('sendText posts chunks sequentially and includes context only when known', async () => {
  responses.push(response({ ret: 0 }), response({ ret: 0 }), response({ ret: 0 }));
  await lib.sendText(cfg, 'x'.repeat(5000), { contextToken: 'CONTEXT_PLACEHOLDER' });
  await lib.sendText(cfg, 'No context');
  const sent = calls.map(call => JSON.parse(call.body).msg);
  assert.deepEqual(
    sent.map(msg => msg.item_list[0].text_item.text),
    ['x'.repeat(4000), 'x'.repeat(1000), 'No context'],
  );
  for (const msg of sent) {
    assert.equal(msg.from_user_id, '');
    assert.equal(msg.to_user_id, cfg.userId);
    assert.equal(msg.message_type, 2);
    assert.equal(msg.message_state, 2);
    assert.equal(msg.item_list[0].type, 1);
    assert.match(msg.client_id, /^ask-human-\d+-.+$/);
  }
  assert.equal(new Set(sent.map(msg => msg.client_id)).size, 3);
  assert.equal(sent[0].context_token, 'CONTEXT_PLACEHOLDER');
  assert.equal(sent[1].context_token, 'CONTEXT_PLACEHOLDER');
  assert.equal('context_token' in sent[2], false);
});

test('fetchUpdates sends cursor, preserves it on empty response and on AbortError', async () => {
  responses.push(response({ msgs: [], get_updates_buf: '' }), new DOMException('aborted', 'AbortError'));
  assert.deepEqual(await lib.fetchUpdates(cfg, 'CURSOR_PLACEHOLDER', 4000), { msgs: [], cursor: 'CURSOR_PLACEHOLDER' });
  assert.deepEqual(JSON.parse(calls[0].body), { get_updates_buf: 'CURSOR_PLACEHOLDER' });
  assert.deepEqual(await lib.fetchUpdates(cfg, 'CURSOR_PLACEHOLDER', 4000), { msgs: [], cursor: 'CURSOR_PLACEHOLDER' });
  assert.ok(calls[0].url.endsWith('/ilink/bot/getupdates'));
});

test('drain no-wait returns pending messages and persists cursor and context', async () => {
  responses.push(
    response({
      msgs: [incoming('Pending', { context_token: 'CONTEXT_PLACEHOLDER' })],
      get_updates_buf: 'NEXT_CURSOR_PLACEHOLDER',
    }),
  );
  assert.equal((await lib.drain(cfg))[0].text, 'Pending');
  assert.equal(calls.length, 1);
  assert.deepEqual(lib.loadState(), { cursor: 'NEXT_CURSOR_PLACEHOLDER', contextToken: 'CONTEXT_PLACEHOLDER' });
  responses.push(new DOMException('aborted', 'AbortError'));
  assert.deepEqual(await lib.drain(cfg), []);
  assert.deepEqual(lib.loadState(), { cursor: 'NEXT_CURSOR_PLACEHOLDER', contextToken: 'CONTEXT_PLACEHOLDER' });
  responses.push(
    response({
      msgs: [incoming('Old'), incoming('New', { create_time_ms: 2000 })],
      get_updates_buf: 'FILTERED_CURSOR_PLACEHOLDER',
    }),
  );
  assert.deepEqual(
    (await lib.drain(cfg, { since: 1500 })).map(item => item.text),
    ['New'],
  );
  assert.equal(lib.loadState().contextToken, 'CONTEXT_PLACEHOLDER');
});

test('drain wait throttles fast empty polls then collects a two-second grace window', async context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  responses.push(
    response({ msgs: [], get_updates_buf: 'EMPTY_CURSOR_PLACEHOLDER' }),
    () => {
      assert.equal(lib.loadState().cursor, 'EMPTY_CURSOR_PLACEHOLDER');
      return response({
        msgs: [incoming('First', { context_token: 'FIRST_CONTEXT_PLACEHOLDER' })],
        get_updates_buf: 'FIRST_CURSOR_PLACEHOLDER',
      });
    },
    response({
      msgs: [incoming('Second', { context_token: 'SECOND_CONTEXT_PLACEHOLDER' })],
      get_updates_buf: 'SECOND_CURSOR_PLACEHOLDER',
    }),
    ...Array.from({ length: 4 }, () => response({ msgs: [] })),
  );
  const handed = [];
  const pending = lib.drain(cfg, {
    waitSec: 10,
    onItems: items => {
      handed.push(items.map(item => item.text));
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  for (let index = 0; index < 4; index++) {
    context.mock.timers.tick(1000);
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.deepEqual(
    (await pending).map(item => item.text),
    ['First', 'Second'],
  );
  assert.deepEqual(handed, [['First'], ['Second']]);
  assert.ok(calls.length >= 4 && calls.length <= 6, `polls ${calls.length}`);
  assert.deepEqual(
    calls.slice(0, 4).map(call => JSON.parse(call.body).get_updates_buf),
    ['', 'EMPTY_CURSOR_PLACEHOLDER', 'FIRST_CURSOR_PLACEHOLDER', 'SECOND_CURSOR_PLACEHOLDER'],
  );
  assert.deepEqual(lib.loadState(), {
    cursor: 'SECOND_CURSOR_PLACEHOLDER',
    contextToken: 'SECOND_CONTEXT_PLACEHOLDER',
  });
  assert.equal(
    fs.readFileSync(lib.paths().historyFile, 'utf8'),
    lib.formatInbox(lib.humanMessages([incoming('First')], cfg.userId)) +
      '---\n' +
      lib.formatInbox(lib.humanMessages([incoming('Second')], cfg.userId)),
  );
});

test('drain keeps an undelivered message in the session queue and advances the cursor', async () => {
  lib.saveState({ cursor: 'OLD_CURSOR_PLACEHOLDER', contextToken: '' });
  responses.push(
    response({
      msgs: [incoming('Handed', { context_token: 'CONTEXT_PLACEHOLDER' })],
      get_updates_buf: 'NEW_CURSOR_PLACEHOLDER',
    }),
  );
  await assert.rejects(
    lib.drain(cfg, {
      onItems: () => {
        throw new Error('stdout closed');
      },
    }),
    isError(1, /stdout closed/),
  );
  assert.deepEqual(lib.loadState(), { cursor: 'NEW_CURSOR_PLACEHOLDER', contextToken: 'CONTEXT_PLACEHOLDER' });
  const queue = path.join(lib.paths().sessionsDir, lib.sessionKey(''), `queue.jsonl.${process.pid}`);
  assert.equal(JSON.parse(fs.readFileSync(queue, 'utf8')).text, 'Handed');
  assert.equal(fs.existsSync(lib.paths().lockFile), false);
  assert.deepEqual(
    (await lib.drain(cfg)).map(item => item.text),
    ['Handed'],
  );
  assert.equal(calls.length, 1);
  assert.equal(fs.existsSync(queue), false);
  assert.equal(fs.readFileSync(lib.paths().historyFile, 'utf8').split('Handed').length, 2);
});

test('drain no-wait yields nothing while another process holds the lock', async context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  fs.mkdirSync(lib.paths().stateDir);
  fs.writeFileSync(lib.paths().lockFile, 'FOREIGN_LOCK');
  const pending = lib.drain(cfg);
  for (let index = 0; index < 12; index++) {
    await new Promise(resolve => setImmediate(resolve));
    context.mock.timers.tick(500);
  }
  assert.deepEqual(await pending, []);
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(lib.paths().lockFile), true);
});

test('drain no-wait returns queued replies without an API call while the lock is held', async () => {
  fs.mkdirSync(lib.paths().stateDir);
  fs.writeFileSync(lib.paths().lockFile, 'FOREIGN_LOCK');
  const item = { time: 1000, from: cfg.userId, text: 'Queued', re: '', contextToken: '' };
  fs.writeFileSync(sessionFile('B', 'queue.jsonl'), `${JSON.stringify(item)}\n`);
  const started = Date.now();
  assert.deepEqual(await lib.drain(cfg, { title: 'B' }), [item]);
  assert.ok(Date.now() - started < 1000);
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(sessionFile('B', 'queue.jsonl')), false);
  assert.equal(fs.existsSync(lib.paths().lockFile), true);
});

test('drain wait expires without spinning on fast empty polls', async () => {
  responses.push(...Array.from({ length: 4 }, () => response({ msgs: [] })));
  await assert.rejects(lib.drain(cfg, { waitSec: 1 }), isError(124, /no message received within 1 s/));
  assert.ok(calls.length <= 2);
  assert.equal(fs.existsSync(lib.paths().lockFile), false);
});

test('drain backs off transient errors and preserves token-expiry failures', async context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  responses.push(
    response({}, 500),
    response({}, 502),
    response({ msgs: [incoming('Recovered')] }),
    ...Array.from({ length: 3 }, () => response({ msgs: [] })),
  );
  const pending = lib.drain(cfg, { waitSec: 10 });
  await new Promise(resolve => setImmediate(resolve));
  context.mock.timers.tick(1999);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  context.mock.timers.tick(1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 2);
  for (let index = 0; index < 4; index++) {
    context.mock.timers.tick(index ? 1000 : 4000);
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal((await pending)[0].text, 'Recovered');
  assert.equal(calls.length, 5);
  responses.length = 0;
  responses.push(response({ ret: -14 }));
  await assert.rejects(lib.drain(cfg, { waitSec: 10 }), isError(1, /setup\.mjs/));
});

test('drain rethrows last error when no poll succeeded before deadline', async context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  responses.push(response({}, 503));
  const pending = assert.rejects(lib.drain(cfg, { waitSec: 1 }), isError(1, /HTTP 503/));
  await new Promise(resolve => setImmediate(resolve));
  context.mock.timers.tick(1000);
  await pending;
});

test('drain preserves collected messages when its single grace poll fails transiently', async () => {
  responses.push(
    response({
      msgs: [incoming('Collected', { context_token: 'CONTEXT_PLACEHOLDER' })],
      get_updates_buf: 'CURSOR_PLACEHOLDER',
    }),
    response({}, 500),
  );
  assert.equal((await lib.drain(cfg, { waitSec: 10 }))[0].text, 'Collected');
  assert.equal(calls.length, 2);
  assert.deepEqual(lib.loadState(), { cursor: 'CURSOR_PLACEHOLDER', contextToken: 'CONTEXT_PLACEHOLDER' });
});

test('drain wait of four hours still receives a reply arriving after three virtual hours', async context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  responses.push(
    response({ msgs: [] }),
    () => {
      context.mock.timers.tick(3 * 3600 * 1000);
      return response({ msgs: [incoming('Late')], get_updates_buf: 'LATE_CURSOR_PLACEHOLDER' });
    },
    ...Array.from({ length: 4 }, () => response({ msgs: [] })),
  );
  const pending = lib.drain(cfg, { waitSec: 14400 });
  for (let index = 0; index < 5; index++) {
    await new Promise(resolve => setImmediate(resolve));
    context.mock.timers.tick(1000);
  }
  assert.deepEqual(
    (await pending).map(item => item.text),
    ['Late'],
  );
  assert.equal(lib.loadState().cursor, 'LATE_CURSOR_PLACEHOLDER');
  assert.equal(fs.existsSync(lib.paths().lockFile), false);
});

test('drain queues a reply quoting another known title for that session instead of the poller', async () => {
  responses.push(response({ msgs: [] }));
  assert.deepEqual(await lib.drain(cfg, { title: 'B' }), []);
  responses.push(response({ msgs: [quoted('For B', 'B\nquestion')], get_updates_buf: 'ROUTED_CURSOR_PLACEHOLDER' }));
  assert.deepEqual(await lib.drain(cfg, { title: 'A' }), []);
  assert.equal(lib.loadState().cursor, 'ROUTED_CURSOR_PLACEHOLDER');
  assert.deepEqual(
    (await lib.drain(cfg, { title: 'B' })).map(item => item.text),
    ['For B'],
  );
  assert.equal(calls.length, 2);
});

const sessionFile = (title, name) => path.join(lib.paths().sessionsDir, lib.registerSession(title), name);
const waiterFixture = (title, since, ageMs = 0) => {
  const file = sessionFile(title, 'waiter.json');
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, since }));
  const stamp = new Date(Date.now() - ageMs);
  fs.utimesSync(file, stamp, stamp);
};

test('drain routes unquoted replies to the most recently started active waiter, skipping stale ones', async () => {
  waiterFixture('A', 1000);
  waiterFixture('B', 2000);
  waiterFixture('C', 3000, 40000);
  responses.push(
    response({
      msgs: [incoming('Unquoted'), quoted('Quoted A', 'A\nquestion')],
      get_updates_buf: 'CURSOR_PLACEHOLDER',
    }),
  );
  assert.deepEqual(await lib.drain(cfg), []);
  assert.deepEqual(
    (await lib.drain(cfg, { title: 'B' })).map(item => item.text),
    ['Unquoted'],
  );
  assert.deepEqual(
    (await lib.drain(cfg, { title: 'A' })).map(item => item.text),
    ['Quoted A'],
  );
  assert.equal(fs.existsSync(sessionFile('C', 'queue.jsonl')), false);
  assert.equal(calls.length, 1);
  assert.equal(lib.loadState().cursor, 'CURSOR_PLACEHOLDER');
});

const deferred = () => {
  let resolve;
  const promise = new Promise(done => (resolve = done));
  return { promise, resolve };
};
const settle = ms => new Promise(resolve => setTimeout(resolve, ms));

test('F2 queue contention respects the consumer original one-second deadline', async context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const file = sessionFile('B', 'queue.lock');
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, since: Date.now() }));
  let outcome;
  const pending = lib.drain(cfg, { title: 'B', waitSec: 1 }).then(
    value => (outcome = value),
    error => (outcome = error),
  );
  try {
    await new Promise(resolve => setImmediate(resolve));
    context.mock.timers.tick(1000);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(isError(124, /no message received within 1 s/)(outcome), String(outcome));
    assert.equal(calls.length, 0);
  } finally {
    fs.rmSync(file, { force: true });
    context.mock.timers.tick(500);
    await pending;
  }
});

test('F2 withLock never acquires after its deadline, including a just-released lock', async context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  await assert.rejects(
    lib.withLock(() => assert.fail('Expired acquisition'), { deadline: Date.now() }),
    isError(124, /poll.lock/),
  );
  assert.equal(fs.existsSync(lib.paths().lockFile), false);
  fs.mkdirSync(lib.paths().stateDir, { recursive: true });
  fs.writeFileSync(lib.paths().lockFile, JSON.stringify({ pid: process.pid }));
  const pending = assert.rejects(
    lib.withLock(() => assert.fail('Late acquisition'), { deadline: Date.now() + 125 }),
    isError(124, /poll.lock/),
  );
  fs.unlinkSync(lib.paths().lockFile);
  context.mock.timers.tick(125);
  await pending;
  assert.equal(fs.existsSync(lib.paths().lockFile), false);
});

test('F2 four-hour consumer remains pending after 35 seconds of live queue contention', async context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const file = sessionFile('B', 'queue.lock');
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid }));
  fs.writeFileSync(lib.paths().lockFile, JSON.stringify({ pid: process.pid }));
  let outcome;
  const pending = lib.drain(cfg, { title: 'B', waitSec: 14400 }).then(
    value => (outcome = value),
    error => (outcome = error),
  );
  try {
    context.mock.timers.tick(35001);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(outcome, undefined);
    const item = lib.humanMessages([incoming('After contention')], cfg.userId)[0];
    fs.writeFileSync(sessionFile('B', 'queue.jsonl'), `${JSON.stringify(item)}\n`);
    fs.utimesSync(lib.paths().lockFile, new Date(), new Date());
  } finally {
    fs.rmSync(file, { force: true });
    context.mock.timers.tick(500);
    await new Promise(resolve => setImmediate(resolve));
    context.mock.timers.tick(2000);
    await pending;
  }
  assert.deepEqual(
    outcome.map(item => item.text),
    ['After contention'],
  );
  assert.equal(calls.length, 0);
});

test('F2 destination queue contention fails at the poller deadline without advancing cursor', async context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const file = sessionFile('B', 'queue.lock');
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid }));
  const original = { cursor: 'OLD_CURSOR_PLACEHOLDER', contextToken: 'OLD_CONTEXT_PLACEHOLDER' };
  lib.saveState(original);
  responses.push(response({ msgs: [quoted('For B', 'B')], get_updates_buf: 'NEW_CURSOR_PLACEHOLDER' }));
  let outcome;
  const pending = lib.drain(cfg, { title: 'A', waitSec: 1 }).then(
    value => (outcome = value),
    error => (outcome = error),
  );
  try {
    await new Promise(resolve => setImmediate(resolve));
    context.mock.timers.tick(1000);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(isError(1, /queue.lock/)(outcome), String(outcome));
    assert.deepEqual(lib.loadState(), original);
    assert.match(fs.readFileSync(lib.paths().historyFile, 'utf8'), /For B/);
    assert.equal(fs.existsSync(sessionFile('B', 'queue.jsonl')), false);
  } finally {
    fs.rmSync(file, { force: true });
    context.mock.timers.tick(500);
    await pending;
  }
});

test('R2 expired displaced response preserves a ready batch without rolling newer state back', async context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  lib.registerSession('B');
  lib.registerSession('C');
  lib.saveState({ cursor: 'OLD_CURSOR_PLACEHOLDER', contextToken: 'OLD_CONTEXT_PLACEHOLDER' });
  const current = { cursor: 'CURRENT_CURSOR_PLACEHOLDER', contextToken: 'CURRENT_CONTEXT_PLACEHOLDER' };
  const { lockFile, stateDir } = lib.paths();
  responses.push(() => {
    fs.renameSync(lockFile, `${lockFile}.previous`);
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid }));
    lib.saveState(current);
    context.mock.timers.tick(1000);
    return response({
      msgs: [quoted('Durable for B', 'B\nquestion', { context_token: 'STALE_CONTEXT_PLACEHOLDER' })],
      get_updates_buf: 'STALE_CURSOR_PLACEHOLDER',
    });
  });
  const started = Date.now();
  await assert.rejects(lib.drain(cfg, { title: 'A', waitSec: 1 }), isError(1, /poll.lock/));
  assert.equal(Date.now(), started + 1000);
  assert.deepEqual(lib.loadState(), current);
  const recovery = path.join(stateDir, 'recovery');
  assert.ok(fs.existsSync(recovery), 'received B reply must be durable before expired reclamation');
  const ready = fs.readdirSync(recovery).filter(name => name.endsWith('.json'));
  assert.equal(ready.length, 1);
  assert.match(fs.readFileSync(path.join(recovery, ready[0]), 'utf8'), /Durable for B/);
  fs.unlinkSync(lockFile);
  assert.deepEqual(
    (await lib.drain(cfg, { title: 'B' })).map(item => item.text),
    ['Durable for B'],
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(lib.loadState(), current);
  assert.deepEqual(fs.readdirSync(recovery), []);
  assert.equal(fs.existsSync(sessionFile('A', 'queue.jsonl')), false);
  assert.equal(fs.existsSync(sessionFile('C', 'queue.jsonl')), false);
});

const recoveryFixture = (messages, title, sequence = 1) => {
  const file = path.join(
    lib.paths().recoveryDir,
    `0000000000000001-${String(sequence).padStart(24, '0')}-0000000000000000.json`,
  );
  fs.mkdirSync(lib.paths().recoveryDir, { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ targets: [[lib.registerSession(title), lib.humanMessages(messages, cfg.userId)]] }),
  );
  return file;
};

test('R2 receipt routing stays fixed and history retains interleaved message order', async context => {
  const now = Date.now();
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
  waiterFixture('B', now + 1);
  lib.registerSession('C');
  responses.push(() => {
    fs.renameSync(lib.paths().lockFile, `${lib.paths().lockFile}.previous`);
    fs.writeFileSync(lib.paths().lockFile, JSON.stringify({ pid: process.pid }));
    context.mock.timers.tick(1000);
    return response({ msgs: [incoming('First B'), quoted('Middle C', 'C'), incoming('Last B')] });
  });
  await assert.rejects(lib.drain(cfg, { title: 'A', waitSec: 1 }), isError(1, /poll.lock/));
  waiterFixture('C', now + 2000);
  fs.unlinkSync(lib.paths().lockFile);
  assert.deepEqual(
    (await lib.drain(cfg, { title: 'B' })).map(item => item.text),
    ['First B', 'Last B'],
  );
  assert.deepEqual(
    (await lib.drain(cfg, { title: 'C' })).map(item => item.text),
    ['Middle C'],
  );
  const history = fs.readFileSync(lib.paths().historyFile, 'utf8');
  assert.ok(history.indexOf('First B') < history.indexOf('Middle C'));
  assert.ok(history.indexOf('Middle C') < history.indexOf('Last B'));
  assert.equal(calls.length, 1);
});

test('R2 partial history or second-target enqueue failure retains the whole batch for local replay', async context => {
  const append = fs.appendFileSync;
  for (const stage of ['history', 'second']) {
    lib.resetState();
    lib.registerSession('B');
    lib.registerSession('C');
    const original = { cursor: 'CURRENT_CURSOR_PLACEHOLDER', contextToken: 'CURRENT_CONTEXT_PLACEHOLDER' };
    lib.saveState(original);
    let appends = 0;
    const failure = context.mock.method(fs, 'appendFileSync', (...args) => {
      appends++;
      if (appends === (stage === 'history' ? 1 : 3)) throw new Error('injected durable write failure');
      return append(...args);
    });
    responses.push(
      response({
        msgs: [quoted('First target', 'B'), quoted('Second target', 'C')],
        get_updates_buf: 'UNCOMMITTED_CURSOR_PLACEHOLDER',
      }),
    );
    await assert.rejects(lib.drain(cfg, { title: 'A' }), isError(1, /injected durable write/));
    failure.mock.restore();
    assert.equal(fs.readdirSync(lib.paths().recoveryDir).length, 1);
    assert.deepEqual(lib.loadState(), original);
    if (stage === 'second') {
      assert.equal(JSON.parse(fs.readFileSync(sessionFile('B', 'queue.jsonl'), 'utf8')).text, 'First target');
    }
    const count = calls.length;
    assert.deepEqual(
      (await lib.drain(cfg, { title: 'C' })).map(item => item.text),
      ['Second target'],
    );
    assert.deepEqual(
      (await lib.drain(cfg, { title: 'B' })).map(item => item.text),
      stage === 'second' ? ['First target', 'First target'] : ['First target'],
    );
    assert.equal(calls.length, count);
    assert.deepEqual(fs.readdirSync(lib.paths().recoveryDir), []);
    assert.deepEqual(lib.loadState(), original);
  }
});

test('R2 own recovery callback failure retains its claim without another API call', async () => {
  const ready = recoveryFixture([incoming('Retry stdout')], 'B');
  await assert.rejects(
    lib.drain(cfg, {
      title: 'B',
      onItems: () => {
        throw new Error('stdout closed');
      },
    }),
    isError(1, /stdout closed/),
  );
  assert.equal(fs.existsSync(ready), false);
  assert.equal(fs.existsSync(sessionFile('B', `queue.jsonl.${process.pid}`)), true);
  assert.deepEqual(
    (await lib.drain(cfg, { title: 'B' })).map(item => item.text),
    ['Retry stdout'],
  );
  assert.equal(calls.length, 0);
});

test('R2 concurrent ready publication survives snapshot replay and incomplete temporary files are ignored', async context => {
  const first = recoveryFixture([incoming('First')], 'B', 1);
  const temporary = path.join(lib.paths().recoveryDir, 'incomplete.json.publisher.tmp');
  fs.writeFileSync(temporary, '{');
  const append = fs.appendFileSync;
  let later;
  context.mock.method(fs, 'appendFileSync', (...args) => {
    const result = append(...args);
    if (!later) later = recoveryFixture([incoming('Later')], 'C', 2);
    return result;
  });
  assert.deepEqual(
    (await lib.drain(cfg, { title: 'B' })).map(item => item.text),
    ['First'],
  );
  assert.equal(fs.existsSync(first), false);
  assert.equal(fs.existsSync(later), true);
  assert.deepEqual(
    (await lib.drain(cfg, { title: 'C' })).map(item => item.text),
    ['Later'],
  );
  assert.equal(fs.readFileSync(temporary, 'utf8'), '{');
  assert.equal(calls.length, 0);
});

test('R2 ready batches replay by receipt order rather than directory enumeration', async () => {
  recoveryFixture([incoming('Later')], 'B', 2);
  recoveryFixture([incoming('Earlier')], 'B', 1);
  assert.deepEqual(
    (await lib.drain(cfg, { title: 'B' })).map(item => item.text),
    ['Earlier', 'Later'],
  );
  assert.equal(calls.length, 0);
});

test('R2 ongoing poller delivers ready data before another fetch on success or HTTP 500', async context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  for (const status of [200, 500]) {
    lib.resetState();
    let delivered = false;
    responses.push(() => {
      recoveryFixture([incoming('During request')], 'B');
      return response({ msgs: [] }, status);
    });
    if (status === 200)
      responses.push(() => {
        assert.equal(delivered, true, 'queue must be handed over before next network call');
        context.mock.timers.tick(2000);
        return response({ msgs: [] });
      });
    const pending = lib.drain(cfg, {
      title: 'B',
      waitSec: 10,
      onItems: () => {
        delivered = true;
      },
    });
    await new Promise(resolve => setImmediate(resolve));
    context.mock.timers.tick(1000);
    assert.deepEqual(
      (await pending).map(item => item.text),
      ['During request'],
    );
    assert.equal(delivered, true);
  }
});

test('R2 replay losing ownership after enqueue retains the batch and never restores old state', async context => {
  const ready = recoveryFixture([incoming('Repeat allowed')], 'B');
  const current = { cursor: 'CURRENT_CURSOR_PLACEHOLDER', contextToken: 'CURRENT_CONTEXT_PLACEHOLDER' };
  const append = fs.appendFileSync;
  let displaced = false;
  context.mock.method(fs, 'appendFileSync', (...args) => {
    const result = append(...args);
    if (typeof args[0] === 'number' && !displaced) {
      displaced = true;
      fs.renameSync(lib.paths().lockFile, `${lib.paths().lockFile}.previous`);
      lib.saveState(current);
    }
    return result;
  });
  const open = fs.openSync;
  context.mock.method(fs, 'openSync', (...args) => {
    if (args[0] === lib.paths().lockFile && displaced) assert.equal(fs.existsSync(ready), true);
    return open(...args);
  });
  assert.deepEqual(
    (await lib.drain(cfg, { title: 'B' })).map(item => item.text),
    ['Repeat allowed', 'Repeat allowed'],
  );
  assert.equal(displaced, true);
  assert.equal(fs.existsSync(ready), false);
  assert.deepEqual(lib.loadState(), current);
  assert.equal(calls.length, 0);
});

test('R2 ready publication during HTTP 500 backoff is delivered before the retry request', async context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  let delivered = false;
  responses.push(response({}, 500), () => {
    assert.equal(delivered, true);
    context.mock.timers.tick(2000);
    return response({ msgs: [] });
  });
  const pending = lib.drain(cfg, {
    title: 'B',
    waitSec: 10,
    onItems: () => {
      delivered = true;
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  recoveryFixture([incoming('During backoff')], 'B');
  context.mock.timers.tick(2000);
  assert.deepEqual(
    (await pending).map(item => item.text),
    ['During backoff'],
  );
  assert.equal(calls.length, 2);
});

test('F2 displaced poller reclamation stops at its original deadline with recoverable cursor', async context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const original = { cursor: 'OLD_CURSOR_PLACEHOLDER', contextToken: 'OLD_CONTEXT_PLACEHOLDER' };
  lib.saveState(original);
  const { lockFile } = lib.paths();
  responses.push(() => {
    fs.renameSync(lockFile, `${lockFile}.previous`);
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid }));
    return response({ msgs: [incoming('Not acknowledged')], get_updates_buf: 'NEW_CURSOR_PLACEHOLDER' });
  });
  let outcome;
  const pending = lib.drain(cfg, { waitSec: 1 }).then(
    value => (outcome = value),
    error => (outcome = error),
  );
  try {
    await new Promise(resolve => setImmediate(resolve));
    context.mock.timers.tick(1000);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(isError(1, /poll.lock/)(outcome), String(outcome));
    assert.deepEqual(lib.loadState(), original);
    assert.equal(fs.existsSync(lockFile), true);
  } finally {
    fs.rmSync(lockFile, { force: true });
    context.mock.timers.tick(500);
    await pending;
  }
});

test('F1 displaced fetch waits for current ownership and preserves replies without old cursor or context', async () => {
  const fetched = deferred();
  const replacement = deferred();
  const entered = deferred();
  const current = { cursor: 'CURRENT_CURSOR_PLACEHOLDER', contextToken: 'CURRENT_CONTEXT_PLACEHOLDER' };
  lib.saveState({ cursor: 'OLD_CURSOR_PLACEHOLDER', contextToken: 'OLD_CONTEXT_PLACEHOLDER' });
  responses.push(() => fetched.promise);
  const pending = lib.drain(cfg, { title: 'A' });
  await new Promise(resolve => setImmediate(resolve));
  const { lockFile, historyFile } = lib.paths();
  const old = new Date(Date.now() - 40000);
  fs.utimesSync(lockFile, old, old);
  const owner = lib.withLock(async () => {
    lib.saveState(current);
    waiterFixture('B', Date.now());
    entered.resolve();
    await replacement.promise;
  });
  await entered.promise;
  try {
    fetched.resolve(
      response({
        msgs: [incoming('Fetched while displaced', { context_token: 'STALE_CONTEXT_PLACEHOLDER' })],
        get_updates_buf: 'STALE_CURSOR_PLACEHOLDER',
      }),
    );
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(lib.loadState(), current);
    assert.equal(fs.existsSync(historyFile), false);
    assert.equal(fs.existsSync(sessionFile('B', 'queue.jsonl')), false);
  } finally {
    replacement.resolve();
    await owner;
    await pending;
  }
  assert.deepEqual(await pending, []);
  assert.deepEqual(lib.loadState(), current);
  assert.match(fs.readFileSync(historyFile, 'utf8'), /Fetched while displaced/);
  assert.equal(JSON.parse(fs.readFileSync(sessionFile('B', 'queue.jsonl'), 'utf8')).text, 'Fetched while displaced');
  assert.deepEqual(
    (await lib.drain(cfg, { title: 'B' })).map(item => item.text),
    ['Fetched while displaced'],
  );
  responses.push(response({ msgs: [], get_updates_buf: 'NEXT_CURSOR_PLACEHOLDER' }));
  await lib.drain(cfg, { title: 'A' });
  assert.equal(JSON.parse(calls.at(-1).body).get_updates_buf, current.cursor);
});

test('F1 displacement during handover preserves the current cursor on success and failure', async () => {
  for (const fail of [false, true]) {
    const current = { cursor: 'CURRENT_CURSOR_PLACEHOLDER', contextToken: 'CURRENT_CONTEXT_PLACEHOLDER' };
    responses.push(
      response({
        msgs: [incoming('Handed over', { context_token: 'STALE_CONTEXT_PLACEHOLDER' })],
        get_updates_buf: 'STALE_CURSOR_PLACEHOLDER',
      }),
    );
    const pending = lib.drain(cfg, {
      title: String(fail),
      onItems: async () => {
        const old = new Date(Date.now() - 40000);
        fs.utimesSync(lib.paths().lockFile, old, old);
        await lib.withLock(() => lib.saveState(current));
        if (fail) throw new Error('handover failed');
      },
    });
    if (fail) await assert.rejects(pending, isError(1, /handover failed/));
    else assert.equal((await pending)[0].text, 'Handed over');
    assert.deepEqual(lib.loadState(), current);
    if (fail)
      assert.equal(
        JSON.parse(fs.readFileSync(sessionFile(String(fail), `queue.jsonl.${process.pid}`), 'utf8')).text,
        'Handed over',
      );
  }
});

test('F1 queue mutations wait for stale live owners but promptly recover dead owners', async context => {
  const file = sessionFile('B', 'queue.lock');
  const queue = sessionFile('B', 'queue.jsonl');
  const item = { time: 1000, from: cfg.userId, text: 'Queued', re: '', contextToken: '' };
  fs.writeFileSync(queue, `${JSON.stringify(item)}\n`);
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, since: Date.now() - 40000 }));
  const old = new Date(Date.now() - 40000);
  fs.utimesSync(file, old, old);
  let delivered = false;
  const pending = lib.drain(cfg, {
    title: 'B',
    onItems: () => {
      delivered = true;
    },
  });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(delivered, false);
    assert.equal(fs.existsSync(queue), true);
  } finally {
    fs.rmSync(file, { force: true });
    await pending;
  }
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  fs.writeFileSync(file, JSON.stringify({ pid: dead, since: Date.now() }));
  fs.writeFileSync(queue, `${JSON.stringify(item)}\n`);
  const delays = context.mock.method(globalThis, 'setTimeout');
  assert.deepEqual(await lib.drain(cfg, { title: 'B' }), [item]);
  assert.equal(delays.mock.callCount(), 0);
});

test('F1 enqueue rechecks poll ownership after waiting for the destination queue lock', async () => {
  const queueLock = sessionFile('B', 'queue.lock');
  fs.writeFileSync(queueLock, JSON.stringify({ pid: process.pid, since: Date.now() }));
  responses.push(response({ msgs: [quoted('For B', 'B')], get_updates_buf: 'STALE_CURSOR_PLACEHOLDER' }));
  const pending = lib.drain(cfg, { title: 'A' });
  await new Promise(resolve => setImmediate(resolve));
  const old = new Date(Date.now() - 40000);
  fs.utimesSync(lib.paths().lockFile, old, old);
  const release = deferred();
  const current = { cursor: 'CURRENT_CURSOR_PLACEHOLDER', contextToken: 'CURRENT_CONTEXT_PLACEHOLDER' };
  const owner = lib.withLock(async () => {
    lib.saveState(current);
    await release.promise;
  });
  try {
    fs.unlinkSync(queueLock);
    await settle(550);
    assert.equal(fs.existsSync(sessionFile('B', 'queue.jsonl')), false);
    assert.deepEqual(lib.loadState(), current);
  } finally {
    release.resolve();
    await owner;
    await pending;
  }
  assert.deepEqual(lib.loadState(), current);
  assert.equal(JSON.parse(fs.readFileSync(sessionFile('B', 'queue.jsonl'), 'utf8')).text, 'For B');
});

test('drain waiter consumes its queue while another process holds the poll lock', async () => {
  const first = deferred();
  const second = deferred();
  responses.push(
    () => first.promise.then(() => response({ msgs: [quoted('For B', 'B\nquestion')], get_updates_buf: 'C1' })),
    () => second.promise.then(() => response({ msgs: [incoming('Unquoted')], get_updates_buf: 'C2' })),
    ...Array.from({ length: 4 }, () => response({ msgs: [] })),
  );
  const pollerA = lib.drain(cfg, { waitSec: 8, title: 'A' });
  await settle(50);
  assert.equal(fs.existsSync(lib.paths().lockFile), true);
  assert.equal(calls.length, 1);
  const started = Date.now();
  const waiterB = lib.drain(cfg, { waitSec: 8, title: 'B' });
  await settle(100);
  assert.equal(fs.existsSync(sessionFile('B', 'waiter.json')), true);
  assert.equal(calls.length, 1);
  first.resolve();
  assert.deepEqual(
    (await waiterB).map(item => item.text),
    ['For B'],
  );
  assert.ok(Date.now() - started < 4000);
  assert.equal(fs.existsSync(sessionFile('B', 'waiter.json')), false);
  assert.equal(calls.length, 2);
  assert.equal(fs.existsSync(lib.paths().lockFile), true);
  second.resolve();
  assert.deepEqual(
    (await pollerA).map(item => item.text),
    ['Unquoted'],
  );
  assert.equal(fs.existsSync(lib.paths().lockFile), false);
  assert.equal(lib.loadState().cursor, 'C2');
});

test("drain reclaims dead consumers' claims ahead of newer messages and never touches live ones", async () => {
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  const live = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)']);
  try {
    const dir = path.dirname(sessionFile('B', 'queue.jsonl'));
    const line = text => `${JSON.stringify({ time: 1000, from: cfg.userId, text, re: '', contextToken: '' })}\n`;
    fs.writeFileSync(path.join(dir, `queue.jsonl.${dead}`), line('Leftover'));
    const old = new Date(Date.now() - 5000);
    fs.utimesSync(path.join(dir, `queue.jsonl.${dead}`), old, old);
    fs.writeFileSync(path.join(dir, `queue.jsonl.${live.pid}`), line('Live'));
    fs.writeFileSync(path.join(dir, 'queue.jsonl'), line('Newer'));
    await assert.rejects(
      lib.drain(cfg, {
        title: 'B',
        onItems: () => {
          throw new Error('stdout closed');
        },
      }),
      isError(1, /stdout closed/),
    );
    const claims = () =>
      fs
        .readdirSync(dir)
        .filter(name => name.startsWith('queue.jsonl'))
        .sort();
    assert.deepEqual(
      claims(),
      [`queue.jsonl.${live.pid}`, `queue.jsonl.${process.pid}`, `queue.jsonl.${process.pid}.${dead}`].sort(),
    );
    assert.deepEqual(
      (await lib.drain(cfg, { title: 'B' })).map(item => item.text),
      ['Leftover', 'Newer'],
    );
    assert.deepEqual(claims(), [`queue.jsonl.${live.pid}`]);
    assert.equal(calls.length, 0);
  } finally {
    live.kill();
  }
});

test('F4 failed handover preserves the entire corrupt claim for an ordered retry', async context => {
  const queue = sessionFile('B', 'queue.jsonl');
  const dir = path.dirname(queue);
  const before = lib.humanMessages([incoming('Before')], cfg.userId)[0];
  const after = lib.humanMessages([incoming('After')], cfg.userId)[0];
  const raw = `${JSON.stringify(before)}\n{torn\n${JSON.stringify(after)}\n`;
  fs.writeFileSync(queue, raw);
  const warnings = [];
  context.mock.method(process.stderr, 'write', text => {
    warnings.push(text);
    return true;
  });
  await assert.rejects(
    lib.drain(cfg, {
      title: 'B',
      onItems: items => {
        assert.deepEqual(items, [before, after]);
        throw new Error('stdout closed');
      },
    }),
    isError(1, /stdout closed/),
  );
  const claim = path.join(dir, `queue.jsonl.${process.pid}`);
  assert.equal(fs.readFileSync(claim, 'utf8'), raw);
  assert.deepEqual(warnings, []);
  assert.equal(
    fs.readdirSync(dir).some(name => name.startsWith('queue.jsonl.corrupt.')),
    false,
  );
  assert.deepEqual(await lib.drain(cfg, { title: 'B' }), [before, after]);
  const corrupt = fs.readdirSync(dir).filter(name => name.startsWith('queue.jsonl.corrupt.'));
  assert.equal(corrupt.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, corrupt[0]), 'utf8'), raw);
  assert.equal(fs.existsSync(claim), false);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes(path.join(dir, corrupt[0])));
  assert.equal(calls.length, 0);
});

const qr = () => response({ qrcode: 'QR_HANDLE_PLACEHOLDER +&', qrcode_img_content: 'https://example.invalid/scan' });
const confirmed = () =>
  response({
    status: 'confirmed',
    bot_token: 'TOKEN_PLACEHOLDER',
    ilink_bot_id: 'BOT_PLACEHOLDER',
    baseurl: 'https://example.invalid/account',
    ilink_user_id: 'USER_PLACEHOLDER',
  });

test('login waits, reports scan once, and returns the confirmed account', async () => {
  responses.push(
    qr(),
    response({ status: 'wait' }),
    response({ status: 'scaned' }),
    response({ status: 'scaned' }),
    confirmed(),
  );
  const output = [];
  const urls = [];
  const result = await lib.login({
    out: line => output.push(line),
    ask: () => assert.fail('Unexpected question'),
    onQr: url => urls.push(url),
    pollIntervalMs: 0,
  });
  assert.deepEqual(result, { ...cfg, botId: 'BOT_PLACEHOLDER' });
  assert.deepEqual(urls, ['https://example.invalid/scan']);
  assert.deepEqual(output, ['Scanned — confirm on your phone.']);
  assert.equal(calls[0].url, 'https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3');
  assert.ok(calls[1].url.includes(`qrcode=${encodeURIComponent('QR_HANDLE_PLACEHOLDER +&')}`));
  assert.equal(calls[1].headers['iLink-App-ClientVersion'], '1');
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].headers.Authorization, undefined);
});

test('login refreshes expired QR and handles verification, redirect, and accepted code', async () => {
  responses.push(
    qr(),
    response({ status: 'expired' }),
    qr(),
    response({ status: 'scaned_but_redirect', redirect_host: 'redirect.example.invalid' }),
    response({ status: 'need_verifycode' }),
    response({ status: 'wait' }),
    response({ status: 'scaned' }),
    confirmed(),
  );
  const urls = [];
  const questions = [];
  await lib.login({
    out: () => {},
    onQr: url => urls.push(url),
    ask: async question => {
      questions.push(question);
      return 'CODE_PLACEHOLDER +&';
    },
    pollIntervalMs: 0,
  });
  assert.equal(urls.length, 2);
  assert.deepEqual(questions, ['Enter the number shown in WeChat: ']);
  assert.ok(calls[4].url.startsWith('https://redirect.example.invalid/'));
  assert.ok(calls[5].url.includes(`verify_code=${encodeURIComponent('CODE_PLACEHOLDER +&')}`));
  assert.ok(calls[6].url.includes('verify_code='));
  assert.equal(calls[7].url.includes('verify_code='), false);
});

test('login retries polling network errors, AbortError and gateway 5xx, but fails other API errors', async () => {
  responses.push(
    qr(),
    new TypeError('Network unavailable'),
    new DOMException('aborted', 'AbortError'),
    response({}, 502),
    response({ status: 'confirmed', bot_token: 'TOKEN_PLACEHOLDER', ilink_bot_id: 'BOT_PLACEHOLDER' }),
  );
  const options = { out: () => {}, ask: async () => '', onQr: () => {}, pollIntervalMs: 0 };
  assert.deepEqual(await lib.login(options), {
    token: 'TOKEN_PLACEHOLDER',
    botId: 'BOT_PLACEHOLDER',
    baseUrl: 'https://ilinkai.weixin.qq.com',
    userId: '',
  });
  responses.push(qr(), response({}, 404));
  await assert.rejects(lib.login(options), isError(1, /HTTP 404/));
  responses.push(qr(), response({ ret: 7 }));
  await assert.rejects(lib.login(options), isError(1, /ret=7/));
});

test('login rejects blocked codes, bound bots, incomplete confirmation, and exhausted refreshes', async () => {
  const options = { out: () => {}, ask: async () => '', onQr: () => {}, pollIntervalMs: 0 };
  for (const [status, pattern] of [
    ['verify_code_blocked', /too many wrong codes/],
    ['binded_redirect', /already bound/],
    ['confirmed', /confirm/],
  ]) {
    responses.push(qr(), response({ status }));
    await assert.rejects(lib.login(options), isError(1, pattern));
  }
  const before = calls.length;
  for (let index = 0; index < 4; index++) responses.push(qr(), response({ status: 'expired' }));
  await assert.rejects(lib.login(options), isError(1, /expired/));
  assert.equal(calls.length - before, 8);
});

test('login enforces its eight-minute deadline', async context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  responses.push(qr(), () => {
    context.mock.timers.tick(8 * 60 * 1000);
    return response({ status: 'wait' });
  });
  await assert.rejects(
    lib.login({ out: () => {}, ask: async () => '', onQr: () => {}, pollIntervalMs: 0 }),
    isError(1, /login timed out/),
  );
});
