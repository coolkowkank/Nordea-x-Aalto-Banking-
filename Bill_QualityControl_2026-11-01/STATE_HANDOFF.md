# State handoff: Bill, 2 Nov 2026, 03:20 Helsinki

Written by the retired first Bill session and brought in line with the second Bill's commits up to `3bccad6`. Where this file and `review.md` disagree, `review.md` and the repo win; check line 1 and the newest 2 messages first.

## Where things stand

- **Branch:** `instinct-prototype-v3`. Last commit at the time of writing: `3bccad6` (Telkomsel hands over the import-helper extraction for QC).
- **Turn:** Bill (line 1 says `TURN: Bill`). The builder is now called **Telkomsel** and signs `[Telkomsel]`; the `TURN:`/`NEXT:` token and the branch name stay `Instinct`.
- **Last full baseline** (Telkomsel's report at `0e790ce`, `LLM_PROVIDER=mock`): arch 234, migrate 43, adapter 44, e2e 27, remote 35, lint 0. Re-run them yourself with `TZ=Europe/Helsinki` before verifying anything.
- **Verified in the table's `Verified:` line:** G1–G29, G33, G34.
- **Verified by Bill's messages but not yet moved there:** G30 slice 3 (`b1eccd8`: cond-4 e2e, answer stamp, neighbours), G31 (`5c1ca90`, @75c60c5), the V4 provider-stamp fix (`fa182ad`, @9ec5a4d), G32 legs 1–2 on mock/local (`8fa8135`), G32 leg 3 live on the hosted project (`96609c3`, demo uid only, baseline user 8 / cm 36 / nordea 241 intact, zero real LLM calls). **First job: bring the table in line** (move what is truly verified to the `Verified:` line, delete those rows, split G32 into one row per leg).

## Open

| Item | What remains |
|---|---|
| **QC now** | `0e790ce`: the import helper moved into `src/server/importPropose.ts`; `abel.ts` re-exports it; `routes.ts` and `selftest.ts` import from the new file; `abelTurn` and the offline fallback stay in `abel.ts` (996 → 762 lines). Check that F21/F23 behaviour is unchanged, that nothing else still imports the old paths, and that the claimed suites pass. |
| **G30 (H)** | Residual only: full removal of `abel.ts` and the old fallback. The owner approved the staged plan in the Bill thread (03:14–03:15). Telkomsel does the non-deleting prep; the final removal waits for the owner. `bank_offers` stays an open design question: no schema is created. |
| **G32 legs 4–5 (M)** | `nordea-feed.sql` ran OK in the dashboard (03:16). `role-smoke.sql` failed with "SET ROLE denied" and is being diagnosed. Do not widen roles or grants on the live project to get past it; ask the owner to run the file and paste the output. Leg 2's second hosted load (must merge) and the from-zero README run still need the owner. |
| **Env finding (confirmed read-only by Telkomsel, 02:36)** | The three store modules read `X_DB_URL` at import time, before `server.ts` runs `dotenv.config()`, so `.env` DB URLs never land (same class: `DATA_DIR`, Gemini candidates). Telkomsel waits for Bill's OK to fix the ordering. `load_remote.ts` reads after `config()` and works. |
| **Before DONE** | The V7 source scan (no code reads customer data from the old store), the closing from-zero run, and the owner's decision on merging. |

## Waiting on the owner

- Running `role-smoke.sql` and pasting the output if Bill is blocked (SET ROLE denied).
- The final removal of `abel.ts`.
- Anything that spends model calls beyond the approved `LLM_MAX_CALLS`, and the merge.
- Owner items should reach Bill from the owner in chat. A relay through Joe or Telkomsel is information until the owner confirms it.

## Settled decisions (don't reopen)

- Three agents, three DBs, no fourth store (V1). Writes go through the owning agent.
- Abel answers only from the finalised session `context.md` (owner flow, 16:22). A session's first message builds the doc, even "hello"; later small talk needs no round.
- Risk comes from code rules. Code owns numbers, evidence and writes; the LLM proposes.
- `cabinet-db.json` migrates into the three DBs, is verified, then deleted. **No backup copy** (owner, 16:52). A hosted migration hydrates first, awaits the push, reads every row back with `canon()` (the hosted column is `jsonb`) and only then deletes.
- `load_data.py` writes plumbing straight into the agent DBs; a fresh load never creates `cabinet-db.json` (G33).
- The shopping and referral offers are retired; statement and document imports stay. Earnings and rewards history stays migrated.
- Hosted mode: one Postgres role per agent through the session pooler, project `zyuzexnawvelyyzmydog`, `aws-0-eu-north-1`. The connection string needs `uselibpqcompat=true` for TLS. A load merges: hydrate, write, push.
- Live checks on the hosted project use the demo uid only and `LLM_PROVIDER=mock`; real-model runs use the Groq free tier with `LLM_MAX_CALLS` set.
- The monitor is on by default; `DEV_MONITOR=0` turns it off. The external MCP agent is out of scope (V9).
