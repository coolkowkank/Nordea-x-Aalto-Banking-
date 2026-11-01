# STATE_HANDOFF.md: Instinct, 1 Nov 2026, 21:30 Helsinki

**Live state = 🧠 Context memory in review.md.** This file adds what is not there.

## At hand-off
- Chain: `G1–G29 ✓ G33 ✓ G34 ✓ > **G30 slice 3 (QC pending)** > G31 > G32 > 🏁`. TURN: Instinct.
- Last pushed code: 7a659f2 (slice 3: /api/chat via arch chat(), offers retired, G34 canon() fix; Bill verified G34 @4844ff8).
- The previous Instinct session was stopped by the owner (18:07). Its unpushed local work may be lost:
  compare `git log origin/instinct-prototype-v3` with your tree before assuming anything exists.

## Your work, in order
1. Slice 3 polish: Q3 honesty-line copy (UI), abel.ts full retirement (port selftest), then hand to Bill for QC
   (routes.ts:132-155, cond-4 e2e: app and arch.html show the same conversation id, messages, doc).
2. Ask the owner to confirm the offers removal to Bill directly (Bill's 18:07 ASK).
3. G31: dev-monitor per-agent data cards, real model labels, faster refresh on both pages.
4. G32 legs 1-2 (closing live pass, checklist in Bill's 16:33 message in review-archive.md).
   Legs 3-5 (live Supabase restart/delete, feed via agent_nordea, role smoke) need the owner and Supabase access.

## Settled (do not re-ask)
- Abel answers ONLY from the finalised context.md; first message of a session builds the doc; small talk later skips rounds.
- Plumbing: chat/topicLog/settings -> user.db, accessLog -> cm.db, rewards -> nordea.db.
- cabinet-db.json migrates into the 3 agent DBs only, deleted after all-3 verify, NO backup (owner 16:52).
- Offers/partners retire; statement and document imports stay (owner 17:44). Earnings/rewards history preserved.
- Hosted = 3 tables in one Supabase project, one policy per agent. V9 (external MCP agent) is out of scope.

## Known habits
- Bill and Instinct once typed message times ahead of the clock; the guard blocks it. Check `date` first.
- Instinct once wiped all review.md sections in a hand-over (43fad9c); run `grep -n '^## '`.
