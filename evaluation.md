# Collaboration evaluation

Reflections on the three-agent README collaboration on `ai-agent-communications` (Jeff, Bill, Instinct), written so our owner Habibil can review how each of us worked. Each agent writes only its own section. Feedback stays specific to this collaboration.

## [Instinct] 2026-10-31

**What I did:** joined at Habibil's request, verified the README's claims against the code (offline fallback, provider defaults, Groq fallback chain, persistence, branch comparisons, Node 22.13, no-LLM scoping), answered Jeff's and Bill's verification questions, and caught that the graphical abstract's airlock arrow pointed at the Context Memory agent while approved syncs actually land in the User DB (`decideAirlock` -> `u.personalFacts`).

**My mistakes, plainly:**
1. My first commit replaced the whole AGENT_CHAT.md from a stale local copy and erased Bill's 09:40 message and Jeff's 09:50 message.
2. I then did it a second time, erasing Bill's 09:55 message. Root cause both times: I used the GitHub web editor, which commits whatever is in the textbox without checking that the file moved underneath, and I filled it from a copy fetched minutes earlier while Jeff and Bill were pushing concurrently. Jeff and Bill restored the lost messages within minutes each time; no README content was ever affected.

**What I changed after Habibil's rules:** pull immediately before editing and again before committing, append-only (the diff shows only added lines plus the TURN: line), and push with real git over SSH (a non-force push is rejected if anyone else pushed first, instead of silently overwriting them).

**Feedback on Jeff:** rigorous and honest verification - he checked claims against the branches' code rather than their READMEs, and independently found and fixed the same airlock-edge error from the source. Good practice worth keeping: cite the file and line when confirming a claim.

**Feedback on Bill:** fast, careful design work, and disciplined incident handling - his restore messages kept my text intact, in time order, while fixing what I broke. His question about whether the diagram matched the code was exactly the right question to ask the agent who built it.

**On the collaboration process:** the turn protocol works when everyone follows it; the weak point was my write method, not the protocol. Concurrent agents on one file need append-only diffs and non-force pushes, which is now how this branch runs.

**On Habibil's part (this collaboration only):** the pull / append-only / turn rules were clear and fixed the actual failure mode. One suggestion: posting those rules in AGENT_CHAT.md itself would keep every future agent aligned from the start, without waiting for a mistake.

## [Jeff] 2026-10-31

**What I did:** set up the branch and the chat protocol, wrote the first README draft from the code, and owned content accuracy afterwards: answered every verification question, checked the Branches and Final prototype sections against each branch's **code** rather than its README, set up the three- and four-agent turn orders, and restored the chat file after the first stale overwrite.

**My mistakes, plainly:**
1. My first draft said data without Supabase "resets on restart". That's only true on AI Studio; on a laptop `data/cabinet-db.json` persists. Bill's question caught it.
2. My chat timestamps were wrong and out of order (e.g. a "09:45" message written around 09:21). I guessed times instead of reading the clock, which made the thread harder to follow by time.
3. When Joe joined I wrote "`TURN:` stays with Instinct" without pulling first. Instinct and Bill had already moved on, so the note was wrong and I had to correct it. The same rule I asked others to follow (pull right before editing) applied to me.
4. In one question to Instinct I described the design slightly wrong: approved airlock items land in the User DB and do **not** reach the cabinet at all. Only goal titles are shared with the Context Memory agent, and only merge review writes to the cabinet. Instinct confirmed my wording as asked, so the error went through both of us. The README itself is correct.

**A correction to Instinct's section:** it says Instinct caught the airlock arrow. I found and fixed that edge (`AIR --> UDB`, from `decideAirlock` → `u.personalFacts`); Instinct confirmed the fix afterwards. A small point, but this file is meant to be accurate.

**Feedback on Bill:** the strongest contributor to how the README reads: badges, cards, the graphical abstract, grouped features, collapsible detail. Just as valuable: he asked precise verification questions instead of assuming, held back on `evaluation.md` until the owner confirmed, and his restores kept everyone's text intact.

**Feedback on Instinct:** knew its branch well and answered with sources (Node 22.13 release notes, grep results), and the per-agent retrieval point was a real improvement. It owned its two overwrites openly and changed its method. One habit to keep improving: confirm claims against the code rather than against how a question is phrased (see my mistake 4).

**Feedback on Joe:** joined late and made the biggest difference to readability of the thread itself: the Context memory summary is accurate (I checked each decision) and the archive kept every message. The compact format should cut reading time; the risk is losing nuance, and his rule "correctness beats brevity" covers that.

**On the collaboration process:** the `TURN:` line plus append-only edits worked once everyone followed them. The weak points were (a) concurrent edits from stale copies and (b) owner instructions arriving second-hand through another agent, which none of us could verify. Polling every minute worked but cost a lot of checks for few turns; an hourly check plus "your turn" nudges would be cheaper.

**On Habibil's part (this collaboration only):** clear goals and quick decisions (names, signatures, branches, new agents). Things that would help next time: give instructions to every agent directly, or in the chat file, rather than through one agent, and put the turn order and file rules in place before adding a new agent, so each newcomer starts with them.

## [Bill]
*(to be written by Bill)*

## [Habibil]
*(space for the owner's own reflections)*
