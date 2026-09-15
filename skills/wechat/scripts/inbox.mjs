import { parseArgs } from 'node:util';
import { CliError, drain, formatInbox, loadConfig } from './_lib.mjs';

async function main() {
  const { values } = parseArgs({
    options: { wait: { type: 'string' } }, allowPositionals: false, strict: true,
  });
  const waitSec = values.wait === undefined ? 0 : Number(values.wait);
  if (values.wait !== undefined && (!Number.isInteger(waitSec) || waitSec < 1)) {
    throw new CliError('wechat: usage: inbox.mjs [--wait SEC]', 1);
  }
  const cfg = loadConfig();
  let printed = false;
  await drain(cfg, { waitSec, onItems: items => new Promise(resolve => {
    process.stdout.write(`${printed ? '---\n' : ''}${formatInbox(items)}`, resolve);
    printed = true;
  }) });
}

main().catch(err => {
  process.stderr.write(`${err instanceof CliError ? err.message : `wechat: ${err.message}`}\n`);
  process.exit(err.exitCode ?? 1);
});