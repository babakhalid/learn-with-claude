#!/usr/bin/env node
// "learn" MCP server (stdio, newline-delimited JSON-RPC). Zero dependencies.
// Works with Claude Code, Codex, and any MCP client.
'use strict';

const readline = require('readline');
const store = require('./store');
const dashboard = require('./dashboard');
const { version } = require('../package.json');

const flashcard = {
  type: 'object',
  properties: {
    front: { type: 'string', description: 'Question/prompt side. One atomic idea; ask "why"/"when", not trivia.' },
    back: { type: 'string', description: 'Answer side. Short; include the reason.' },
    tags: { type: 'array', items: { type: 'string' }, description: 'Concept tags, e.g. ["react","memoization"].' },
  },
  required: ['front', 'back'],
};

const quizItem = {
  type: 'object',
  properties: {
    question: { type: 'string' },
    options: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 4, description: 'Plausible options; vary the correct position.' },
    answer_index: { type: 'integer', description: '0-based index of the correct option. Never reveal it to the user before they answer.' },
    explanation: { type: 'string', description: 'Why the right answer is right and the tempting wrong one is wrong.' },
    tags: { type: 'array', items: { type: 'string' } },
    kind: { type: 'string', enum: ['predict', 'check', 'diff'], description: 'predict = asked before the code exists, check = about a concept, diff = about the actual change. Default check.' },
  },
  required: ['question', 'options', 'answer_index', 'explanation'],
};

const note = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Concept name, e.g. "Sliding-window rate limiting".' },
    body: { type: 'string', description: 'Micro-lesson, max ~6 lines. Markdown: **bold**, `code`, ``` fenced blocks. Prefer a snippet from the user\'s codebase.' },
  },
  required: ['title', 'body'],
};

const change = {
  type: 'object',
  properties: { file: { type: 'string', description: 'path:line' }, what: { type: 'string' }, why: { type: 'string' } },
  required: ['what', 'why'],
};

const TOOLS = [
  {
    name: 'create_lesson',
    description: 'Start a lesson for the current task. Call once at the start of teach mode; returns lesson_id used by the other tools.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short name of the task, e.g. "Add rate limiting to /api/login".' },
        goal: { type: 'string', description: 'What the user asked for.' },
        critique: { type: 'string', description: 'Your honest review of the request and any better approach you proposed.' },
        tags: { type: 'array', items: { type: 'string' } },
        project: { type: 'string', description: 'Project name. Defaults to the working directory name.' },
      },
      required: ['title'],
    },
    run: (a) => {
      const l = store.createLesson(a);
      return { lesson_id: l.id, title: l.title, project: l.project };
    },
  },
  {
    name: 'add_learning_items',
    description: 'Add content to a lesson; it appears live in the dashboard. notes = micro-lessons, quiz = multiple-choice questions (ids are passed to answer_quiz when the user answers in-session), flashcards = spaced-repetition cards (first review in ~1 day), changes/summary = the walkthrough of the real diff.',
    inputSchema: {
      type: 'object',
      properties: {
        lesson_id: { type: 'string' },
        notes: { type: 'array', items: note },
        quiz: { type: 'array', items: quizItem },
        flashcards: { type: 'array', items: flashcard },
        changes: { type: 'array', items: change, description: 'Walkthrough of the diff. Replaces any previous list.' },
        summary: { type: 'string', description: 'One or two sentences on what was built.' },
      },
      required: ['lesson_id'],
    },
    run: (a) => {
      const { cards, quizzes } = store.addItems(a);
      return {
        flashcard_ids: cards.map((c) => c.id),
        quiz: quizzes.map((q) => ({ quiz_id: q.id, question: q.question, options: q.options })),
      };
    },
  },
  {
    name: 'answer_quiz',
    description: "Grade the user's answer to a saved quiz question. Returns correct/incorrect, the right answer and explanation, and the running lesson score. A wrong answer automatically becomes a flashcard due in 10 minutes.",
    inputSchema: {
      type: 'object',
      properties: {
        quiz_id: { type: 'string' },
        chosen_index: { type: 'integer', description: '0-based index of the option the user picked.' },
      },
      required: ['quiz_id', 'chosen_index'],
    },
    run: (a) => store.answerQuiz(a),
  },
  {
    name: 'complete_lesson',
    description: 'Mark a lesson done. Returns the score so far, the questions the user missed, and the card count, for a short recap. Questions the user hasn\'t answered yet stay open in the dashboard.',
    inputSchema: {
      type: 'object',
      properties: {
        lesson_id: { type: 'string' },
        summary: { type: 'string' },
        changes: { type: 'array', items: change },
        concepts: { type: 'array', items: { type: 'string' }, description: 'Concept names covered.' },
      },
      required: ['lesson_id'],
    },
    run: (a) => {
      const { lesson, score, missed, cards } = store.completeLesson(a);
      return { lesson_id: lesson.id, score, missed, cards, streak_days: store.progress().streak_days };
    },
  },
  {
    name: 'get_due_cards',
    description: 'Flashcards due for spaced-repetition review, oldest first.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', default: 10 },
        tag: { type: 'string' },
        include_upcoming: { type: 'boolean', description: 'Also return cards not yet due (for cramming).' },
      },
    },
    run: (a) => store.dueCards({ limit: 10, ...a }).map((c) => ({ card_id: c.id, front: c.front, back: c.back, tags: c.tags, lesson: c.lesson, reviews: c.reviews })),
  },
  {
    name: 'grade_card',
    description: 'Record how well the user recalled a flashcard and schedule its next review. again = forgot, hard = recalled with effort, good = recalled, easy = instant.',
    inputSchema: {
      type: 'object',
      properties: {
        card_id: { type: 'string' },
        grade: { type: 'string', enum: ['again', 'hard', 'good', 'easy'] },
      },
      required: ['card_id', 'grade'],
    },
    run: (a) => store.gradeCard(a),
  },
  {
    name: 'get_progress',
    description: "The learner's stats: lessons, cards due, first-try accuracy, streak, weakest topics, recent lessons.",
    inputSchema: { type: 'object', properties: {} },
    run: () => store.progress(),
  },
  {
    name: 'open_dashboard',
    description: 'Start the local learning dashboard and open it in the browser, unless a dashboard tab is already open (then it does nothing). Its Live tab shows the current lesson and updates by itself.',
    inputSchema: {
      type: 'object',
      properties: { open: { type: 'boolean', default: true, description: 'Open the browser automatically.' } },
    },
    run: async ({ open = true } = {}) => {
      const url = await dashboard.start();
      if (await dashboard.viewerActive(url)) return { url, opened: false, already_open: true };
      return { url, opened: open ? dashboard.openBrowser(url) : false, already_open: false };
    },
  },
  {
    name: 'set_mode',
    description: 'Set teach mode: sidecar (default; critique in session, lesson + quizzes live in the dashboard), inline (quizzes in the session), light (one check question + recap card), off.',
    inputSchema: {
      type: 'object',
      properties: { mode: { type: 'string', enum: ['sidecar', 'inline', 'light', 'off'] } },
      required: ['mode'],
    },
    run: (a) => store.setMode(a),
  },
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}
function fail(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

async function onMessage(msg) {
  const { id, method, params = {} } = msg;
  if (id === undefined || id === null) return; // notification
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: params.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'learn', version },
        instructions: 'Teach-while-building tools. Save lessons, flashcards and quizzes; grade answers server-side; schedule spaced repetition.',
      });
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call': {
      const tool = byName.get(params.name);
      if (!tool) return fail(id, -32602, `Unknown tool: ${params.name}`);
      try {
        const out = await tool.run(params.arguments || {});
        return reply(id, { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] });
      } catch (e) {
        return reply(id, { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
      }
    }
    default:
      return fail(id, -32601, `Method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return fail(null, -32700, 'Parse error'); }
  onMessage(msg).catch((e) => fail(msg.id ?? null, -32603, e.message));
});
rl.on('close', () => process.exit(0));
