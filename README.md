<img width="1900" height="1000" alt="The Banking Context Cabinet: app screenshots" src="https://github.com/user-attachments/assets/29cb5da6-584e-4264-bf98-a026b911e060" />

# The Banking Context Cabinet

**A Nordea × Aalto University mobile banking concept.** Customers chat with **Abel**, an AI banking assistant, and decide exactly what Abel and other helpers may know about them. Everything Abel knows lives in a **Context Cabinet** the customer controls, and every read goes through a logged **access gateway**.

> This is a research prototype. All bank data, partners and customers in it are fictional.

---

## Contents
- [What it does](#what-it-does)
- [How it works](#how-it-works)
- [Tech stack](#tech-stack)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Project structure](#project-structure)
- [Testing](#testing)
- [Further docs](#further-docs)

---

## What it does

| Feature | What the customer gets |
|---|---|
| **Abel, the AI assistant** | Answers questions about balances, spending, goals and payday plans. Numbers come from code, not from the model's imagination. |
| **Context Cabinet** | One place for everything Abel knows: goals, life events, preferences, facts and Nordea's observations. Each item shows where it came from and its full history. |
| **Access gateway** | Every read by Abel, the partner-offer helper or a Nordea adviser is checked against the customer's permissions and logged in *Who sees it*. |
| **One-time sharing** | Share with a Nordea adviser for a limited time, and revoke at any moment. |
| **Partner offers** | Fictional partners (homes, movers, energy, insurance, planning) appear only when relevant and allowed. The fee is always shown, and part of it goes back to the customer. |
| **Data rewards** | Fictional points for sharing notes and for each time a helper actually uses them. |
| **Import** | Bring in WhatsApp chats, PDFs, photos, Excel and CSV files. Abel suggests what to save; the customer ticks what to keep. |
| **Your documents** | Files are read once and not kept, unless the customer chooses "Keep a copy" (deleted automatically after 30 days). |
| **Nordea account data** | Upload or feed fictional account data; Nordea spots salary changes, spending shifts and new regular payments for the customer to confirm. |
| **Safe actions** | Money never moves from chat. Abel can only propose a transfer; the customer confirms it. |

Demo personas: **Lauri**, **Eeva** and **Alex**.

## How it works

```
 React app (src/components)
        │  /api/*
        ▼
 Express server (server.ts, src/server/routes.ts)
        │
        ├── Abel (abel.ts) ──► LLM chain (llm*.ts): Groq / Aalto LLM / Gemini / mock
        │        │                └─► offline answers (abelOffline.ts) if every model is busy
        │        ▼
        ├── Access gateway (accessGateway.ts) ──► permissions per agent (agents/*.json)
        │        │
        │        ▼
        ├── Context Cabinet + finance maths (db.ts, finance.ts)
        │        │
        │        ▼
        └── Storage: Supabase (store.ts) or local file data/cabinet-db.json
```

**Guardrails built into the code**
1. Abel reads the cabinet through the gateway before every reply.
2. Every number in a reply must come from a tool or the cabinet; otherwise the reply is sent back to be fixed.
3. The cabinet changes only through a proposal the customer can undo, with provenance recorded.
4. Partner offers come only from the registry, never when turned off, and at most once per partner per chat.
5. "Based on N things" lists only what the gateway actually returned in that turn.

## Tech stack

| Layer | Tools |
|---|---|
| Frontend | React 19, Vite 8, Tailwind CSS 4, Motion, Lucide icons |
| Backend | Node.js, Express, TypeScript (run with `tsx`) |
| AI | Google Gemini (`@google/genai`), any OpenAI-compatible API (Groq, Aalto LLM gateway), scripted mock |
| Storage | Supabase (Postgres + private file bucket), or a local JSON file |
| File reading | `unpdf` (PDF), `read-excel-file` (Excel) |
| Hosting | Google AI Studio (Cloud Run) |

## Quick start

**Prerequisite:** [Node.js](https://nodejs.org) LTS.

```bash
npm install --legacy-peer-deps
cp .env.example .env        # then add your key (see Configuration)
npm run dev                 # opens on http://localhost:3000
```

No AI key yet? Run with the scripted stand-in:

```bash
LLM_PROVIDER=mock npm run dev
```

Check the connection in the app under **More → AI connection → Test**.

| Script | What it does |
|---|---|
| `npm run dev` / `npm start` | Start the server and app on port 3000 |
| `npm run build` | Build the frontend with Vite |
| `npm run lint` | Type-check with TypeScript |
| `npm test` | Run the bank-records tests |

## Configuration

Put these in `.env` on a laptop, or in **AI Studio → Settings → Secrets**. Never commit keys.

| Variable | Required | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | Yes, for Gemini | Gemini API key (injected automatically in AI Studio) |
| `APP_URL` | AI Studio only | URL where the app is hosted |
| `GEMINI_MODEL` | No | Gemini model to use (default `gemini-3.8-flash`) |
| `LLM_PROVIDER` | No | `openai` for Groq or the Aalto LLM, `mock` for local tests only |
| `LLM_BASE_URL` | With `openai` | API address, e.g. `https://api.groq.com/openai/v1` |
| `LLM_API_KEY` | With `openai` | API key for that service |
| `LLM_MODEL` | With `openai` | First model to try |
| `LLM_FALLBACK_MODELS` | No | Comma-separated backup models |
| `LLM_VISION_MODELS` | No | Models that can read photos |
| `LLM_TIMEOUT_MS`, `LLM_TURN_MS` | No | Time limits for one call and a whole reply |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | No | Save data in Supabase instead of a local file that resets on restart |

**Using Supabase:** run `supabase/setup.sql` once in the Supabase SQL Editor (and `supabase/nordea-feed.sql` for the account-data feed), then add the two secrets.

**Using the Aalto LLM:** works only on the Aalto VPN. See [LAPTOP.md](LAPTOP.md) for a step-by-step guide.

## Project structure

```
├── server.ts                 Express entry point (port 3000)
├── src/
│   ├── App.tsx, main.tsx     React app
│   ├── components/           Home, Chat, Pages (cabinet, sharing, rewards, settings), modals
│   ├── server/
│   │   ├── abel.ts           Abel's prompt, tools and guardrails
│   │   ├── llm*.ts           Model providers and fallback chain
│   │   ├── abelOffline.ts    Code-based answers when no model is free
│   │   ├── accessGateway.ts  Permission checks and access log
│   │   ├── finance.ts        All numbers: balances, spending, goals, fees
│   │   ├── routes.ts         API routes
│   │   ├── db.ts, store.ts   In-memory data + Supabase sync
│   │   ├── documents.ts      Uploaded files (read once / keep 30 days)
│   │   ├── nordeaData.ts     Account data and Nordea observations
│   │   └── dataRewards.ts    Points for sharing and use
│   ├── services/api.ts       Frontend API client
│   └── types.ts              Shared types
├── agents/                   What each helper may read (abel, offers, adviser)
├── partners/                 Fictional partner definitions
├── data/cabinet-db.json      Local demo data
├── supabase/                 SQL setup scripts
├── scripts/                  Tests
├── public/                   Fonts, screenshots and design assets
└── docs/, docs-v14.md        Design and change notes
```

## Testing

- `npm test` runs the bank-records tests.
- In the app, **More → Check Abel's answers** asks 12 real questions on a copy of Lauri and grades them automatically.

## Further docs

- [docs-v14.md](docs-v14.md): how Abel, the gateway, storage, documents and data rewards work
- [docs/bank-records.md](docs/bank-records.md): structure of the Nordea account data
- [LAPTOP.md](LAPTOP.md): running with the Aalto LLM on a laptop
