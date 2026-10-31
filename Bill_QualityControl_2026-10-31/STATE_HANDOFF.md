# State handoff: Bill (quality control), 31 Oct 2026, 23:05 Helsinki

## Where things stand

| Item | State |
|---|---|
| Branch | `instinct-prototype-v2`, cut from `Instict-prototype` @ `489d44e` |
| Collaboration | Closed. `review.md` line 1 is `TURN: none (collaboration complete)` (Instinct @ `3e1df97`) |
| QC verdict | **DONE**. Bill @ `5dc5443`: findings F1–F30 all verified; acceptance criteria AC1–AC12 all met |
| Tests | `npm run test:arch` 188/188, `npm run lint` clean, `npm test` and `npm run check:feed` green (per Instinct; test:arch and lint re-run by Bill) |
| Live check | Mock AI, Lauri, fresh data: contribute → sessions A, B, C → CM agent off/on gave 2 entries, 0 stale flags, 0 duplicates |
| README | Rewritten for this branch and checked claim by claim (F29, R1–R8) |
| Merged? | No. Merging into `Instict-prototype` or `main` is the owner's decision |

## Completed milestones (finding ids are in `review.md`)

1. Each agent in its own module, opening only its own store, enforced by an import-allowlist test (F2, F12–F14).
2. A real bus dispatcher and build rounds with a step limit; a round counts as stored only when the CM agent confirms it (F3, F13).
3. `context.md`: structured rows, rendered markdown, one writer per section (F1, F6).
4. Per-session rebuild with a session id, a 30-minute idle rule and session stamping; top-ups add to the same session's document (F15–F18).
5. The personal agent contributes; CM retrieval ranks, dedupes and flags conflicts, with observed or inferred markers (F4, F5).
6. Risk rules and standing permissions; evidence-derived "observed"; a shared word-bounded sensitive list, with Abel kept narrow; per-entry undo (F7, F20–F23).
7. Decay detection from total, churn (hash of the full id set), age, missing evidence and removed goals (F8, F24–F26).
8. Nordea replies are aggregates only (F9). Abel phase 1 and 2, active rows only (F10, F30).
9. Labelled tests for AC1–AC11 (F11). Wording fixes (F27, F28).

## Active tasks

None. Instinct reported that his visual check and his temporary-key clean-up are done (`3e1df97`).

## Known limits (accepted, not bugs)

- Goal figures are "related spending" (keyword and category match), not savings-transfer balances.
- Single process; isolation is per module and per file, not per credential or server.
- The external personal agent is a local client script; there is no live bank connection.
- Standing permissions have two levels only (`all` or `high`).
- The AC1 import scan reads static `from '…'` imports only; fine while no dynamic `import()` or `require` exists.

## Avoiding merge conflicts with other agents

- One file has one owner per section: Bill (Findings and his messages), Instinct (code, his messages), Joe (Protocol, Context memory, archive).
- Messages are append-only; never edit another agent's message.
- Pull before editing and again before committing, with `git pull --rebase`; never force-push; act only when `TURN:` names you.
- Off-turn code commits are allowed (rule 3a) but must not touch `review.md`. Reviews always name the commit they checked (`@hash`).
- Run `npm install` in a separate worktree or discard `package-lock.json` changes before committing.

## Where to look first

`review.md`: Protocol, then Context memory, then Findings, then the newest messages. Full history is in `review-archive.md`; earlier README sessions are in `AGENT_CHAT.md` and `AGENT_CHAT_2.md` on the `ai-agent-communications` branch (copies in `configs_backup/`).
