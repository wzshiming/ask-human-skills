import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  let held = [];
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
      held.push(res);
      res.on('close', () => {
        held = held.filter(other => other !== res);
        res.end();
      });
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
    else if (command.type === 'held') parentPort.postMessage(held.length);
    else if (command.type === 'respond') {
      const res = held.shift();
      if (res) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(command.body));
      }
      parentPort.postMessage(Boolean(res));
    } else {
      requests = [];
      updates = command.updates ?? [];
      sendResult = command.sendResult ?? { ret: 0 };
      for (const res of held) res.end();
      held = [];
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

  function start(args) {
    const child = spawn(process.execPath, [path.join(scripts, 'inbox.mjs'), ...args], {
      env: { ...process.env, ASK_HUMAN_DIR: dir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const handle = { child, stdout: '', stderr: '' };
    child.stdout.on('data', chunk => (handle.stdout += chunk));
    child.stderr.on('data', chunk => (handle.stderr += chunk));
    handle.exit = new Promise(resolve => child.on('exit', code => resolve(code)));
    return handle;
  }

  async function until(condition, what) {
    for (let waited = 0; waited < 8000; waited += 50) {
      if (await condition()) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail(`timed out waiting for ${what}`);
  }

  const settle = ms => new Promise(resolve => setTimeout(resolve, ms));
  const session = title =>
    path.join(dir, 'wechat/sessions', createHash('sha256').update(title).digest('hex').slice(0, 16));
  const heldPoll = () => command({ type: 'held' });
  const polls = async () =>
    (await command({ type: 'requests' })).filter(request => request.url === '/ilink/bot/getupdates');
  const quoted = (text, title, overrides = {}) =>
    message(text, { item_list: [{ type: 1, text_item: { text }, ref_msg: { title } }], ...overrides });
  const hint = 'Reply by quoting this message; other questions are open.';

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

  test('F2 live queue owner bounds wait=1 and no-wait contention without fetching', async () => {
    const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    const exited = new Promise(resolve => owner.on('exit', resolve));
    try {
      fs.mkdirSync(session('B'), { recursive: true });
      fs.writeFileSync(path.join(session('B'), 'title.json'), JSON.stringify({ title: 'B' }));
      const queue = path.join(session('B'), 'queue.jsonl');
      const contents = `${JSON.stringify({ time, text: 'Older queued reply', re: '', from: 'USER_PLACEHOLDER', contextToken: '' })}\n`;
      fs.writeFileSync(queue, contents);
      fs.writeFileSync(path.join(session('B'), 'queue.lock'), JSON.stringify({ pid: owner.pid }));
      const started = Date.now();
      failure(run('inbox.mjs', ['--wait', '1', '--title', 'B']), 124, /no message received within 1 s/);
      assert.ok(Date.now() - started >= 900 && Date.now() - started < 7000);
      const noWait = Date.now();
      failure(run('inbox.mjs', ['--title', 'B']), 1, /queue.lock/);
      assert.ok(Date.now() - noWait < 8000);
      assert.equal(fs.readFileSync(queue, 'utf8'), contents);
      assert.equal((await polls()).length, 0);
    } finally {
      owner.kill();
      await exited;
    }
  });

  test('R2 a new inbox recovers ready batches from living and exited publishers without fetching', async () => {
    fs.mkdirSync(session('B'), { recursive: true });
    fs.writeFileSync(path.join(session('B'), 'title.json'), JSON.stringify({ title: 'B' }));
    const recovery = path.join(dir, 'wechat/recovery');
    fs.mkdirSync(recovery, { mode: 0o700 });
    const current = { cursor: 'CURRENT_CURSOR_PLACEHOLDER', contextToken: 'CURRENT_CONTEXT_PLACEHOLDER' };
    fs.writeFileSync(path.join(dir, 'wechat/state.json'), JSON.stringify(current));
    for (const publisher of ['living', 'exited']) {
      const file = path.join(recovery, '0000000000000001-000000000000000000000001-0000000000000000.json');
      const batch = JSON.stringify({
        targets: [
          [
            path.basename(session('B')),
            [{ time, from: 'USER_PLACEHOLDER', text: publisher, re: 'B', contextToken: 'STALE_CONTEXT_PLACEHOLDER' }],
          ],
        ],
      });
      if (publisher === 'living') fs.writeFileSync(file, batch);
      else {
        const result = spawnSync(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            'import fs from "node:fs"; fs.writeFileSync(process.argv[1], process.argv[2]);',
            file,
            batch,
          ],
          { encoding: 'utf8' },
        );
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
      }
      success(run('inbox.mjs', ['--title', 'B']), `[${stamp}] re: "B"\n${publisher}\n`);
      assert.deepEqual(state(), current);
      assert.deepEqual(fs.readdirSync(recovery), []);
    }
    assert.equal((await polls()).length, 0);
    success(run('notify.mjs', ['reply']));
    const requests = await command({ type: 'requests' });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.msg.context_token, current.contextToken);
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
    const child = spawn(process.execPath, [path.join(scripts, 'inbox.mjs'), '--wait', '20', '--title', 'A'], {
      env: { ...process.env, ASK_HUMAN_DIR: dir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const lockFile = path.join(dir, 'wechat/poll.lock');
    const waiterFile = path.join(session('A'), 'waiter.json');
    for (let waited = 0; !fs.existsSync(lockFile) && waited < 4000; waited += 50)
      await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(fs.existsSync(lockFile), true);
    assert.equal(fs.existsSync(waiterFile), true);
    child.kill('SIGTERM');
    const code = await new Promise(resolve => child.on('exit', resolve));
    assert.equal(code, 143);
    assert.equal(fs.existsSync(lockFile), false);
    assert.equal(fs.existsSync(waiterFile), false);
    await command({ type: 'reset', updates: [{ msgs: [message('after')] }] });
    success(run('inbox.mjs'), `[${stamp}]\nafter\n`);
  });

  test('inbox accepts --title and a four-hour wait, registers the title, and rejects multi-line titles', async () => {
    await command({ type: 'reset', updates: [{ msgs: [message('hello')], get_updates_buf: 'CURSOR_PLACEHOLDER' }] });
    success(run('inbox.mjs', ['--wait', '14400', '--title', 'Task A']), `[${stamp}]\nhello\n`);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(session('Task A'), 'title.json'), 'utf8')), {
      title: 'Task A',
    });
    assert.equal(fs.existsSync(path.join(session('Task A'), 'waiter.json')), false);
    failure(run('inbox.mjs', ['--title', 'two\nlines']), 1, /single line/);
    failure(run('notify.mjs', ['--title', 'two\nlines', 'hello']), 1, /single line/);
  });

  test('notify registers its title and hints only while another distinct-title waiter is active', async () => {
    await command({ type: 'reset', updates: [{ hold: true }] });
    const waiter = start(['--wait', '30', '--title', 'B']);
    try {
      await until(() => fs.existsSync(path.join(session('B'), 'waiter.json')), 'B waiter');
      success(run('notify.mjs', ['--title', 'A', '--choice', 'Yes', 'question']));
      success(run('notify.mjs', ['--title', 'B', 'same session']));
      success(run('notify.mjs', ['plain']));
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(session('A'), 'title.json'), 'utf8')), { title: 'A' });
      waiter.child.kill('SIGTERM');
      assert.equal(await waiter.exit, 143);
      fs.mkdirSync(session('C'), { recursive: true });
      fs.writeFileSync(path.join(session('C'), 'title.json'), JSON.stringify({ title: 'C' }));
      fs.writeFileSync(path.join(session('C'), 'waiter.json'), JSON.stringify({ pid: 1, since: Date.now() }));
      const old = new Date(Date.now() - 40000);
      fs.utimesSync(path.join(session('C'), 'waiter.json'), old, old);
      success(run('notify.mjs', ['--title', 'A', 'stale peer']));
      const sent = (await command({ type: 'requests' }))
        .filter(request => request.url === '/ilink/bot/sendmessage')
        .map(request => request.body.msg.item_list[0].text_item.text);
      assert.deepEqual(sent, [`A\nquestion\n\n1. Yes\n${hint}`, 'B\nsame session', `plain\n${hint}`, 'A\nstale peer']);
    } finally {
      waiter.child.kill();
    }
  });

  test('a quoted reply reaches only its waiter while the poller keeps its long poll', async () => {
    await command({ type: 'reset', updates: [{ hold: true }, { hold: true }, { hold: true }] });
    const a = start(['--wait', '30', '--title', 'A']);
    await until(async () => (await heldPoll()) === 1, 'first long poll');
    const b = start(['--wait', '30', '--title', 'B']);
    try {
      await until(() => fs.existsSync(path.join(session('B'), 'waiter.json')), 'B waiter');
      await settle(700);
      assert.equal((await polls()).length, 1);
      assert.equal(
        await command({ type: 'respond', body: { msgs: [quoted('for B', 'B\nquestion')], get_updates_buf: 'C1' } }),
        true,
      );
      assert.equal(await b.exit, 0);
      assert.equal(b.stdout, `[${stamp}] re: "B"\nfor B\n`);
      assert.equal(a.child.exitCode, null);
      await until(async () => (await heldPoll()) === 1, 'second long poll');
      assert.equal((await polls()).length, 2);
      assert.equal(state().cursor, 'C1');
      assert.equal(await command({ type: 'respond', body: { msgs: [message('for A')], get_updates_buf: 'C2' } }), true);
      assert.equal(await a.exit, 0);
      assert.equal(a.stdout, `[${stamp}]\nfor A\n`);
      assert.equal(state().cursor, 'C2');
      assert.equal(fs.existsSync(path.join(dir, 'wechat/poll.lock')), false);
    } finally {
      a.child.kill();
      b.child.kill();
    }
  });

  test('an unquoted reply goes to the most recently started waiter even after the other notifies', async () => {
    await command({ type: 'reset', updates: [{ hold: true }, { hold: true }] });
    const a = start(['--wait', '30', '--title', 'A']);
    try {
      await until(async () => (await heldPoll()) === 1, 'long poll');
      const b = start(['--wait', '30', '--title', 'B']);
      try {
        await until(() => fs.existsSync(path.join(session('B'), 'waiter.json')), 'B waiter');
        success(run('notify.mjs', ['--title', 'A', 'later question']));
        assert.equal(
          await command({ type: 'respond', body: { msgs: [message('answer')], get_updates_buf: 'C1' } }),
          true,
        );
        assert.equal(await b.exit, 0);
        assert.equal(b.stdout, `[${stamp}]\nanswer\n`);
        assert.equal(a.child.exitCode, null);
        const sent = (await command({ type: 'requests' })).filter(request => request.url === '/ilink/bot/sendmessage');
        assert.equal(sent[0].body.msg.item_list[0].text_item.text, `A\nlater question\n${hint}`);
      } finally {
        b.child.kill();
      }
      a.child.kill('SIGTERM');
      assert.equal(await a.exit, 143);
      assert.equal(fs.existsSync(path.join(dir, 'wechat/poll.lock')), false);
    } finally {
      a.child.kill();
    }
  });

  test('inbox --title without --wait reads its queued reply while another process holds the poll lock', async () => {
    await command({ type: 'reset', updates: [{ hold: true }, { hold: true }] });
    success(run('notify.mjs', ['--title', 'B', 'question']));
    const a = start(['--wait', '30', '--title', 'A']);
    try {
      await until(async () => (await heldPoll()) === 1, 'long poll');
      assert.equal(
        await command({ type: 'respond', body: { msgs: [quoted('for B', 'B\nquestion')], get_updates_buf: 'C1' } }),
        true,
      );
      await until(() => fs.existsSync(path.join(session('B'), 'queue.jsonl')), 'B queue');
      await until(async () => (await heldPoll()) === 1, 'second long poll');
      success(run('inbox.mjs', ['--title', 'B']), `[${stamp}] re: "B"\nfor B\n`);
      success(run('inbox.mjs', ['--title', 'B']));
      assert.equal((await polls()).length, 2);
      assert.equal(a.child.exitCode, null);
    } finally {
      a.child.kill();
    }
  });

  test('F4 routed replies survive torn tails and quarantine each incident with one warning', async () => {
    fs.mkdirSync(session('B'), { recursive: true });
    fs.writeFileSync(path.join(session('B'), 'title.json'), JSON.stringify({ title: 'B' }));
    const queue = path.join(session('B'), 'queue.jsonl');
    const quarantined = [];
    for (let incident = 0; incident < 2; incident++) {
      const before = { time, text: `Before ${incident}`, re: '', from: 'USER_PLACEHOLDER', contextToken: '' };
      const torn = `${JSON.stringify(before)}\n{"text":"torn ${incident}`;
      fs.writeFileSync(queue, torn);
      await command({
        type: 'reset',
        updates: [{ msgs: [quoted(`After ${incident}`, 'B')], get_updates_buf: `CURSOR_${incident}` }],
      });
      success(run('inbox.mjs', ['--title', 'A']));
      assert.equal(state().cursor, `CURSOR_${incident}`);
      const queued = fs.readFileSync(queue);
      const result = run('inbox.mjs', ['--title', 'B']);
      assert.equal(result.status, 0);
      assert.equal(result.stdout, `[${stamp}]\nBefore ${incident}\n---\n[${stamp}] re: "B"\nAfter ${incident}\n`);
      assert.match(result.stderr, /^wechat: [^\r\n]*queue\.jsonl\.corrupt\.[^\r\n]+\n$/);
      const files = fs.readdirSync(session('B')).filter(name => name.startsWith('queue.jsonl.corrupt.'));
      assert.equal(files.length, incident + 1);
      const fresh = files.find(name => !quarantined.includes(name));
      assert.ok(fresh);
      assert.ok(result.stderr.includes(path.join(session('B'), fresh)));
      assert.deepEqual(fs.readFileSync(path.join(session('B'), fresh)), queued);
      assert.ok(queued.subarray(0, Buffer.byteLength(torn)).equals(Buffer.from(torn)));
      quarantined.push(fresh);
      assert.equal((await polls()).length, 1);
    }
    fs.writeFileSync(path.join(dir, 'wechat/poll.lock'), JSON.stringify({ pid: process.pid }));
    success(run('inbox.mjs', ['--title', 'B']));
    assert.equal(fs.readdirSync(session('B')).filter(name => name.startsWith('queue.jsonl.corrupt.')).length, 2);
  });

  test('F4 wholly corrupt and wrong-shaped records are quarantined without consumption', async () => {
    fs.mkdirSync(session('B'), { recursive: true });
    fs.writeFileSync(path.join(session('B'), 'title.json'), JSON.stringify({ title: 'B' }));
    fs.writeFileSync(path.join(dir, 'wechat/poll.lock'), JSON.stringify({ pid: process.pid }));
    const raw =
      '{broken\nnull\nfalse\n42\n"text"\n[]\n{}\n{"text":5,"time":1000}\n{"text":"wrong time","time":null}\n{"text":"bad quote","time":1000,"re":{}}\n';
    fs.writeFileSync(path.join(session('B'), 'queue.jsonl'), raw);
    const result = run('inbox.mjs', ['--title', 'B']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^wechat: [^\r\n]*queue\.jsonl\.corrupt\.[^\r\n]+\n$/);
    const files = fs.readdirSync(session('B')).filter(name => name.startsWith('queue.jsonl.corrupt.'));
    assert.equal(files.length, 1);
    assert.equal(fs.readFileSync(path.join(session('B'), files[0]), 'utf8'), raw);
    assert.equal((await polls()).length, 0);
  });

  test('queued bursts reach the waiter exactly once and in order while it is already draining', async () => {
    await command({ type: 'reset', updates: Array.from({ length: 5 }, () => ({ hold: true })) });
    const a = start(['--wait', '30', '--title', 'A']);
    await until(async () => (await heldPoll()) === 1, 'first long poll');
    const b = start(['--wait', '30', '--title', 'B']);
    try {
      await until(() => fs.existsSync(path.join(session('B'), 'waiter.json')), 'B waiter');
      for (let batch = 0; batch < 3; batch++) {
        await until(async () => (await heldPoll()) === 1, `long poll ${batch}`);
        const msgs = [quoted(`b${batch * 2}`, 'B\nq'), quoted(`b${batch * 2 + 1}`, 'B\nq')];
        assert.equal(await command({ type: 'respond', body: { msgs, get_updates_buf: `C${batch}` } }), true);
        await settle(400);
      }
      assert.equal(await b.exit, 0);
      const block = text => `[${stamp}] re: "B"\n${text}\n`;
      assert.equal(b.stdout, [0, 1, 2, 3, 4, 5].map(index => block(`b${index}`)).join('---\n'));
      assert.equal(a.child.exitCode, null);
      assert.deepEqual(fs.readdirSync(session('B')).sort(), ['title.json']);
    } finally {
      a.child.kill();
      b.child.kill();
    }
  });

  test('a later inbox promptly recovers the fresh lock and waiter left by a killed process', async () => {
    await command({ type: 'reset', updates: [{ hold: true }, { msgs: [message('after')] }] });
    const a = start(['--wait', '30', '--title', 'A']);
    try {
      await until(async () => (await heldPoll()) === 1, 'long poll');
      a.child.kill('SIGKILL');
      await a.exit;
      const lockFile = path.join(dir, 'wechat/poll.lock');
      const waiterFile = path.join(session('A'), 'waiter.json');
      assert.equal(fs.existsSync(lockFile), true);
      assert.equal(fs.existsSync(waiterFile), true);
      assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid, a.child.pid);
      success(run('inbox.mjs', ['--wait', '5', '--title', 'A']), `[${stamp}]\nafter\n`);
      assert.equal(fs.existsSync(lockFile), false);
      assert.equal(fs.existsSync(waiterFile), false);
    } finally {
      a.child.kill();
    }
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
