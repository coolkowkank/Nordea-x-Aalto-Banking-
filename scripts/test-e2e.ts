/**
 * V7 end-to-end: proof the app, /arch.html and /dev-monitor.html are ONE machine.
 * Boots the real server (mock LLM, DEV_MONITOR=1) over a throwaway data dir seeded from
 * seed/demo, then drives the exact HTTP routes the three pages use:
 *   1. a goal given to the personal agent's chat appears in the arch state and the monitor
 *   2. a review decision on /arch.html changes what the agent's chat answers from
 *   3. a bank import updates all three views (app route, arch state, monitor)
 *   4. round A (session) and round B (top-up) run over HTTP
 *   5. a source scan proves no app/arch code reads customer data from the old store
 * The live three-page check and the hosted-Supabase check are Bill's (review.md).
 */
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-'));
const PORT = 3210 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;

const seed = spawnSync('python3', ['scripts/load_data.py', 'seed/demo', '--target', 'file', '--no-reload'], {
  env: { ...process.env, CABINET_DATA_DIR: DIR }, encoding: 'utf-8',
});
if (seed.status !== 0) { console.error(seed.stdout, seed.stderr); process.exit(1); }

const server = spawn('npx', ['tsx', 'server.ts'], {
  env: { ...process.env, CABINET_DATA_DIR: DIR, LLM_PROVIDER: 'mock', DEV_MONITOR: '1', PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true, // own process group, so the whole server tree can be signalled at the end
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { passed++; console.log(`PASS  ${name}`); }
  else { failed++; console.log(`FAIL  ${name} ${detail === undefined ? '' : JSON.stringify(detail)}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api(method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(BASE + p, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

const UID = 'eeva';
const CAR_TXS = [
  { id: 'e2e-t1', userId: UID, date: '2026-10-01', category: 'transport', amount: -100, account: 'current', description: 'Fuel for the car' },
  { id: 'e2e-t2', userId: UID, date: '2026-10-02', category: 'transport', amount: -83.5, account: 'current', description: 'Car wash' },
];

try {
  // Boot
  const deadline = Date.now() + 30000;
  for (;;) {
    try { const r = await fetch(`${BASE}/api/arch/customers`); if (r.ok) break; } catch { /* not up yet */ }
    if (Date.now() > deadline) { console.error(serverLog); throw new Error('server did not start'); }
    await sleep(300);
  }
  const customers = await api('GET', '/api/arch/customers');
  check('V7: the arch customers endpoint lists the seeded customers', [UID, 'lauri', 'alex'].every((c) => JSON.stringify(customers.json).includes(c)), customers.json);
  check('V7: both view pages are served', (await fetch(`${BASE}/arch.html`)).ok && (await fetch(`${BASE}/dev-monitor.html`)).ok);

  // 0. Known bank data for eeva (import #1, snapshot)
  const imp1 = await api('POST', '/api/nordea-data', { userId: UID, fileName: 'e2e-import-1.json', data: { accounts: [], transactions: CAR_TXS } });
  check('V7: bank import #1 lands', imp1.status === 200 && imp1.json?.result?.ok === true, imp1.json);

  // 1. A goal given to the personal agent's chat appears on /arch.html's data and in the monitor
  const goalsBefore = (await api('GET', `/api/arch/${UID}/state`)).json?.databases?.user?.goals ?? 0;
  const goalChat = await api('POST', `/api/arch/${UID}/chat`, { text: 'my goal is Save for a car' });
  check('V7: the goal is accepted by the personal agent chat', goalChat.status === 200 && String(goalChat.json?.reply ?? '').includes('Save for a car'), goalChat.json);
  const st1 = (await api('GET', `/api/arch/${UID}/state`)).json;
  check('V7: the goal is visible in the arch state (/arch.html data)', st1?.databases?.user?.goals === goalsBefore + 1 && String(st1?.contextMd ?? '').includes('Save for a car'), { goals: st1?.databases?.user?.goals, before: goalsBefore });
  const mon1 = (await api('GET', `/api/dev/monitor?userId=${UID}`)).json;
  check('V7: the same goal is visible in the dev monitor', mon1?.arch?.databases?.user?.goals === goalsBefore + 1 && String(mon1?.arch?.contextMd ?? '').includes('Save for a car'), mon1?.arch?.databases);

  // 2. A review decision on /arch.html changes what the agent's chat answers from
  const preChat = await api('POST', `/api/arch/${UID}/chat`, { text: 'how much have I saved for the car?' });
  check('V7: before review the chat cannot answer from the Context Memory DB', !(preChat.json?.used ?? []).includes('context-memory-db'), preChat.json?.used);
  let review = (await api('GET', `/api/arch/${UID}/review`)).json?.proposals ?? [];
  if (!review.some((m: any) => m.from === 'nordea')) { await api('POST', `/api/arch/${UID}/nordea/contribute`); review = (await api('GET', `/api/arch/${UID}/review`)).json?.proposals ?? []; }
  const prop = review.find((m: any) => m.from === 'nordea' && String(m.summary ?? '').includes('Activity related to goal'));
  check('V7: the goal-matching Nordea proposal waits in review', !!prop, review.map((m: any) => `${m.from}:${m.summary}`));
  const acc = await api('POST', `/api/arch/${UID}/review/${prop.id}/accept`);
  check('V7: accepting the proposal writes the cabinet entry', acc.status === 200 && !!(acc.json?.id ?? acc.json?.entry?.id), acc.json);
  const entries = (await api('GET', `/api/arch/${UID}/entries`)).json?.entries ?? [];
  check('V7: the entry is active with the matched evidence', entries.some((e: any) => e.status === 'active' && typeof e.evidence?.total === 'number' && String(e.title).includes('Activity related to goal')), entries.map((e: any) => `${e.status}:${e.title.slice(0, 30)}`));
  const postChat = await api('POST', `/api/arch/${UID}/chat`, { text: 'how much have I saved for the car?' });
  check('V7: after the review decision the chat answers from the Context Memory DB', (postChat.json?.used ?? []).includes('context-memory-db'), postChat.json?.used);

  // 3. Bank import #2 (incremental) updates all three views
  const imp2 = await api('POST', '/api/nordea-data', { userId: UID, fileName: 'e2e-import-2.json', data: { mode: 'incremental', transactions: [{ id: 'e2e-t3', userId: UID, date: '2026-10-20', category: 'transport', amount: -50, account: 'current', description: 'Car wash' }] } });
  check('V7: bank import #2 lands and the arch hook runs', imp2.status === 200 && imp2.json?.result?.ok === true && imp2.json?.arch?.updated === true, imp2.json);
  const appView = (await api('GET', `/api/nordea-data?userId=${UID}`)).json;
  const st2 = (await api('GET', `/api/arch/${UID}/state`)).json;
  const mon2 = (await api('GET', `/api/dev/monitor?userId=${UID}`)).json;
  check('V7: all three views show the new transaction', appView?.transactions === 3 && st2?.databases?.nordea?.transactions === 3 && mon2?.arch?.databases?.nordea?.transactions === 3, { app: appView?.transactions, arch: st2?.databases?.nordea?.transactions, monitor: mon2?.arch?.databases?.nordea?.transactions });

  // 4. Round A (session) and round B (top-up) run over HTTP
  await api('POST', `/api/arch/${UID}/chat`, { text: 'what do you know about my car saving?', sessionId: 'e2e-rounds' });
  const ctxA = (await api('GET', `/api/arch/${UID}/state`)).json?.context;
  check('V7: round A runs as a session round on a new session', ctxA?.trigger === 'session' && typeof ctxA?.roundId === 'string' && ctxA.roundId.length > 0, ctxA);
  await api('POST', `/api/arch/${UID}/chat`, { text: 'what about my pension contributions?', sessionId: 'e2e-rounds' });
  const ctxB = (await api('GET', `/api/arch/${UID}/state`)).json?.context;
  check('V7: round B runs as a top-up round on the same session', ctxB?.trigger === 'topup' && ctxB?.roundId !== ctxA?.roundId, ctxB);

  // 5. Source scan: no app/arch code reads customer data from the old store
  const read = (f: string) => fs.readFileSync(f, 'utf-8');
  const appFiles = ['abel.ts', 'finance.ts', 'routes.ts', 'devMonitor.ts', 'dataRewards.ts', 'documents.ts'].map((f) => `src/server/${f}`);
  const infraAllowed = new Set(['src/server/db.ts', 'src/server/documents.ts', 'src/server/nordeaFeed.ts']);
  const oldStoreRef = /from\s+['"](?:\.\.\/)*\.\.?\/store\.js['"]/;
  const appLeaks = appFiles.filter((f) => !infraAllowed.has(f) && oldStoreRef.test(read(f)));
  const archFiles = [...fs.readdirSync('src/server/arch'), ...fs.readdirSync('src/server/arch/agents').map((f) => `agents/${f}`), ...fs.readdirSync('src/server/arch/store').map((f) => `store/${f}`)]
    .filter((f) => f.endsWith('.ts')).map((f) => `src/server/arch/${f}`);
  const archLeaks = archFiles.filter((f) => /from\s+['"][^'"]*server\/store\.js['"]|from\s+['"](?:\.\.\/)+store\.js['"]/.test(read(f)));
  check('V7: no app-layer code outside db/documents/feed imports the old store', appLeaks.length === 0, appLeaks);
  check('V7: no arch code reaches across to the old store', archLeaks.length === 0, archLeaks);
} finally {
  try { process.kill(-server.pid!, 'SIGTERM'); } catch { server.kill('SIGTERM'); }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
