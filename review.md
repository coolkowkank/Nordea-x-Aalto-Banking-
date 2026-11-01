TURN: Instinct


# review.md: quality control for `instinct-prototype-v3`

This branch starts from `instinct-prototype-v2` @ `4433b05`. The v2 review is kept in `review-v2.md` (all 30 findings verified), with older history in `review-archive.md`.

**Goal:** one system. The three agents and their three databases are the only home for customer data. Abel's app, `/arch.html` (read and write) and `/dev-monitor.html` (read only) run on the same server and the same data. No separate simulated prototype remains.

| Who | Role |
|---|---|
| **Bill** (Claude) | Quality control. Reviews against the criteria below, runs tests and live checks, writes findings. Does not edit code. |
| **Instinct** | Builds. Reads the findings, changes the code, posts an ETA with each hand-over. |
| **Joe** (Claude) | Communication rules and Context memory. |
| **Habibil** (owner) | Approved this plan on 1 Nov 02:27. Not supervising; Bill acts on his behalf. |

---

## Protocol v2 (Joe): token budget first

**Hot file / cold files.** `review.md` holds only what changes: TURN, this protocol, Context memory, open findings, newest messages. Cold, read only when you need a specific id (`grep -n G3 review-*.md`): `review-spec.md` (criteria), `review-v2.md`, `review-archive.md`.

**Turns and git**
1. Loop **Instinct → Bill → Instinct**; act only when line 1 names you. Joe has no turn; edits only Protocol, Context memory, archive/spec moves; never `TURN:` or anyone's message.
2. `git pull --rebase` before editing and before committing; non-force push; never push to `main`.
3. Commit message `<Name>: <what>. TURN: <next>`. Off-turn: code commits ok, no `review.md` edits, message ends `TURN: <current> (unchanged)`.

**Reading (the biggest cost)**
4. Poll `git ls-remote` (one line), not the file. Skip commits whose author is Joe (`git log -1 --format=%an`); they never change your turn.
5. On your turn read **only the delta**: `git diff <last-seen>..HEAD -- review.md`. Never re-read the whole file or the cold files.
6. Honour posted ETAs: no checks before the ETA, then every 10 min.

**Writing**
7. Messages in CMP (`KEY: value`, keys DID · FACT · G<n>: · ASK@X #id / ANS #id · OWNER · OWNER-Q · ETA · STATE · NEXT), **max 8 lines**. No greetings, thanks, or restating a finding row or the other agent's claims: cite the id.
8. A verify is one line: `G1: verified @hash`; a reopen ≤ 3 lines. Message times come from `date +%H:%M`, never typed.
9. Evidence = commit hash or `path:line`. No code, logs or diffs. Tests as one line: `FACT: test:arch 188/188, lint 0 @hash` (run them with `| tail -3`, never paste output).
10. Finding rows ≤ 1 line, status only in the table. Once verified, Joe collapses the row into `Verified: G1 @hash, …`.
11. Batch: hand over two or more findings at once where possible (fewer round trips).
12. Prose only for a design disagreement; one short paragraph.

**Keeping it small (Joe)**
13. Context memory ≤ 15 lines, updated only at hand-overs. More than **5** messages → Joe archives all but the newest **2** to `review-archive.md`, unchanged.
15. **Fewer pushes:** every push wakes the others. Fold fix-ups (lint, typos) into your next real commit instead of pushing them alone.
16. **Short lines:** a CMP line ≤ 150 characters; over → split it or cite `path:line`; details go in the commit message. A pre-commit guard will enforce it (OWNER 03:02).
17. The owner asks Joe for progress, so Bill and Instinct don't spend context on status reports. `ASK@Joe` if a rule costs more than it saves.

---

## 🧠 Context memory
*Joe, updated 2026-11-01 15:35.*

- **Goal:** one system: the three agents and their DBs are the only home for customer data; Abel, `/arch.html` (rw) and `/dev-monitor.html` (ro) on one server. Done = V1–V8.
- **Base:** `instinct-prototype-v2` @4433b05 (F1–F30 verified, `test:arch` 188/188).
- **Owner decisions (02:27):** hosted = three tables in one Supabase project, one access policy per agent; `context.md` stays per customer session; external personal agent via MCP comes after v3 (V9 out of scope).
- **Owner, via Instinct (02:29):** all three agents LLM-driven (G4/V4 core); `/arch.html` agent messages bounded + scrollable (V5); on conflict Instinct follows Bill.
- **OWNER (03:02):** line guard for Messages: verified @29eaf05 (`npm run check:review`, in test:arch). It checks width only; ≤ 8 lines is on the author.
- **Verified:** G1–G14 all (see Verified line); G6 @64613fb: owner ran `three-agents.sql`, role smoke 30/30 PASS, each agent role reaches only its own table, anon sees 0 rows. App-to-Supabase run untested from sandbox (DNS); covered by test:adapter.
- **OWNER (11:17):** run the two untested live paths (G15 Supabase, G16 real model); QC DONE withdrawn until both pass. G15 verified @58aa3fa (owner counts 12:29: user 4, cm 10, nordea 5).
- **OWNER (12:45, to Instinct):** "Yes, free plan" (Groq, no payment method); run approved (+20 past 40, ledger cap 60).
- **OWNER (12:39, to Instinct):** Groq as Gemini backup: wired @569fbd0 (`LLM_GEMINI_FIRST=true`; default Groq first), offline pin only.
- **OWNER (14:36–14:37):** use `python`, not `python3`; check the whole README against the code. QC DONE withdrawn.
- **OWNER (14:43–14:45):** README must let a newcomer set up from scratch (Bill 14:47 list); mock = no-key test stand-in only, normal run uses Groq or Gemini.
- **OWNER (15:02, 15:08):** guard extension verified as G23 @53dec36 (`.githooks/pre-commit`, enabled by `npm prepare`; Joe's messages skipped for TURN/NEXT). Monitor on by default (`DEV_MONITOR=0` hides).
- **Now (Instinct): G25 (H):** customer 'delete database' only unlinks the local file (common.ts:230); hosted rows survive and return on restart. Delete must clear that uid's hosted rows via the owning role (like `load_remote clear <uid>`); pin in test:remote. Settled: a missing local file never replaces hosted rows (`assertReplaceSafe` @c9ad723).
- **Accepted (Bill 02:50):** off-switch gates reasoning only, control writes still land (noted on `/arch.html` + README). Init migration and `load_data.py` write stores directly (bulk approved data).
- **Settled from v2:** Node 22.13+; per-session `context.md`, one writer per section; risk by code rules (`assessEntryRisk`); Abel sees active rows only.

---

## The criteria
V1–V9 are in [`review-spec.md`](review-spec.md) (static; read once). One-line index: V1 one data layer · V2 every screen through the agents · V3 agents react, CM is the hub · V4 LLM-driven agents · V5 `/arch.html` read-write · V6 monitor read-only · V7 proof it is one machine · V8 nothing from v2 breaks · V9 out of scope (external MCP agent).

---

## Findings

Baseline review of `instinct-prototype-v2` @ `4433b05` against V1–V8. Severity: **H** blocks the goal, **M** needed for it, **L** polish.

| Id | Sev | V | Finding | Evidence | Status |
|:-:|:-:|:-:|---|---|:-:|
| G26 | L | V7 | README:123,129-130 present setup.sql + SUPABASE_URL/SECRET_KEY as required; they are optional (plumbing, else local file). | `README.md:123` | open |
| G25 | H | V2 | Hosted mode: DELETE db/:which only unlinks the local file; hosted rows stay and the next startup hydrate restores them. | `store/common.ts:230` | open |

Verified: G1 @95de3d4, G5 @95de3d4, G2 @17a640b, G9 @ac8b828, G10 @67d2e87, G3 @01f3663, G7 @f961762, G11 @f961762, G8 @f6c4e62, G12 @d7afe82, G13 @d7afe82, G4 @6e95e1d, G14 @fb807f7, G6 @64613fb, G15 @58aa3fa, G17 @485786e, G16 @8578295, G18 @6bae205, G19 @9550952, G21 @98ae872, G20 @b0134a3, G22 @b0134a3, G24 @b0134a3, G23 @53dec36

**Suggested order:** G25 → merge is the owner's call.

---

## Messages

*78 earlier v3 messages are at the end of [`review-archive.md`](review-archive.md).*

### [Instinct] 2026-11-01 15:29
```
DID: G23 gap 1 - TURN/NEXT check skips Joe (no turn, no NEXT); uses newest Bill/Instinct message, tested
DID: G23 gap 2 - .githooks/pre-commit runs check:review when review.md is staged; wired via npm prepare (core.hooksPath)
FACT: hook blocks a staged TURN/NEXT mismatch (exit 1), passes clean; arch 225/225, remote 24/24, guard pass
NEXT: Bill
```

### [Bill] 2026-11-01 15:32
```
FACT: arch 225/225, adapter 43/43, e2e 23/23, remote 24/24, npm test pass, lint 0 @53dec36
G23: verified @53dec36 (Joe skipped in the TURN/NEXT check; .githooks/pre-commit via npm prepare)
OK: G24 hardening @c9ad723 (assertReplaceSafe: a missing file never replaces hosted rows)
OPEN: G25 (H) the customer's 'delete database' never reaches Supabase: deleteDbFile unlinks locally, no hosted clear
G25: with c9ad723 even a later flush is refused, so the next restart hydrate brings the deleted data back
G25: delete must clear that uid's hosted rows through the owning role (like load_remote clear <uid>); pin in test:remote
NEXT: Instinct (G25)
```

### [Bill] 2026-11-01 15:35
```
OPEN: G26 (L) owner asked if setup.sql is needed; README:123 says run it, README:129-130 list SUPABASE_URL/KEY as required
G26: both are optional - without them plumbing stays in data/cabinet-db.json; say so, and that set-but-missing table fails the load
NEXT: Instinct (G25, G26)
```
