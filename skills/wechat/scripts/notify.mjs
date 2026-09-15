import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { CliError, formatOutgoing, loadConfig, loadState, sendText } from './_lib.mjs';

async function main() {
  const { values, positionals } = parseArgs({
    options: { title: { type: 'string' }, choice: { type: 'string', multiple: true } },
    allowPositionals: true, strict: true,
  });
  const usage = () => new CliError('wechat: usage: notify.mjs [--title T] [--choice X]... [MESSAGE]', 1);
  if (!positionals.length && process.stdin.isTTY) throw usage();
  const message = positionals.length ? positionals.join(' ') : fs.readFileSync(0, 'utf8');
  const text = formatOutgoing({ title: values.title, message, choices: values.choice });
  if (!text.trim()) throw usage();
  const cfg = loadConfig();
  await sendText(cfg, text, { contextToken: loadState().contextToken });
}

main().catch(err => {
  process.stderr.write(`${err instanceof CliError ? err.message : `wechat: ${err.message}`}\n`);
  process.exit(err.exitCode ?? 1);
});