import { parseArgs } from 'node:util';
import { CliError, activeChannel, cliError, drain, formatInbox, loadConfig, useChannel } from './_lib.mjs';

async function main() {
  const { values } = parseArgs({
    options: { wait: { type: 'string' }, title: { type: 'string' } },
    allowPositionals: false,
    strict: true,
  });
  const waitSec = values.wait === undefined ? 0 : Number(values.wait);
  if (values.wait !== undefined && (!Number.isInteger(waitSec) || waitSec < 1)) {
    throw new CliError('usage: inbox.mjs [--wait SEC] [--title T]', 1);
  }
  await useChannel(activeChannel());
  const cfg = loadConfig();
  let printed = false;
  await drain(cfg, {
    waitSec,
    title: values.title ?? '',
    onItems: items =>
      new Promise(resolve => {
        process.stdout.write(`${printed ? '---\n' : ''}${formatInbox(items)}`, resolve);
        printed = true;
      }),
  });
}

main().catch(err => {
  const error = cliError(err);
  process.stderr.write(`${error instanceof CliError ? error.message : `ask-human: ${error.message}`}\n`);
  process.exit(error.exitCode ?? 1);
});
