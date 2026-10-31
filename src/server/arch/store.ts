import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import type { BankAccount, Transaction } from '../../types.js';

/**
 * The three-database architecture, kept physically separate on purpose:
 * one SQLite database file per database per customer, next to (never inside) the app's own data.
 * An agent only ever opens its own database file; everything between agents is an explicit message.
 *
 * Local prototype boundary, stated honestly: separation is one SQLite file per database with
 * per-agent accessor functions (each agent module only ever calls its own openDb), enforced by
 * code convention in one OS process. There is no separate database server, credential, or OS-user
 * isolation here - that is the live-Supabase target, not this local demo.
 *
 * Legacy: the first version of this prototype used JSON files (<uid>.<db>.json). On first open of
 * a database that exists only as JSON, the contents are migrated into SQLite and the JSON left in
 * place as a backup (<file>.json.migrated) so no existing demo data is lost.
 */
const DATA_DIR = process.env.CABINET_DATA_DIR ? path.resolve(process.env.CABINET_DATA_DIR) : path.resolve(process.cwd(), 'data');
const ARCH_DIR = path.join(DATA_DIR, 'arch');

export type AgentId = 'personal' | 'cm' | 'nordea';
export const AGENTS: { id: AgentId; name: string; owns: string }[] = [
  { id: 'personal', name: 'Personal agent', owns: 'User DB (your profile, goals, personal facts)' },
  { id: 'cm', name: 'Context Memory agent', owns: 'Context Memory DB (the shared context cabinet)' },
  { id: 'nordea', name: 'Nordea agent', owns: 'Nordea DB (accounts and transactions)' },
];

export interface Goal { id: string; title: string; detail: string; createdAt: string; }
export interface PersonalFact { id: string; source: string; text: string; at: string; viaAirlockId: string; }
export interface PersonalAgentSettings { mode: 'abel' | 'external'; externalName?: string; connectedAt?: string; simulated?: boolean; }
export interface UserDb {
  userId: string;
  profileName?: string;
  goals: Goal[];
  personalFacts: PersonalFact[];
  personalAgent: PersonalAgentSettings;
  agentsOff: AgentId[];
}
export interface ArchEntry {
  id: string;
  title: string;
  detail: string;
  goalIds: string[];
  proposedBy: AgentId | 'user';
  viaMessageId?: string;
  evidence?: { transactionIds?: string[]; total?: number; note?: string };
  status: 'active' | 'disputed' | 'stale';
  disputeReason?: string;
  createdAt: string;
}
export interface CmDb { userId: string; entries: ArchEntry[]; parked?: boolean; }
export interface NordeaDb { userId: string; accounts: BankAccount[]; transactions: Transaction[]; }

export type MessageType = 'propose' | 'query' | 'reply' | 'inform' | 'flag-stale' | 'refresh';
export interface AgentMessage {
  id: string;
  at: string;
  from: AgentId;
  to: AgentId | 'user';
  type: MessageType;
  summary: string;
  payload?: Record<string, unknown>;
  status: 'pending' | 'accepted' | 'rejected' | 'answered' | 'read';
}
export interface AirlockItem { id: string; kind: string; text: string; }
export interface AirlockBatch {
  id: string;
  at: string;
  source: string; // whatsapp | calendar | notes | email
  items: AirlockItem[];
  status: 'pending' | 'approved' | 'rejected';
  decidedAt?: string;
}
export interface Bus { messages: AgentMessage[]; airlock: AirlockBatch[]; }

const now = () => new Date().toISOString();
let seq = 0;
export const newId = (p: string) => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

type DbKind = 'user' | 'cm' | 'nordea' | 'bus';

function fileFor(uid: string, db: DbKind) {
  const safe = uid.replace(/[^a-z0-9_-]/gi, '_');
  return path.join(ARCH_DIR, `${safe}.${db}.db`);
}
const legacyFileFor = (uid: string, db: DbKind) => fileFor(uid, db).replace(/\.db$/, '.json');

const SCHEMAS: Record<DbKind, string> = {
  user: `CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS goals (id TEXT PRIMARY KEY, title TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS personal_facts (id TEXT PRIMARY KEY, source TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL, via_airlock_id TEXT NOT NULL);`,
  cm: `CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, detail TEXT NOT NULL, goal_ids TEXT NOT NULL,
      proposed_by TEXT NOT NULL, via_message_id TEXT, evidence TEXT, status TEXT NOT NULL,
      dispute_reason TEXT, created_at TEXT NOT NULL);`,
  nordea: `CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY, date TEXT NOT NULL, category TEXT NOT NULL, amount REAL NOT NULL,
      account TEXT NOT NULL, description TEXT, json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions(category);
    CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);`,
  bus: `CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, at TEXT NOT NULL, frm TEXT NOT NULL, tto TEXT NOT NULL,
      type TEXT NOT NULL, summary TEXT NOT NULL, payload TEXT, status TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS airlock (
      id TEXT PRIMARY KEY, at TEXT NOT NULL, source TEXT NOT NULL, items TEXT NOT NULL,
      status TEXT NOT NULL, decided_at TEXT);`,
};

function openDb(file: string, kind: DbKind): DatabaseSync {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMAS[kind]);
  return db;
}

const kvGet = (db: DatabaseSync, k: string): string | undefined =>
  (db.prepare('SELECT v FROM kv WHERE k = ?').get(k) as { v: string } | undefined)?.v;
const kvSet = (db: DatabaseSync, k: string, v: string | null) => {
  if (v === null) db.prepare('DELETE FROM kv WHERE k = ?').run(k);
  else db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);
};

// ---------- User DB ----------

const emptyUser = (userId: string): UserDb => ({ userId, goals: [], personalFacts: [], personalAgent: { mode: 'abel' }, agentsOff: [] });

export function loadUserDb(uid: string): UserDb {
  migrateLegacy(uid, 'user');
  if (!fs.existsSync(fileFor(uid, 'user'))) return emptyUser(uid);
  const db = openDb(fileFor(uid, 'user'), 'user');
  try {
    const d = emptyUser(uid);
    const profileName = kvGet(db, 'profileName');
    if (profileName) d.profileName = profileName;
    const pa = kvGet(db, 'personalAgent');
    if (pa) d.personalAgent = JSON.parse(pa);
    const off = kvGet(db, 'agentsOff');
    if (off) d.agentsOff = JSON.parse(off);
    d.goals = (db.prepare('SELECT * FROM goals ORDER BY created_at').all() as Record<string, string>[])
      .map((r) => ({ id: r.id, title: r.title, detail: r.detail, createdAt: r.created_at }));
    d.personalFacts = (db.prepare('SELECT * FROM personal_facts ORDER BY at').all() as Record<string, string>[])
      .map((r) => ({ id: r.id, source: r.source, text: r.text, at: r.at, viaAirlockId: r.via_airlock_id }));
    return d;
  } finally { db.close(); }
}

export function saveUserDb(d: UserDb) {
  const db = openDb(fileFor(d.userId, 'user'), 'user');
  try {
    kvSet(db, 'profileName', d.profileName ?? null);
    kvSet(db, 'personalAgent', JSON.stringify(d.personalAgent));
    kvSet(db, 'agentsOff', JSON.stringify(d.agentsOff));
    db.exec('BEGIN');
    db.prepare('DELETE FROM goals').run();
    const g = db.prepare('INSERT INTO goals (id, title, detail, created_at) VALUES (?, ?, ?, ?)');
    for (const goal of d.goals) g.run(goal.id, goal.title, goal.detail, goal.createdAt);
    db.prepare('DELETE FROM personal_facts').run();
    const f = db.prepare('INSERT INTO personal_facts (id, source, text, at, via_airlock_id) VALUES (?, ?, ?, ?, ?)');
    for (const fact of d.personalFacts) f.run(fact.id, fact.source, fact.text, fact.at, fact.viaAirlockId);
    db.exec('COMMIT');
  } finally { db.close(); }
}

// ---------- Context Memory DB ----------

const emptyCm = (userId: string): CmDb => ({ userId, entries: [] });

export function loadCmDb(uid: string): CmDb {
  migrateLegacy(uid, 'cm');
  if (!fs.existsSync(fileFor(uid, 'cm'))) return emptyCm(uid);
  const db = openDb(fileFor(uid, 'cm'), 'cm');
  try {
    const entries = (db.prepare('SELECT * FROM entries ORDER BY created_at').all() as Record<string, string>[])
      .map((r) => ({
        id: r.id, title: r.title, detail: r.detail, goalIds: JSON.parse(r.goal_ids) as string[],
        proposedBy: r.proposed_by as ArchEntry['proposedBy'],
        ...(r.via_message_id ? { viaMessageId: r.via_message_id } : {}),
        ...(r.evidence ? { evidence: JSON.parse(r.evidence) } : {}),
        status: r.status as ArchEntry['status'],
        ...(r.dispute_reason ? { disputeReason: r.dispute_reason } : {}),
        createdAt: r.created_at,
      }));
    const parked = kvGet(db, 'parked') === '1';
    return { userId: uid, entries, ...(parked ? { parked: true } : {}) };
  } finally { db.close(); }
}

export function saveCmDb(d: CmDb) {
  const db = openDb(fileFor(d.userId, 'cm'), 'cm');
  try {
    kvSet(db, 'parked', d.parked ? '1' : null);
    db.exec('BEGIN');
    db.prepare('DELETE FROM entries').run();
    const ins = db.prepare(`INSERT INTO entries
      (id, title, detail, goal_ids, proposed_by, via_message_id, evidence, status, dispute_reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const e of d.entries) {
      ins.run(e.id, e.title, e.detail, JSON.stringify(e.goalIds), e.proposedBy,
        e.viaMessageId ?? null, e.evidence ? JSON.stringify(e.evidence) : null,
        e.status, e.disputeReason ?? null, e.createdAt);
    }
    db.exec('COMMIT');
  } finally { db.close(); }
}

// ---------- Nordea DB ----------

export function nordeaFileExists(uid: string) {
  return fs.existsSync(fileFor(uid, 'nordea')) || fs.existsSync(legacyFileFor(uid, 'nordea'));
}

export function loadNordeaDb(uid: string): NordeaDb | null {
  if (!nordeaFileExists(uid)) return null;
  migrateLegacy(uid, 'nordea');
  if (!fs.existsSync(fileFor(uid, 'nordea'))) return { userId: uid, accounts: [], transactions: [] };
  const db = openDb(fileFor(uid, 'nordea'), 'nordea');
  try {
    const accounts = (db.prepare('SELECT json FROM accounts').all() as { json: string }[]).map((r) => JSON.parse(r.json) as BankAccount);
    const transactions = (db.prepare('SELECT json FROM transactions ORDER BY date').all() as { json: string }[])
      .map((r) => JSON.parse(r.json) as Transaction);
    return { userId: uid, accounts, transactions };
  } finally { db.close(); }
}

export function saveNordeaDb(d: NordeaDb) {
  const db = openDb(fileFor(d.userId, 'nordea'), 'nordea');
  try {
    db.exec('BEGIN');
    db.prepare('DELETE FROM accounts').run();
    const a = db.prepare('INSERT INTO accounts (id, json) VALUES (?, ?)');
    for (const acc of d.accounts) a.run(acc.id, JSON.stringify(acc));
    db.prepare('DELETE FROM transactions').run();
    const t = db.prepare('INSERT INTO transactions (id, date, category, amount, account, description, json) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const tx of d.transactions) t.run(tx.id, tx.date, tx.category, tx.amount, tx.account, tx.description ?? null, JSON.stringify(tx));
    db.exec('COMMIT');
  } finally { db.close(); }
}

// ---------- Message bus (shared transport, not a knowledge store) ----------

const emptyBus = (): Bus => ({ messages: [], airlock: [] });

export function loadBus(uid: string): Bus {
  migrateLegacy(uid, 'bus');
  if (!fs.existsSync(fileFor(uid, 'bus'))) return emptyBus();
  const db = openDb(fileFor(uid, 'bus'), 'bus');
  try {
    const messages = (db.prepare('SELECT * FROM messages ORDER BY at').all() as Record<string, string>[])
      .map((r) => ({
        id: r.id, at: r.at, from: r.frm as AgentId, to: r.tto as AgentMessage['to'],
        type: r.type as MessageType, summary: r.summary,
        ...(r.payload ? { payload: JSON.parse(r.payload) } : {}),
        status: r.status as AgentMessage['status'],
      }));
    const airlock = (db.prepare('SELECT * FROM airlock ORDER BY at').all() as Record<string, string>[])
      .map((r) => ({
        id: r.id, at: r.at, source: r.source, items: JSON.parse(r.items) as AirlockItem[],
        status: r.status as AirlockBatch['status'],
        ...(r.decided_at ? { decidedAt: r.decided_at } : {}),
      }));
    return { messages, airlock };
  } finally { db.close(); }
}

export function saveBus(uid: string, b: Bus) {
  const db = openDb(fileFor(uid, 'bus'), 'bus');
  try {
    db.exec('BEGIN');
    db.prepare('DELETE FROM messages').run();
    const m = db.prepare('INSERT INTO messages (id, at, frm, tto, type, summary, payload, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const msg of b.messages) m.run(msg.id, msg.at, msg.from, msg.to, msg.type, msg.summary, msg.payload ? JSON.stringify(msg.payload) : null, msg.status);
    db.prepare('DELETE FROM airlock').run();
    const a = db.prepare('INSERT INTO airlock (id, at, source, items, status, decided_at) VALUES (?, ?, ?, ?, ?, ?)');
    for (const item of b.airlock) a.run(item.id, item.at, item.source, JSON.stringify(item.items), item.status, item.decidedAt ?? null);
    db.exec('COMMIT');
  } finally { db.close(); }
}

// ---------- Lifecycle ----------

/** Delete one database, and only that one (including any unmigrated legacy JSON copy). */
export function deleteDb(uid: string, which: 'user' | 'cm' | 'nordea') {
  for (const f of [fileFor(uid, which), legacyFileFor(uid, which), `${legacyFileFor(uid, which)}.migrated`]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

/** One-time import of a legacy JSON store into its SQLite database. */
function migrateLegacy(uid: string, kind: DbKind) {
  const dbFile = fileFor(uid, kind);
  const jsonFile = legacyFileFor(uid, kind);
  if (fs.existsSync(dbFile) || !fs.existsSync(jsonFile)) return;
  try {
    const data = JSON.parse(fs.readFileSync(jsonFile, 'utf-8'));
    if (kind === 'user') saveUserDb({ ...emptyUser(uid), ...data });
    else if (kind === 'cm') saveCmDb({ ...emptyCm(uid), ...data });
    else if (kind === 'nordea') saveNordeaDb(data);
    else saveBus(uid, { ...emptyBus(), ...data });
    fs.renameSync(jsonFile, `${jsonFile}.migrated`);
  } catch {
    // A corrupt legacy file must not block the demo: start the SQLite DB empty instead.
  }
}

export function postMessage(bus: Bus, m: Omit<AgentMessage, 'id' | 'at' | 'status'> & { status?: AgentMessage['status'] }): AgentMessage {
  const msg: AgentMessage = { id: newId('msg'), at: now(), status: 'read', ...m };
  bus.messages.push(msg);
  return msg;
}
export { now, fileFor };
