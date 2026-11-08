'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-test-'));
process.env.LEARN_HOME = HOME;
const store = require('../mcp/store');
const ROOT = path.join(__dirname, '..');

test('lesson → quiz → miss becomes flashcard → complete', () => {
  const lesson = store.createLesson({ title: 'Rate limit login', critique: 'Use a sliding window' });
  const { cards, quizzes } = store.addItems({
    lesson_id: lesson.id,
    flashcards: [{ front: 'Why rate-limit login?', back: 'Stops credential stuffing', tags: ['security'] }],
    quiz: [
      { question: 'Where should the check go?', options: ['Client', 'Server, before DB'], answer_index: 1, explanation: 'Client can be bypassed', tags: ['security'] },
      { question: 'Q2', options: ['a', 'b', 'c'], answer_index: 0, explanation: 'x' },
    ],
  });
  assert.equal(cards.length, 1);

  const wrong = store.answerQuiz({ quiz_id: quizzes[0].id, chosen_index: 0 });
  assert.equal(wrong.correct, false);
  assert.equal(wrong.correct_answer, 'Server, before DB');
  assert.ok(wrong.created_flashcard);
  // Retrying the same quiz must not duplicate the miss card.
  assert.equal(store.answerQuiz({ quiz_id: quizzes[0].id, chosen_index: 0 }).created_flashcard, null);

  assert.equal(store.answerQuiz({ quiz_id: quizzes[1].id, chosen_index: 0 }).correct, true);
  const { score } = store.completeLesson({ lesson_id: lesson.id, summary: 'done', changes: [{ file: 'a.js', what: 'x', why: 'y' }] });
  assert.deepEqual(score, { answered: 2, correctFirstTry: 1, total: 2 });

  assert.throws(() => store.answerQuiz({ quiz_id: quizzes[0].id, chosen_index: 9 }), /chosen_index/);
  assert.throws(() => store.addItems({ lesson_id: 'nope' }), /Unknown lesson_id/);
});

test('spaced repetition intervals grow, and "again" resets', () => {
  const now = 0;
  const DAY = 86400000;
  const c = { ease: 2.5, interval: 0, reviews: 0, lapses: 0 };
  store.schedule(c, 'good', now); assert.equal(c.interval, 1);
  store.schedule(c, 'good', now); assert.equal(c.interval, 2.5);
  store.schedule(c, 'easy', now); assert.ok(c.interval > 7);
  store.schedule(c, 'again', now); assert.equal(c.interval, 0); assert.equal(c.lapses, 1);
  assert.ok(c.due < DAY);
  assert.throws(() => store.schedule(c, 'meh'), /grade/);
});

test('due cards and progress', () => {
  const due = store.dueCards({});
  assert.ok(due.some((c) => c.tags.includes('missed')) === false, 'miss card is due in 10 min, not now');
  assert.ok(store.dueCards({ include_upcoming: true }).length >= 2);
  const p = store.progress();
  assert.equal(p.lessons, 1);
  assert.equal(p.first_try_accuracy, 50);
  assert.equal(p.streak_days, 1);
  assert.deepEqual(p.weakest_topics, ['security']);
  assert.equal(p.mode, 'sidecar');
});

function mcp(messages) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [path.join(ROOT, 'mcp/server.js')], { env: { ...process.env, LEARN_HOME: HOME } });
    let out = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.on('error', reject);
    proc.on('close', () => {
      const rows = out.trim().split('\n').map((l) => JSON.parse(l));
      resolve(Object.fromEntries(rows.map((r) => [r.id, r])));
    });
    for (const m of messages) proc.stdin.write(`${JSON.stringify(m)}\n`);
    setTimeout(() => proc.stdin.end(), 300);
  });
}

test('MCP server speaks JSON-RPC over stdio', async () => {
  const res = await mcp([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'create_lesson', arguments: { title: 'Via MCP' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'grade_card', arguments: { card_id: 'bad', grade: 'good' } } },
    { jsonrpc: '2.0', id: 5, method: 'nope' },
  ]);
  assert.equal(Object.keys(res).length, 5, 'notification gets no response');
  assert.equal(res[1].result.serverInfo.name, 'learn');
  assert.equal(res[1].result.protocolVersion, '2025-06-18');
  assert.deepEqual(res[2].result.tools.map((t) => t.name).sort(), [
    'add_learning_items', 'answer_quiz', 'complete_lesson', 'create_lesson', 'get_due_cards', 'get_progress', 'grade_card', 'open_dashboard', 'set_mode',
  ]);
  assert.match(JSON.parse(res[3].result.content[0].text).lesson_id, /^lesson_/);
  assert.equal(res[4].result.isError, true);
  assert.equal(res[5].error.code, -32601);
});

test('dashboard API serves state without leaking answers, grades, rejects cross-site POST', async () => {
  process.env.LEARN_PORT = String(45000 + Math.floor(Math.random() * 1000));
  const dashboard = require('../mcp/dashboard');
  const url = await dashboard.start();
  const html = await (await fetch(url)).text();
  assert.match(html, /<title>Learn with Claude<\/title>/);

  const state = await (await fetch(`${url}api/state`)).json();
  assert.ok(state.quizzes.length >= 2);
  assert.ok(Array.isArray(state.lives) && state.lives.length && typeof state.stamp === 'number');
  assert.equal(await dashboard.viewerActive(url), true, 'a poll counts as an open tab');
  assert.equal(state.quizzes[0].answerIndex, undefined);

  const q = state.quizzes[1];
  const r = await (await fetch(`${url}api/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quiz_id: q.id, chosen_index: 0 }) })).json();
  assert.equal(typeof r.correct, 'boolean');

  const evil = await fetch(`${url}api/answer`, { method: 'POST', headers: { Origin: 'http://evil.example', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(evil.status, 403);
  assert.equal(await dashboard.start(), url, 'start is idempotent');
});

test('hooks inject context and respect mode', () => {
  const run = (event, input) => execFileSync('node', [path.join(ROOT, 'hooks/context.js'), event], { input: JSON.stringify(input), env: { ...process.env, LEARN_HOME: HOME } }).toString();
  const out = JSON.parse(run('prompt', { prompt: 'add rate limiting to the login route' }));
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(out.hookSpecificOutput.additionalContext, /Sidecar teach mode/);
  assert.equal(run('prompt', { prompt: '/learn-with-claude:review' }), '');
  assert.equal(run('prompt', { prompt: 'B' }), '');
  assert.match(JSON.parse(run('session', {})).hookSpecificOutput.additionalContext, /Teach mode is "sidecar"/);

  store.setMode({ mode: 'off' });
  assert.equal(run('prompt', { prompt: 'add rate limiting to the login route' }), '');
  assert.equal(run('session', {}), '');
  store.setMode({ mode: 'sidecar' });
});

test('legacy "full" mode maps to inline', () => {
  fs.writeFileSync(path.join(HOME, 'mode.json'), JSON.stringify({ mode: 'full' }));
  assert.equal(store.getMode(), 'inline');
  store.setMode({ mode: 'sidecar' });
  assert.throws(() => store.setMode({ mode: 'full' }), /mode must be/);
});

test('sidecar: live lesson hides answers until answered, dashboard answers flow back via hook', () => {
  const l = store.createLesson({ title: 'Sidecar lesson' });
  const { quizzes } = store.addItems({
    lesson_id: l.id,
    notes: [{ title: 'Trust boundaries', body: 'Validate on the server.\n```js\nparse(x)\n```' }],
    quiz: [
      { kind: 'predict', question: 'Where to validate?', options: ['client', 'server'], answer_index: 1, explanation: 'client is bypassable' },
      { kind: 'diff', question: 'Why before the DB call?', options: ['speed', 'safety', 'style'], answer_index: 1, explanation: 'never trust input' },
    ],
  });
  assert.throws(() => store.addItems({ lesson_id: l.id, quiz: [{ kind: 'bogus', question: 'q', options: ['a', 'b'], answer_index: 0 }] }), /kind/);

  let live = store.liveLesson();
  assert.equal(live.id, l.id);
  assert.equal(live.status, 'live');
  assert.equal(live.notes.length, 1);
  assert.equal(live.quizzes[0].kind, 'predict');
  assert.equal(live.quizzes[0].answered, null);
  assert.ok(!JSON.stringify(live.quizzes).includes('answerIndex'), 'answer never leaks before answering');

  store.answerQuiz({ quiz_id: quizzes[0].id, chosen_index: 0, source: 'dashboard' });
  live = store.liveLesson();
  assert.deepEqual({ ...live.quizzes[0].answered, explanation: undefined }, { chosen: 0, correct: false, correctIndex: 1, explanation: undefined });

  // The prompt hook reports the dashboard answer once, then never again.
  const run = (input) => execFileSync('node', [path.join(ROOT, 'hooks/context.js'), 'prompt'], { input: JSON.stringify(input), env: { ...process.env, LEARN_HOME: HOME } }).toString();
  const ctx = JSON.parse(run({ prompt: 'ok' })).hookSpecificOutput.additionalContext;
  assert.match(ctx, /answered 1 dashboard question: 0 correct/);
  assert.match(ctx, /Where to validate\?/);
  assert.equal(run({ prompt: 'ok' }), '');

  // In-session answers are not re-reported.
  store.answerQuiz({ quiz_id: quizzes[1].id, chosen_index: 1 });
  assert.equal(run({ prompt: 'ok' }), '');

  const done = store.completeLesson({ lesson_id: l.id, changes: [{ file: 'a.js:3', what: 'x', why: 'y' }] });
  assert.equal(done.lesson.status, 'done');
  assert.deepEqual(done.missed, [{ question: 'Where to validate?', chose: 'client', correct: 'server' }]);
  assert.equal(store.liveLesson().status, 'done', 'stays visible after completion');
  assert.equal(store.liveLesson(store.load(), Date.now() + 3 * 3600e3), null, 'gone after 2h');
});

test('activity hooks drive the dashboard status: working, waiting on a question, finished', async () => {
  const run = (event, input, tag = '--hooks=2') => execFileSync('node', [path.join(ROOT, 'hooks/context.js'), event, tag], { input: JSON.stringify(input), env: { ...process.env, LEARN_HOME: HOME } }).toString();
  // A session started with an older hook list (no tag, no Stop hook) must not report a status it can never finish.
  run('prompt', { session_id: 'old-session', cwd: '/tmp/x', prompt: 'ok' }, '');
  assert.ok(!store.getAgents().some((a) => a.session === 'old-session'));
  const base = { session_id: 'sess-1', cwd: '/tmp/learn-playground' };
  run('prompt', { ...base, prompt: 'ok' });
  assert.equal(store.getAgent().state, 'working');
  assert.equal(store.getAgent().project, 'learn-playground');
  assert.equal(run('ask', { ...base, tool_input: { questions: [{ question: 'Shared schema or client only?' }] } }), '', 'PreToolUse must not print anything');
  assert.deepEqual([store.getAgent().state, store.getAgent().message], ['waiting', 'Shared schema or client only?']);
  run('answered', base);
  assert.equal(store.getAgent().state, 'working');
  run('notify', { ...base, message: 'Claude needs your permission to use Bash' });
  assert.match(store.getAgent().message, /permission/);
  assert.equal(run('stop', base), '');
  assert.equal(store.getAgent().state, 'done');

  const url = await require('../mcp/dashboard').start();
  const state = await (await fetch(`${url}api/state`)).json();
  assert.equal(state.agents[0].state, 'done');
  const font = await fetch(`${url}fonts/geist.woff2`);
  assert.equal(font.headers.get('content-type'), 'font/woff2');
  assert.equal((await fetch(`${url}fonts/../store.js`)).status, 404);
});

test('parallel sessions: one live lesson per project, sessions tracked separately, SessionEnd removes one', () => {
  const run = (event, input) => execFileSync('node', [path.join(ROOT, 'hooks/context.js'), event, '--hooks=2'], { input: JSON.stringify(input), env: { ...process.env, LEARN_HOME: HOME } }).toString();
  store.createLesson({ title: 'API lesson', project: 'api' });
  store.createLesson({ title: 'Web lesson', project: 'web' });
  const lives = store.liveLessons();
  assert.deepEqual(lives.slice(0, 2).map((l) => l.project).sort(), ['api', 'web']);
  assert.equal(new Set(lives.map((l) => l.project)).size, lives.length, 'one lesson per project');

  run('prompt', { session_id: 'A', cwd: '/x/api', prompt: 'ok' });
  run('ask', { session_id: 'B', cwd: '/x/web', tool_input: { questions: [{ question: 'Which router?' }] } });
  const agents = store.getAgents();
  assert.equal(agents.find((a) => a.session === 'A').state, 'working');
  assert.equal(agents.find((a) => a.session === 'B').project, 'web');
  run('end', { session_id: 'A' });
  assert.ok(!store.getAgents().some((a) => a.session === 'A'));
  assert.ok(store.getAgents().some((a) => a.session === 'B'));
});

test('a newer session never reuses a dashboard running older code', async () => {
  const http = require('http');
  const port = 46000 + Math.floor(Math.random() * 1000);
  const old = http.createServer((req, res) => res.end(JSON.stringify({ app: 'learnwithclaude', build: 'old-build', lastSeen: 0 })));
  await new Promise((r) => old.listen(port, '127.0.0.1', r));
  const script = `require('${path.join(ROOT, 'mcp/dashboard.js').replace(/\\/g, '/')}').start(${port}).then((u) => { console.log(u); process.exit(0); })`;
  // Async exec: the fake old server lives in this process and must keep answering.
  const { stdout } = await require('util').promisify(require('child_process').execFile)('node', ['-e', script], { env: { ...process.env, LEARN_HOME: HOME } });
  const url = stdout.trim();
  old.close();
  assert.equal(url, `http://127.0.0.1:${port + 1}/`);
});

test('progress insights: topics weakest first, fixed mistakes, memory buckets; quiz answers only revealed once passed', async () => {
  const l = store.createLesson({ title: 'Insights', project: 'insights' });
  const { quizzes } = store.addItems({ lesson_id: l.id, quiz: [
    { question: 'weak q', options: ['a', 'b'], answer_index: 0, explanation: 'e1', tags: ['weak-topic'] },
    { question: 'strong q', options: ['a', 'b'], answer_index: 0, explanation: 'e2', tags: ['strong-topic'] },
  ] });
  store.answerQuiz({ quiz_id: quizzes[0].id, chosen_index: 1 }); // missed
  store.answerQuiz({ quiz_id: quizzes[1].id, chosen_index: 0 }); // passed
  let I = store.progress().insights;
  const weak = I.topics.find((t) => t.tag === 'weak-topic');
  assert.equal(weak.accuracy, 0);
  assert.ok(I.topics.indexOf(weak) < I.topics.findIndex((t) => t.tag === 'strong-topic'), 'weakest first');
  assert.equal(I.days.length, 14);
  assert.ok(I.days[13].missed >= 1 && I.days[13].correct >= 1, 'today counts both');

  const url = await require('../mcp/dashboard').start();
  let state = await (await fetch(`${url}api/state`)).json();
  const view = (id) => state.quizzes.find((q) => q.id === id);
  assert.equal(view(quizzes[0].id).reveal, null, 'a missed question keeps its answer hidden');
  assert.deepEqual(view(quizzes[1].id).reveal, { answer: 'a', explanation: 'e2' });

  const fixedBefore = I.fixed;
  store.answerQuiz({ quiz_id: quizzes[0].id, chosen_index: 0 }); // retry, now right
  I = store.progress().insights;
  assert.equal(I.fixed, fixedBefore + 1);
  assert.equal(I.topics.find((t) => t.tag === 'weak-topic').now, 1, 'after retries');
  state = await (await fetch(`${url}api/state`)).json();
  assert.equal(view(quizzes[0].id).firstCorrect, false);
  assert.equal(view(quizzes[0].id).lastCorrect, true);
  assert.ok(view(quizzes[0].id).reveal);
});

test('manifests are valid JSON and reference existing files', () => {
  for (const f of ['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', '.codex-plugin/plugin.json', 'hooks/hooks.json']) {
    JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
  }
  for (const s of ['teach', 'review', 'progress']) {
    const md = fs.readFileSync(path.join(ROOT, 'skills', s, 'SKILL.md'), 'utf8');
    assert.match(md, new RegExp(`^---\\nname: ${s}\\ndescription: `));
  }
});

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));
