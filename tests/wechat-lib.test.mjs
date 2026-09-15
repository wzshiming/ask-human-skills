import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const lib = await import(new URL('../skills/wechat/scripts/_lib.mjs', import.meta.url));
const originalFetch = globalThis.fetch;
const originalDir = process.env.ASK_HUMAN_DIR;
let tempDir;
let calls;
let responses;
const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const isError = (code, pattern) => error => error instanceof lib.CliError && error.exitCode === code && pattern.test(error.message);

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
  assert.equal(lib.SETUP_SCRIPT, path.resolve(path.dirname(new URL('../skills/wechat/scripts/_lib.mjs', import.meta.url).pathname), 'setup.mjs'));
  assert.deepEqual(lib.paths(), {
    dir: tempDir, configFile: path.join(tempDir, 'wechat.json'),
    stateDir: path.join(tempDir, 'wechat'), stateFile: path.join(tempDir, 'wechat/state.json'),
    lockFile: path.join(tempDir, 'wechat/poll.lock'), historyFile: path.join(tempDir, 'wechat/history.log'),
  });
  assert.throws(() => lib.loadConfig(), isError(2, /setup\.mjs/));
  assert.deepEqual(lib.loadState(), { cursor: '', contextToken: '' });
  const config = { token: 'TOKEN_PLACEHOLDER', baseUrl: 'https://example.invalid', userId: 'USER_PLACEHOLDER', botId: 'BOT_PLACEHOLDER' };
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

const cfg = { token: 'TOKEN_PLACEHOLDER', baseUrl: 'https://example.invalid/account', userId: 'USER_PLACEHOLDER' };
const incoming = (text, extra = {}) => ({
  from_user_id: cfg.userId, message_type: 1, create_time_ms: 1000,
  item_list: [{ type: 1, text_item: { text } }], ...extra,
});

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
  assert.deepEqual(await lib.apiPost(cfg.baseUrl, 'ilink/bot/sendmessage', { msg: 'PLACEHOLDER' }, { token: cfg.token }), { ret: 0 });
  assert.equal(calls[0].url, 'https://example.invalid/account/ilink/bot/sendmessage');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].body), { msg: 'PLACEHOLDER' });
  assert.equal(calls[0].headers.Authorization, `Bearer ${cfg.token}`);
  for (const scripted of [response({ ret: -14 }), response({ errcode: -14 }), response({}, 401)]) {
    responses.push(scripted);
    await assert.rejects(lib.apiPost(cfg.baseUrl, 'ilink/bot/sendmessage', {}, { token: cfg.token }), isError(1, /setup\.mjs/));
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
  await assert.rejects(lib.apiGet('https://example.invalid/limited', { deadline: Date.now() + 500 }), isError(1, /HTTP 429/));
  assert.equal(calls.length - before, 1);
  responses.push(response({}, 429, { 'Retry-After': '0' }), response({}, 429), response({}, 429, { 'Retry-After': '0' }), response({ ret: 0 }));
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
  for (const [scripted, pattern] of [[response({}, 500), /HTTP 500/], [response({ ret: 5 }), /ret=5/]]) {
    responses.push(scripted);
    await assert.rejects(lib.apiPost(cfg.baseUrl, 'ilink/bot/sendmessage', {}, { token: cfg.token }), isError(1, pattern));
  }
  const aborted = new DOMException('Request aborted', 'AbortError');
  responses.push(aborted);
  await assert.rejects(lib.apiPost(cfg.baseUrl, 'ilink/bot/sendmessage', {}, { token: cfg.token }), error => error === aborted);
  responses.push((_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
  await assert.rejects(lib.apiGet('https://example.invalid/timeout', { timeoutMs: 5 }), { name: 'AbortError' });
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
  } finally { clearTimeout(timer); }
});

test('withLock takes over stale locks, times out on fresh locks, and releases on failure', async () => {
  fs.mkdirSync(lib.paths().stateDir);
  fs.writeFileSync(lib.paths().lockFile, 'STALE_LOCK');
  const old = new Date(Date.now() - 40000);
  fs.utimesSync(lib.paths().lockFile, old, old);
  const started = Date.now();
  assert.equal(await lib.withLock(() => 'acquired'), 'acquired');
  assert.ok(Date.now() - started < 200);
  await assert.rejects(lib.withLock(() => { throw new Error('callback\nfailed'); }), isError(1, /callback failed/));
  assert.equal(fs.existsSync(lib.paths().lockFile), false);
  fs.writeFileSync(lib.paths().lockFile, 'FRESH_LOCK');
  await assert.rejects(lib.withLock(() => assert.fail('Lock must not be acquired'), { deadline: Date.now() + 300 }), isError(124, /poll lock/));
  assert.equal(fs.existsSync(lib.paths().lockFile), true);
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

test('formatOutgoing preserves plain text and adds title and numbered choices', () => {
  assert.equal(lib.formatOutgoing({ title: 'Task', message: '* _ [ ] < > &', choices: ['Yes', 'No'] }), 'Task\n* _ [ ] < > &\n\n1. Yes\n2. No');
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
  const voice = incoming('', { context_token: 'CONTEXT_PLACEHOLDER', item_list: [
    { type: 2 }, { type: 1, text_item: { text: 'Caption' }, ref_msg: { title: 'Quoted\nsecond line' } },
    { type: 3, voice_item: { text: 'Transcript' } },
  ] });
  const messages = [incoming('echo', { message_type: 2 }), incoming('stranger', { from_user_id: 'OTHER_USER_PLACEHOLDER' }), incoming('', { item_list: [{ type: 2 }] }), voice];
  assert.deepEqual(lib.humanMessages(messages, cfg.userId), [{ time: 1000, from: cfg.userId, text: 'Caption\nTranscript', re: 'Quoted', contextToken: 'CONTEXT_PLACEHOLDER' }]);
  assert.equal(lib.humanMessages(messages, '').length, 2);
  const fallback = incoming('Answer', { item_list: [{ text_item: { text: 'Answer' }, ref_msg: { message_item: { text_item: { text: 'Fallback\nquote' } } } }] });
  assert.equal(lib.humanMessages([fallback], cfg.userId)[0].re, 'Fallback');
});

test('formatInbox uses local minute timestamps, optional quotes, and trailing newline', () => {
  const time = new Date(2026, 0, 2, 3, 4).getTime();
  const date = new Date(time);
  const pad = number => String(number).padStart(2, '0');
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  assert.equal(lib.formatInbox([{ time, text: 'First', re: 'Question' }, { time, text: 'Second', re: '' }]), `[${stamp}] re: "Question"\nFirst\n---\n[${stamp}]\nSecond\n`);
  assert.equal(lib.formatInbox([]), '');
});

test('sendText posts chunks sequentially and includes context only when known', async () => {
  responses.push(response({ ret: 0 }), response({ ret: 0 }), response({ ret: 0 }));
  await lib.sendText(cfg, 'x'.repeat(5000), { contextToken: 'CONTEXT_PLACEHOLDER' });
  await lib.sendText(cfg, 'No context');
  const sent = calls.map(call => JSON.parse(call.body).msg);
  assert.deepEqual(sent.map(msg => msg.item_list[0].text_item.text), ['x'.repeat(4000), 'x'.repeat(1000), 'No context']);
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
  responses.push(response({ msgs: [incoming('Pending', { context_token: 'CONTEXT_PLACEHOLDER' })], get_updates_buf: 'NEXT_CURSOR_PLACEHOLDER' }));
  assert.equal((await lib.drain(cfg))[0].text, 'Pending');
  assert.equal(calls.length, 1);
  assert.deepEqual(lib.loadState(), { cursor: 'NEXT_CURSOR_PLACEHOLDER', contextToken: 'CONTEXT_PLACEHOLDER' });
  responses.push(new DOMException('aborted', 'AbortError'));
  assert.deepEqual(await lib.drain(cfg), []);
  assert.deepEqual(lib.loadState(), { cursor: 'NEXT_CURSOR_PLACEHOLDER', contextToken: 'CONTEXT_PLACEHOLDER' });
  responses.push(response({ msgs: [incoming('Old'), incoming('New', { create_time_ms: 2000 })], get_updates_buf: 'FILTERED_CURSOR_PLACEHOLDER' }));
  assert.deepEqual((await lib.drain(cfg, { since: 1500 })).map(item => item.text), ['New']);
  assert.equal(lib.loadState().contextToken, 'CONTEXT_PLACEHOLDER');
});

test('drain wait throttles fast empty polls then collects a two-second grace window', async context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  responses.push(response({ msgs: [], get_updates_buf: 'EMPTY_CURSOR_PLACEHOLDER' }),
    () => {
      assert.equal(lib.loadState().cursor, 'EMPTY_CURSOR_PLACEHOLDER');
      return response({ msgs: [incoming('First', { context_token: 'FIRST_CONTEXT_PLACEHOLDER' })], get_updates_buf: 'FIRST_CURSOR_PLACEHOLDER' });
    },
    response({ msgs: [incoming('Second', { context_token: 'SECOND_CONTEXT_PLACEHOLDER' })], get_updates_buf: 'SECOND_CURSOR_PLACEHOLDER' }),
    ...Array.from({ length: 4 }, () => response({ msgs: [] })));
  const handed = [];
  const pending = lib.drain(cfg, { waitSec: 10, onItems: items => { handed.push(items.map(item => item.text)); } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  for (let index = 0; index < 4; index++) {
    context.mock.timers.tick(1000);
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.deepEqual((await pending).map(item => item.text), ['First', 'Second']);
  assert.deepEqual(handed, [['First'], ['Second']]);
  assert.ok(calls.length >= 4 && calls.length <= 6, `polls ${calls.length}`);
  assert.deepEqual(calls.slice(0, 4).map(call => JSON.parse(call.body).get_updates_buf),
    ['', 'EMPTY_CURSOR_PLACEHOLDER', 'FIRST_CURSOR_PLACEHOLDER', 'SECOND_CURSOR_PLACEHOLDER']);
  assert.deepEqual(lib.loadState(), { cursor: 'SECOND_CURSOR_PLACEHOLDER', contextToken: 'SECOND_CONTEXT_PLACEHOLDER' });
  assert.equal(fs.readFileSync(lib.paths().historyFile, 'utf8'), lib.formatInbox(lib.humanMessages([incoming('First')], cfg.userId)) + '---\n' + lib.formatInbox(lib.humanMessages([incoming('Second')], cfg.userId)));
});

test('drain hands messages over before advancing the cursor', async () => {
  lib.saveState({ cursor: 'OLD_CURSOR_PLACEHOLDER', contextToken: '' });
  responses.push(response({ msgs: [incoming('Handed', { context_token: 'CONTEXT_PLACEHOLDER' })], get_updates_buf: 'NEW_CURSOR_PLACEHOLDER' }));
  await assert.rejects(lib.drain(cfg, { onItems: () => { throw new Error('stdout closed'); } }), isError(1, /stdout closed/));
  assert.deepEqual(lib.loadState(), { cursor: 'OLD_CURSOR_PLACEHOLDER', contextToken: '' });
  assert.match(fs.readFileSync(lib.paths().historyFile, 'utf8'), /\nHanded\n$/);
  assert.equal(fs.existsSync(lib.paths().lockFile), false);
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

test('drain wait expires without spinning on fast empty polls', async () => {
  responses.push(...Array.from({ length: 4 }, () => response({ msgs: [] })));
  await assert.rejects(lib.drain(cfg, { waitSec: 1 }), isError(124, /no message received within 1 s/));
  assert.ok(calls.length <= 2);
  assert.equal(fs.existsSync(lib.paths().lockFile), false);
});

test('drain backs off transient errors and preserves token-expiry failures', async context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  responses.push(response({}, 500), response({}, 502), response({ msgs: [incoming('Recovered')] }), ...Array.from({ length: 3 }, () => response({ msgs: [] })));
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
  responses.push(response({ msgs: [incoming('Collected', { context_token: 'CONTEXT_PLACEHOLDER' })], get_updates_buf: 'CURSOR_PLACEHOLDER' }), response({}, 500));
  assert.equal((await lib.drain(cfg, { waitSec: 10 }))[0].text, 'Collected');
  assert.equal(calls.length, 2);
  assert.deepEqual(lib.loadState(), { cursor: 'CURSOR_PLACEHOLDER', contextToken: 'CONTEXT_PLACEHOLDER' });
});

const qr = () => response({ qrcode: 'QR_HANDLE_PLACEHOLDER +&', qrcode_img_content: 'https://example.invalid/scan' });
const confirmed = () => response({ status: 'confirmed', bot_token: 'TOKEN_PLACEHOLDER', ilink_bot_id: 'BOT_PLACEHOLDER', baseurl: 'https://example.invalid/account', ilink_user_id: 'USER_PLACEHOLDER' });

test('login waits, reports scan once, and returns the confirmed account', async () => {
  responses.push(qr(), response({ status: 'wait' }), response({ status: 'scaned' }), response({ status: 'scaned' }), confirmed());
  const output = [];
  const urls = [];
  const result = await lib.login({ out: line => output.push(line), ask: () => assert.fail('Unexpected question'), onQr: url => urls.push(url), pollIntervalMs: 0 });
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
  responses.push(qr(), response({ status: 'expired' }), qr(),
    response({ status: 'scaned_but_redirect', redirect_host: 'redirect.example.invalid' }),
    response({ status: 'need_verifycode' }), response({ status: 'wait' }), response({ status: 'scaned' }), confirmed());
  const urls = [];
  const questions = [];
  await lib.login({ out: () => {}, onQr: url => urls.push(url), ask: async question => { questions.push(question); return 'CODE_PLACEHOLDER +&'; }, pollIntervalMs: 0 });
  assert.equal(urls.length, 2);
  assert.deepEqual(questions, ['Enter the number shown in WeChat: ']);
  assert.ok(calls[4].url.startsWith('https://redirect.example.invalid/'));
  assert.ok(calls[5].url.includes(`verify_code=${encodeURIComponent('CODE_PLACEHOLDER +&')}`));
  assert.ok(calls[6].url.includes('verify_code='));
  assert.equal(calls[7].url.includes('verify_code='), false);
});

test('login retries polling network errors, AbortError and gateway 5xx, but fails other API errors', async () => {
  responses.push(qr(), new TypeError('Network unavailable'), new DOMException('aborted', 'AbortError'), response({}, 502),
    response({ status: 'confirmed', bot_token: 'TOKEN_PLACEHOLDER', ilink_bot_id: 'BOT_PLACEHOLDER' }));
  const options = { out: () => {}, ask: async () => '', onQr: () => {}, pollIntervalMs: 0 };
  assert.deepEqual(await lib.login(options), { token: 'TOKEN_PLACEHOLDER', botId: 'BOT_PLACEHOLDER', baseUrl: 'https://ilinkai.weixin.qq.com', userId: '' });
  responses.push(qr(), response({}, 404));
  await assert.rejects(lib.login(options), isError(1, /HTTP 404/));
  responses.push(qr(), response({ ret: 7 }));
  await assert.rejects(lib.login(options), isError(1, /ret=7/));
});

test('login rejects blocked codes, bound bots, incomplete confirmation, and exhausted refreshes', async () => {
  const options = { out: () => {}, ask: async () => '', onQr: () => {}, pollIntervalMs: 0 };
  for (const [status, pattern] of [['verify_code_blocked', /too many wrong codes/], ['binded_redirect', /already bound/], ['confirmed', /confirm/]]) {
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
  await assert.rejects(lib.login({ out: () => {}, ask: async () => '', onQr: () => {}, pollIntervalMs: 0 }), isError(1, /login timed out/));
});