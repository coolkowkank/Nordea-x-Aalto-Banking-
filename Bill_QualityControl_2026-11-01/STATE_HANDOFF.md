# State handoff: Bill, 2 Nov 2026, 00:15 Helsinki

## Where things stand

- **Branch:** `instinct-prototype-v3`. Bill's last push is `25f0143` (his 18:07 message). Last code Bill reviewed: `4844ff8`.
- **Turn:** Instinct, but **Instinct is paused by the owner** (chat, 18:07: stop work and commits until the owner has spoken with him). Do not start the watcher or review until the owner says to resume. Check line 1 of `review.md` and the newest 2 messages first; the owner may have moved things since.
- **Tests at 4844ff8** (run with `TZ=Europe/Helsinki`): test:arch 229/229, test:migrate 43/43, test:adapter 44/44, test:e2e 27/27, test:remote 35/35, npm test passes, lint clean, review guard passes.
- **Verified:** G1–G29, G33, G34 (see the `Verified:` line in `review.md`).

## Open findings

| Id | What remains |
|---|---|
| **G30 (H)** | **One Abel.** Slices 1 and 2 (legacy migration `npm run migrate:legacy`, plumbing in the three DBs) are checked and OK. **Slice 3 is shipped by Instinct but NOT yet reviewed by Bill:** `/api/chat` now answers through the arch `chat()` (`src/server/routes.ts:132-155`), the app's conversation id is the arch session id, offers/partners code is deleted, suggestions are model-composed and figure-guarded (`personal.ts`, `orchestrator.ts`). Still to check: the cond-4 e2e (same conversation id, messages and doc in the app and in `/arch.html`), what the deletions broke next to them (cards, import flow, `selftest.ts`, `abelOffline.ts`), the honesty-line copy (Q3) and the full retirement of `abel.ts`. Bill's four conditions of 16:26 are the gate (see `review.md` Context memory). |
| **G31 (M)** | Monitor needs per-agent data cards and the actual model label; both pages refresh slowly. Not started. |
| **G32 (M)** | Closing live pass on the final code: (1) e2e, isolation scans and a Groq run after G30; (2) a README-only from-zero run, local then hosted twice; (3) live Supabase restart and delete; (4) a live feed row via `agent_nordea` (owner re-runs `nordea-feed.sql` first); (5) `supabase/role-smoke.sql` all PASS. Legs 3–5 need the owner. |

## Waiting on the owner

- **Release Instinct** (he is paused) and talk to him. Instinct was unreachable at 18:30.
- **Confirm the offers retirement to Bill directly.** The shopping and referral offers were removed on a WhatsApp answer relayed by Instinct and Joe (17:44). Bill treats it as information until the owner confirms it in chat.
- Supabase access for G32 legs 3–5 (the owner runs SQL and counts; passwords only through Instinct's secure form, never in chat or the repo).
- The owner was away until 20:00 on 1 Nov; questions for him go through Instinct, in one batch.

## Settled decisions (don't reopen)

- Three agents, three DBs, no fourth store (V1). Writes go through the owning agent.
- Abel answers only from the finalised session `context.md` (owner flow, 16:22). First message of a session builds the doc, even "hello"; later small talk needs no round.
- Risk comes from code rules. Code owns numbers, evidence and writes; the LLM proposes.
- `cabinet-db.json` migrates into the three DBs, is verified, then deleted. **No backup copy** (owner, 16:52).
- Hosted mode: one Postgres role per agent through the session pooler, project `zyuzexnawvelyyzmydog`, `aws-0-eu-north-1`. A load merges: hydrate, write, push. A hosted migration hydrates first, awaits the push, reads every row back (compared with `canon()`, because the hosted column is `jsonb`) and only then deletes the file.
- `load_data.py` writes plumbing straight into the agent DBs; a fresh load never creates `cabinet-db.json` (G33).
- The monitor is on by default; `DEV_MONITOR=0` turns it off.
- Real-model runs use the Groq free tier with `LLM_MAX_CALLS` set. Any further budget is the owner's call.
- The external MCP agent is out of scope (V9).
