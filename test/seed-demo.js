// Demo data for the dashboard: `npm run demo`
// Seeds one finished lesson with due cards, then streams a live lesson the way the teacher agent does.
'use strict';
const fs = require('fs');
const store = require('../mcp/store');

const STEP = Number(process.env.DEMO_STEP_MS) || 4000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function seedPast() {
  const l = store.createLesson({
    title: 'Add rate limiting to POST /login', project: 'demo-app', goal: 'Block brute-force login attempts',
    critique: 'An in-memory counter resets on deploy and is not shared across instances. Used Redis with a sliding window instead.',
  });
  store.addItems({
    lesson_id: l.id,
    flashcards: [
      { front: 'Why not keep rate-limit counters in process memory?', back: 'They reset on restart and are not shared across instances, so limits are trivially bypassed at scale.', tags: ['rate-limiting', 'scaling'] },
      { front: 'Sliding window vs fixed window: what does sliding fix?', back: 'Fixed windows allow 2x bursts at the boundary; a sliding window smooths that out.', tags: ['rate-limiting'] },
      { front: 'Why return `429` with `Retry-After`?', back: 'Clients and proxies know to back off and for how long, instead of hammering.', tags: ['http'] },
    ],
  });
  store.completeLesson({ lesson_id: l.id, summary: 'Login allows 5 attempts / 15 min per IP+username, backed by Redis.', concepts: ['rate-limiting', 'HTTP 429'] });
  const db = store.load();
  db.cards.forEach((c) => { c.due = Date.now() - 1; });
  fs.writeFileSync(store.FILE, JSON.stringify(db));
}

async function streamLive() {
  const l = store.createLesson({
    title: 'Validate the signup form with zod', project: 'demo-app', goal: 'Reject bad emails and weak passwords',
    critique: 'You asked for validation in the React form only. That is bypassable with curl, so the same zod schema now runs in the server action too. **Validate at the trust boundary.**',
  });
  const add = (items) => store.addItems({ lesson_id: l.id, ...items });
  await sleep(STEP);
  add({
    quiz: [{ kind: 'predict', question: 'The form already validates in the browser. What happens if someone POSTs straight to the endpoint with curl?', options: ['The browser validation still runs', 'The request is accepted unvalidated', 'Next.js rejects it automatically'], answer_index: 1, explanation: 'Client-side checks are UX, not security. Anything outside your server can be skipped, so the server must validate again.', tags: ['security'] }],
    notes: [{ title: 'Validate at the trust boundary', body: 'Your server action is the first code **you** control. Client validation gives fast feedback; server validation gives safety.\n```ts\n// app/signup/actions.ts\nconst data = SignupSchema.parse(Object.fromEntries(form));\n```' }],
  });
  await sleep(STEP);
  add({
    quiz: [{ kind: 'predict', question: 'Where should the zod schema live so client and server never drift?', options: ['Copy it into both files', 'A shared module both import', 'Only on the server'], answer_index: 1, explanation: 'One schema, two call sites. Copies drift the first time someone edits one of them.', tags: ['zod', 'architecture'] }],
    notes: [{ title: 'One schema, many uses', body: 'Define `SignupSchema` once in `lib/schemas.ts`. Import it in the form (for instant errors) and in the action (for safety). `z.infer<typeof SignupSchema>` gives you the TypeScript type for free.' }],
  });
  await sleep(STEP * 1.5);
  add({
    summary: 'Signup now validates with one shared zod schema, in the form for UX and in the server action for safety.',
    changes: [
      { file: 'lib/schemas.ts:4', what: 'New `SignupSchema` (email, password ≥ 12 chars)', why: 'Single source of truth for client and server' },
      { file: 'app/signup/actions.ts:12', what: '`safeParse` before touching the DB', why: 'Bad input never reaches the database; errors are returned, not thrown' },
      { file: 'app/signup/form.tsx:20', what: 'Form uses the same schema via the resolver', why: 'Instant feedback without duplicating rules' },
    ],
    quiz: [{ kind: 'diff', question: 'Why does the action use `safeParse` instead of `parse`?', options: ['It is faster', 'It returns errors as values so we can show them in the form', 'parse does not work in server actions'], answer_index: 1, explanation: '`parse` throws, which becomes a 500. `safeParse` returns `{ success, error }`, so the form can show field errors.', tags: ['zod'] }],
    flashcards: [
      { front: 'Why validate on the server if the form already validates?', back: 'Client checks are bypassable (curl, devtools). The server is the trust boundary.', tags: ['security'] },
      { front: 'zod: `parse` vs `safeParse`?', back: '`parse` throws; `safeParse` returns `{ success, data | error }`, which is better for user-facing errors.', tags: ['zod'] },
    ],
  });
  await sleep(STEP);
  store.completeLesson({ lesson_id: l.id, concepts: ['trust boundary', 'zod', 'shared schema'] });
}

// Two weeks of made-up practice so the Progress charts have something to show.
function seedHistory() {
  const topics = { security: 0.45, zod: 0.7, 'rate-limiting': 0.9, http: 0.8, sql: 0.55, react: 0.95 };
  const l = store.createLesson({ title: 'Practice set', project: 'learn-playground' });
  const quiz = [];
  for (const [tag, p] of Object.entries(topics)) {
    for (let i = 0; i < 4; i++) quiz.push({ question: `${tag}: sample question ${i + 1}`, options: ['A', 'B', 'C'], answer_index: 0, explanation: `Why A is right for ${tag}.`, tags: [tag], _p: p });
  }
  const { quizzes } = store.addItems({ lesson_id: l.id, quiz: quiz.map(({ _p, ...q }) => q) });
  store.completeLesson({ lesson_id: l.id, concepts: Object.keys(topics) });
  const db = store.load();
  const DAY = 864e5; let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  quizzes.forEach((q, i) => {
    const stored = db.quizzes.find((x) => x.id === q.id);
    const at = Date.now() - Math.floor(rnd() * 13) * DAY - 3600e3;
    const first = rnd() < quiz[i]._p;
    stored.attempts.push({ at, chosen: first ? 0 : 1, correct: first, source: 'dashboard', reported: true });
    db.activity.push({ at, day: new Date(at).toISOString().slice(0, 10), kind: first ? 'quiz_correct' : 'quiz_wrong' });
    if (!first && rnd() < 0.5) { // some misses fixed by a retry
      stored.attempts.push({ at: at + 600e3, chosen: 0, correct: true, source: 'dashboard', reported: true });
      db.activity.push({ at: at + 600e3, day: new Date(at + 600e3).toISOString().slice(0, 10), kind: 'quiz_correct' });
    }
  });
  db.cards.forEach((c, i) => { c.reviews = i % 4; c.interval = [0, 2, 9, 30][i % 4]; });
  for (let d = 0; d < 14; d += 2) db.activity.push({ at: Date.now() - d * DAY, day: new Date(Date.now() - d * DAY).toISOString().slice(0, 10), kind: 'review' });
  fs.writeFileSync(store.FILE, JSON.stringify(db));
}

seedPast();
if (process.argv.includes('--history')) seedHistory();
console.log(`Seeded demo data into ${store.HOME}`);
if (process.argv.includes('--live')) streamLive().then(() => console.log('Live lesson finished.'));
