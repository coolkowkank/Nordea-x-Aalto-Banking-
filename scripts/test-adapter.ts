/**
 * Tests for the G1/G2 data layer (src/server/db.ts as the adapter over the three agent DBs):
 *  1. Legacy file data migrates into the three agent databases on init; the old store
 *     keeps only app plumbing (chat transcripts, logs, conversations, earnings, rewards).
 *  2. The legacy file is stripped of customer data after migration (no second copy).
 *  3. getState() composes the old full DatabaseState shape from the three DBs + plumbing.
 *  4. G2: app code writes the agent DBs directly through the adapter - transactions land
 *     in the Nordea DB, goals in the User DB, other entries in the Context Memory DB.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-test-'));
process.env.CABINET_DATA_DIR = DIR;

const { writeDemoDb } = await import('./demo-data.js');
writeDemoDb(DIR);
const { db } = await import('../src/server/db.js');
await db.init();
const S = await import('../src/server/arch/store/index.js');

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { passed++; console.log(`PASS  ${name}`); }
  else { failed++; console.log(`FAIL  ${name} ${detail === undefined ? '' : JSON.stringify(detail)}`); }
}

// --- Migration: legacy demo file -> three agent databases
check('both demo customers are registered in the customers index', ['lauri', 'eeva'].every((u) => S.listCustomers().includes(u)), S.listCustomers());
check('lauri profile lives in the User DB', S.loadProfile('lauri')?.name === 'Lauri' && S.loadProfile('lauri')?.age === 31);
check('lauri goals live in the User DB (2 demo goals)', S.loadUserDb('lauri').goals.length === 2, S.loadUserDb('lauri').goals.length);
check('lauri non-goal entries live in the Context Memory DB (2 observations + 1 preference)', S.loadCmDb('lauri').entries.length === 3, S.loadCmDb('lauri').entries.length);
check('eeva data migrated too (1 goal + 2 entries)', S.loadUserDb('eeva').goals.length === 1 && S.loadCmDb('eeva').entries.length === 2);
check('lauri balances live in the Nordea DB', !!S.loadBalances('lauri')?.current);
check('lauri bank accounts live in the Nordea DB', (S.loadNordeaDb('lauri')?.accounts ?? []).some((a) => a.userId === 'lauri' && a.key === 'current'));
check('entry history migrated into the Context Memory DB', S.loadHistory('lauri').length >= 3, S.loadHistory('lauri').length);

// --- The old store keeps plumbing only; the file is stripped of customer data
const fileState = JSON.parse(fs.readFileSync(path.join(DIR, 'cabinet-db.json'), 'utf-8'));
check('the legacy file no longer carries customer data', !fileState.cabinetEntries && !fileState.users && !fileState.transactions, Object.keys(fileState));
check('the legacy file still carries app plumbing (access log + topic log)', Array.isArray(fileState.accessLog) && Array.isArray(fileState.topicLog));
check('rewards stay in the old store, keyed by customer', fileState.rewards?.lauri?.points === 120, fileState.rewards);

// --- getState composes the old DatabaseState shape
const state = db.getState();
check('getState composes users from User DB + Nordea DB + rewards', state.users.lauri?.name === 'Lauri' && state.users.lauri?.points === 120 && !!state.users.lauri?.accounts?.current);
check('getState composes all 8 demo cabinet entries (goals + entries)', state.cabinetEntries.length === 8, state.cabinetEntries.length);
check('getState keeps plumbing lists (messages, access log)', state.messages.length === 3 && state.accessLog.length >= 1, { m: state.messages.length, a: state.accessLog.length });

// --- G2: app code writes the agent DBs directly through the adapter
db.upsertTransactions('lauri', [{ id: 't-adapt-1', userId: 'lauri', date: '2026-10-30', category: 'groceries', amount: -12.5, account: 'current', bankId: 'ADAPT-1' }]);
check('upsertTransactions writes the Nordea DB directly', S.loadNordeaDb('lauri')!.transactions.some((t) => t.bankId === 'ADAPT-1'));

db.addCabinetEntry({ id: 'g-adapt-1', userId: 'lauri', type: 'goal', title: 'Adapter goal', detail: 'written by app code', source: 'customer', status: 'active', private: false, readableBy: { abel: true, offers: true }, provenance: { channel: 'app' }, reviewed: true, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' });
check('a goal entry written by app code lands in the User DB', S.loadUserDb('lauri').goals.some((g) => g.id === 'g-adapt-1'));

db.addCabinetEntry({ id: 'p-adapt-1', userId: 'lauri', type: 'preference', title: 'Adapter preference', detail: 'written by app code', source: 'customer', status: 'active', private: false, readableBy: { abel: true, offers: true }, provenance: { channel: 'app' }, reviewed: true, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' });
check('a non-goal entry written by app code lands in the Context Memory DB', S.loadCmDb('lauri').entries.some((e) => e.id === 'p-adapt-1'));
check('adapter writes record entry history in the Context Memory DB', S.loadHistory('lauri').some((h) => h.entryId === 'p-adapt-1'));

const roundTrip = db.getCabinetEntry('p-adapt-1');
check('a written entry reads back through getState mapping with Abel fields intact', roundTrip?.title === 'Adapter preference' && roundTrip?.type === 'preference' && roundTrip?.provenance.channel === 'app');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.error('ADAPTER TESTS FAILED'); process.exit(1); }
console.log('All checks passed');
