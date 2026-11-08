// Local web dashboard: flip flashcards, take quizzes with instant feedback, see progress.
// Binds to 127.0.0.1 only. Logs go to stderr so the MCP stdio channel stays clean.
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const store = require('./store');

// The page is read once, with the code that serves it, so a long-running session never pairs
// today's page with yesterday's API. BUILD fingerprints that code: a session running newer code
// will not reuse a dashboard started by an older one.
const PAGE = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');
const BUILD = require('crypto').createHash('sha1')
  .update(PAGE).update(fs.readFileSync(__filename)).update(fs.readFileSync(path.join(__dirname, 'store.js')))
  .digest('hex').slice(0, 12);
const MAGIC = 'learnwithclaude';
const FONTS = { '/fonts/geist.woff2': 'Geist-Variable.woff2', '/fonts/geist-mono.woff2': 'GeistMono-Variable.woff2' };
let running = null; // { url, server }
let lastSeen = 0; // last time an open dashboard tab polled us

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// Changes whenever the deck or the agent activity changes.
function stamp() {
  let deck = 0;
  try { deck = fs.statSync(store.FILE).mtimeMs; } catch { /* no deck yet */ }
  return Math.max(deck, store.agentStamp());
}

function state() {
  const db = store.load();
  return {
    stamp: stamp(),
    mode: store.getMode(),
    agents: store.getAgents(),
    lives: store.liveLessons(db),
    progress: store.progress(),
    due: store.dueCards({ limit: 100 }),
    // Quiz pool, without the answer index: grading happens server-side.
    quizzes: db.quizzes.map((q) => {
      const last = q.attempts[q.attempts.length - 1];
      return {
        id: q.id, question: q.question, options: q.options, tags: q.tags, kind: q.kind || 'check',
        lessonId: q.lessonId, lesson: db.lessons.find((l) => l.id === q.lessonId)?.title || '',
        attempts: q.attempts.length, lastAt: last ? last.at : null,
        firstCorrect: q.attempts.length ? q.attempts[0].correct : null,
        lastCorrect: last ? last.correct : null,
        // The answer is only sent once the user has got it right: a missed question stays a real retry.
        reveal: last && last.correct ? { answer: q.options[q.answerIndex], explanation: q.explanation } : null,
      };
    }),
    lessons: db.lessons.slice().reverse(),
  };
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, PAGE, 'text/html; charset=utf-8');
    // Bundled Geist fonts (SIL OFL). Fixed allowlist, so no path from the URL ever reaches the filesystem.
    const font = FONTS[url.pathname];
    if (req.method === 'GET' && font) {
      res.writeHead(200, { 'Content-Type': 'font/woff2', 'Cache-Control': 'public, max-age=31536000, immutable' });
      return res.end(fs.readFileSync(path.join(__dirname, 'fonts', font)));
    }
    if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { app: MAGIC, build: BUILD, lastSeen });
    // Cheap poll: the page asks for the stamp and only refetches state when it changed.
    if (req.method === 'GET' && url.pathname === '/api/stamp') { lastSeen = Date.now(); return send(res, 200, { stamp: stamp() }); }
    if (req.method === 'GET' && url.pathname === '/api/state') { lastSeen = Date.now(); return send(res, 200, state()); }
    // Reject cross-site writes: browsers always send Origin on POST.
    const origin = req.headers.origin;
    if (req.method === 'POST' && origin && new URL(origin).host !== req.headers.host) return send(res, 403, { error: 'forbidden' });
    if (req.method === 'POST' && url.pathname === '/api/grade') return send(res, 200, store.gradeCard(await readBody(req)));
    if (req.method === 'POST' && url.pathname === '/api/answer') return send(res, 200, store.answerQuiz({ ...(await readBody(req)), source: 'dashboard' }));
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    return send(res, 400, { error: e.message });
  }
}

function health(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 800 }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { try { const j = JSON.parse(d); resolve(j.app === MAGIC ? j : null); } catch { resolve(null); } });
    });
    req.on('timeout', () => req.destroy()); // the timeout option only emits an event; it doesn't abort
    req.on('error', () => resolve(null));
  });
}

// True when a dashboard tab polled in the last 10s, so we shouldn't open another one.
async function viewerActive(url) {
  if (running && running.url === url) return Date.now() - lastSeen < 10000;
  const h = await health(Number(new URL(url).port));
  return !!h && Date.now() - h.lastSeen < 10000;
}

async function start(port = Number(process.env.LEARN_PORT) || 4477) {
  if (running) return running.url;
  for (let p = port; p < port + 10; p++) {
    const other = await health(p);
    if (other && other.build === BUILD) return `http://127.0.0.1:${p}/`; // another session already serves this version
    if (other) continue; // an older (or newer) version is running there: never mix versions, use the next port
    const server = http.createServer(handle);
    const ok = await new Promise((resolve) => {
      server.once('error', () => resolve(false));
      server.listen(p, '127.0.0.1', () => resolve(true));
    });
    if (ok) {
      server.unref(); // never keep the MCP process alive just for the dashboard
      running = { server, url: `http://127.0.0.1:${p}/` };
      process.stderr.write(`[learn] dashboard on ${running.url}\n`);
      return running.url;
    }
  }
  throw new Error(`No free port in ${port}-${port + 9}. Set LEARN_PORT.`);
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); return true; } catch { return false; }
}

module.exports = { start, openBrowser, viewerActive, BUILD };
