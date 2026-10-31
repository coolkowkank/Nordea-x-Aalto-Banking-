## At a glance

How the Nordea-side data is stored. These are the real records the app writes when it applies the bundled
example feed row ([`supabase/nordea-feed-example.csv`](supabase/nordea-feed-example.csv)) for the demo customer Lauri.

**Supabase tables.** Every record is one row of `abel_records`; the `kind` column says which table below it belongs to.

| Table | Columns |
|---|---|
| `abel_records` | `kind` · `id` · `user_id` · `data` (JSON) · `updated_at` |
| `nordea_feed` (inbox) | `id` · `user_id` · `data` (JSON) · `note` · `created_at` · `applied_at` · `result` |

| kind | id | user_id | data |
|---|---|---|---|
| `bankAccounts` | `acc-lauri-current` | `lauri` | `{ "key": "current", "iban": "FI29 1234 …", … }` |
| `transactions` | `nd-lauri-bank-ND-20261027-0001` | `lauri` | `{ "date": "2026-10-27", "amount": -32.4, … }` |
| `balanceSnapshots` | `snap-lauri-current-2026-10-30-batch-…` | `lauri` | `{ "balance": 1104.3, "at": "2026-10-30", … }` |
| `importBatches` | `batch-lauri-mvw0c4fv-wfup` | `lauri` | `{ "mode": "incremental", "added": 7, … }` |

**Bank accounts** (`bankAccounts`)

| id | key | iban | type | currency |
|---|---|---|---|---|
| `acc-lauri-current` | `current` | FI29 1234 5678 9012 34 | current account | EUR |
| `acc-lauri-savings` | `savings` | FI29 1234 5678 9012 35 | savings | EUR |
| `acc-lauri-carFund` | `carFund` | FI29 1234 5678 9012 36 | savings goal | EUR |

**Transactions** (`transactions`, 4 of the 7 from this batch)

| id | account | date | valueDate | amount | description | counterparty | status | category | categorySource | batchId |
|---|---|---|---|---|---|---|---|---|---|---|
| `nd-lauri-bank-ND-20261027-0001` | current | 2026-10-27 | 2026-10-27 | -32.40 EUR | K-Supermarket Kamppi | K-Supermarket Kamppi | booked | groceries | feed | `batch-lauri-mvw0c4fv-wfup` |
| `nd-lauri-bank-ND-20261028-0003` | current | 2026-10-28 | 2026-10-28 | -45.00 EUR | VR Train Ticket Helsinki-Tampere | VR-Yhtyma Oy | booked | transport *(original: TRAVEL)* | app | `batch-lauri-mvw0c4fv-wfup` |
| `nd-lauri-bank-ND-20261030-0005` | current | 2026-10-30 | – | -12.90 EUR | Cafe Java | Cafe Java | pending | restaurants | app | `batch-lauri-mvw0c4fv-wfup` |
| `nd-lauri-bank-ND-20261030-0007` | savings | 2026-10-30 | 2026-10-30 | 200.00 EUR | Auto deposit from Current Account | Nordea | booked | savings_transfer_in | feed | `batch-lauri-mvw0c4fv-wfup` |

Older demo transactions keep their simple form (`tx-house-2024-11` · current · 2024-11-01 · -1150 · housing · Rent & Housing charge).

**Balance snapshots** (`balanceSnapshots`)

| id | accountKey | balance | at | source | batchId |
|---|---|---|---|---|---|
| `snap-lauri-current-2026-10-30-batch-…` | current | 1104.30 | 2026-10-30 | Supabase nordea_feed row 1 | `batch-lauri-mvw0c4fv-wfup` |
| `snap-lauri-savings-2026-10-30-batch-…` | savings | 14800.00 | 2026-10-30 | Supabase nordea_feed row 1 | `batch-lauri-mvw0c4fv-wfup` |
| `snap-lauri-carFund-2026-10-30-batch-…` | carFund | 2350.00 | 2026-10-30 | Supabase nordea_feed row 1 | `batch-lauri-mvw0c4fv-wfup` |

**Import batches** (`importBatches`)

| id | source | mode | received | added | skipped | updated | rejected |
|---|---|---|---|---|---|---|---|
| `batch-lauri-mvw0c4fv-wfup` | Supabase nordea_feed row 1 | incremental | 7 | 7 | 0 | 0 | 0 |

**Nordea observations with evidence** (`cabinetEntries`, field `evidence`)

| id | title | evidence: transactions | period | inputsHash | reviewed |
|---|---|---|---|---|---|
| `lauri-obs-salary` | Your salary went up in May 2026 | 24 (`tx-sal-2024-11`, `tx-sal-2024-12`, …) | 2025-11 → 2026-10 | `14c0f3k` | no, waiting for the customer |
| `lauri-obs-restaurants` | You've been eating out more | 12 (`tx-rest-2025-10`, `tx-rest-2025-11`, …) | 2025-10 → 2026-09 | `1kkvhq0` | no, waiting for the customer |

## What this branch is for

**`Bank_database` structures the Nordea-side bank data** so it looks more like a real account statement:

- **Transactions keep banking detail**: optional `bankId`, `valueDate`, `status` (booked/pending), `currency`,
  `counterparty`, `reference`. Only stored when the data carries them, never invented.
- **Stable transaction ids** and two import modes: `snapshot` (replace the statement, the default) and
  `incremental` (merge new rows, skip ones already known, correct a pending row that got booked).
- **Explicit account records**, **dated balance snapshots** (balance history survives later imports) and an
  **import batch** record for every import.
- **Original vs enriched data**: a category from the feed is kept as given; the app's own guess is marked as such.
- **"Nordea noticed" cards carry their evidence**: which transactions, which period, when computed.
- **Supabase setup guide** and a ready-made example feed row.

The Supabase tables don't change (`abel_records`, `nordea_feed`): the new data lives in the existing JSON columns.
Full details: [docs/bank-records.md](docs/bank-records.md).

## How it differs from the other branches

| Branch | What it has |
|---|---|
| `main` | The app, plus the first part of this bank-data work (PR #4). |
| **`Bank_database`** (this one) | `main` + the rest of the bank-data work, docs, tests, example feed, Supabase guide. |
| `dev-context-monitor` | The app **starts with no data** (load it with a Python script), plus a read-only **developer monitor** page. Does not have this branch's bank-data work. |

The two feature branches both change `src/server/db.ts`, so merging them needs that file reconciled.

## Run it on your computer

**Needs:** Node.js (LTS).

1. Install: `npm install` (if that fails, `npm install --legacy-peer-deps`).
2. Create `.env.local` in the project folder with an AI key, e.g. `GEMINI_API_KEY=...`
   (other options, such as the Aalto LLM or Groq, are in [.env.example](.env.example) and [LAPTOP.md](LAPTOP.md)).
3. Start: `npm run dev`, then open http://localhost:3000.

**Data:** this branch comes with the fictional demo customers (Lauri, Eeva, Alex) built in.
- Without Supabase, the app saves to `data/cabinet-db.json` on the server (resets when the hosting restarts).
- With Supabase, follow [supabase/README.md](supabase/README.md) once. On the first start the demo customers are
  copied into the empty table; after that, Supabase is the source of truth.

**New account data** for a customer: add a row to the `nordea_feed` table in Supabase (example:
[supabase/nordea-feed-example.csv](supabase/nordea-feed-example.csv)), or upload a file in the app under
More → Nordea account data.

## Checks

| Command | What it does |
|---|---|
| `npm test` | Checks the bank-data model (ids, snapshot/incremental imports, balance history, evidence) on a throwaway copy. Never touches your data. |
| `npm run check:feed` | Validates `supabase/nordea-feed-example.csv` and dry-runs it twice on a throwaway copy. |
| `npm run lint` | TypeScript check. |

## Where to read more

- [docs/bank-records.md](docs/bank-records.md): the bank-data model in detail, with examples.
- [supabase/README.md](supabase/README.md): first-time Supabase setup.
- [docs-v14.md](docs-v14.md): how the app is built (Abel, guardrails, partner offers, sharing).
- [LAPTOP.md](LAPTOP.md): running on a laptop with the Aalto LLM (VPN).
