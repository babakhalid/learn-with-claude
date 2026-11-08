#!/usr/bin/env node
// Terminal entry point, installed globally as `learn-with-claude`:
//   install | uninstall      add or remove the plugin in Claude Code
//   dashboard | stats | due  practice and progress from the terminal
//   mode [sidecar|inline|light|off]
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const store = require('./store');
const dashboard = require('./dashboard');
const { version } = require('../package.json');

const NAME = 'learn-with-claude';
const ROOT = path.join(__dirname, '..'); // the package folder is itself a Claude Code marketplace
const args = process.argv.slice(2);
const [cmd = 'help', arg] = args.filter((a) => !a.startsWith('-'));
const flag = (f) => args.includes(f);

function claude(argv, quiet = false) {
  return spawnSync('claude', argv, { stdio: quiet ? 'pipe' : 'inherit', encoding: 'utf8', shell: process.platform === 'win32' });
}

function requireClaude() {
  const r = claude(['--version'], true);
  if (r.error || r.status !== 0) {
    throw new Error('The Claude Code CLI (`claude`) was not found. Install Claude Code first: https://claude.com/claude-code');
  }
}

function install() {
  requireClaude();
  const listed = claude(['plugin', 'marketplace', 'list'], true).stdout || '';
  if (listed.includes(NAME) && flag('--force')) claude(['plugin', 'marketplace', 'remove', NAME]);
  if (listed.includes(NAME) && !flag('--force')) {
    console.log(`The ${NAME} marketplace is already registered; keeping it. Use --force to point it at this install.`);
  } else if (claude(['plugin', 'marketplace', 'add', ROOT]).status !== 0) {
    throw new Error('Could not register the marketplace.');
  }
  if (claude(['plugin', 'install', `${NAME}@${NAME}`]).status !== 0) throw new Error('Could not install the plugin.');
  console.log(`
Installed. Restart Claude Code, then just ask for a change: teach mode starts on its own.
  Dashboard any time:  ${NAME} dashboard
  Updates:             npm update -g ${NAME}   (then restart Claude Code)`);
}

function uninstall() {
  requireClaude();
  claude(['plugin', 'uninstall', `${NAME}@${NAME}`]);
  claude(['plugin', 'marketplace', 'remove', NAME]);
  console.log(`\nRemoved from Claude Code. Your lessons and cards are kept in ${store.HOME}.`);
}

function stats() {
  const p = store.progress();
  if (flag('--json')) return console.log(JSON.stringify(p, null, 2));
  const I = p.insights;
  const weak = I.topics.filter((t) => t.accuracy < 60).map((t) => `${t.tag} (${t.accuracy}%)`);
  console.log([
    `${p.lessons} lessons · ${p.cards} cards (${p.cards_due} due, ${p.cards_mature} mastered)`,
    `Right first time: ${p.first_try_accuracy == null ? '-' : `${p.first_try_accuracy}%`} · streak: ${p.streak_days} day${p.streak_days === 1 ? '' : 's'}`,
    weak.length ? `Needs work: ${weak.join(', ')}` : '',
    `Mode: ${p.mode} · data: ${store.FILE}`,
  ].filter(Boolean).join('\n'));
}

const HELP = `learn-with-claude ${version}: learn what Claude changes, while it changes it.

Usage: ${NAME} <command>

  install [--force]    add the plugin to Claude Code
  uninstall            remove it (your lessons and cards are kept)
  dashboard            open the learning dashboard
  stats [--json]       your progress
  due                  flashcards due for review
  mode [mode]          show or set the teach mode: sidecar, inline, light, off
  version              print the version`;

async function main() {
  if (flag('--version') || flag('-v') || cmd === 'version') return console.log(version);
  switch (cmd) {
    case 'install': return install();
    case 'uninstall': return uninstall();
    case 'dashboard': {
      const url = await dashboard.start();
      dashboard.openBrowser(url);
      console.log(`Learning dashboard: ${url}  (Ctrl+C to stop)`);
      setInterval(() => {}, 1 << 30); // keep the process alive
      return;
    }
    case 'stats': return stats();
    case 'due':
      for (const c of store.dueCards({ limit: 50 })) console.log(`- ${c.front}  [${c.tags.join(', ')}]`);
      return;
    case 'mode':
      if (!arg) return console.log(`mode: ${store.getMode()}`);
      return console.log(`mode set to: ${store.setMode({ mode: arg }).mode}`);
    default:
      console.log(HELP);
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
