import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const lib = await import(new URL('../skills/ask-human/scripts/_lib.mjs', import.meta.url));
const wechat = await import(new URL('../skills/ask-human/scripts/_wechat.mjs', import.meta.url));
const { qrMatrix, renderQr } = await import(new URL('../skills/ask-human/scripts/_qr.mjs', import.meta.url));
const originalFetch = globalThis.fetch;
const originalDir = process.env.ASK_HUMAN_DIR;
let tempDir;
let calls;
let responses;
const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const isError = (code, pattern) => error =>
  error instanceof lib.CliError && error.exitCode === code && pattern.test(error.message);

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-adapter-test-'));
  process.env.ASK_HUMAN_DIR = tempDir;
  await lib.useChannel('wechat');
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

const cfg = { token: 'TOKEN_PLACEHOLDER', baseUrl: 'https://example.invalid/account', userId: 'USER_PLACEHOLDER' };
const incoming = (text, extra = {}) => ({
  from_user_id: cfg.userId,
  message_type: 1,
  create_time_ms: 1000,
  item_list: [{ type: 1, text_item: { text } }],
  ...extra,
});
const poll = { timeoutMs: 4000, deadline: Date.now() + 60000 };

test('adapter describes the channel', () => {
  assert.equal(wechat.label, 'WeChat');
  assert.equal(wechat.textLimit, 4000);
  assert.deepEqual(wechat.configKeys, ['token', 'baseUrl', 'userId']);
  assert.equal(typeof wechat.setup, 'function');
  assert.equal(typeof wechat.send, 'function');
  assert.equal(typeof wechat.fetch, 'function');
});

test('headers use the four required fields and a base64 decimal uint32', () => {
  const result = wechat.headers('TOKEN_PLACEHOLDER');
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
    await wechat.apiPost(cfg.baseUrl, 'ilink/bot/sendmessage', { msg: 'PLACEHOLDER' }, { token: cfg.token }),
    { ret: 0 },
  );
  assert.equal(calls[0].url, 'https://example.invalid/account/ilink/bot/sendmessage');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].body), { msg: 'PLACEHOLDER' });
  assert.equal(calls[0].headers.Authorization, `Bearer ${cfg.token}`);
  for (const scripted of [response({ ret: -14 }), response({ errcode: -14 }), response({}, 401)]) {
    responses.push(scripted);
    await assert.rejects(wechat.apiPost(cfg.baseUrl, 'ilink/bot/sendmessage', {}, { token: cfg.token }), error => {
      assert.ok(isError(1, /expired.*run: node \S*setup\.mjs wechat/)(error), error.message);
      assert.equal(error.fatal, true);
      return true;
    });
  }
  responses.push(response({}, 429, { 'Retry-After': '0' }), response({ ret: 0 }));
  assert.deepEqual(await wechat.apiGet('https://example.invalid/retry'), { ret: 0 });
  for (const scripted of [response({}, 500), response({ ret: 5, errmsg: 'bad\nrequest' }), response({ errcode: 6 })]) {
    responses.push(scripted);
    await assert.rejects(wechat.apiGet('https://example.invalid/error'), error => {
      assert.ok(isError(1, /HTTP 500|ret=5|errcode=6/)(error));
      assert.equal(error.message.includes('\n'), false);
      assert.equal(error.fatal, undefined);
      return true;
    });
  }
  const before = calls.length;
  responses.push(response({}, 429, { 'Retry-After': '1' }));
  await assert.rejects(
    wechat.apiGet('https://example.invalid/limited', { deadline: Date.now() + 500 }),
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
  assert.deepEqual(await wechat.apiGet('https://example.invalid/limited'), { ret: 0 });
  assert.ok(Date.now() - started >= 1900, 'missing Retry-After defaults to 2 s');
  assert.equal(calls.length - before, 5);
  responses.push(new Response('not JSON'));
  await assert.rejects(wechat.apiGet('https://example.invalid/json'), isError(1, /invalid JSON/));
  responses.push(new Response('proxy saw Bearer TOKEN_PLACEHOLDER', { status: 500 }));
  await assert.rejects(wechat.apiPost(cfg.baseUrl, 'ilink/bot/sendmessage', {}, { token: cfg.token }), error => {
    assert.equal(error.message.includes('TOKEN_PLACEHOLDER'), false);
    assert.match(error.message, /HTTP 500: proxy saw Bearer \*\*\*/);
    return true;
  });
  responses.push(response({ ret: 9, errmsg: 'token TOKEN_PLACEHOLDER rejected' }));
  await assert.rejects(wechat.apiPost(cfg.baseUrl, 'ilink/bot/sendmessage', {}, { token: cfg.token }), error => {
    assert.match(error.message, /ret=9 errcode=undefined token \*\*\* rejected/);
    return true;
  });
  responses.push(new TypeError('network\nfailure'));
  await assert.rejects(wechat.apiGet('https://example.invalid/network'), isError(1, /network failure/));
  await assert.rejects(
    wechat.apiPost('not a url', 'ilink/bot/sendmessage', {}, { token: cfg.token }),
    isError(1, /URL/),
  );
});

test('fetch reports expired credentials when an HTTP 401 body is interrupted', async () => {
  responses.push(
    Object.assign(response({}, 401), {
      text: async () => {
        throw new DOMException('Response interrupted', 'AbortError');
      },
    }),
  );
  await assert.rejects(wechat.fetch(cfg, {}, poll), error => {
    assert.ok(isError(1, /expired.*setup\.mjs wechat/)(error), error.message);
    assert.equal(error.fatal, true);
    return true;
  });
  assert.equal(calls.length, 1);
});

test('apiPost handles rate limiting and preserves AbortError including actual timeout', async () => {
  responses.push(response({}, 429, { 'Retry-After': '0' }), response({ ret: 0 }));
  await wechat.apiPost(cfg.baseUrl, 'ilink/bot/sendmessage', {}, { token: cfg.token });
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].headers['X-WECHAT-UIN'], calls[1].headers['X-WECHAT-UIN']);
  for (const [scripted, pattern] of [
    [response({}, 500), /HTTP 500/],
    [response({ ret: 5 }), /ret=5/],
  ]) {
    responses.push(scripted);
    await assert.rejects(
      wechat.apiPost(cfg.baseUrl, 'ilink/bot/sendmessage', {}, { token: cfg.token }),
      isError(1, pattern),
    );
  }
  const aborted = new DOMException('Request aborted', 'AbortError');
  responses.push(aborted);
  await assert.rejects(
    wechat.apiPost(cfg.baseUrl, 'ilink/bot/sendmessage', {}, { token: cfg.token }),
    error => error === aborted,
  );
  responses.push(
    (_url, { signal }) =>
      new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
  );
  await assert.rejects(wechat.apiGet('https://example.invalid/timeout', { timeoutMs: 5 }), { name: 'AbortError' });
});

test('send builds the iLink text message and includes context only when the state has one', async () => {
  responses.push(response({ ret: 0 }), response({ ret: 0 }), response({ ret: 0 }));
  await wechat.send(cfg, { cursor: '', contextToken: 'CONTEXT_PLACEHOLDER' }, 'With context');
  await wechat.send(cfg, {}, 'No context');
  await wechat.send(cfg, { contextToken: 5 }, 'Bad context', { deadline: Date.now() + 5000 });
  const sent = calls.map(call => JSON.parse(call.body).msg);
  assert.deepEqual(
    sent.map(msg => msg.item_list[0].text_item.text),
    ['With context', 'No context', 'Bad context'],
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
  assert.equal('context_token' in sent[1], false);
  assert.equal('context_token' in sent[2], false);
  assert.ok(calls.every(call => call.url === 'https://example.invalid/account/ilink/bot/sendmessage'));
  responses.push(response({}, 429, { 'Retry-After': '1' }));
  await assert.rejects(wechat.send(cfg, {}, 'late', { deadline: Date.now() + 200 }), isError(1, /HTTP 429/));
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
  assert.deepEqual(wechat.humanMessages(messages, cfg.userId), [
    { time: 1000, from: cfg.userId, text: 'Caption\nTranscript', re: 'Quoted', contextToken: 'CONTEXT_PLACEHOLDER' },
  ]);
  assert.equal(wechat.humanMessages(messages, '').length, 2);
  const fallback = incoming('Answer', {
    item_list: [
      { text_item: { text: 'Answer' }, ref_msg: { message_item: { text_item: { text: 'Fallback\nquote' } } } },
    ],
  });
  assert.equal(wechat.humanMessages([fallback], cfg.userId)[0].re, 'Fallback');
});

test('fetch sends the cursor, normalizes replies, and keeps cursor and context on empty or aborted polls', async () => {
  const state = { cursor: 'CURSOR_PLACEHOLDER', contextToken: 'CONTEXT_PLACEHOLDER' };
  responses.push(response({ msgs: [], get_updates_buf: '' }), new DOMException('aborted', 'AbortError'));
  assert.deepEqual(await wechat.fetch(cfg, state, poll), { items: [], state });
  assert.deepEqual(JSON.parse(calls[0].body), { get_updates_buf: 'CURSOR_PLACEHOLDER' });
  assert.ok(calls[0].url.endsWith('/ilink/bot/getupdates'));
  assert.equal(calls[0].headers.Authorization, `Bearer ${cfg.token}`);
  assert.deepEqual(await wechat.fetch(cfg, state, poll), { items: [], state });
  responses.push(
    response({
      msgs: [
        incoming('echo', { message_type: 2 }),
        incoming('stranger', { from_user_id: 'OTHER_USER_PLACEHOLDER' }),
        incoming('Plain'),
        incoming('Quoted', {
          create_time_ms: 2000,
          context_token: 'NEW_CONTEXT_PLACEHOLDER',
          item_list: [{ type: 1, text_item: { text: 'Quoted' }, ref_msg: { title: 'Title\nrest' } }],
        }),
      ],
      get_updates_buf: 'NEXT_CURSOR_PLACEHOLDER',
    }),
  );
  assert.deepEqual(await wechat.fetch(cfg, { cursor: 5, contextToken: null }, poll), {
    items: [
      { time: 1000, from: cfg.userId, text: 'Plain', re: '' },
      { time: 2000, from: cfg.userId, text: 'Quoted', re: 'Title' },
    ],
    state: { cursor: 'NEXT_CURSOR_PLACEHOLDER', contextToken: 'NEW_CONTEXT_PLACEHOLDER' },
  });
  assert.deepEqual(JSON.parse(calls[2].body), { get_updates_buf: '' });
  responses.push(response({ msgs: [incoming('Without token')] }));
  assert.deepEqual((await wechat.fetch(cfg, state, poll)).state, state);
  responses.push(response({ ret: -14 }));
  await assert.rejects(wechat.fetch(cfg, state, poll), error => error.fatal === true);
  responses.push(response({}, 500));
  await assert.rejects(wechat.fetch(cfg, state, poll), isError(1, /HTTP 500/));
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
  const result = await wechat.login({
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
  await wechat.login({
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
  assert.deepEqual(await wechat.login(options), {
    token: 'TOKEN_PLACEHOLDER',
    botId: 'BOT_PLACEHOLDER',
    baseUrl: 'https://ilinkai.weixin.qq.com',
    userId: '',
  });
  responses.push(qr(), response({}, 404));
  await assert.rejects(wechat.login(options), isError(1, /HTTP 404/));
  responses.push(qr(), response({ ret: 7 }));
  await assert.rejects(wechat.login(options), isError(1, /ret=7/));
});

test('login rejects blocked codes, bound bots, incomplete confirmation, and exhausted refreshes', async () => {
  const options = { out: () => {}, ask: async () => '', onQr: () => {}, pollIntervalMs: 0 };
  for (const [status, pattern] of [
    ['verify_code_blocked', /too many wrong codes/],
    ['binded_redirect', /already bound/],
    ['confirmed', /confirm/],
  ]) {
    responses.push(qr(), response({ status }));
    await assert.rejects(wechat.login(options), isError(1, pattern));
  }
  const before = calls.length;
  for (let index = 0; index < 4; index++) responses.push(qr(), response({ status: 'expired' }));
  await assert.rejects(wechat.login(options), isError(1, /expired/));
  assert.equal(calls.length - before, 8);
});

test('login enforces its eight-minute deadline', async context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  responses.push(qr(), () => {
    context.mock.timers.tick(8 * 60 * 1000);
    return response({ status: 'wait' });
  });
  await assert.rejects(
    wechat.login({ out: () => {}, ask: async () => '', onQr: () => {}, pollIntervalMs: 0 }),
    isError(1, /login timed out/),
  );
});

test('setup logs in, pairs with the first sender, waits for the test reply, and returns the config unwritten', async context => {
  const now = Date.now();
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
  const pairing = incoming('hi bot', { create_time_ms: now, context_token: 'PAIR_CONTEXT_PLACEHOLDER' });
  const stale = incoming('old message', {
    create_time_ms: now - 120000,
    from_user_id: 'OTHER_USER_PLACEHOLDER',
    context_token: 'OTHER_CONTEXT_PLACEHOLDER',
  });
  const reply = incoming('ok\nsecond line', { create_time_ms: now, context_token: 'REPLY_CONTEXT_PLACEHOLDER' });
  responses.push(
    qr(),
    response({
      status: 'confirmed',
      bot_token: 'TOKEN_PLACEHOLDER',
      ilink_bot_id: 'BOT_PLACEHOLDER',
      baseurl: 'https://example.invalid/account',
    }),
    response({ msgs: [pairing, stale], get_updates_buf: 'PAIR_CURSOR_PLACEHOLDER' }),
    response({ msgs: [] }),
    response({ msgs: [] }),
    response({ ret: 0 }),
    response({ msgs: [reply], get_updates_buf: 'REPLY_CURSOR_PLACEHOLDER' }),
    response({ msgs: [] }),
    response({ msgs: [] }),
  );
  const output = [];
  let settled = false;
  const pending = wechat.setup({ out: line => output.push(line), ask: () => assert.fail('Unexpected question') });
  pending.finally(() => (settled = true));
  for (let index = 0; index < 30 && !settled; index++) {
    await new Promise(resolve => setImmediate(resolve));
    context.mock.timers.tick(1000);
  }
  assert.deepEqual(await pending, {
    token: 'TOKEN_PLACEHOLDER',
    baseUrl: 'https://example.invalid/account',
    botId: 'BOT_PLACEHOLDER',
    userId: 'USER_PLACEHOLDER',
  });
  assert.equal(fs.existsSync(lib.paths().configFile), false);
  assert.equal(fs.existsSync(lib.paths().pointerFile), false);
  assert.match(output[0], /^WeChat setup for ask-human/);
  assert.equal(output[1], renderQr(qrMatrix('https://example.invalid/scan')).slice(0, -1));
  assert.ok(output[2].includes('https://example.invalid/scan'));
  assert.ok(output.some(line => line.includes('Paired with WeChat user USER_PLACEHOLDER.')));
  assert.equal(output.at(-1), 'Reply received: "ok"');
  const sent = calls.filter(call => call.url.endsWith('/ilink/bot/sendmessage')).map(call => JSON.parse(call.body).msg);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to_user_id, 'USER_PLACEHOLDER');
  assert.equal(sent[0].context_token, 'PAIR_CONTEXT_PLACEHOLDER');
  assert.match(sent[0].item_list[0].text_item.text, /^ask-human: WeChat is connected\./);
  assert.deepEqual(lib.loadState(), { cursor: 'REPLY_CURSOR_PLACEHOLDER', contextToken: 'REPLY_CONTEXT_PLACEHOLDER' });
  assert.equal(fs.existsSync(lib.paths().lockFile), false);
});
