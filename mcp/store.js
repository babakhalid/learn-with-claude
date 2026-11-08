// Persistent learning store: lessons, flashcards, quizzes, spaced repetition.
// Zero dependencies. Data lives in $LEARN_HOME (default ~/.learnwithclaude/deck.json).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const HOME = process.env.LEARN_HOME || path.join(os.homedir(), '.learnwithclaude');
const FILE = path.join(HOME, 'deck.json');
const MODE_FILE = path.join(HOME, 'mode.json');
const AGENT_FILE = path.join(HOME, 'agent.json');
const AGENT_STATES = ['working', 'waiting', 'done'];
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const GRADES = { again: 0, hard: 1, good: 2, easy: 3 };
const MODES = ['sidecar', 'inline', 'light', 'off'];
const LEGACY_MODES = { full: 'inline' };
const QUIZ_KINDS = ['predict', 'check', 'diff'];

function empty() {
  return { version: 1, lessons: [], cards: [], quizzes: [], activity: [] };
}

function load() {
  try {
    return { ...empty(), ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
  } catch (e) {
    if (e.code === 'ENOENT') return empty();
    throw new Error(`Cannot read ${FILE}: ${e.message}`);
  }
}

function save(db) {
  fs.mkdirSync(HOME, { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, FILE);
}

function mutate(fn) {
  const db = load();
  const result = fn(db);
  save(db);
  return result;
}

const newId = (prefix) => `${prefix}_${crypto.randomBytes(4).toString('hex')}`;
const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

function logActivity(db, kind, now = Date.now()) {
  db.activity.push({ at: now, day: today(now), kind });
  if (db.activity.length > 5000) db.activity = db.activity.slice(-5000);
}

function findLesson(db, lessonId) {
  const lesson = db.lessons.find((l) => l.id === lessonId);
  if (!lesson) throw new Error(`Unknown lesson_id "${lessonId}". Call create_lesson first.`);
  return lesson;
}

function makeCard(lessonId, { front, back, tags = [] }, now, dueIn = DAY) {
  if (!front || !back) throw new Error('Each flashcard needs "front" and "back".');
  return {
    id: newId('card'), lessonId, front, back, tags,
    ease: 2.5, interval: 0, reviews: 0, lapses: 0,
    createdAt: now, due: now + dueIn, lastReviewed: null,
  };
}

function makeQuiz(lessonId, { question, options, answer_index, explanation = '', tags = [], kind = 'check' }, now) {
  if (!question || !Array.isArray(options) || options.length < 2) {
    throw new Error('Each quiz item needs "question" and at least 2 "options".');
  }
  if (!Number.isInteger(answer_index) || answer_index < 0 || answer_index >= options.length) {
    throw new Error(`answer_index must be an integer between 0 and ${options.length - 1}.`);
  }
  if (!QUIZ_KINDS.includes(kind)) throw new Error(`kind must be one of: ${QUIZ_KINDS.join(', ')}`);
  return { id: newId('quiz'), lessonId, kind, question, options, answerIndex: answer_index, explanation, tags, createdAt: now, attempts: [] };
}

function makeNote({ title, body }, now) {
  if (!title || !body) throw new Error('Each note needs "title" and "body".');
  return { id: newId('note'), title, body, createdAt: now };
}

// ---------- lessons ----------

function createLesson({ title, goal = '', critique = '', project, tags = [] }) {
  if (!title) throw new Error('"title" is required.');
  const now = Date.now();
  return mutate((db) => {
    const lesson = {
      id: newId('lesson'), title, goal, critique, tags,
      project: project || path.basename(process.cwd()),
      status: 'live', createdAt: now, completedAt: null, summary: '', changes: [], concepts: [], notes: [],
    };
    db.lessons.push(lesson);
    logActivity(db, 'lesson', now);
    return lesson;
  });
}

function addItems({ lesson_id, flashcards = [], quiz = [], notes = [], changes, summary }) {
  const now = Date.now();
  return mutate((db) => {
    const lesson = findLesson(db, lesson_id);
    lesson.notes = [...(lesson.notes || []), ...notes.map((n) => makeNote(n, now))];
    if (changes) lesson.changes = changes;
    if (summary) lesson.summary = summary;
    lesson.updatedAt = now;
    const cards = flashcards.map((c) => makeCard(lesson_id, c, now));
    const quizzes = quiz.map((q) => makeQuiz(lesson_id, q, now));
    db.cards.push(...cards);
    db.quizzes.push(...quizzes);
    return { cards, quizzes };
  });
}

function completeLesson({ lesson_id, summary, changes, concepts }) {
  return mutate((db) => {
    const lesson = findLesson(db, lesson_id);
    if (summary) lesson.summary = summary;
    if (changes) lesson.changes = changes;
    if (concepts) lesson.concepts = concepts;
    Object.assign(lesson, { status: 'done', completedAt: Date.now(), updatedAt: Date.now() });
    const qs = db.quizzes.filter((q) => q.lessonId === lesson_id);
    return {
      lesson,
      score: lessonScore(db, lesson_id),
      missed: qs.filter((q) => q.attempts[0] && !q.attempts[0].correct)
        .map((q) => ({ question: q.question, chose: q.options[q.attempts[0].chosen], correct: q.options[q.answerIndex] })),
      cards: db.cards.filter((c) => c.lessonId === lesson_id).length,
    };
  });
}

function lessonScore(db, lessonId) {
  const qs = db.quizzes.filter((q) => q.lessonId === lessonId && q.attempts.length);
  const correct = qs.filter((q) => q.attempts[0].correct).length;
  return { answered: qs.length, correctFirstTry: correct, total: db.quizzes.filter((q) => q.lessonId === lessonId).length };
}

// ---------- quizzes ----------

function answerQuiz({ quiz_id, chosen_index, source = 'agent' }) {
  const now = Date.now();
  return mutate((db) => {
    const quiz = db.quizzes.find((q) => q.id === quiz_id);
    if (!quiz) throw new Error(`Unknown quiz_id "${quiz_id}".`);
    if (!Number.isInteger(chosen_index) || chosen_index < 0 || chosen_index >= quiz.options.length) {
      throw new Error(`chosen_index must be between 0 and ${quiz.options.length - 1}.`);
    }
    const correct = chosen_index === quiz.answerIndex;
    // Dashboard answers are reported back to the agent later by the prompt hook.
    quiz.attempts.push({ at: now, chosen: chosen_index, correct, source, reported: source !== 'dashboard' });
    logActivity(db, correct ? 'quiz_correct' : 'quiz_wrong', now);

    // A missed question becomes a flashcard due soon: errors are the best study material.
    let missCard = null;
    const alreadyCarded = db.cards.some((c) => c.fromQuiz === quiz.id);
    if (!correct && !alreadyCarded) {
      missCard = makeCard(quiz.lessonId, {
        front: quiz.question,
        back: `${quiz.options[quiz.answerIndex]}${quiz.explanation ? `\n\n${quiz.explanation}` : ''}`,
        tags: [...quiz.tags, 'missed'],
      }, now, 10 * MIN);
      missCard.fromQuiz = quiz.id;
      db.cards.push(missCard);
    }
    return {
      correct,
      chosen: quiz.options[chosen_index],
      correct_index: quiz.answerIndex,
      correct_answer: quiz.options[quiz.answerIndex],
      explanation: quiz.explanation,
      created_flashcard: missCard ? missCard.id : null,
      lesson_score: lessonScore(db, quiz.lessonId),
    };
  });
}

// Dashboard answers the agent hasn't heard about yet; marks them reported.
function takeUnreported() {
  return mutate((db) => {
    const out = [];
    for (const q of db.quizzes) {
      for (const a of q.attempts) {
        if (a.reported !== false) continue;
        a.reported = true;
        out.push({ question: q.question, correct: a.correct, chose: q.options[a.chosen], answer: q.options[q.answerIndex] });
      }
    }
    return out;
  });
}

// Lessons the Live tab shows: the newest lesson of each project, if it is in progress or
// finished in the last 2 hours. Several coding sessions can be building at once.
function liveLessons(db = load(), now = Date.now()) {
  const newest = new Map();
  for (const l of db.lessons) newest.set(l.project, l); // lessons are stored oldest first
  return [...newest.values()]
    .filter((l) => l.status !== 'done' || now - (l.completedAt || 0) <= 2 * 60 * MIN)
    .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))
    .map((l) => liveView(db, l));
}

function liveLesson(db = load(), now = Date.now()) {
  return liveLessons(db, now)[0] || null;
}

function liveView(db, l) {
  const quizzes = db.quizzes.filter((q) => q.lessonId === l.id).map((q) => {
    const first = q.attempts[0];
    // Never send the answer before the user has answered.
    return {
      id: q.id, kind: q.kind || 'check', question: q.question, options: q.options, createdAt: q.createdAt,
      answered: first ? { chosen: first.chosen, correct: first.correct, correctIndex: q.answerIndex, explanation: q.explanation } : null,
    };
  });
  return {
    ...l, notes: l.notes || [], quizzes,
    cards: db.cards.filter((c) => c.lessonId === l.id).length,
    score: lessonScore(db, l.id),
  };
}

// ---------- spaced repetition (SM-2 lite) ----------

function schedule(card, grade, now = Date.now()) {
  const q = GRADES[grade];
  if (q === undefined) throw new Error('grade must be one of: again, hard, good, easy');
  card.reviews += 1;
  card.lastReviewed = now;
  if (q === 0) {
    card.lapses += 1;
    card.interval = 0;
    card.ease = Math.max(1.3, card.ease - 0.2);
    card.due = now + 10 * MIN;
    return card;
  }
  const prev = card.interval;
  const next = prev === 0
    ? [0, 1, 1, 3][q]
    : prev * [0, 1.2, card.ease, card.ease * 1.3][q];
  card.ease = Math.max(1.3, card.ease + [0, -0.15, 0, 0.15][q]);
  card.interval = Math.max(1, Math.round(next * 10) / 10);
  card.due = now + card.interval * DAY;
  return card;
}

function dueCards({ limit = 20, tag, include_upcoming = false } = {}) {
  const db = load();
  const now = Date.now();
  return db.cards
    .filter((c) => (include_upcoming || c.due <= now) && (!tag || c.tags.includes(tag)))
    .sort((a, b) => a.due - b.due)
    .slice(0, limit)
    .map((c) => ({ ...c, lesson: db.lessons.find((l) => l.id === c.lessonId)?.title || '' }));
}

function gradeCard({ card_id, grade }) {
  const now = Date.now();
  return mutate((db) => {
    const card = db.cards.find((c) => c.id === card_id);
    if (!card) throw new Error(`Unknown card_id "${card_id}".`);
    schedule(card, grade, now);
    logActivity(db, 'review', now);
    return { card_id, next_due: new Date(card.due).toISOString(), interval_days: card.interval };
  });
}

// ---------- progress ----------

function streak(db, now = Date.now()) {
  const days = new Set(db.activity.map((a) => a.day));
  let n = 0;
  let t = now;
  if (!days.has(today(t))) t -= DAY; // streak survives until you skip a full day
  while (days.has(today(t))) { n += 1; t -= DAY; }
  return n;
}

// Personal stats for the Progress charts.
function insights(db, now = Date.now()) {
  const days = [];
  for (let i = 13; i >= 0; i--) days.push({ day: today(now - i * DAY), correct: 0, missed: 0, reviews: 0 });
  const byDay = new Map(days.map((d) => [d.day, d]));
  for (const a of db.activity) {
    const d = byDay.get(a.day);
    if (!d) continue;
    if (a.kind === 'quiz_correct') d.correct += 1;
    else if (a.kind === 'quiz_wrong') d.missed += 1;
    else if (a.kind === 'review') d.reviews += 1;
  }

  // Per topic: first-try accuracy (honest) and where you stand now (after retries).
  const t = {};
  const topic = (tag) => (t[tag] = t[tag] || { tag, answered: 0, firstTry: 0, now: 0, cards: 0, lapses: 0 });
  for (const q of db.quizzes) {
    if (!q.attempts.length) continue;
    for (const tag of q.tags) {
      const x = topic(tag);
      x.answered += 1;
      if (q.attempts[0].correct) x.firstTry += 1;
      if (q.attempts[q.attempts.length - 1].correct) x.now += 1;
    }
  }
  for (const c of db.cards) {
    for (const tag of c.tags) {
      if (tag === 'missed') continue;
      const x = topic(tag);
      x.cards += 1;
      x.lapses += c.lapses;
    }
  }
  const topics = Object.values(t).filter((x) => x.answered > 0)
    .map((x) => ({ ...x, accuracy: Math.round((100 * x.firstTry) / x.answered) }))
    .sort((a, b) => a.accuracy - b.accuracy || b.answered - a.answered);

  const memory = { new: 0, learning: 0, young: 0, mature: 0 };
  for (const c of db.cards) {
    if (!c.reviews) memory.new += 1;
    else if (c.interval < 3) memory.learning += 1;
    else if (c.interval < 21) memory.young += 1;
    else memory.mature += 1;
  }

  const fixed = db.quizzes.filter((q) => q.attempts.length > 1 && !q.attempts[0].correct && q.attempts[q.attempts.length - 1].correct).length;
  const concepts = new Set([...db.lessons.flatMap((l) => l.concepts || []), ...db.quizzes.flatMap((q) => q.tags)]);
  return {
    days, topics, memory, fixed,
    projects: new Set(db.lessons.map((l) => l.project)).size,
    concepts: concepts.size,
    answered14: days.reduce((n, d) => n + d.correct + d.missed, 0),
  };
}

function progress() {
  const db = load();
  const now = Date.now();
  const firstTries = db.quizzes.filter((q) => q.attempts.length).map((q) => q.attempts[0].correct);
  const weak = {};
  for (const c of db.cards) for (const t of c.tags) if (t !== 'missed') weak[t] = (weak[t] || 0) + c.lapses;
  for (const q of db.quizzes) {
    if (q.attempts[0] && !q.attempts[0].correct) for (const t of q.tags) weak[t] = (weak[t] || 0) + 1;
  }
  return {
    mode: getMode(),
    lessons: db.lessons.length,
    cards: db.cards.length,
    cards_due: db.cards.filter((c) => c.due <= now).length,
    cards_mature: db.cards.filter((c) => c.interval >= 21).length,
    quizzes_answered: firstTries.length,
    first_try_accuracy: firstTries.length ? Math.round((100 * firstTries.filter(Boolean).length) / firstTries.length) : null,
    streak_days: streak(db, now),
    weakest_topics: Object.entries(weak).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t]) => t),
    insights: insights(db, now),
    recent_lessons: db.lessons.slice(-5).reverse().map((l) => ({ id: l.id, title: l.title, project: l.project, score: lessonScore(db, l.id) })),
  };
}

// ---------- agent activity (written by hooks, shown in the dashboard header) ----------

function readAgents() {
  try { return JSON.parse(fs.readFileSync(AGENT_FILE, 'utf8')); } catch { return {}; }
}

// One entry per Claude Code session; the dashboard shows the most recently updated one.
function setAgent({ session, state, message = '', project = '' }) {
  if (!AGENT_STATES.includes(state)) throw new Error(`state must be one of: ${AGENT_STATES.join(', ')}`);
  const now = Date.now();
  const all = readAgents();
  for (const [k, v] of Object.entries(all)) if (now - v.at > DAY) delete all[k];
  all[session || 'default'] = { state, message: String(message).slice(0, 500), project, at: now };
  fs.mkdirSync(HOME, { recursive: true });
  const tmp = `${AGENT_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all));
  fs.renameSync(tmp, AGENT_FILE);
  return all[session || 'default'];
}

// Every known session, most recently active first.
function getAgents() {
  return Object.entries(readAgents()).map(([session, a]) => ({ session, ...a })).sort((a, b) => b.at - a.at);
}

function getAgent() {
  return getAgents()[0] || null;
}

// SessionEnd: the session is gone, so it leaves the dashboard.
function removeAgent(session) {
  const all = readAgents();
  if (!all[session]) return false;
  delete all[session];
  fs.writeFileSync(AGENT_FILE, JSON.stringify(all));
  return true;
}

function agentStamp() {
  try { return fs.statSync(AGENT_FILE).mtimeMs; } catch { return 0; }
}

// ---------- mode ----------

function getMode() {
  try {
    const raw = JSON.parse(fs.readFileSync(MODE_FILE, 'utf8')).mode;
    const m = LEGACY_MODES[raw] || raw;
    return MODES.includes(m) ? m : 'sidecar';
  } catch {
    return 'sidecar';
  }
}

function setMode({ mode }) {
  if (!MODES.includes(mode)) throw new Error(`mode must be one of: ${MODES.join(', ')}`);
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(MODE_FILE, JSON.stringify({ mode }));
  return { mode };
}

module.exports = {
  HOME, FILE, load, createLesson, addItems, completeLesson, answerQuiz,
  dueCards, gradeCard, progress, getMode, setMode, schedule, takeUnreported, liveLesson, liveLessons, setAgent, getAgent, getAgents, removeAgent, agentStamp,
};
