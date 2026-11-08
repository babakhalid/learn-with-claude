---
name: progress
description: Show the user's learning progress and open the flashcard/quiz dashboard in the browser. Use when the user asks about progress, stats, streak, "what have I learned", or wants to practice in the browser.
---

# Learning progress

1. Call `get_progress` and render it compactly:

```
4-day streak · 12 lessons · 38 cards (7 due, 9 mastered)
First-try accuracy: 74%
Focus next on: sql-indexes, react-effects
Recent: Add rate limiting (3/4) · Fix N+1 query (2/2)
```

2. Call `open_dashboard` and share the URL. The dashboard has flip cards with keyboard shortcuts (Space, then keys 1–4), quizzes with instant right/wrong feedback, lesson history, and stats.
3. If any topics are weak, offer a 2-minute review on the weakest one (the `review` skill).
