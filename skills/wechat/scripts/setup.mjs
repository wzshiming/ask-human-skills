import fs from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { CliError, drain, loadState, login, paths, saveConfig, saveState, sendText } from './_lib.mjs';
import { qrMatrix, renderQr } from './_qr.mjs';

async function main() {
  parseArgs({ options: {}, allowPositionals: false, strict: true });
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('WeChat setup for ask-human. Scan the QR code with WeChat and confirm on your phone.');
    const creds = await login({
      out: line => console.log(line),
      ask: question => rl.question(question),
      onQr: url => {
        process.stdout.write(renderQr(qrMatrix(url)));
        console.log(`If the QR code above is not scannable, open this URL in a browser and scan it there:\n${url}\n`);
      },
    });
    fs.rmSync(paths().lockFile, { force: true });
    saveState({ cursor: '', contextToken: '' });
    const cfg = { ...creds };
    console.log(
      `Logged in (bot ${cfg.botId}). Now send the bot any message in WeChat \u2014 it appears as a new chat there.`,
    );
    const first = await drain(cfg, { waitSec: 600, since: Date.now() - 60_000 });
    cfg.userId ||= first[0].from;
    saveConfig(cfg);
    console.log(`Paired with WeChat user ${cfg.userId}.`);
    await sendText(cfg, 'ask-human: WeChat is connected. Reply to this message to finish setup.', {
      contextToken: loadState().contextToken,
    });
    console.log('Test message sent. Reply to it in WeChat (waiting up to 10 minutes)\u2026');
    const reply = await drain(cfg, { waitSec: 600 });
    console.log(`Reply received: ${JSON.stringify(reply[0].text.split('\n')[0])}`);
    console.log(`Config written to ${paths().configFile}`);
  } finally {
    rl.close();
  }
}

main().catch(err => {
  process.stderr.write(`${err instanceof CliError ? err.message : `wechat: ${err.message}`}\n`);
  process.exit(err.exitCode ?? 1);
});
