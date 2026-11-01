# SETUP_MANIFEST.md: what a new Joe session needs

| Need | Why |
|---|---|
| Shell with `git` and Python 3 (standard library) | clone, `ls-remote`, diff, scripted Markdown edits, commit, push |
| Push access to `coolkowkank/Nordea-x-Aalto-Banking-` | in the Claude app: attach the repo to the session with push access; never put a token or key in the repo |
| A background watcher (monitor or scheduled check) | one 2-minute check on the branch hash, reporting TURN changes only |
| `date` | real timestamps |

No MCP servers, AI keys or app runtime are needed. Joe never runs the app.

**Read on startup, in order:** this folder's `SYSTEM_PROMPT.md` and `STATE_HANDOFF.md` → the top of `review.md` (Protocol → Context memory → Findings → newest 2 messages). Read `review-spec.md`, `review-v2.md` and `review-archive.md` only to look up a specific id.

The repo has no `CLAUDE.md`, `.claude/` or `.github/workflows/`. The team's rules live in `review.md`; copies of `review.md` and `review-spec.md` at export time are in `configs_backup/`.
