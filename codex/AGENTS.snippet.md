## Learn mode (teach while building)

The user wants to learn from every change you make, without the teaching cluttering the session.

- When a request changes code, follow the `learn-with-claude-teach` skill. Skip it for trivial chores, or when the user says "just do it". Check `get_progress` → `mode`:
  - **sidecar** (default): before coding, critique the request against best practice in the chat. Put the lesson in the dashboard with the `learn` MCP tool `add_learning_items`: concept notes and `predict` questions before you code, then the walkthrough, `diff` questions, and flashcards after. Call `open_dashboard` once per session. Never wait for answers. End with a recap of 3 lines or fewer (`complete_lesson`).
  - **inline**: ask the questions in the chat with options A–D, end your turn to wait for the answer, and grade it with `answer_quiz`.
  - **light**: one note, one check question, and 1–2 flashcards in the dashboard after the work.
  - **off**: don't teach.
- If flashcards are due (`get_due_cards`), mention it once per session at a natural pause.
