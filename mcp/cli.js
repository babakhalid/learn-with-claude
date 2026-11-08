#!/usr/bin/env node
// Terminal entry point: `learn dashboard | stats | due | mode <sidecar|inline|light|off>`
'use strict';

const store = require('./store');
const dashboard = require('./dashboard');

const [cmd = 'help', arg] = process.argv.slice(2);

async function main() {
  switch (cmd) {
    case 'dashboard': {
      const url = await dashboard.start();
      dashboard.openBrowser(url);
      console.log(`Learning dashboard: ${url}  (Ctrl+C to stop)`);
      setInterval(() => {}, 1 << 30); // keep the process alive
      return;
    }
    case 'stats':
      return console.log(JSON.stringify(store.progress(), null, 2));
    case 'due':
      for (const c of store.dueCards({ limit: 50 })) console.log(`- ${c.front}  [${c.tags.join(', ')}]`);
      return;
    case 'mode':
      if (!arg) return console.log(`mode: ${store.getMode()}`);
      return console.log(`mode set to: ${store.setMode({ mode: arg }).mode}`);
    default:
      console.log('usage: learn <dashboard|stats|due|mode [sidecar|inline|light|off]>');
      console.log(`data: ${store.FILE}`);
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
