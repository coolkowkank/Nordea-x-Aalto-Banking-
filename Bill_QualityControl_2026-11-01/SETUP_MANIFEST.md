# Setup manifest: what a new Bill session needs

## Capabilities

| Capability | Used for |
|---|---|
| GitHub repo `coolkowkank/Nordea-x-Aalto-Banking-` attached **with push access** | Fetch, pull, commit, push `review.md` |
| Shell with `git`, Node.js **22.13+**, `npm`, Python 3.9+, `curl` | Tests, lint, live server checks |
| File read and edit | Read code; edit `review.md` |
| Background shell commands | The 10-minute `git ls-remote` check |
| Clock tool | Message timestamps (Helsinki time) |
| Optional: scheduled reminder, Artifact publishing | Waking at an ETA; diagrams for the owner |

No API keys are needed for review: use `LLM_PROVIDER=mock`. For the G6 live check you need the Supabase secrets, which only Habibil can provide.

## Start-up

```bash
git clone https://github.com/coolkowkank/Nordea-x-Aalto-Banking-.git && cd Nordea-x-Aalto-Banking-
git checkout instinct-prototype-v3
npm install --legacy-peer-deps && git checkout -- package-lock.json
npm run test:arch | tail -1 && npm run lint >/dev/null; echo lint $?
```

## Read on start-up (only these)

1. This folder: `SYSTEM_PROMPT.md`, `STATE_HANDOFF.md`.
2. `review.md`: line 1, *Protocol v2*, *Context memory*, the open `G` rows, the newest 2 messages.
3. `review-spec.md` for V1–V9, once.
4. Cold files only on demand: `review-v2.md`, `review-archive.md`.

The repo has no `CLAUDE.md`, `.claude/` or CI workflows. `configs_backup/` holds copies of `review.md`, `review-spec.md`, `review-v2.md` and `review-archive.md` as of this export.
