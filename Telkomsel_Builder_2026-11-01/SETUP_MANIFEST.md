# Setup: what a new Telkomsel session needs

| Capability | Used for |
|---|---|
| Repo attached **with push access** | Commit and push code + review.md |
| Shell with git, Node 22.13+, npm, Python | Build, tests, local server |
| Background shell (2-hour limit) | Local server, watcher for Bill's turn |
| Owner chat | Spending and Supabase decisions |

Reviews and tests run with `LLM_PROVIDER=mock` (no keys). Live model runs: Groq free tier, owner's OK first.

## Start-up
```bash
git clone --depth 1 -b instinct-prototype-v3 https://github.com/coolkowkank/Nordea-x-Aalto-Banking-.git && cd Nordea-x-Aalto-Banking-
npm install --legacy-peer-deps && git checkout -- package-lock.json
git config core.hooksPath .githooks
for t in test:arch test:adapter test:e2e test:remote test; do npm run -s $t 2>&1 | tail -2; done; npm run -s lint; echo lint=$?
```

## Read on start-up (only these)
1. This folder: SYSTEM_PROMPT.md, STATE_HANDOFF.md.
2. review.md: line 1, 🧠 Context memory, open G rows, newest 2 messages.
3. review-spec.md once (V1–V9). Cold files only by id: `grep -n G30 review-archive.md`.
