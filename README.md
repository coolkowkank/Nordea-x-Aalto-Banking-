<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Abel × Nordea: Context Cabinet (branch `dev-context-monitor`)

A student concept: Abel, a banking assistant inside a Nordea-style app, works from a **Context Cabinet**,
the things the customer chose to share (goals, life events, preferences) plus what Nordea notices in their
transactions. Every read goes through an access gateway, and the customer decides what each side may see.
All data is fictional.

View the app in AI Studio: https://ai.studio/apps/8fb23cbd-15fa-415e-a3bd-7c8740e2a253

## What this branch is for

**1. The app ships with no data. You load it separately.**
- Nothing is built in: with no data loaded, the app shows **"No data yet"**.
- Data is loaded with [`scripts/load_data.py`](scripts/load_data.py) (CSV, JSON, JSON Lines or Excel), into
  Supabase or into the local file. The fictional demo customers (Lauri, Eeva, Alex) are in [`seed/demo/`](seed/demo).
- With Supabase set up, only Supabase counts: an empty table means an empty app.
- More → **Delete all data** empties everything (including Supabase).

**2. A read-only developer monitor** at `/dev-monitor.html`, beside the app:
- Three panels: what the customer's side (Abel) can read, what is shared with Nordea right now, and Nordea's own cards.
- Which **AI model** Abel uses (and the fallback order); the Nordea adviser has no model (rules and code).
- The latest changes to the cabinet and the audited reads, refreshed every 3 seconds.
- A customer picker to watch any loaded customer.
- It only reads: watching never changes data or the access log.

## How it differs from the other branches

| Branch | What it has |
|---|---|
| `main` | The app with demo data built in, plus the first part of the structured bank-data work (PR #4). |
| `Bank_database` | Structured Nordea-side bank data (stable ids, incremental imports, balance history, evidence) and a Supabase setup guide. |
| **`dev-context-monitor`** (this one) | Data loaded separately + the developer monitor. Does **not** have `Bank_database`'s bank-data work. |

The two feature branches both change `src/server/db.ts`, so merging them needs that file reconciled.

## Run it on your computer

**Needs:** Node.js (LTS), and Python 3.9+ to load data.

1. Install: `npm install` (if that fails, `npm install --legacy-peer-deps`).
2. Create `.env.local` in the project folder with an AI key, e.g. `GEMINI_API_KEY=...`
   (other options, such as the Aalto LLM or Groq, are in [.env.example](.env.example) and [LAPTOP.md](LAPTOP.md)).
3. Load data (the app is empty until you do):
   - With Supabase (run `supabase/setup.sql` once in Supabase → SQL Editor, and put `SUPABASE_URL` and
     `SUPABASE_SECRET_KEY` in `.env.local`):
     ```
     python scripts/load_data.py seed/demo
     ```
   - Without Supabase (saved in `data/cabinet-db.json`, which git ignores):
     ```
     python scripts/load_data.py seed/demo --target file
     ```
4. Start: `npm run dev`, then open http://localhost:3000.

If the app is already running when you load data, it picks the data up straight away (or press **Check again**
on the "No data yet" screen). Loading your own files, options like `--dry-run` / `--replace` / `--clear`, and what
each kind of record needs: [seed/README.md](seed/README.md).

## Open the developer monitor

1. Add `DEV_MONITOR=1` to `.env.local` and restart the app. It is **off by default**, because it shows every card,
   private ones included. Never set it on the hosted app (AI Studio).
2. With the app running, open http://localhost:3000/dev-monitor.html in a second tab.
3. Pick the customer to watch at the top right (or add `?userId=eeva` to the address).

If it says "The developer monitor is off", the setting wasn't picked up (check the spelling, restart).
"No data loaded yet" means it works, but no data has been loaded.

## Where to read more

- [seed/README.md](seed/README.md): loading data (formats, options, required fields).
- [docs-v14.md](docs-v14.md): how the app is built (Abel, guardrails, partner offers, sharing, saved data).
- [LAPTOP.md](LAPTOP.md): running on a laptop with the Aalto LLM (VPN).
