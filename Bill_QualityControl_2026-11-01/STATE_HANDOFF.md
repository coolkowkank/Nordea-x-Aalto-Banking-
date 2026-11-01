# State handoff: Bill, 1 Nov 2026, 16:49 Helsinki

## Where things stand

- **Branch:** `instinct-prototype-v3`. The last commit Bill reviewed is `c621afa`, his 16:43 message.
- **Turn:** Instinct.
- **Tests at 0778fec:** test:arch 229/229, test:adapter 43/43, test:e2e 23/23, test:remote 35/35, npm test passes, lint is clean, the review guard passes.
- **Verified:** G1–G29 except G30 and G31 (see the `Verified:` line in `review.md`).

## Open findings

| Id | What remains |
|---|---|
| **G30 (H)** | **One Abel.** Today the app's `/api/chat` runs the legacy `abelTurn`, while `/arch.html` runs the personal agent. Bill OK'd the plan at 16:26 with four conditions:<br>1. Later questions get a top-up round, not a full rebuild.<br>2. A session's first message, even "hello", builds the doc first; later small talk needs no round.<br>3. No direct bank tools; every figure traces to a doc row.<br>4. Both UIs show the same conversation id, messages and doc, proven by e2e.<br>It also includes the **legacy migration**: `cabinet-db.json` moves into the three DBs only (chat, topicLog and settings to user.db; accessLog to cm.db; rewards to nordea.db). The migration must fail closed and pass an all-3 verify before the file is deleted. |
| **G31 (M)** | Instinct's own finding: the monitor needs per-agent data cards and the actual model label, and both pages refresh slowly. |
| **G32 (M)** | **Closing live pass on the final code.**<br>1. After G30: e2e, the isolation scans and a real-model run on Groq.<br>2. A from-zero run with the README only: a local load, then the hosted load twice (the second must merge).<br>3. Live Supabase: data survives a restart, and a delete clears the hosted rows.<br>4. A live feed row is applied through `agent_nordea`. The owner must re-run `nordea-feed.sql` first.<br>5. `supabase/role-smoke.sql`: every row PASS.<br>Legs 3–5 need the owner, because the sandbox can't reach Supabase. |

## Waiting on the owner

- Whether to keep a dated backup `cabinet-db.json.migrated-<date>` before the migration deletes the file. Bill recommended keeping it.
- Supabase access for G32 legs 3–5. The owner runs the SQL and counts in the SQL editor; Instinct collects passwords through its secure form. Never in chat or in the repo.

## Settled decisions (don't reopen)

- Three agents, three DBs, no fourth store (V1, updated 16:43). Writes go through the owning agent.
- Abel answers only from the finalised session `context.md` (owner flow, 16:22).
- Risk comes from code rules. Code owns numbers, evidence and writes; the LLM proposes.
- Hosted mode: one Postgres role per agent through the session pooler, project `zyuzexnawvelyyzmydog`, `aws-0-eu-north-1`.
  - A load **merges**: hydrate, then write, then push. A failed hydrate stops the load. A missing local file never replaces hosted rows.
- The monitor is on by default; `DEV_MONITOR=0` turns it off (V6, updated 15:08).
- The real-model runs use the Groq free tier, owner-approved, with `LLM_MAX_CALLS` set. Any further budget is the owner's call.
- The external MCP agent is out of scope (V9).
