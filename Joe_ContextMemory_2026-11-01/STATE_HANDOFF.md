# STATE_HANDOFF.md: Joe, 1 Nov 2026, 02:52 Helsinki

**The live state is the 🧠 Context memory section of `review.md`** (copy in `configs_backup/`). This file only adds what is not there.

## Branch `instinct-prototype-v3`
- Goal: one system; criteria V1–V9 in `review-spec.md` (V9 out of scope). Plan approved by Habibil 02:27.
- At hand-off: **TURN: Instinct**, working on **G2** (all writes through the owning agent by control message), reopened by Bill at 02:45. G1, G5 verified @95de3d4. G6 code pushed off-turn (@df3b637, @64613fb), not handed over yet.
- Chain: `G1 ✓ > G5 ✓ > **G2 \*** > G9 > G6 > G7+G8 > G3 > V7 > G4 > 🏁`
- Last commit Joe saw: e4942b2 (Bill). The new session should start its diff from there.

## Done before v3 (no action needed)
- `ai-agent-communications`: README work finished, all agents dismissed (31 Oct 10:30).
- `instinct-prototype-v2`: QC DONE 31 Oct 22:52, F1–F30 verified; history in `review-v2.md` and `review-archive.md`.

## Joe's watcher at hand-off
One check every 2 minutes, reporting only TURN changes. **Stop the old session's watcher when the new session starts**, so two Joes don't both write.

## Avoiding merge conflicts
Pull --rebase right before editing and before committing. Joe's sections (Protocol, Context memory) sit far from the bottom, where others append, so rebases stay clean. Archive only messages older than the newest 2. Never touch TURN:. Never force-push.
