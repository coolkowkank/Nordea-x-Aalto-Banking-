/**
 * G6: hosted storage for the three agent databases (Supabase Postgres - see
 * supabase/three-agents.sql). Pure pg helper: this module knows no store internals and
 * never sees a service key - each store module passes ONLY its own connection string
 * (USER_DB_URL / CM_DB_URL / NORDEA_DB_URL), one Postgres role per agent.
 *
 * Local SQLite stays the default and the synchronous working format. With a remote
 * configured, db.init() hydrates the local files from the store's table at startup, and
 * common.ts flushes a customer's database back after writes (replace that customer's rows
 * in one transaction). If the remote is unreachable the app keeps working locally and
 * logs the failure - the local files remain the honest fallback copy.
 */
import pg from 'pg';
import type { DbKind } from './common.js';

/** Store kind -> hosted table (mirrors supabase/three-agents.sql). */
export const REMOTE_TABLES: Partial<Record<DbKind, string>> = {
  user: 'agent_user_records',
  cm: 'agent_cm_records',
  nordea: 'agent_nordea_records',
};

export interface RemoteRow { user_id: string; table_name: string; id: string; data: Record<string, unknown>; }

/** The slice of pg.Pool the sync uses (structural, so tests can substitute a double). */
export interface PoolLike {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  connect(): Promise<{ query(text: string, params?: unknown[]): Promise<unknown>; release(): void }>;
}

let poolFactory: ((url: string) => PoolLike) | null = null;
/** Tests only: replace pool creation with a double (no live database needed). */
export function setPoolFactoryForTests(factory: ((url: string) => PoolLike) | null) {
  poolFactory = factory;
  pools.clear();
}

const pools = new Map<string, PoolLike>();
const poolFor = (url: string): PoolLike => {
  if (poolFactory) return poolFactory(url);
  let p = pools.get(url);
  if (!p) { p = new pg.Pool({ connectionString: url, max: 2 }); pools.set(url, p); }
  return p;
};

/** All rows of one store's table (that store's role can only ever see its own table). */
export async function pullStore(kind: DbKind, url: string): Promise<RemoteRow[]> {
  const table = REMOTE_TABLES[kind];
  if (!table) return [];
  const res = await poolFor(url).query(`SELECT user_id, table_name, id, data FROM ${table}`);
  return res.rows as RemoteRow[];
}

/** Replace one customer's rows in one store's table, in a single transaction. */
export async function pushCustomer(kind: DbKind, url: string, uid: string, rows: RemoteRow[]): Promise<void> {
  const table = REMOTE_TABLES[kind];
  if (!table) return;
  const client = await poolFor(url).connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM ${table} WHERE user_id = $1`, [uid]);
    for (const r of rows) {
      await client.query(`INSERT INTO ${table} (user_id, table_name, id, data) VALUES ($1, $2, $3, $4)`,
        [uid, r.table_name, r.id, JSON.stringify(r.data)]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
