import fs from 'fs';
import path from 'path';
import {
  User,
  CabinetEntry,
  Transaction,
  ChatMessage,
  AccessLogEntry,
  TopicLogEntry,
  UndoRecord,
  Conversation,
  Earning,
  Share,
  StoredDocument,
  EntryEvent,
  DataReward,
  BalanceSnapshot,
  ImportBatch,
  BankAccount,
  PersonaId,
  ViewMode,
} from '../types.js';
import { Remote, Row, supabaseConfigured, supabaseRemote, cleanErr } from './store.js';
// G1: customer data lives in the three agent databases (User / Context Memory / Nordea).
// The app layer may import the store modules (see the store file headers); agents never
// import this module, and no agent module imports another agent's store.
import { listCustomers, unregisterCustomer, deleteDbFile, ARCH_DIR, hydrateAgentStores } from './arch/store/common.js';
import { loadBus } from './arch/store/busStore.js';
import { appWrites, decideProposal } from './arch/orchestrator.js';
import {
  loadUserDb, loadProfile, saveProfile, putGoal, removeGoal,
  loadDocuments, putDocument, removeStoredDocument, deleteUserDb,
} from './arch/store/userStore.js';
import type { UserProfile } from './arch/store/userStore.js';
import {
  loadCmDb, putEntry, removeEntry, addHistoryEvent, loadHistory, deleteHistoryFor, listUndoRecords,
  loadShares, putShare, putUndoRecord, getUndoRecord as cmGetUndo, removeUndoRecord as cmRemoveUndo, deleteCmDb,
} from './arch/store/cmStore.js';
import {
  loadNordeaDb, nordeaFileExists, saveNordeaDb, loadBalances, saveBalances,
  putTransactions, putBankAccount, loadBalanceSnapshots, putBalanceSnapshot,
  loadImportBatches, putImportBatch, deleteNordeaDb,
} from './arch/store/nordeaStore.js';
import { deleteContext } from './arch/store/contextStore.js';
import type { ArchEntry, Goal } from './arch/types.js';

const DATA_DIR = process.env.CABINET_DATA_DIR ? path.resolve(process.env.CABINET_DATA_DIR) : path.resolve(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'cabinet-db.json');

export interface DatabaseState {
  users: Record<string, User>;
  cabinetEntries: CabinetEntry[];
  transactions: Transaction[];
  messages: ChatMessage[];
  accessLog: AccessLogEntry[];
  topicLog: TopicLogEntry[];
  undoRecords: UndoRecord[];
  conversations: Conversation[];
  earnings: Earning[];
  shares: Share[];
  documents: StoredDocument[];
  entryHistory: EntryEvent[];
  dataRewards: DataReward[];
  balanceSnapshots: BalanceSnapshot[];
  importBatches: ImportBatch[];
  bankAccounts: BankAccount[];
}

/** Points and reward redemptions: app plumbing, kept in the old store (V1: rewards stay). */
interface RewardState {
  points: number;
  pointsSpent?: number;
  redeemed?: { rewardId: string; title: string; pts: number; at: string }[];
}

/** What the old store still holds: chat transcripts, access log, rewards. Nothing about the customer. */
interface PlumbState {
  messages: ChatMessage[];
  accessLog: AccessLogEntry[];
  topicLog: TopicLogEntry[];
  conversations: Conversation[];
  earnings: Earning[];
  dataRewards: DataReward[];
  rewards: Record<string, RewardState>;
}

/** Record kinds that moved into the three agent databases (used to detect legacy data). */
const CUSTOMER_KINDS = ['cabinetEntries', 'transactions', 'undoRecords', 'shares', 'documents', 'entryHistory', 'balanceSnapshots', 'importBatches', 'bankAccounts'] as const;

/** Plumbing lists synced to the old store, and how to restore their order from unordered rows. */
const PLUMBING_LISTS = ['messages', 'accessLog', 'topicLog', 'conversations', 'earnings', 'dataRewards'] as const;
type PlumbingList = (typeof PLUMBING_LISTS)[number];
const ORDER: Record<PlumbingList, { field: string; desc?: boolean }> = {
  messages: { field: 'createdAt' },
  accessLog: { field: 'timestamp', desc: true },
  topicLog: { field: 'timestamp', desc: true },
  conversations: { field: 'createdAt' },
  earnings: { field: 'createdAt' },
  dataRewards: { field: 'at' },
};

/** Who changed something in What Abel knows, and where. Recorded in the entry's history. */
export interface ChangeMeta {
  by?: EntryEvent['by'];
  how?: string;
  action?: EntryEvent['action'];
}

/** The fields whose changes are worth showing in an entry's history. */
const TRACKED: (keyof CabinetEntry)[] = ['title', 'detail', 'status', 'private', 'target', 'readableBy', 'reviewed'];
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
let seq = 0;
const eventId = () => `ev-${Date.now()}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** History for entries that existed before history was kept (the seed, or an older saved database). */
function historyFor(entries: CabinetEntry[]): EntryEvent[] {
  const out: EntryEvent[] = [];
  for (const e of entries) {
    out.push({ id: `ev-seed-${e.id}-a`, entryId: e.id, userId: e.userId, at: e.createdAt, action: 'added', by: e.source === 'nordea' ? 'nordea' : 'you', how: e.source === 'nordea' ? 'Noticed in your transactions' : e.source === 'document' ? 'From a document' : 'In the app', title: e.title });
    if (e.confirmedAt && e.confirmedAt !== e.createdAt) out.push({ id: `ev-seed-${e.id}-c`, entryId: e.id, userId: e.userId, at: e.confirmedAt, action: 'confirmed', by: 'you', how: 'You said it’s still right', title: e.title });
  }
  return out;
}

/** Each kind of record the legacy store knew, and how it's keyed (migration only). */
const LEGACY_LISTS = ['cabinetEntries', 'transactions', 'messages', 'accessLog', 'topicLog', 'undoRecords', 'conversations', 'earnings', 'shares', 'documents', 'entryHistory', 'dataRewards', 'balanceSnapshots', 'importBatches', 'bankAccounts'] as const;
type LegacyList = (typeof LEGACY_LISTS)[number];
const LEGACY_ORDER: Record<LegacyList, { field: string; desc?: boolean }> = {
  cabinetEntries: { field: 'createdAt' },
  transactions: { field: 'date' },
  messages: { field: 'createdAt' },
  accessLog: { field: 'timestamp', desc: true },
  topicLog: { field: 'timestamp', desc: true },
  undoRecords: { field: 'timestamp' },
  conversations: { field: 'createdAt' },
  earnings: { field: 'createdAt' },
  shares: { field: 'createdAt' },
  documents: { field: 'createdAt' },
  entryHistory: { field: 'at' },
  dataRewards: { field: 'at' },
  balanceSnapshots: { field: 'at' },
  importBatches: { field: 'at' },
  bankAccounts: { field: 'id' },
};

function getEmptyLegacyState(): DatabaseState {
  return {
    users: {}, cabinetEntries: [], transactions: [], messages: [], accessLog: [], topicLog: [],
    undoRecords: [], conversations: [], earnings: [], shares: [], documents: [], entryHistory: [],
    dataRewards: [], balanceSnapshots: [], importBatches: [], bankAccounts: [],
  };
}

function legacyFromRows(rows: Row[]): DatabaseState {
  const st: any = getEmptyLegacyState();
  for (const r of rows) {
    if (r.kind === 'users') st.users[r.id] = r.data;
    else if ((LEGACY_LISTS as readonly string[]).includes(r.kind)) st[r.kind].push(r.data);
  }
  for (const k of LEGACY_LISTS) {
    const { field, desc } = LEGACY_ORDER[k];
    st[k].sort((a: any, b: any) => String(a[field] || '').localeCompare(String(b[field] || '')) * (desc ? -1 : 1));
  }
  return st as DatabaseState;
}

/**
 * Fills in what loaded legacy data may leave out (migration only): history for entries that
 * predate history, and explicit account records derived from the customer record.
 */
function migrateLegacyState(state: DatabaseState): DatabaseState {
  const empty = getEmptyLegacyState();
  for (const k of Object.keys(empty) as (keyof DatabaseState)[]) (state as any)[k] = state[k] || empty[k];
  const known = new Set(state.entryHistory.map((h) => h.entryId));
  state.entryHistory.push(...historyFor(state.cabinetEntries.filter((e) => !known.has(e.id))));
  for (const u of Object.values(state.users || {})) {
    for (const key of ['current', 'savings', 'carFund'] as const) {
      const a = (u.accounts as any)?.[key];
      if (!a) continue;
      const id = `acc-${u.id}-${key}`;
      const existing = state.bankAccounts.find((x) => x.id === id);
      if (existing) { if (a.iban && !existing.iban) existing.iban = a.iban; }
      else state.bankAccounts.push({ id, userId: u.id, key, iban: a.iban || undefined });
    }
  }
  return state;
}

// ---------- Mapping between the Abel CabinetEntry record and the arch store rows ----------
// Each field has ONE authoritative home: arch-owned fields (title, detail, status, evidence,
// goalIds, proposedBy...) live in the store columns; Abel-owned fields (type, source, private,
// readableBy, provenance, target, why, reviewed, goalType, confirmedAt, updatedAt) live in the
// row's `doc` JSON. The two views are merged on read, split on write.

const goalToEntry = (userId: string, g: Goal): CabinetEntry =>
  g.doc
    ? { ...g.doc, id: g.id, userId, type: 'goal', title: g.title, detail: g.detail, createdAt: g.createdAt }
    : {
        id: g.id, userId, type: 'goal', title: g.title, detail: g.detail, source: 'customer',
        status: 'active', private: false, readableBy: { abel: true, offers: true }, provenance: { channel: 'app' },
        reviewed: true, createdAt: g.createdAt, updatedAt: g.createdAt,
      };

const entryToGoal = (e: CabinetEntry): Goal => ({ id: e.id, title: e.title, detail: e.detail, createdAt: e.createdAt, doc: e });

const cmToEntry = (userId: string, e: ArchEntry): CabinetEntry => {
  const doc = e.doc;
  return {
    id: e.id, userId,
    type: doc?.type ?? (e.proposedBy === 'nordea' ? 'observation' : 'fact'),
    title: e.title,
    detail: e.detail,
    source: doc?.source ?? (e.proposedBy === 'nordea' ? 'nordea' : 'customer'),
    status: e.status,
    private: doc?.private ?? false,
    readableBy: doc?.readableBy ?? { abel: true, offers: true },
    provenance: doc?.provenance ?? { channel: 'system' },
    ...(doc?.target ? { target: doc.target } : {}),
    ...(doc?.linked ? { linked: doc.linked } : {}),
    ...(doc?.why ? { why: doc.why } : {}),
    ...(e.evidence || doc?.evidence
      ? { evidence: doc?.evidence ?? { transactionIds: e.evidence?.transactionIds, inputsHash: e.evidence?.transactionIdsHash, computedAt: e.createdAt } }
      : {}),
    reviewed: doc?.reviewed ?? true,
    ...(doc?.goalType ? { goalType: doc.goalType } : {}),
    ...(doc?.confirmedAt ? { confirmedAt: doc.confirmedAt } : {}),
    createdAt: e.createdAt,
    updatedAt: doc?.updatedAt ?? e.createdAt,
  };
};

const entryToCm = (e: CabinetEntry, existing?: ArchEntry): ArchEntry => ({
  id: e.id,
  title: e.title,
  detail: e.detail,
  goalIds: existing?.goalIds ?? [],
  proposedBy: existing?.proposedBy ?? (e.source === 'nordea' ? 'nordea' : 'user'),
  ...(existing?.viaMessageId ? { viaMessageId: existing.viaMessageId } : {}),
  ...(existing?.evidence
    ? { evidence: existing.evidence }
    : e.evidence
      ? { evidence: { transactionIds: e.evidence.transactionIds, transactionIdsHash: e.evidence.inputsHash } }
      : {}),
  status: e.status,
  ...(existing?.disputeReason ? { disputeReason: existing.disputeReason } : {}),
  ...(existing?.observed ? { observed: existing.observed } : {}),
  ...(existing?.risk ? { risk: existing.risk } : {}),
  ...(existing?.autoAccepted ? { autoAccepted: true } : {}),
  createdAt: existing?.createdAt ?? e.createdAt,
  doc: e,
});

export interface DbStatus {
  mode: 'supabase' | 'file' | 'memory';
  ok: boolean;
  message: string;
  lastSavedAt?: string;
  lastError?: { at: string; message: string };
  rows?: number;
  waiting: number;
}

function getEmptyPlumb(): PlumbState {
  return { messages: [], accessLog: [], topicLog: [], conversations: [], earnings: [], dataRewards: [], rewards: {} };
}

class Database {
  private state: PlumbState;
  private remote: Remote | null = null;
  /** What Supabase has, as JSON per record, so only changed records are sent. */
  private synced = new Map<string, string>();
  private chain: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private st: DbStatus = { mode: 'file', ok: true, message: 'Saved on this server only. It resets when the app restarts.', waiting: 0 };
  /** Supabase is set up but couldn't be reached: keep changes in memory only, so no stale local copy appears. */
  private memoryOnly = false;

  // Nothing is preloaded: the app starts with no data until init() reads what was loaded on purpose.
  constructor() {
    this.state = getEmptyPlumb();
  }

  /**
   * G1: move legacy customer data (the old store's users / cabinet / bank records) into the
   * three agent databases. Idempotent enough for the demo: store writes are upserts, and the
   * legacy rows are removed from the old store afterwards, so this runs once per dataset.
   */
  // Bulk migration writes the stores directly - same class as scripts/load_data.py (G5):
  // loading existing approved data, not app behavior. Runtime writes go through the agents (G2).
  private splitLegacyIntoStores(legacy: DatabaseState) {
    const st = migrateLegacyState(legacy);
    const uids = new Set<string>([
      ...Object.keys(st.users),
      ...st.cabinetEntries.map((e) => e.userId),
      ...st.transactions.map((t) => t.userId),
      ...st.documents.map((d) => d.userId),
      ...st.shares.map((s) => s.userId),
      ...st.undoRecords.map((u) => u.userId),
      ...st.entryHistory.map((h) => h.userId),
      ...st.balanceSnapshots.map((b) => b.userId),
      ...st.importBatches.map((b) => b.userId),
      ...st.bankAccounts.map((b) => b.userId),
    ]);
    for (const uid of uids) {
      const u = st.users[uid];
      if (u) {
        const { points, pointsSpent, redeemed, accounts, id: _id, ...profile } = u;
        saveProfile(uid, profile as UserProfile);
        if (accounts) saveBalances(uid, accounts);
        this.state.rewards[uid] = { points: points ?? 0, ...(pointsSpent !== undefined ? { pointsSpent } : {}), ...(redeemed ? { redeemed } : {}) };
      }
      for (const e of st.cabinetEntries.filter((x) => x.userId === uid)) {
        if (e.type === 'goal') putGoal(uid, entryToGoal(e));
        else putEntry(uid, entryToCm(e));
      }
      for (const h of st.entryHistory.filter((x) => x.userId === uid)) addHistoryEvent(uid, h);
      for (const s of st.shares.filter((x) => x.userId === uid)) putShare(uid, s);
      for (const r of st.undoRecords.filter((x) => x.userId === uid)) putUndoRecord(uid, r);
      for (const d of st.documents.filter((x) => x.userId === uid)) putDocument(d);
      const txs = st.transactions.filter((x) => x.userId === uid);
      if (txs.length) putTransactions(uid, txs);
      for (const a of st.bankAccounts.filter((x) => x.userId === uid)) putBankAccount(uid, a);
      for (const b of st.balanceSnapshots.filter((x) => x.userId === uid)) putBalanceSnapshot(uid, b);
      for (const b of st.importBatches.filter((x) => x.userId === uid)) putImportBatch(uid, b);
    }
  }

  /** Take in a loaded old-style state (file or Supabase rows): migrate customer data, keep plumbing. */
  private adoptLoaded(loaded: Partial<DatabaseState> & { rewards?: Record<string, RewardState> }) {
    const hasLegacy =
      Object.keys(loaded.users ?? {}).length > 0 ||
      CUSTOMER_KINDS.some((k) => ((loaded as DatabaseState)[k] ?? []).length > 0);
    if (hasLegacy) this.splitLegacyIntoStores({ ...getEmptyLegacyState(), ...loaded } as DatabaseState);
    this.state = {
      messages: loaded.messages ?? [],
      accessLog: loaded.accessLog ?? [],
      topicLog: loaded.topicLog ?? [],
      conversations: loaded.conversations ?? [],
      earnings: loaded.earnings ?? [],
      dataRewards: loaded.dataRewards ?? [],
      rewards: { ...(loaded.rewards ?? {}), ...this.state.rewards },
    };
    // The local file must not keep a second copy of the customer's data: strip it now.
    if (hasLegacy && !this.remote) this.writeFile();
  }

  /**
   * Read the data. Called once before the server starts (and by reload()).
   * With Supabase set up, only Supabase counts (for the plumbing it still holds).
   * Customer data comes from the three agent databases, or is migrated there once from
   * legacy rows. Load data with scripts/load_data.py.
   */
  public async init() {
    this.synced.clear();
    this.state = getEmptyPlumb();
    // G6: when the three agent stores have hosted secrets, their tables are the source of
    // truth - pull them into the local SQLite files before anything reads them.
    const hydrated = await hydrateAgentStores();
    if (hydrated.length) console.log(`Database: agent stores hydrated from hosted tables: ${hydrated.join(', ')}`);
    if (!supabaseConfigured()) {
      this.adoptLoaded(this.loadFile());
      console.log(`Database: local file (${listCustomers().length} customers in the three databases)`);
      return;
    }
    const remote = supabaseRemote();
    try {
      const rows = await remote.loadAll();
      this.remote = remote;
      this.memoryOnly = false;
      const customerRows = rows.filter((r) => r.kind === 'users' || (CUSTOMER_KINDS as readonly string[]).includes(r.kind));
      const plumbingRows = rows.filter((r) => !customerRows.includes(r));
      const loaded: Partial<DatabaseState> & { rewards: Record<string, RewardState> } = { ...getEmptyLegacyState(), rewards: {} };
      for (const r of plumbingRows) {
        if (r.kind === 'rewards') loaded.rewards![r.id] = r.data as RewardState;
        else if ((PLUMBING_LISTS as readonly string[]).includes(r.kind)) (loaded as any)[r.kind].push(r.data);
      }
      for (const k of PLUMBING_LISTS) {
        const { field, desc } = ORDER[k];
        (loaded as any)[k].sort((a: any, b: any) => String(a[field] || '').localeCompare(String(b[field] || '')) * (desc ? -1 : 1));
      }
      if (customerRows.length) this.splitLegacyIntoStores(migrateLegacyState(legacyFromRows(customerRows)));
      this.state = { ...this.state, ...{
        messages: loaded.messages!, accessLog: loaded.accessLog!, topicLog: loaded.topicLog!,
        conversations: loaded.conversations!, earnings: loaded.earnings!, dataRewards: loaded.dataRewards!,
        rewards: { ...loaded.rewards, ...this.state.rewards },
      } };
      rows.forEach((r) => this.synced.set(`${r.kind}:${r.id}`, JSON.stringify(r.data)));
      await this.flush();
      this.st = { ...this.st, mode: 'supabase', ok: !this.st.lastError, message: rows.length ? 'Saved in Supabase' : 'Supabase is empty. Load data with scripts/load_data.py.', rows: this.synced.size };
      console.log(`Database: Supabase (${this.synced.size} records)`);
    } catch (err) {
      this.remote = null;
      this.memoryOnly = true;
      this.state = getEmptyPlumb();
      const message = cleanErr(err);
      this.st = { mode: 'memory', ok: false, message: `Supabase isn’t working, so the app has no data and changes are kept in memory only. ${message}`, lastError: { at: new Date().toISOString(), message }, waiting: 0 };
      console.error('Database: Supabase failed, starting with no data.', message);
    }
  }

  /** Read the data again, e.g. after scripts/load_data.py added rows while the app was running. */
  public async reload(): Promise<DatabaseState> {
    await this.chain;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    await this.init();
    return this.getState();
  }

  public hasData() {
    return listCustomers().length > 0 || Object.keys(this.state.rewards).length > 0;
  }

  public status(): DbStatus {
    return { ...this.st, waiting: this.remote ? this.pendingCount() : 0 };
  }

  private toRows(): Row[] {
    const rows: Row[] = Object.entries(this.state.rewards).map(([uid, r]) => ({ kind: 'rewards', id: uid, user_id: uid, data: r }));
    for (const kind of PLUMBING_LISTS) for (const x of this.state[kind] as any[]) rows.push({ kind, id: x.id, user_id: x.userId ?? null, data: x });
    return rows;
  }

  private pendingCount() {
    let n = 0;
    const now = new Map(this.toRows().map((r) => [`${r.kind}:${r.id}`, JSON.stringify(r.data)]));
    for (const [k, v] of now) if (this.synced.get(k) !== v) n++;
    for (const k of this.synced.keys()) if (!now.has(k)) n++;
    return n;
  }

  /** Send every changed record to Supabase. Requests that change data wait for this before answering. */
  public flush(): Promise<void> {
    if (!this.remote) return Promise.resolve();
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.chain = this.chain.then(() => this.push()).catch(() => {});
    return this.chain;
  }

  private async push() {
    const remote = this.remote;
    if (!remote) return;
    const now = new Map<string, Row>();
    this.toRows().forEach((r) => now.set(`${r.kind}:${r.id}`, r));
    const changed: Row[] = [];
    const json = new Map<string, string>();
    for (const [k, r] of now) {
      const j = JSON.stringify(r.data);
      json.set(k, j);
      if (this.synced.get(k) !== j) changed.push(r);
    }
    const gone = [...this.synced.keys()].filter((k) => !now.has(k)).map((k) => ({ kind: k.slice(0, k.indexOf(':')), id: k.slice(k.indexOf(':') + 1) }));
    if (!changed.length && !gone.length) return;
    try {
      if (changed.length) await remote.upsert(changed.map((r) => ({ ...r, data: JSON.parse(json.get(`${r.kind}:${r.id}`)!) })));
      if (gone.length) await remote.remove(gone);
      changed.forEach((r) => this.synced.set(`${r.kind}:${r.id}`, json.get(`${r.kind}:${r.id}`)!));
      gone.forEach((g) => this.synced.delete(`${g.kind}:${g.id}`));
      this.st = { ...this.st, ok: true, message: 'Saved in Supabase', lastSavedAt: new Date().toISOString(), rows: this.synced.size };
    } catch (err) {
      const message = cleanErr(err);
      this.st = { ...this.st, ok: false, message: `Last save to Supabase failed. Trying again. ${message}`, lastError: { at: new Date().toISOString(), message } };
      console.error('Database: save to Supabase failed:', message);
      this.later(5000); // try again shortly; nothing is lost while the server runs
    }
  }

  private later(ms = 300) {
    if (!this.remote || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, ms);
  }

  private ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  }

  private loadFile(): Partial<DatabaseState> & { rewards?: Record<string, RewardState> } {
    if (!fs.existsSync(DB_FILE)) return {};
    try {
      return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
    } catch (err) {
      console.warn('Could not read the local data file. Starting with no data.', err);
      return {};
    }
  }

  private writeFile() {
    try {
      this.ensureDataDir();
      fs.writeFileSync(DB_FILE, JSON.stringify(this.state, null, 2), 'utf-8');
    } catch (err) {
      console.error('Failed to write db state to disk:', err);
    }
  }

  /** Every plumbing change ends here: queue the Supabase save, or write the local file when there's no Supabase. */
  private saveState() {
    if (this.remote) this.later();
    else if (!this.memoryOnly) this.writeFile();
  }

  /** The full composed view: customer data read back from the three agent databases. */
  public getState(): DatabaseState {
    const uids = [...new Set([...listCustomers(), ...Object.keys(this.state.rewards)])];
    const users: Record<string, User> = {};
    for (const uid of uids) {
      const u = this.getUser(uid);
      if (u) users[uid] = u;
    }
    return {
      users,
      cabinetEntries: uids.flatMap((uid) => this.getCabinetEntries(uid)),
      transactions: uids.flatMap((uid) => this.getTransactions(uid)),
      messages: this.state.messages,
      accessLog: this.state.accessLog,
      topicLog: this.state.topicLog,
      undoRecords: uids.flatMap((uid) => listUndoRecords(uid)),
      conversations: this.state.conversations,
      earnings: this.state.earnings,
      shares: uids.flatMap((uid) => loadShares(uid)),
      documents: uids.flatMap((uid) => loadDocuments(uid)),
      entryHistory: uids.flatMap((uid) => loadHistory(uid)),
      dataRewards: this.state.dataRewards,
      balanceSnapshots: uids.flatMap((uid) => loadBalanceSnapshots(uid)),
      importBatches: uids.flatMap((uid) => loadImportBatches(uid)),
      bankAccounts: uids.flatMap((uid) => this.getBankAccounts(uid)),
    };
  }

  /** Delete all data, including rows loaded into Supabase that this app never read. */
  public async clearAll(): Promise<DatabaseState> {
    await this.chain;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.state = getEmptyPlumb();
    fs.rmSync(ARCH_DIR, { recursive: true, force: true });
    if (this.remote) {
      await this.remote.removeAll();
      this.synced.clear();
      this.st = { ...this.st, ok: true, message: 'Supabase is empty. Load data with scripts/load_data.py.', rows: 0 };
    } else this.saveState();
    return this.getState();
  }

  // ---------- Users: profile + settings in the User DB, balances in the Nordea DB, rewards here ----------

  public getUser(userId: string): User | undefined {
    const profile = loadProfile(userId);
    const balances = loadBalances(userId);
    const rewards = this.state.rewards[userId];
    if (!profile && !balances && !rewards) return undefined;
    return {
      id: userId,
      persona: (profile?.persona ?? 'lauri') as PersonaId,
      name: profile?.name ?? userId,
      age: profile?.age ?? 0,
      roleDescription: profile?.roleDescription ?? '',
      viewMode: (profile?.viewMode ?? 'full') as ViewMode,
      layoutPrefs: profile?.layoutPrefs ?? { widgetsOrder: [], hiddenWidgets: [] },
      accounts: balances ?? { current: { iban: '', balance: 0 }, savings: { iban: '', balance: 0, monthlyDeposit: 0 } },
      points: rewards?.points ?? 0,
      ...(rewards?.pointsSpent !== undefined ? { pointsSpent: rewards.pointsSpent } : {}),
      ...(rewards?.redeemed ? { redeemed: rewards.redeemed } : {}),
      ...(profile?.offersOff !== undefined ? { offersOff: profile.offersOff } : {}),
      ...(profile?.extraMonthly !== undefined ? { extraMonthly: profile.extraMonthly } : {}),
      ...(profile?.nordeaData ? { nordeaData: profile.nordeaData } : {}),
    };
  }

  public updateUser(userId: string, updates: Partial<User>): User | undefined {
    const user = this.getUser(userId);
    if (!user) return undefined;
    const { points, pointsSpent, redeemed, accounts, ...profileUpdates } = updates;
    if (points !== undefined || pointsSpent !== undefined || redeemed !== undefined) {
      const r = this.state.rewards[userId] ?? { points: 0 };
      if (points !== undefined) r.points = points;
      if (pointsSpent !== undefined) r.pointsSpent = pointsSpent;
      if (redeemed !== undefined) r.redeemed = redeemed;
      this.state.rewards[userId] = r;
    }
    if (accounts !== undefined) appWrites.putBalances(userId, accounts);
    if (Object.keys(profileUpdates).length) appWrites.putProfile(userId, { ...(loadProfile(userId) ?? {}), ...profileUpdates });
    this.saveState();
    return this.getUser(userId);
  }

  // ---------- Cabinet: goals in the User DB, everything else in the Context Memory DB ----------

  public getCabinetEntries(userId: string): CabinetEntry[] {
    const goals = loadUserDb(userId).goals.map((g) => goalToEntry(userId, g));
    const cm = loadCmDb(userId).entries.map((e) => cmToEntry(userId, e));
    return [...goals, ...cm].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  public getCabinetEntry(id: string): CabinetEntry | undefined {
    for (const uid of listCustomers()) {
      const g = loadUserDb(uid).goals.find((x) => x.id === id);
      if (g) return goalToEntry(uid, g);
      const e = loadCmDb(uid).entries.find((x) => x.id === id);
      if (e) return cmToEntry(uid, e);
    }
    return undefined;
  }

  // ---- history of each entry (Context Memory DB)
  private logEvent(e: CabinetEntry, action: EntryEvent['action'], meta: ChangeMeta = {}, changes?: EntryEvent['changes']) {
    appWrites.logHistory(e.userId, {
      id: eventId(), entryId: e.id, userId: e.userId, at: new Date().toISOString(), action: meta.action || action,
      by: meta.by || (e.source === 'nordea' ? 'nordea' : 'you'), how: meta.how, title: e.title, changes: changes?.length ? changes : undefined,
    });
  }

  public getEntryHistory(entryId: string): EntryEvent[] {
    for (const uid of listCustomers()) {
      const h = loadHistory(uid, entryId);
      if (h.length) return h;
    }
    return [];
  }

  public addCabinetEntry(entry: CabinetEntry, meta: ChangeMeta = {}): CabinetEntry {
    if (entry.type === 'goal') appWrites.putGoal(entry.userId, entryToGoal(entry));
    else appWrites.putEntry(entry.userId, entryToCm(entry));
    this.logEvent(entry, 'added', meta);
    return entry;
  }

  /** G10: a write still waiting in the CM review queue, as the CabinetEntry it carries.
   *  Lets app flows (e.g. observation-confirmed) find it; the actual consent decision
   *  still goes through decideProposal in updateCabinetEntry. */
  public getQueuedCabinetEntry(id: string): CabinetEntry | undefined {
    for (const uid of listCustomers()) {
      const pending = loadBus(uid).messages.find((m) => m.type === 'propose' && m.status === 'pending'
        && (m.payload as { appWrite?: boolean; entry?: { id?: string; doc?: CabinetEntry } } | undefined)?.appWrite === true
        && (m.payload as { entry?: { id?: string } } | undefined)?.entry?.id === id);
      const doc = (pending?.payload as { entry?: { doc?: CabinetEntry } } | undefined)?.entry?.doc;
      if (doc) return doc;
    }
    return undefined;
  }

  public updateCabinetEntry(id: string, updates: Partial<CabinetEntry>, meta: ChangeMeta = {}): CabinetEntry | undefined {
    let before = this.getCabinetEntry(id);
    if (!before && updates.reviewed === true) {
      // G10 one consent path: the write may still wait in the CM review queue. The app's
      // confirm IS the queue decision (Bill 03:09) - accept the pending proposal for this
      // entry, then apply the rest of the update to the now-stored entry.
      for (const uid of listCustomers()) {
        const pending = loadBus(uid).messages.find((m) => m.type === 'propose' && m.status === 'pending'
          && (m.payload as { appWrite?: boolean; entry?: { id?: string } } | undefined)?.appWrite === true
          && (m.payload as { entry?: { id?: string } } | undefined)?.entry?.id === id);
        if (pending) { decideProposal(uid, pending.id, true); break; }
      }
      before = this.getCabinetEntry(id);
    }
    if (!before) return undefined;
    const after = { ...before, ...updates, updatedAt: new Date().toISOString() };
    if (before.type === 'goal') {
      appWrites.putGoal(before.userId, entryToGoal(after));
    } else {
      const existing = loadCmDb(before.userId).entries.find((x) => x.id === id);
      appWrites.putEntry(before.userId, entryToCm(after, existing));
    }
    const changes = TRACKED.filter((f) => f in updates && !same(before[f], after[f])).map((f) => ({ field: f, from: before[f] ?? null, to: after[f] ?? null }));
    const status = changes.find((c) => c.field === 'status');
    const action: EntryEvent['action'] =
      status?.to === 'archived' ? 'removed'
      : status?.to === 'disputed' ? 'marked_wrong'
      : status && (status.from === 'archived' || status.from === 'disputed') && changes.length === 1 ? 'brought_back'
      : changes.length === 1 && changes[0].field === 'reviewed' && after.reviewed ? 'confirmed'
      : 'changed';
    if (changes.length) this.logEvent(after, action, meta, changes.filter((c) => !(action === 'confirmed' && c.field === 'reviewed')));
    else if (updates.confirmedAt || meta.action) this.logEvent(after, 'confirmed', meta);
    return after;
  }

  /**
   * Delete for good. `purge` also drops the entry's history (used when the customer deletes a document
   * "and the things taken from it", or undoes an add: then nothing about it should stay).
   */
  public deleteCabinetEntry(id: string, meta: ChangeMeta & { purge?: boolean } = {}): boolean {
    const e = this.getCabinetEntry(id);
    if (!e) return false;
    if (e.type === 'goal') {
      appWrites.removeGoal(e.userId, id);
      if (meta.purge) appWrites.removeEntry(e.userId, id, true); // a goal has no CM row; purge is a no-op there
      else this.logEvent(e, 'deleted', meta);
    } else {
      appWrites.removeEntry(e.userId, id, meta.purge === true);
      if (!meta.purge) this.logEvent(e, 'deleted', meta);
    }
    return true;
  }

  // ---- kept documents ("Keep a copy"): the customer's own files, in the User DB
  public getDocuments(userId: string): StoredDocument[] {
    return loadDocuments(userId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  public getDocument(id: string): StoredDocument | undefined {
    for (const uid of listCustomers()) {
      const d = loadDocuments(uid).find((x) => x.id === id);
      if (d) return d;
    }
    return undefined;
  }

  public addDocument(d: StoredDocument): StoredDocument {
    appWrites.putDocument(d.userId, d);
    return d;
  }

  public updateDocument(id: string, updates: Partial<StoredDocument>) {
    const d = this.getDocument(id);
    if (!d) return undefined;
    const next = { ...d, ...updates };
    appWrites.putDocument(d.userId, next);
    return next;
  }

  public removeDocument(id: string) {
    const d = this.getDocument(id);
    if (!d) return undefined;
    appWrites.removeDocument(d.userId, id);
    // The chat bubble keeps the file name but loses its preview.
    for (const m of this.state.messages) if (m.attachment?.documentId === id) m.attachment = { ...m.attachment, thumb: undefined, deleted: true };
    this.saveState();
    return d;
  }

  /** A copy of a demo customer (for the answer check), so tests never change the real demo data. */
  public cloneUser(fromId: string, toId: string) {
    this.removeUser(toId);
    const u = this.getUser(fromId);
    if (!u) return false;
    const clone = JSON.parse(JSON.stringify(u)) as User;
    const { points, pointsSpent, redeemed, accounts, id: _id, ...profile } = clone;
    saveProfile(toId, profile as UserProfile);
    if (accounts) saveBalances(toId, accounts);
    this.state.rewards[toId] = { points: points ?? 0, ...(pointsSpent !== undefined ? { pointsSpent } : {}), ...(redeemed ? { redeemed } : {}) };
    for (const e of this.getCabinetEntries(fromId)) {
      const copy = JSON.parse(JSON.stringify(e)) as CabinetEntry;
      copy.id = `${toId}-${e.id}`;
      copy.userId = toId;
      if (copy.type === 'goal') putGoal(toId, entryToGoal(copy));
      else putEntry(toId, entryToCm(copy));
    }
    const txs = this.getTransactions(fromId).map((t) => ({ ...t, id: `${toId}-${t.id}`, userId: toId }));
    if (txs.length) putTransactions(toId, txs);
    this.saveState();
    return true;
  }

  /** Remove a (test) customer and everything about them. */
  public removeUser(id: string) {
    deleteUserDb(id);
    deleteCmDb(id);
    deleteNordeaDb(id);
    deleteDbFile(id, 'bus');
    deleteContext(id);
    unregisterCustomer(id);
    delete this.state.rewards[id];
    const keep = (x: { userId?: string }) => x.userId !== id;
    this.state.messages = this.state.messages.filter(keep);
    this.state.conversations = this.state.conversations.filter(keep);
    this.state.accessLog = this.state.accessLog.filter(keep);
    this.state.topicLog = this.state.topicLog.filter(keep);
    this.state.earnings = this.state.earnings.filter(keep);
    this.state.dataRewards = this.state.dataRewards.filter(keep);
    this.saveState();
  }

  /** Delete one chat: its messages and the conversation. Kept documents and what Abel knows stay. */
  public deleteConversation(userId: string, id: string) {
    const c = this.getConversation(id);
    if (!c || c.userId !== userId) return 0;
    const n = this.state.messages.filter((m) => m.conversationId === id).length;
    this.state.messages = this.state.messages.filter((m) => m.conversationId !== id);
    this.state.conversations = this.state.conversations.filter((x) => x.id !== id);
    this.saveState();
    return n;
  }

  /** "Delete my chats": every conversation and message of this customer. What Abel knows stays. */
  public deleteChats(userId: string) {
    const n = this.state.messages.filter((m) => m.userId === userId).length;
    this.state.messages = this.state.messages.filter((m) => m.userId !== userId);
    this.state.conversations = this.state.conversations.filter((c) => c.userId !== userId);
    this.state.topicLog = this.state.topicLog.filter((t) => t.userId !== userId);
    this.saveState();
    return n;
  }

  // ---------- Bank data: the Nordea DB is the one home ----------

  public getTransactions(userId: string): Transaction[] {
    return (nordeaFileExists(userId) ? loadNordeaDb(userId) : null)?.transactions ?? [];
  }

  /** New Nordea account data for a customer, snapshot mode: their transactions are replaced by these. */
  public replaceTransactions(userId: string, list: Transaction[]) {
    appWrites.putTransactions(userId, list, 'replace');
  }

  /**
   * New Nordea account data, incremental mode: merge by stable transaction id.
   * Rows whose id the customer already has are skipped (re-imports never duplicate).
   */
  public upsertTransactions(userId: string, list: Transaction[]): { added: Transaction[]; skipped: Transaction[]; updated: Transaction[] } {
    // The Nordea agent owns the merge semantics (dedupe by stable id, bank corrections) and
    // performs the write to its own DB; the adapter only relays the result.
    const reply = appWrites.putTransactions(userId, list, 'upsert') as { added: Transaction[]; skipped: Transaction[]; updated: Transaction[] };
    return { added: reply.added ?? [], skipped: reply.skipped ?? [], updated: reply.updated ?? [] };
  }

  // ---- Explicit account records: one per account, derived from the customer record, extended by feeds ----
  public getBankAccounts(userId: string): BankAccount[] {
    return loadNordeaDb(userId)?.accounts ?? [];
  }

  /** Add or enrich an account record. Only the fields supplied are set; nothing is invented. */
  public upsertBankAccount(userId: string, key: string, fields: { type?: string; iban?: string; currency?: string }): BankAccount {
    const id = `acc-${userId}-${key}`;
    const nd = loadNordeaDb(userId);
    const existing = nd?.accounts.find((x) => x.id === id);
    const a: BankAccount = { ...(existing ?? { id, userId, key }) };
    if (fields.type !== undefined) a.type = fields.type;
    if (fields.iban !== undefined) a.iban = fields.iban;
    if (fields.currency !== undefined) a.currency = fields.currency;
    appWrites.putBankAccount(userId, a);
    return a;
  }

  // ---- Balance snapshots: dated balances per account, kept across imports ----
  public getBalanceSnapshots(userId: string, accountKey?: string): BalanceSnapshot[] {
    return loadBalanceSnapshots(userId, accountKey);
  }

  public addBalanceSnapshot(x: BalanceSnapshot) {
    appWrites.putSnapshot(x.userId, x);
    return x;
  }

  // ---- Import batches: what was applied, when, and what it did ----
  public getImportBatches(userId: string): ImportBatch[] {
    return loadImportBatches(userId);
  }

  public addImportBatch(x: ImportBatch) {
    appWrites.putImportBatch(x.userId, x);
    return x;
  }

  // ---- Data rewards: points for what the customer shares and for how often it's read ----
  public getDataRewards(userId: string): DataReward[] {
    return this.state.dataRewards.filter((r) => r.userId === userId);
  }

  public addDataReward(r: DataReward) {
    this.state.dataRewards.push(r);
    this.saveState();
    return r;
  }

  public getMessages(userId: string): ChatMessage[] {
    return this.state.messages.filter((m) => m.userId === userId);
  }

  public addMessage(msg: ChatMessage): ChatMessage {
    this.state.messages.push(msg);
    this.saveState();
    return msg;
  }

  public getAccessLog(userId?: string): AccessLogEntry[] {
    if (!userId) return this.state.accessLog;
    return this.state.accessLog.filter((log) => log.userId === userId);
  }

  public addAccessLogEntry(log: AccessLogEntry): AccessLogEntry {
    this.state.accessLog.unshift(log);
    if (this.state.accessLog.length > 200) {
      this.state.accessLog.pop();
    }
    this.saveState();
    return log;
  }

  public getTopicLog(userId?: string): TopicLogEntry[] {
    if (!userId) return this.state.topicLog;
    return this.state.topicLog.filter((t) => t.userId === userId);
  }

  public addTopicLogEntry(entry: TopicLogEntry): TopicLogEntry {
    this.state.topicLog.unshift(entry);
    this.saveState();
    return entry;
  }

  // ---- Undo records: cabinet history, in the Context Memory DB ----
  public addUndoRecord(record: UndoRecord): UndoRecord {
    appWrites.putUndo(record.userId, record);
    return record;
  }

  public getUndoRecord(undoToken: string): UndoRecord | undefined {
    for (const uid of listCustomers()) {
      const r = cmGetUndo(uid, undoToken);
      if (r) return r;
    }
    return undefined;
  }

  public removeUndoRecord(undoToken: string): boolean {
    for (const uid of listCustomers()) {
      const reply = appWrites.removeUndo(uid, undoToken) as { removed?: boolean };
      if (reply.removed) return true;
    }
    return false;
  }

  // ---- v14: conversations, partner earnings, one-time shares
  public getConversations(userId: string): Conversation[] {
    return this.state.conversations.filter((c) => c.userId === userId);
  }

  public getConversation(id: string): Conversation | undefined {
    return this.state.conversations.find((c) => c.id === id);
  }

  public addConversation(c: Conversation): Conversation {
    this.state.conversations.push(c);
    this.saveState();
    return c;
  }

  public touchConversation(id: string, updates: Partial<Conversation> = {}) {
    const c = this.getConversation(id);
    if (!c) return;
    Object.assign(c, updates, { updatedAt: new Date().toISOString() });
    this.saveState();
  }

  public updateMessage(id: string, updates: Partial<ChatMessage>) {
    const m = this.state.messages.find((x) => x.id === id);
    if (!m) return undefined;
    Object.assign(m, updates);
    this.saveState();
    return m;
  }

  public getEarnings(userId: string): Earning[] {
    return this.state.earnings.filter((e) => e.userId === userId);
  }

  public addEarning(e: Earning): Earning {
    this.state.earnings.push(e);
    this.saveState();
    return e;
  }

  // ---- One-time shares: standing permissions live in the Context Memory DB ----
  public getShares(userId: string): Share[] {
    return loadShares(userId);
  }

  public addShare(x: Share): Share {
    appWrites.putShare(x.userId, x);
    return x;
  }

  public updateShare(id: string, updates: Partial<Share>) {
    for (const uid of listCustomers()) {
      const x = loadShares(uid).find((y) => y.id === id);
      if (x) {
        const next = { ...x, ...updates };
        appWrites.putShare(uid, next);
        return next;
      }
    }
    return undefined;
  }
}

export const db = new Database();
