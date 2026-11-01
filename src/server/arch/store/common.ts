/**
 * Physical storage plumbing shared by the per-database store modules.
 * One SQLite file per database per customer, next to (never inside) the app's own data.
 * An agent only ever opens its own database file; everything between agents is an explicit message.
 *
 * Local prototype boundary, stated honestly: separation is one SQLite file per database with
 * per-agent store modules (each agent module imports only its own store), pinned by a source-scan
 * boundary test. There is no separate database server, credential, or OS-user isolation here -
 * that is the live-Supabase target, not this local demo.
 */
import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

export const DATA_DIR = process.env.CABINET_DATA_DIR ? path.resolve(process.env.CABINET_DATA_DIR) : path.resolve(process.cwd(), 'data');
export const ARCH_DIR = path.join(DATA_DIR, 'arch');

export type DbKind = 'user' | 'cm' | 'nordea' | 'bus';

export function fileFor(uid: string, db: DbKind) {
  const safe = uid.replace(/[^a-z0-9_-]/gi, '_');
  return path.join(ARCH_DIR, `${safe}.${db}.db`);
}
export const legacyFileFor = (uid: string, db: DbKind) => fileFor(uid, db).replace(/\.db$/, '.json');

const SCHEMAS: Record<DbKind, string> = {
  user: `CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS goals (id TEXT PRIMARY KEY, title TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL, doc TEXT);
    CREATE TABLE IF NOT EXISTS personal_facts (id TEXT PRIMARY KEY, source TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL, via_airlock_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, json TEXT NOT NULL);`,
  cm: `CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, detail TEXT NOT NULL, goal_ids TEXT NOT NULL,
      proposed_by TEXT NOT NULL, via_message_id TEXT, evidence TEXT, status TEXT NOT NULL,
      dispute_reason TEXT, created_at TEXT NOT NULL, observed TEXT, risk TEXT, auto_accepted INTEGER, doc TEXT);
    CREATE TABLE IF NOT EXISTS history (id TEXT PRIMARY KEY, entry_id TEXT NOT NULL, at TEXT NOT NULL, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS shares (id TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS undo (token TEXT PRIMARY KEY, at TEXT NOT NULL, json TEXT NOT NULL);`,
  nordea: `CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY, date TEXT NOT NULL, category TEXT NOT NULL, amount REAL NOT NULL,
      account TEXT NOT NULL, description TEXT, json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions(category);
    CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);
    CREATE TABLE IF NOT EXISTS balance_snapshots (id TEXT PRIMARY KEY, account_key TEXT NOT NULL, at TEXT NOT NULL, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS import_batches (id TEXT PRIMARY KEY, at TEXT NOT NULL, json TEXT NOT NULL);`,
  bus: `CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, at TEXT NOT NULL, frm TEXT NOT NULL, tto TEXT NOT NULL,
      type TEXT NOT NULL, summary TEXT NOT NULL, payload TEXT, status TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS airlock (
      id TEXT PRIMARY KEY, at TEXT NOT NULL, source TEXT NOT NULL, items TEXT NOT NULL,
      status TEXT NOT NULL, decided_at TEXT);`,
};

/** Id column per SQLite table, per database kind (used by the G6 hosted sync). */
const TABLE_IDS: Record<DbKind, Record<string, string>> = {
  user: { kv: 'k', goals: 'id', personal_facts: 'id', documents: 'id' },
  cm: { kv: 'k', entries: 'id', history: 'id', shares: 'id', undo: 'token' },
  nordea: { kv: 'k', accounts: 'id', transactions: 'id', balance_snapshots: 'id', import_batches: 'id' },
  bus: { kv: 'k', messages: 'id', airlock: 'id' },
};

/**
 * G6: per-store hosted secret, configured by the owning store module and ONLY by it
 * (each store module passes only its own env var - pinned by a source-scan test).
 * common.ts itself never names an env var.
 */
const REMOTE_SECRETS = new Map<DbKind, string>();
export function configureRemote(kind: DbKind, url: string | undefined) {
  if (url) REMOTE_SECRETS.set(kind, url);
}
export const remoteConfigured = (kind: DbKind) => REMOTE_SECRETS.has(kind);

/** Write verbs mark a handle dirty; a dirty remote-backed handle flushes on close. */
const WRITE_VERB = /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)/i;

export function openDb(file: string, kind: DbKind): DatabaseSync {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMAS[kind]);
  if (!REMOTE_SECRETS.has(kind)) return db;
  // Remote-backed: watch for writes and flush this customer's database on close.
  let dirty = false;
  const wrap = <A extends unknown[], R>(fn: (...args: A) => R) => (...args: A) => {
    if (typeof args[0] === 'string' && WRITE_VERB.test(args[0])) dirty = true;
    return fn.apply(db, args);
  };
  const wrapped = {
    prepare: wrap(db.prepare.bind(db) as (...a: unknown[]) => unknown),
    exec: wrap(db.exec.bind(db) as (...a: unknown[]) => unknown),
    close: () => { db.close(); if (dirty) scheduleFlush(file, kind); },
  };
  return wrapped as unknown as DatabaseSync;
}

// ---------- G6: hosted sync (hydrate at startup, flush after writes) ----------

const flushTimers = new Map<string, ReturnType<typeof setTimeout>>();
const flushChains = new Map<string, Promise<void>>();

/** Serialize every row of every table of one local database file for its hosted table.
 *  Exported for scripts/load_remote.ts (the hosted data loader, G20). */
export function rowsOf(file: string, kind: DbKind): { table_name: string; id: string; data: Record<string, unknown> }[] {
  const db = new DatabaseSync(file);
  try {
    const out: { table_name: string; id: string; data: Record<string, unknown> }[] = [];
    for (const [table, idCol] of Object.entries(TABLE_IDS[kind])) {
      for (const row of db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[]) {
        out.push({ table_name: table, id: String(row[idCol]), data: row });
      }
    }
    return out;
  } finally { db.close(); }
}

function scheduleFlush(file: string, kind: DbKind) {
  const url = REMOTE_SECRETS.get(kind);
  if (!url) return;
  const key = `${kind}:${file}`;
  if (flushTimers.has(key)) clearTimeout(flushTimers.get(key)!);
  flushTimers.set(key, setTimeout(() => {
    flushTimers.delete(key);
    const uid = path.basename(file).replace(/\.(user|cm|nordea|bus)\.db$/, '');
    const rows = rowsOf(file, kind).map((r) => ({ user_id: uid, ...r }));
    const prev = flushChains.get(key) ?? Promise.resolve();
    const next = prev.then(() => import('./remote.js').then((R) => R.pushCustomer(kind, url, uid, rows)))
      .catch((err) => console.error(`Remote flush failed for ${key}:`, err instanceof Error ? err.message : err));
    flushChains.set(key, next);
  }, 250));
}

/**
 * Hydrate the local SQLite files from the hosted tables at startup (hosted mode only).
 * The remote tables are the source of truth when configured: each customer's local rows
 * for that kind are replaced by the remote ones. Runs before the app serves requests.
 */
export async function hydrateAgentStores(): Promise<string[]> {
  const hydrated: string[] = [];
  for (const [kind, url] of REMOTE_SECRETS) {
    if (kind === 'bus') continue; // the bus is transient agent messaging, local by design
    try {
      const R = await import('./remote.js');
      const rows = await R.pullStore(kind, url);
      const byUid = new Map<string, typeof rows>();
      for (const r of rows) {
        const list = byUid.get(r.user_id) ?? [];
        list.push(r);
        byUid.set(r.user_id, list);
      }
      for (const [uid, list] of byUid) {
        const file = fileFor(uid, kind);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const db = new DatabaseSync(file);
        try {
          db.exec(SCHEMAS[kind]);
          db.exec('BEGIN');
          for (const table of Object.keys(TABLE_IDS[kind])) db.prepare(`DELETE FROM ${table}`).run();
          for (const r of list) {
            const idCol = TABLE_IDS[kind][r.table_name];
            if (!idCol) continue;
            const cols = Object.keys(r.data);
            db.prepare(`INSERT INTO ${r.table_name} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
              .run(...cols.map((c) => r.data[c] as string | number | null));
          }
          db.exec('COMMIT');
        } finally { db.close(); }
        registerCustomer(uid);
      }
      hydrated.push(`${kind} (${rows.length} rows)`);
    } catch (err) {
      // A failed remote must not stop the app: keep working on the local files.
      console.error(`Remote hydrate failed for ${kind}:`, err instanceof Error ? err.message : err);
    }
  }
  return hydrated;
}


export const kvGet = (db: DatabaseSync, k: string): string | undefined =>
  (db.prepare('SELECT v FROM kv WHERE k = ?').get(k) as { v: string } | undefined)?.v;
export const kvSet = (db: DatabaseSync, k: string, v: string | null) => {
  if (v === null) db.prepare('DELETE FROM kv WHERE k = ?').run(k);
  else db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);
};

/** Delete one database file, and only that one (including any unmigrated legacy JSON copy). */
export function deleteDbFile(uid: string, which: DbKind) {
  for (const f of [fileFor(uid, which), legacyFileFor(uid, which), `${legacyFileFor(uid, which)}.migrated`]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

/**
 * One-time import of a legacy JSON store into its SQLite database.
 * `apply` receives the parsed JSON and writes it via the owning store module.
 */
export function migrateLegacy(uid: string, kind: DbKind, apply: (data: Record<string, unknown>) => void) {
  const dbFile = fileFor(uid, kind);
  const jsonFile = legacyFileFor(uid, kind);
  if (fs.existsSync(dbFile) || !fs.existsSync(jsonFile)) return;
  try {
    apply(JSON.parse(fs.readFileSync(jsonFile, 'utf-8')) as Record<string, unknown>);
    fs.renameSync(jsonFile, `${jsonFile}.migrated`);
  } catch {
    // A corrupt legacy file must not block the demo: start the SQLite DB empty instead.
  }
}

/**
 * G1: the index of customers with data in the three-database architecture. The app layer
 * needs it to find which per-customer databases exist (e.g. to look a record up by id
 * without knowing the customer). One small JSON file next to the databases.
 */
const INDEX_FILE = () => path.join(ARCH_DIR, 'customers.json');

export function listCustomers(): string[] {
  try {
    if (!fs.existsSync(INDEX_FILE())) return [];
    const uids = JSON.parse(fs.readFileSync(INDEX_FILE(), 'utf-8')) as string[];
    return Array.isArray(uids) ? uids : [];
  } catch { return []; }
}

export function registerCustomer(uid: string) {
  const uids = listCustomers();
  if (uids.includes(uid)) return;
  fs.mkdirSync(ARCH_DIR, { recursive: true });
  fs.writeFileSync(INDEX_FILE(), JSON.stringify([...uids, uid]), 'utf-8');
}

export function unregisterCustomer(uid: string) {
  const uids = listCustomers().filter((u) => u !== uid);
  if (uids.length === listCustomers().length) return;
  fs.mkdirSync(ARCH_DIR, { recursive: true });
  fs.writeFileSync(INDEX_FILE(), JSON.stringify(uids), 'utf-8');
}
