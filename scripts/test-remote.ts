/**
 * Behavioral tests for the G6 hosted sync (hydrate / flush / failures / isolation / role
 * permissions) against an isolated in-memory Postgres double - no live database, no
 * service, no cost. The double speaks exactly the SQL shapes remote.ts issues and enforces
 * the one-role-per-agent table grants the way supabase/three-agents.sql declares them.
 * The real pg wire protocol and RLS remain to be smoke-tested against a live Supabase.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { PoolLike } from '../src/server/arch/store/remote.js';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-test-'));
process.env.CABINET_DATA_DIR = DIR;

const { configureRemote, hydrateAgentStores } = await import('../src/server/arch/store/common.js');
const R = await import('../src/server/arch/store/remote.js');
const S = await import('../src/server/arch/store/index.js');

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { passed++; console.log(`PASS  ${name}`); }
  else { failed++; console.log(`FAIL  ${name} ${detail === undefined ? '' : JSON.stringify(detail)}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- The in-memory Postgres double ----------
type Row = { user_id: string; table_name: string; id: string; data: Record<string, unknown> };

class FakePg {
  tables = new Map<string, Row[]>(); // table -> rows
  pushes: { table: string; uid: string; rows: number }[] = [];
  failAll = false;

  /** One role per agent, as three-agents.sql grants it: agent_<x> may touch agent_<x>_records only. */
  private permit(url: string, table: string) {
    const role = new URL(url).username;
    if (table !== `agent_${role.replace('agent_', '')}_records`) throw new Error(`permission denied for table ${table}`);
  }
  private run(url: string, text: string, params: unknown[] = []): { rows: unknown[] } {
    if (this.failAll) throw new Error('connection refused (fake outage)');
    let m = text.match(/^SELECT user_id, table_name, id, data FROM (\w+)$/);
    if (m) { this.permit(url, m[1]); return { rows: [...(this.tables.get(m[1]) ?? [])] }; }
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text)) return { rows: [] };
    m = text.match(/^DELETE FROM (\w+) WHERE user_id = \$1$/);
    if (m) { this.permit(url, m[1]); this.tables.set(m[1], (this.tables.get(m[1]) ?? []).filter((r) => r.user_id !== params[0])); return { rows: [] }; }
    m = text.match(/^INSERT INTO (\w+) \(user_id, table_name, id, data\) VALUES \(\$1, \$2, \$3, \$4\)$/);
    if (m) {
      this.permit(url, m[1]);
      const rows = this.tables.get(m[1]) ?? [];
      rows.push({ user_id: String(params[0]), table_name: String(params[1]), id: String(params[2]), data: JSON.parse(String(params[3])) });
      this.tables.set(m[1], rows);
      return { rows: [] };
    }
    throw new Error(`fake pg: unsupported SQL: ${text}`);
  }
  pool(url: string): PoolLike {
    const self = this;
    return {
      query: (text: string, params?: unknown[]) => Promise.resolve(self.run(url, text, params)),
      connect: () => Promise.resolve({
        query: (text: string, params?: unknown[]) => Promise.resolve(self.run(url, text, params)),
        release: () => undefined,
      }),
    };
  }
}

const fake = new FakePg();
R.setPoolFactoryForTests((url) => fake.pool(url));

const URLS = { user: 'postgres://agent_user:pw@fake/db', cm: 'postgres://agent_cm:pw@fake/db', nordea: 'postgres://agent_nordea:pw@fake/db' };
configureRemote('user', URLS.user);
configureRemote('cm', URLS.cm);
configureRemote('nordea', URLS.nordea);

// ---------- Seed the "hosted tables" ----------
fake.tables.set('agent_user_records', [
  { user_id: 'lauri', table_name: 'kv', id: 'profile', data: { k: 'profile', v: JSON.stringify({ name: 'Lauri', age: 31 }) } },
  { user_id: 'lauri', table_name: 'goals', id: 'g1', data: { id: 'g1', title: 'Remote car', detail: 'hosted goal', created_at: '2026-10-01', doc: null } },
  { user_id: 'eeva', table_name: 'goals', id: 'ge1', data: { id: 'ge1', title: 'Eeva remote goal', detail: 'hosted', created_at: '2026-10-01', doc: null } },
]);
fake.tables.set('agent_nordea_records', [
  { user_id: 'lauri', table_name: 'transactions', id: 't1', data: { id: 't1', date: '2026-10-05', category: 'transport', amount: -50, account: 'current', description: 'Hosted fuel', json: JSON.stringify({ id: 't1', userId: 'lauri', date: '2026-10-05', category: 'transport', amount: -50, account: 'current', description: 'Hosted fuel' }) } },
]);

// A stale local row that the hosted table does not have: hydrate must replace, not merge.
S.putGoal('lauri', { id: 'g-local-only', title: 'Stale local goal', detail: 'not hosted', createdAt: '2026-09-01' });

// ---------- Hydrate ----------
const hydrated = await hydrateAgentStores();
check('hydrate reports the stores it pulled', hydrated.some((h) => h.startsWith('user')) && hydrated.some((h) => h.startsWith('nordea')), hydrated);
check('hydrate wrote the hosted goal into the local User DB', S.loadUserDb('lauri').goals.some((g) => g.id === 'g1' && g.title === 'Remote car'));
check('hydrate replaced the stale local row (hosted tables are the source of truth)', !S.loadUserDb('lauri').goals.some((g) => g.id === 'g-local-only'));
check('hydrate wrote the hosted transaction into the local Nordea DB', S.loadNordeaDb('lauri')!.transactions.some((t) => t.id === 't1' && t.description === 'Hosted fuel'));
check('hydrate registered hydrated customers in the index', S.listCustomers().includes('lauri') && S.listCustomers().includes('eeva'));

// ---------- Flush on write ----------
S.putGoal('lauri', { id: 'g2', title: 'Flushed goal', detail: 'written locally, must land hosted', createdAt: '2026-11-01' });
let flushed = false;
for (let i = 0; i < 40 && !flushed; i++) {
  await sleep(100);
  flushed = (fake.tables.get('agent_user_records') ?? []).some((r) => r.user_id === 'lauri' && r.id === 'g2');
}
check('a local write flushes to the store\'s hosted table (debounced)', flushed);
check('flush replaced only that customer\'s rows: eeva\'s hosted rows are untouched',
  (fake.tables.get('agent_user_records') ?? []).some((r) => r.user_id === 'eeva' && r.id === 'ge1'));
check('flush kept lauri\'s other hosted rows (profile, g1 still there)',
  ['profile', 'g1', 'g2'].every((id) => (fake.tables.get('agent_user_records') ?? []).some((r) => r.user_id === 'lauri' && r.id === id)));

// ---------- Read-only opens do not flush ----------
const pushesBefore = (fake.tables.get('agent_nordea_records') ?? []).length;
S.loadNordeaDb('lauri');
S.loadUserDb('lauri');
await sleep(400);
check('read-only opens never flush (no rewrite of hosted rows)',
  (fake.tables.get('agent_nordea_records') ?? []).length === pushesBefore);

// ---------- Failure handling ----------
fake.failAll = true;
S.putGoal('lauri', { id: 'g3', title: 'Written during outage', detail: 'local only until the remote recovers', createdAt: '2026-11-01' });
await sleep(400);
check('a flush failure keeps the app working locally (no throw, local row readable)',
  S.loadUserDb('lauri').goals.some((g) => g.id === 'g3'));
const hydratedDuringOutage = await hydrateAgentStores();
check('a hydrate failure is reported as nothing hydrated, not a crash', hydratedDuringOutage.length === 0, hydratedDuringOutage);
fake.failAll = false;

// ---------- Role permissions (one role per agent, enforced) ----------
fake.tables.set('agent_cm_records', [
  { user_id: 'lauri', table_name: 'entries', id: 'e1', data: { id: 'e1', title: 'CM entry', detail: 'x', goal_ids: '[]', proposed_by: 'user', via_message_id: null, evidence: null, status: 'active', dispute_reason: null, created_at: '2026-10-01', observed: null, risk: null, auto_accepted: null, doc: null } },
]);
// Misconfiguration: the CM store pointed at the USER role's secret must be denied by the grant model.
configureRemote('cm', URLS.user);
const wrongRole = await hydrateAgentStores();
check('a store using another agent\'s secret is denied by the role grants (cm skipped, error caught)',
  !wrongRole.some((h) => h.startsWith('cm')) && !S.loadCmDb('lauri').entries.some((e) => e.id === 'e1'), wrongRole);
configureRemote('cm', URLS.cm);
const rightRole = await hydrateAgentStores();
check('with its own secret the CM store hydrates its table',
  rightRole.some((h) => h.startsWith('cm')) && S.loadCmDb('lauri').entries.some((e) => e.id === 'e1'), rightRole);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.error('REMOTE TESTS FAILED'); process.exit(1); }
console.log('All checks passed');
