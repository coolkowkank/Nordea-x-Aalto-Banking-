#!/usr/bin/env tsx
/**
 * G20: push the local per-customer agent databases to the hosted Supabase tables
 * (supabase/three-agents.sql: agent_user_records / agent_cm_records / agent_nordea_records).
 * scripts/load_data.py calls this after writing the local files; you can also run it by hand.
 *
 *   tsx scripts/load_remote.ts push [uid ...]    replace each customer's hosted rows from the local files
 *   tsx scripts/load_remote.ts clear [uid ...]   delete hosted rows (no uids = every row in every table)
 *
 * Each store's OWN connection string only: USER_DB_URL, CM_DB_URL, NORDEA_DB_URL
 * (read from the environment, .env or .env.local, like the app). No service key is used here.
 * A store whose URL is unset is skipped with a note.
 */
import dotenv from 'dotenv';
import { fileFor, listCustomers, remoteConfigured, configureRemote, rowsOf, type DbKind } from '../src/server/arch/store/common.js';
import { pushCustomer, REMOTE_TABLES, type PoolLike } from '../src/server/arch/store/remote.js';

dotenv.config({ path: '.env' });
dotenv.config({ path: '.env.local', override: true });

// The loader is an operator tool, not an agent: it wires each store kind to that
// store's own URL, the same wiring userStore/cmStore/nordeaStore do inside the app.
const URLS: Partial<Record<DbKind, string | undefined>> = {
  user: process.env.USER_DB_URL,
  cm: process.env.CM_DB_URL,
  nordea: process.env.NORDEA_DB_URL,
};

const KINDS: DbKind[] = ['user', 'cm', 'nordea'];
const configured = KINDS.filter((k) => URLS[k]);
if (!configured.length) {
  console.error('No hosted stores configured: set USER_DB_URL, CM_DB_URL and NORDEA_DB_URL ' +
    '(see supabase/three-agents.sql and the README Supabase section).');
  process.exit(1);
}
for (const k of KINDS) if (URLS[k]) configureRemote(k, URLS[k]);

const [mode, ...rest] = process.argv.slice(2);
const all = rest.includes('--all');
const uidsArg = rest.filter((a) => a !== '--all');
if (mode !== 'push' && mode !== 'clear') {
  console.error('usage: tsx scripts/load_remote.ts push [uid ...] | clear [uid ...] | clear --all');
  process.exit(2);
}
// Guard: wiping EVERY hosted row of every customer is never the default - it needs the
// explicit --all flag (scripts/load_data.py passes it only for its own --clear).
if (mode === 'clear' && !uidsArg.length && !all) {
  console.error('clear with no uids deletes EVERY row in every configured hosted table. ' +
    'Pass --all to confirm, or name the customers to clear.');
  process.exit(2);
}

const uids = uidsArg.length ? uidsArg : listCustomers();

// A pool with a raw DELETE for clear-all (roles own their tables; no rows survive).
async function clearAll(url: string, table: string) {
  const { default: pg } = await import('pg');
  const pool: PoolLike = new pg.Pool({ connectionString: url, max: 1 }) as unknown as PoolLike;
  await pool.query(`DELETE FROM ${table}`);
  await (pool as unknown as { end(): Promise<void> }).end();
}

let failed = 0;
for (const kind of configured) {
  const url = URLS[kind]!;
  const table = REMOTE_TABLES[kind]!;
  if (mode === 'clear' && !uidsArg.length) { // guarded above: this branch requires --all
    try {
      await clearAll(url, table);
      console.log(`cleared every row in ${table}`);
    } catch (err) { failed++; console.error(`clear ${table} failed:`, err instanceof Error ? err.message : err); }
    continue;
  }
  for (const uid of uids) {
    try {
      const rows = mode === 'clear' ? [] : rowsOf(fileFor(uid, kind), kind).map((r) => ({ user_id: uid, ...r }));
      await pushCustomer(kind, url, uid, rows);
      console.log(`${mode === 'clear' ? 'cleared' : 'pushed'} ${uid} -> ${table} (${rows.length} rows)`);
    } catch (err) { failed++; console.error(`${mode} ${uid} -> ${table} failed:`, err instanceof Error ? err.message : err); }
  }
}
if (!uids.length && mode === 'push') console.log('No customers in data/arch/customers.json - nothing to push.');
if (failed) process.exit(1);
