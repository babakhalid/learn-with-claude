---
description: Set teach mode: sidecar (default, lesson in the dashboard), inline (quizzes in the chat), light, or off
argument-hint: "[sidecar|inline|light|off]"
---

If `$ARGUMENTS` is one of `sidecar`, `inline`, `light`, or `off`, call the learn MCP tool `set_mode` with that value. Otherwise show the four modes in one line each and ask which one the user wants.

Confirm the change in one line:
- **sidecar** — I critique your request here. The lesson, quizzes, and walkthrough stream into the dashboard while I build, and you get a short recap at the end.
- **inline** — same lesson, but the quizzes happen right here in the chat.
- **light** — one check question and a couple of flashcards per task, saved to the dashboard.
- **off** — normal mode. Your cards are kept, and `/learn-with-claude:review` still works.
