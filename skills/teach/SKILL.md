---
name: teach
description: Teach-while-building mode. Use whenever the user asks for a code change while learn mode is on, or says "teach me", "learn mode", "explain as you go". Critiques the request against best practice, does the work in a background builder, and has a teacher agent stream micro-lessons, predict-first quizzes, a walkthrough of the real diff, and spaced-repetition flashcards into a live dashboard, so the coding session stays clean.
argument-hint: <what to build or change>
---

# Teach while building

The user should come away from every task able to explain **what changed, why, and the concept behind it**, without the teaching slowing down or cluttering the coding session.

Task: $ARGUMENTS (if empty, use the user's latest request).

## Tools and agents

- **`learn` MCP tools** (in Claude Code: `mcp__plugin_learn-with-claude_learn__<tool>`): `create_lesson`, `add_learning_items`, `answer_quiz`, `complete_lesson`, `open_dashboard`, `get_progress`.
- **Subagents** (Claude Code): `learn-with-claude:builder` writes the code and always runs in the background. `learn-with-claude:teacher` runs on Sonnet, is read-only, and writes the lesson into the dashboard.
- If the MCP server is unavailable, do the work normally and tell the user once that teach mode is off because the learn server isn't connected.

## 1. Calibrate (always)

| Size | Example | Teaching |
|---|---|---|
| Trivial | rename, typo, version bump | None. Just do it. |
| Small | one function, one idea | Use the **light** flow, whatever the mode. |
| Real | feature, refactor, a bug with a lesson in it | Use the flow for the current mode. |

The mode comes from the hook context: `sidecar` (default), `inline`, `light`, or `off`. If the user says "just do it" or seems rushed, use light or nothing for this task.

## 2. Critique (always in the session, for Small and Real tasks)

This is the one part of teaching that belongs in the session, because it changes the code.
- Is there a better approach? Consider security, correctness, performance, maintainability, an idiomatic pattern in *this* codebase, or an existing utility to reuse.
- If yes, state it in 2–4 lines with the concrete tradeoff and the principle behind it, then ask with `AskUserQuestion`, putting your recommendation first.
- If the request is sound, say so in one line and name the principle. Don't invent problems or block on taste.

## 3a. Sidecar flow (default)

1. `create_lesson` with the title, goal, and critique.
2. **In a single message**, launch both agents in the background:
   - **builder**: the full task, the agreed approach, the relevant files, and constraints.
   - **teacher**, phase `prime`: `lesson_id`, the task, the approach, and the key files.
3. Call `open_dashboard`. It does nothing if a dashboard tab is already open. Then tell the user in **one line**: `Lesson is live in the dashboard (<url>). I'll let you know when the build is done.` The session is now free, so answer anything the user asks in the meantime normally.
4. **When the builder finishes:** verify the work. Read the diff, and run the tests or build if the builder didn't. Fix problems before anything gets taught.
5. Launch the **teacher** again in the background, phase `walkthrough`, with the `lesson_id` and the builder's full report. Then give the user the usual short result of the work, as you would without this plugin.
6. **When the teacher finishes:** call `complete_lesson` and post a recap of **3 lines or fewer**:
   ```
   Lesson: <title> · 2/3 correct so far · 4 cards saved · 1 question still open in the dashboard
   Missed: <question> → <answer>. <one-line why>
   Remember: <the single most important idea>
   ```
   Leave out the "Missed" line if nothing was missed.

**Later answers.** The prompt hook tells you when the user answers questions in the dashboard. If they missed something, add **one** clarifying sentence at the end of your next reply. Don't re-teach the lesson.

**No background subagents (e.g. Codex):** do the work yourself in chunks. Before the first chunk, add the concept notes and `predict` questions yourself with `add_learning_items`. After the work, add the walkthrough, diff questions, and flashcards. Never wait for answers; the user answers in the dashboard.

## 3b. Inline flow (`inline` mode, for users who want everything in the terminal)

Same as sidecar, except the main thread asks the questions in the session:
- After launching the builder, teach 1–3 concepts in sequence:
  1. Ask a predict question.
  2. Give a micro-lesson of 5 lines or fewer.
  3. Ask a quiz question.
- Save each question with `add_learning_items` first, ask it with `AskUserQuestion` (2–4 options; never mark the correct one), then grade it with `answer_quiz`.
  - Correct: `Correct.` plus one line that deepens the point.
  - Wrong: `Not quite. It's **X**.` plus the explanation, and note that it's now a flashcard.
- When the builder finishes:
  1. Verify the work.
  2. Walk through it in 10 lines or fewer (`file:line`, what, why).
  3. Ask 1–2 questions about the diff.
  4. Save 2–5 flashcards.
  5. Call `complete_lesson`.
  6. Post the recap.
- **No question tool (e.g. Codex):** print options A–D, then end your turn and wait for the answer.

## 3c. Light flow (`light` mode, or Small tasks)

Do the work normally. Then, in a single `add_learning_items` call, save:
- a two-line note
- one `check` question
- 1–2 flashcards

Call `complete_lesson`, then add one line: `Lesson: 1 question + 2 cards in the dashboard: <concept>`.

## Spaced review

If the session-start context says cards are due, mention it **once**, at a natural pause and never mid-task: `5 cards due. Review them in the dashboard or with /learn-with-claude:review.`

## Tone

- No emoji, in the chat or anywhere in lesson content.

- Sound like a sharp, warm colleague.
- Never let teaching delay or degrade the work.
- In the session, teaching gets the fewest lines possible. The dashboard holds the rest.
