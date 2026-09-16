import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isMainThread, parentPort, Worker } from 'node:worker_threads';

if (!isMainThread) {
  let requests = [];
  let updates = [];
  let sendResult = { ret: 0 };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({ url: req.url, headers: req.headers, body: JSON.parse(raw) });
    const entry =
      req.url === '/ilink/bot/sendmessage'
        ? Array.isArray(sendResult)
          ? (sendResult.shift() ?? { ret: 0 })
          : sendResult
        : req.url === '/ilink/bot/getupdates'
          ? (updates.shift() ?? { msgs: [] })
          : { ret: 1, errmsg: 'Unexpected endpoint' };
    if (entry.hold) {
      res.on('close', () => res.end());
      return;
    }
    const respond = () => {
      res.setHeader('Content-Type', 'application/json');
      if (entry.status) {
        res.statusCode = entry.status;
        for (const [name, value] of Object.entries(entry.headers ?? {})) res.setHeader(name, value);
      }
      res.end(JSON.stringify(entry));
    };
    if (entry.delayMs) setTimeout(respond, entry.delayMs);
    else respond();
  });
  server.listen(0, '127.0.0.1', () => {
    parentPort.postMessage(`http://127.0.0.1:${server.address().port}/`);
  });
  parentPort.on('message', command => {
    if (command.type === 'close') {
      server.closeAllConnections();
      server.close(() => {
        parentPort.postMessage(null);
        parentPort.close();
      });
    } else if (command.type === 'requests') parentPort.postMessage(requests);
    else {
      requests = [];
      updates = command.updates ?? [];
      sendResult = command.sendResult ?? { ret: 0 };
      parentPort.postMessage(null);
    }
  });
} else {
  const scripts = fileURLToPath(new URL('../skills/wechat/scripts/', import.meta.url));
  const dirs = [];
  let worker;
  let baseUrl;
  let dir;

  function command(value) {
    return new Promise((resolve, reject) => {
      const onError = error => {
        worker.off('message', onMessage);
        reject(error);
      };
      const onMessage = result => {
        worker.off('error', onError);
        resolve(result);
      };
      worker.once('error', onError);
      worker.once('message', onMessage);
      if (value) worker.postMessage(value);
    });
  }

  function run(script, args = [], input = '') {
    const result = spawnSync(process.execPath, [path.join(scripts, script), ...args], {
      env: { ...process.env, ASK_HUMAN_DIR: dir },
      input,
      encoding: 'utf8',
      timeout: 8000,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    return result;
  }

  function success(result, stdout = '') {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, stdout);
    assert.equal(result.stderr, '');
  }

  function failure(result, status, message) {
    assert.equal(result.status, status);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^[^\r\n]+\n$/);
    assert.match(result.stderr, message);
  }

  const time = new Date(2026, 8, 15, 10, 23).getTime();
  const pad = number => String(number).padStart(2, '0');
  const date = new Date(time);
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;

  function message(text, overrides = {}) {
    return {
      from_user_id: 'USER_PLACEHOLDER',
      message_type: 1,
      create_time_ms: time,
      item_list: [{ type: 1, text_item: { text } }],
      context_token: 'CTX_PLACEHOLDER',
      ...overrides,
    };
  }

  function state() {
    return JSON.parse(fs.readFileSync(path.join(dir, 'wechat/state.json'), 'utf8'));
  }

  before(async () => {
    worker = new Worker(new URL(import.meta.url));
    baseUrl = await command();
  });

  beforeEach(async () => {
    await command({ type: 'reset' });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-cli-'));
    dirs.push(dir);
    fs.writeFileSync(
      path.join(dir, 'wechat.json'),
      JSON.stringify({
        token: 'TOKEN_PLACEHOLDER',
        baseUrl,
        botId: 'BOT_PLACEHOLDER',
        userId: 'USER_PLACEHOLDER',
      }),
    );
  });

  after(async () => {
    if (worker) await command({ type: 'close' });
    for (const tempDir of dirs) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('notify sends title and choices with identity, authorization, and saved context', async () => {
    fs.mkdirSync(path.join(dir, 'wechat'));
    fs.writeFileSync(
      path.join(dir, 'wechat/state.json'),
      JSON.stringify({ cursor: 'C', contextToken: 'CTX_PLACEHOLDER' }),
    );
    success(run('notify.mjs', ['--title', 'T', '--choice', 'A', '--choice', 'B', 'msg']));
    const requests = await command({ type: 'requests' });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/ilink/bot/sendmessage');
    assert.equal(requests[0].body.msg.item_list[0].text_item.text, 'T\nmsg\n\n1. A\n2. B');
    assert.equal(requests[0].body.msg.to_user_id, 'USER_PLACEHOLDER');
    assert.equal(requests[0].body.msg.context_token, 'CTX_PLACEHOLDER');
    assert.equal(requests[0].headers.authorizationtype, 'ilink_bot_token');
    assert.equal(requests[0].headers.authorization, 'Bearer TOKEN_PLACEHOLDER');
  });

  test('notify joins positionals and omits context when state is absent', async () => {
    success(run('notify.mjs', ['hello', 'world']));
    const requests = await command({ type: 'requests' });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.msg.item_list[0].text_item.text, 'hello world');
    assert.equal(Object.hasOwn(requests[0].body.msg, 'context_token'), false);
  });

  test('notify reads multiline literal text from stdin', async () => {
    const text = '* _ [ ] < > &\nsecond line';
    success(run('notify.mjs', [], text));
    const requests = await command({ type: 'requests' });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.msg.item_list[0].text_item.text, text);
  });

  test('notify splits 5000 characters into ordered 4000 and 1000 character posts', async () => {
    success(run('notify.mjs', ['a'.repeat(4000) + 'b'.repeat(1000)]));
    const requests = await command({ type: 'requests' });
    assert.deepEqual(
      requests.map(request => request.url),
      ['/ilink/bot/sendmessage', '/ilink/bot/sendmessage'],
    );
    assert.deepEqual(
      requests.map(request => request.body.msg.item_list[0].text_item.text),
      ['a'.repeat(4000), 'b'.repeat(1000)],
    );
  });

  test('notify reports missing configuration with exit 2 and a setup hint', () => {
    fs.rmSync(path.join(dir, 'wechat.json'));
    failure(run('notify.mjs', ['hello']), 2, /setup\.mjs/);
  });

  test('notify reports an expired token with exit 1 and a setup hint', async () => {
    await command({ type: 'reset', sendResult: { ret: -14 } });
    failure(run('notify.mjs', ['hello']), 1, /expired.*setup\.mjs/);
  });

  test('notify rejects empty input, unknown options, and missing option values', () => {
    failure(run('notify.mjs', [], ''), 1, /usage: notify\.mjs/);
    failure(run('notify.mjs', ['--bogus', 'x']), 1, /Unknown option/);
    failure(run('notify.mjs', ['--title']), 1, /argument missing/);
  });

  test('inbox prints a pending message and persists cursor and context', async () => {
    await command({ type: 'reset', updates: [{ msgs: [message('hello')], get_updates_buf: 'CURSOR_PLACEHOLDER' }] });
    success(run('inbox.mjs'), `[${stamp}]\nhello\n`);
    assert.deepEqual(state(), { cursor: 'CURSOR_PLACEHOLDER', contextToken: 'CTX_PLACEHOLDER' });
    assert.equal(fs.existsSync(path.join(dir, 'wechat/poll.lock')), false);
    const requests = await command({ type: 'requests' });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/ilink/bot/getupdates');
    success(run('inbox.mjs'));
    const nextRequests = await command({ type: 'requests' });
    assert.equal(nextRequests[1].body.get_updates_buf, 'CURSOR_PLACEHOLDER');
  });

  test('inbox returns empty output immediately when no messages are pending', async () => {
    await command({ type: 'reset', updates: [{ msgs: [] }] });
    success(run('inbox.mjs'));
  });

  test('inbox times out a held request within four seconds', async () => {
    await command({ type: 'reset', updates: [{ hold: true }] });
    const started = Date.now();
    failure(run('inbox.mjs', ['--wait', '1']), 124, /no message received/);
    assert.ok(Date.now() - started < 4000);
    assert.equal(fs.existsSync(path.join(dir, 'wechat/poll.lock')), false);
  });

  test('inbox collects a burst for about two seconds and mirrors it to history.log', async () => {
    const quoted = message('two', {
      create_time_ms: time + 1000,
      item_list: [{ type: 1, text_item: { text: 'two' }, ref_msg: { title: 'Question line 1\nline 2' } }],
    });
    await command({
      type: 'reset',
      updates: [
        { delayMs: 300, msgs: [message('one')], get_updates_buf: 'FIRST_CURSOR_PLACEHOLDER' },
        { msgs: [quoted], get_updates_buf: 'SECOND_CURSOR_PLACEHOLDER' },
        { delayMs: 1200, msgs: [message('three')], get_updates_buf: 'THIRD_CURSOR_PLACEHOLDER' },
      ],
    });
    const started = Date.now();
    const expected = `[${stamp}]\none\n---\n[${stamp}] re: "Question line 1"\ntwo\n---\n[${stamp}]\nthree\n`;
    success(run('inbox.mjs', ['--wait', '5']), expected);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 2300 && elapsed < 5000, `elapsed ${elapsed}`);
    assert.equal(state().cursor, 'THIRD_CURSOR_PLACEHOLDER');
    assert.equal(fs.readFileSync(path.join(dir, 'wechat/history.log'), 'utf8'), expected);
    const requests = await command({ type: 'requests' });
    assert.ok(requests.length >= 3);
    assert.equal(requests[1].body.get_updates_buf, 'FIRST_CURSOR_PLACEHOLDER');
    assert.equal(requests[2].body.get_updates_buf, 'SECOND_CURSOR_PLACEHOLDER');
  });

  test('inbox releases the poll lock when terminated during a wait', async () => {
    await command({ type: 'reset', updates: [{ hold: true }] });
    const child = spawn(process.execPath, [path.join(scripts, 'inbox.mjs'), '--wait', '20'], {
      env: { ...process.env, ASK_HUMAN_DIR: dir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const lockFile = path.join(dir, 'wechat/poll.lock');
    for (let waited = 0; !fs.existsSync(lockFile) && waited < 4000; waited += 50)
      await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(fs.existsSync(lockFile), true);
    child.kill('SIGTERM');
    const code = await new Promise(resolve => child.on('exit', resolve));
    assert.equal(code, 143);
    assert.equal(fs.existsSync(lockFile), false);
    await command({ type: 'reset', updates: [{ msgs: [message('after')] }] });
    success(run('inbox.mjs'), `[${stamp}]\nafter\n`);
  });

  test('rate limits are absorbed by the scripts', async () => {
    await command({
      type: 'reset',
      sendResult: [{ status: 429, headers: { 'Retry-After': '1' } }, { ret: 0 }],
      updates: [
        { status: 429, headers: { 'Retry-After': '1' } },
        { msgs: [message('later')], get_updates_buf: 'LATER_CURSOR_PLACEHOLDER' },
      ],
    });
    const started = Date.now();
    success(run('notify.mjs', ['hello']));
    success(run('inbox.mjs'), `[${stamp}]\nlater\n`);
    assert.ok(Date.now() - started >= 2000);
    const requests = await command({ type: 'requests' });
    assert.deepEqual(
      requests.map(request => request.url),
      ['/ilink/bot/sendmessage', '/ilink/bot/sendmessage', '/ilink/bot/getupdates', '/ilink/bot/getupdates'],
    );
  });

  test('inbox rejects invalid waits and positional arguments', () => {
    for (const wait of ['0', 'abc', '-1', '1.5', 'Infinity']) {
      failure(run('inbox.mjs', [`--wait=${wait}`]), 1, /usage: inbox\.mjs/);
    }
    failure(run('inbox.mjs', ['unexpected']), 1, /Unexpected argument/);
    failure(run('inbox.mjs', ['--wait']), 1, /argument missing/);
    failure(run('inbox.mjs', ['--bogus']), 1, /Unknown option/);
  });

  test('inbox reports missing configuration with exit 2', () => {
    fs.rmSync(path.join(dir, 'wechat.json'));
    failure(run('inbox.mjs'), 2, /setup\.mjs/);
  });

  test('notify reuses the context token received by an earlier inbox process', async () => {
    await command({ type: 'reset', updates: [{ msgs: [message('hello')] }] });
    success(run('inbox.mjs'), `[${stamp}]\nhello\n`);
    success(run('notify.mjs', ['reply']));
    const requests = await command({ type: 'requests' });
    assert.equal(requests.length, 2);
    assert.equal(requests[1].url, '/ilink/bot/sendmessage');
    assert.equal(requests[1].body.msg.context_token, 'CTX_PLACEHOLDER');
  });

  test('inbox ignores other senders and bot echoes', async () => {
    await command({
      type: 'reset',
      updates: [
        { msgs: [message('other', { from_user_id: 'OTHER_PLACEHOLDER' }), message('echo', { message_type: 2 })] },
      ],
    });
    success(run('inbox.mjs'));
    assert.equal(state().contextToken, '');
  });

  test('setup passes syntax checking', () => {
    // QR login uses a fixed public host, so setup is not run end-to-end here.
    const result = spawnSync(process.execPath, ['--check', path.join(scripts, 'setup.mjs')], {
      env: { ...process.env, ASK_HUMAN_DIR: dir },
      encoding: 'utf8',
      timeout: 8000,
    });
    assert.ifError(result.error);
    success(result);
  });
}
