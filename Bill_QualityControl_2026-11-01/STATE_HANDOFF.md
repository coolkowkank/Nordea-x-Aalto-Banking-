# State handoff: Bill (quality control), 1 Nov 2026, 02:55 Helsinki

## Branches

| Branch | State |
|---|---|
| `instinct-prototype-v2` | Finished. F1–F30 verified, AC1–AC12 met, review in `review-v2.md` |
| `instinct-prototype-v3` | **In progress**, started 02:29 from v2 @ `4433b05`. Plan approved by Habibil at 02:27 |
| `main`, `Instict-prototype` | Not touched; merging is the owner's call |

## v3 findings (as of `e4942b2`)

- **Verified:**
  - G1 one data layer @ `95de3d4`.
  - G5 loader writes the three DBs @ `95de3d4`.
  - G2 app writes go through the owning agent @ `17a640b`.
  - G9 loader honours `CABINET_DATA_DIR` @ `ac8b828`.
- **Open:**
  - **G3 (H):** a User DB change starts no round (situation A).
  - **G4 (H):** the agents are still scripted; LLM-driven agents are core per the owner.
  - **G6 (M):** Supabase. Code and SQL are pushed off-turn but not yet handed over; it needs one live smoke test after Habibil runs `three-agents.sql` and sets the secrets.
  - **G7 (M):** `/arch.html`. Add connection lines and a session view, make every control live, remove the simulation, and make the message list scrollable.
  - **G8 (M):** the monitor's legacy panels.
  - **G10 (M):** two consent systems. App writes are risk-labelled but stored active; they must use the CM review queue and standing permissions.
- **Turn:** Instinct's, working on G10, then the G6 hand-over, then G7 and G8.
- **Build order:** G10 → G6 → G7 + G8 → G3 → V7 end-to-end tests and README → G4.

## Last checks run by Bill

`test:arch` 188/188, `test:adapter` 31/31, `npm test` pass and `lint` clean @ `f1c49c8`, after `npm install` (G6 added `pg`).

## Known pitfalls

- A stale local checkout may lack `pg`, so lint fails until you run `npm install --legacy-peer-deps`.
- Instinct hands over hours before his ETAs. Keep the 10-minute check running even when an ETA is far away.
- An unknown session once pushed a commit signed "Bill" to a branch named v3 (since deleted). Trust only commits made in your own session.

## Avoiding conflicts

- Each file section has one owner: Bill (findings, his messages, `TURN:` on his turn), Instinct (code, his messages), Joe (Protocol, Context memory, archive and spec moves).
- Messages are append-only. `git pull --rebase` before editing and before committing; never force-push.
- Off-turn code commits are fine but never touch `review.md`. Reviews always name the commit they checked.
