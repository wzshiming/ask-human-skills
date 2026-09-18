import { createInterface } from 'node:readline/promises';
import {
  CHANNELS,
  CliError,
  activeChannel,
  configured,
  paths,
  resetState,
  saveActive,
  saveConfig,
  useChannel,
} from './_lib.mjs';

function usage() {
  let active;
  try {
    active = activeChannel();
  } catch {}
  const list = CHANNELS.map(
    name => `${name}${configured(name) ? ' (configured)' : ''}${name === active ? ' (active)' : ''}`,
  );
  return new CliError(`usage: setup.mjs CHANNEL — channels: ${list.join(', ')}`);
}

async function main() {
  const [name, ...extra] = process.argv.slice(2);
  if (!CHANNELS.includes(name) || extra.length) throw usage();
  const adapter = await useChannel(name);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    resetState();
    const cfg = await adapter.setup({ out: line => console.log(line), ask: question => rl.question(question) });
    saveConfig(cfg);
    saveActive(name);
    console.log(`Config written to ${paths().configFile}; active channel: ${name}`);
  } finally {
    rl.close();
  }
}

main().catch(err => {
  process.stderr.write(`${err instanceof CliError ? err.message : `ask-human: ${err.message}`}\n`);
  process.exit(err.exitCode ?? 1);
});
