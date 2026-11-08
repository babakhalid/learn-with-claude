---
name: review
description: Spaced-repetition review of flashcards from past teach-mode lessons. Use when the user says "review", "quiz me", "flashcards", "what did I learn", or when cards are due and there's a natural pause.
argument-hint: "[topic tag]"
---

# Review due flashcards

1. Call `get_due_cards`, passing `tag: $ARGUMENTS` if one was given, with `limit: 8`. If nothing is due, say so, show `get_progress` in one line, and offer `include_upcoming: true` to cram or `open_dashboard`.
2. For each card, **ask first and reveal second**. Retrieval is what builds memory.
   - Show the front only and ask the user to answer in their own words. Then end your turn, or use a free-text prompt.
   - Reveal the back, then compare it with their answer in one line, noting what they nailed and what they missed.
   - Ask how it went. In Claude Code, use `AskUserQuestion` with these options:
     - Again (forgot)
     - Hard
     - Good
     - Easy

     Elsewhere, ask "1 Again · 2 Hard · 3 Good · 4 Easy". Infer the grade yourself if the answer was clearly right or wrong and the user prefers speed.
   - Call `grade_card`.
3. For speed you can turn a card into a multiple-choice question. Generate 3 plausible distractors and ask with options. Don't save it as a new quiz.
4. Finish with: `Reviewed 6 · 5 recalled · next due: <soonest>`. If they missed a card, give the one idea to remember.

Keep it brisk. A review session should take about 2–3 minutes.
