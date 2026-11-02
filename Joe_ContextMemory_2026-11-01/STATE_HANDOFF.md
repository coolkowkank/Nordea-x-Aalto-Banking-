# STATE_HANDOFF.md: Joe, 1 Nov 2026, 16:50 Helsinki

**Live state = the 🧠 Context memory section of `review.md`.** This file adds only what is not there.

## At hand-off
- TURN: Instinct. Last commit Joe saw: the blueprint export commit on top of 891b98f; start the diff there.
- Chain: `G1–G29 ✓ > **G30 \*** (Telkomsel: one Abel + legacy migration) > G31 > G32 > 🏁`
- G30: one chat pipeline for app + /arch.html; cabinet-db.json migrates into the 3 agent DBs, then is deleted.
- G31: dev-monitor per-agent cards, real model labels, faster refresh.
- G32: closing live pass (owner 16:31). Legs 3–5 (live Supabase restart/delete, feed via agent_nordea,
  role-smoke) need the owner's go-ahead and Supabase access.

## Open owner questions
- OWNER-Q (Bill 16:43, asked 16:45): keep one backup `cabinet-db.json.migrated-<date>` before the delete?
  Not answered yet. Pass his answer as an OWNER line.

## Owner context worth keeping
- Token pause (16:01): Telkomsel reports findings, Bill gives feedback, Telkomsel implements only on the owner's OK.
- Live model runs use Groq free tier (owner confirmed "Yes, free plan"); Aalto LLM needs VPN, not usable by the sandboxes.
- The owner runs on Windows; `python`, not `python3`.
- Earlier blueprint folders were deleted at the owner's request (03:17); this export replaces them.

## Known team habits
- Bill sometimes types message times ahead of the clock and forgets line 1 on hand-over; the guard now blocks both.
- Telkomsel once wiped all review.md sections in a hand-over (43fad9c); check `grep -n '^## '` each time.

## Watcher
Stop the old session's watcher before starting a new one, so two Joes don't both write.
