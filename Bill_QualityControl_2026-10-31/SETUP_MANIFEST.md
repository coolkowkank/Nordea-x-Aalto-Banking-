# Setup manifest: what a Bill clone needs

## Capabilities used in the Claude app

| Capability | Used for |
|---|---|
| GitHub access to `coolkowkank/Nordea-x-Aalto-Banking-` with **push** rights (attach the repo to the session) | Fetch, pull, commit and push to `instinct-prototype-v2`; read other branches |
| Shell with `git`, Node.js **22.13+**, `npm`, Python 3.9+, `curl` | Run tests, lint and the live server checks |
| File read and edit tools | Read code; edit `review.md` |
| Background shell commands | The 10-minute `git ls-remote` check for `TURN: Bill` |
| A clock tool (current time) | Message timestamps (Helsinki time) |
| Scheduled reminder (optional) | Waking at an agent's posted ETA |
| Artifact publishing (optional) | Diagrams for the owner, e.g. the ecosystem code map |

No other MCP servers are needed. No API keys are needed for review work: use `LLM_PROVIDER=mock`.

## Start-up steps for a clone

```bash
git clone https://github.com/coolkowkank/Nordea-x-Aalto-Banking-.git
cd Nordea-x-Aalto-Banking-
git checkout instinct-prototype-v2
npm install --legacy-peer-deps          # don't commit package-lock.json changes
npm run test:arch && npm run lint        # expect 188 passed, exit 0
```

## Files to read on start-up (in this order)

1. `review.md`, line 1 (`TURN:`), then *Protocol v1*, *Context memory*, *Findings* and the newest messages.
2. `review-archive.md` only when older context is needed.
3. `README.md` for the architecture as built.
4. `src/server/arch/` (agents, stores, `rounds.ts`, `dispatcher.ts`, `orchestrator.ts`, `risk.ts`) and `scripts/test-arch.ts`.

The repository has **no** `CLAUDE.md`, `.claude/` or `.github/workflows/`. `configs_backup/` holds copies of the coordination files that serve as the agents' instructions:

| File | Origin |
|---|---|
| `review.md`, `review-archive.md` | This branch, at the time of export |
| `AGENT_CHAT.md`, `AGENT_CHAT_2.md` | Branch `ai-agent-communications` (the earlier README sessions with Jeff, Joe and Instinct) |
