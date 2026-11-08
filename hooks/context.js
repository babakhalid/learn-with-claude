#!/usr/bin/env node
// Claude Code hook: injects teach-mode context.
//   session -> learn mode + due-card count at SessionStart
//   prompt  -> per-prompt teach-mode reminder, plus answers the user gave in the dashboard
//              since the last prompt (so Claude can clear up a misconception in one line)
//   ask / answered / notify / stop -> agent activity for the dashboard header:
//              working, waiting on the user (a question or a permission prompt), or finished
//   end     -> SessionEnd: the session leaves the dashboard
// Never blocks or fails the session: any error exits 0 silently.
'use strict';

const event = process.argv[2];
// Claude Code reads the hook list once, at session start, but runs this script fresh each time.
// A session started before the Stop/Notification hooks existed would mark itself "working" on every
// prompt and never "finished". Only sessions registered with the full hook set (tagged here) report status.
const HOOKS_VERSION = 2;
const fullHookSet = process.argv.includes(`--hooks=${HOOKS_VERSION}`);
const TAG = '[learn-with-claude]';

const REMINDER = {
  sidecar: `${TAG} Sidecar teach mode: if this request changes code, follow the learn-with-claude:teach skill. Critique in session; background builder + teacher; the lesson goes to the dashboard; recap of 3 lines or fewer. Keep teaching out of the chat. Skip trivial chores and pure questions.`,
  inline: `${TAG} Inline teach mode: if this request changes code, follow the learn-with-claude:teach skill (inline flow: quizzes in session via AskUserQuestion, graded with answer_quiz). Skip trivial chores and pure questions.`,
  light: `${TAG} Light teach mode: if this changes code, do the work, then save one note + one check question + 1-2 flashcards to the dashboard (add_learning_items) and add one line pointing to it. Skip trivial chores and pure chat.`,
};

function emit(hookEventName, additionalContext) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } }));
}

function readStdin() {
  try { return JSON.parse(require('fs').readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}

function answersSummary(answers) {
  if (!answers.length) return '';
  const right = answers.filter((a) => a.correct).length;
  const missed = answers.filter((a) => !a.correct).slice(0, 3)
    .map((a) => `"${a.question}" (chose "${a.chose}", correct "${a.answer}")`);
  return `${TAG} Since the last message the user answered ${answers.length} dashboard question${answers.length > 1 ? 's' : ''}: ${right} correct.`
    + (missed.length ? ` Missed: ${missed.join('; ')}. If relevant, clear up the misconception in ONE sentence at the end of your reply.` : ' No need to mention it.');
}

// What the dashboard header shows for each hook event.
function activity(event, input) {
  if (event === 'prompt' || event === 'answered') return { state: 'working' };
  if (event === 'stop') return { state: 'done' };
  if (event === 'notify') return { state: 'waiting', message: input.message || 'Claude needs your input' };
  if (event === 'ask') {
    const q = (input.tool_input && input.tool_input.questions) || [];
    return { state: 'waiting', message: q.map((x) => x.question).filter(Boolean).join(' / ') || 'Claude asked you a question' };
  }
  return null;
}

try {
  const store = require('../mcp/store');
  const mode = store.getMode();
  const input = readStdin();

  if (event === 'end') store.removeAgent(input.session_id || 'default');
  const act = fullHookSet && mode !== 'off' && activity(event, input);
  if (act) store.setAgent({ session: input.session_id, project: require('path').basename(input.cwd || process.cwd()), ...act });

  if (event === 'session' && mode !== 'off') {
    const due = store.progress().cards_due;
    const lines = [`${TAG} Teach mode is "${mode}". For code-change requests follow the learn-with-claude:teach skill.`];
    if (due > 0) lines.push(`${TAG} ${due} flashcard${due > 1 ? 's are' : ' is'} due. Mention it once at a natural pause (not mid-task): dashboard or /learn-with-claude:review.`);
    emit('SessionStart', lines.join('\n'));
  }

  if (event === 'prompt' && mode !== 'off') {
    const prompt = String(input.prompt || '').trim();
    const words = prompt.split(/\s+/).filter(Boolean).length;
    const parts = [answersSummary(store.takeUnreported())];
    if (!prompt.startsWith('/') && words >= 4) parts.push(REMINDER[mode]);
    const text = parts.filter(Boolean).join('\n');
    if (text) emit('UserPromptSubmit', text);
  }
} catch {
  // Learning must never break the coding session.
}
process.exit(0);
