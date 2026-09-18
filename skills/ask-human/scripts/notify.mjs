import fs from 'node:fs';
import { parseArgs } from 'node:util';
import {
  CliError,
  activeChannel,
  formatOutgoing,
  loadConfig,
  registerSession,
  send,
  sessions,
  useChannel,
} from './_lib.mjs';

async function main() {
  const { values, positionals } = parseArgs({
    options: { title: { type: 'string' }, choice: { type: 'string', multiple: true } },
    allowPositionals: true,
    strict: true,
  });
  const usage = () => new CliError('usage: notify.mjs [--title T] [--choice X]... [MESSAGE]', 1);
  if (!positionals.length && process.stdin.isTTY) throw usage();
  const message = positionals.length ? positionals.join(' ') : fs.readFileSync(0, 'utf8');
  let text = formatOutgoing({ title: values.title, message, choices: values.choice });
  if (!text.trim()) throw usage();
  await useChannel(activeChannel());
  const cfg = loadConfig();
  const key = registerSession(values.title ?? '');
  if (sessions().some(session => session.since && session.key !== key))
    text += '\nReply by quoting this message; other questions are open.';
  await send(cfg, text);
}

main().catch(err => {
  process.stderr.write(`${err instanceof CliError ? err.message : `ask-human: ${err.message}`}\n`);
  process.exit(err.exitCode ?? 1);
});
