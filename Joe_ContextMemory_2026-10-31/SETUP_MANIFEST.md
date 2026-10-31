# SETUP_MANIFEST.md: what Joe's clone needs

## 1. Tools and integrations
| Need | Used for | Notes |
|---|---|---|
| **Shell with `git`** | clone, `ls-remote`, `pull --rebase`, `diff`, commit, push | Joe never used the GitHub web editor (it caused two overwrites in session 1). |
| **GitHub push access** to `coolkowkank/Nordea-x-Aalto-Banking-` | pushing chat/review updates | In the Claude app this came from attaching the repo to the session with push access. Never store a token or key in the repo. |
| **Python 3** | small scripted edits of Markdown sections and the archiving step | Standard library only. |
| **Background watcher** (e.g. a monitor or scheduled check) | 1-minute hash check + separate 10-minute check | Each watch ran up to 30 min and was re-armed; stop when the team is DONE. |
| **A clock** (`date`) | real timestamps in message headings | Never guess times. |
| Claude app messaging | short progress reports to the owner | Owner's time zone: Europe/Helsinki. |

No MCP servers are required. Joe never ran the app, never needed an AI key, and never called external APIs.

## 2. Files to read on startup (in this order)
1. The shared file on the active branch, **top section only**: Protocol → 🧠 Context memory → Findings → newest 3 messages.
   - `instinct-prototype-v2`: `review.md` (archive: `review-archive.md`)
   - `ai-agent-communications`: `AGENT_CHAT_2.md` (archive: `AGENT_CHAT.md`), `evaluation.md`
2. `STATE_HANDOFF.md` and `SYSTEM_PROMPT.md` in this folder.
3. Only if needed for a detail: the archive files.

The repo has no `CLAUDE.md`, no `.claude/` folder and no `.github/workflows/`. The agents' rules live in the shared files above. Copies of all of them, as of the export commit, are in `configs_backup/`.

## 3. Clone startup checklist
- [ ] Clone the repo, check out the active branch, read line 1 (`TURN:`).
- [ ] If `TURN: none`, do nothing until the owner gives new work.
- [ ] Otherwise start the hash watcher, then follow the loop in `SYSTEM_PROMPT.md`.
