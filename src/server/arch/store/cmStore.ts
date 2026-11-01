/**
 * The Context Memory DB store: the shared context cabinet.
 * Only the Context Memory agent module (and the app layer serving the customer) may import this.
 */
import fs from 'fs';
import { fileFor, openDb, kvGet, kvSet, deleteDbFile, migrateLegacy } from './common.js';
import type { ArchEntry, CmDb } from '../types.js';
import type { EntryEvent, Share, UndoRecord } from '../../../types.js';
import { registerCustomer, configureRemote } from './common.js';

// G6: this store reads ONLY its own hosted secret (one Postgres role per agent). Unset = local SQLite.
configureRemote('cm', process.env.CM_DB_URL);

const emptyCm = (userId: string): CmDb => ({ userId, entries: [] });

/** F5: observed/inferred provenance landed after the first schema - add the column to old DBs. */
function ensureColumn(db: ReturnType<typeof openDb>, name: string, ddl: string) {
  const cols = db.prepare('PRAGMA table_info(entries)').all() as { name: string }[];
  if (!cols.some((c) => c.name === name)) db.exec(`ALTER TABLE entries ADD COLUMN ${ddl}`);
}
function ensureColumns(db: ReturnType<typeof openDb>) {
  ensureColumn(db, 'observed', 'observed TEXT');
  ensureColumn(db, 'risk', 'risk TEXT');
  ensureColumn(db, 'auto_accepted', 'auto_accepted INTEGER');
  ensureColumn(db, 'doc', 'doc TEXT'); // G1: the full Abel CabinetEntry record, when there is one
}

export function loadCmDb(uid: string): CmDb {
  migrateLegacy(uid, 'cm', (data) => saveCmDb({ ...emptyCm(uid), ...data } as CmDb));
  if (!fs.existsSync(fileFor(uid, 'cm'))) return emptyCm(uid);
  const db = openDb(fileFor(uid, 'cm'), 'cm');
  try {
    ensureColumns(db);
    const entries = (db.prepare('SELECT * FROM entries ORDER BY created_at').all() as Record<string, string>[])
      .map((r) => ({
        id: r.id, title: r.title, detail: r.detail, goalIds: JSON.parse(r.goal_ids) as string[],
        proposedBy: r.proposed_by as ArchEntry['proposedBy'],
        ...(r.via_message_id ? { viaMessageId: r.via_message_id } : {}),
        ...(r.evidence ? { evidence: JSON.parse(r.evidence) } : {}),
        status: r.status as ArchEntry['status'],
        ...(r.dispute_reason ? { disputeReason: r.dispute_reason } : {}),
        ...(r.observed ? { observed: r.observed as ArchEntry['observed'] } : {}),
        ...(r.risk ? { risk: r.risk as ArchEntry['risk'] } : {}),
        ...(r.auto_accepted ? { autoAccepted: true } : {}),
        createdAt: r.created_at,
        ...(r.doc ? { doc: JSON.parse(r.doc) } : {}),
      }));
    const parked = kvGet(db, 'parked') === '1';
    const rawPerms = kvGet(db, 'permissions');
    const permissions = rawPerms ? (JSON.parse(rawPerms) as CmDb['permissions']) : undefined;
    return { userId: uid, entries, ...(parked ? { parked: true } : {}), ...(permissions ? { permissions } : {}) };
  } finally { db.close(); }
}

export function saveCmDb(d: CmDb) {
  registerCustomer(d.userId);
  const db = openDb(fileFor(d.userId, 'cm'), 'cm');
  try {
    ensureColumns(db);
    kvSet(db, 'parked', d.parked ? '1' : null);
    kvSet(db, 'permissions', d.permissions ? JSON.stringify(d.permissions) : null);
    db.exec('BEGIN');
    db.prepare('DELETE FROM entries').run();
    const ins = db.prepare(`INSERT INTO entries
      (id, title, detail, goal_ids, proposed_by, via_message_id, evidence, status, dispute_reason, created_at, observed, risk, auto_accepted, doc)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const e of d.entries) {
      ins.run(e.id, e.title, e.detail, JSON.stringify(e.goalIds), e.proposedBy,
        e.viaMessageId ?? null, e.evidence ? JSON.stringify(e.evidence) : null,
        e.status, e.disputeReason ?? null, e.createdAt, e.observed ?? null, e.risk ?? null, e.autoAccepted ? 1 : 0,
        e.doc ? JSON.stringify(e.doc) : null);
    }
    db.exec('COMMIT');
  } finally { db.close(); }
}

/** Structured round records the Context Memory agent stores when it finalises a build round (AC6). */
export function storeRoundRecord(uid: string, roundJson: string) {
  const round = JSON.parse(roundJson) as { id: string };
  const db = openDb(fileFor(uid, 'cm'), 'cm');
  try {
    kvSet(db, `round:${round.id}`, roundJson);
    const idx = kvGet(db, 'rounds');
    const ids = idx ? (JSON.parse(idx) as string[]) : [];
    kvSet(db, 'rounds', JSON.stringify([...ids, round.id]));
  } finally { db.close(); }
}

/** Snapshots of the finished shared context.md, stored when a round finalises (AC2/AC4). */
export function storeContextSnapshot(uid: string, roundId: string, markdown: string, rowsJson: string) {
  const db = openDb(fileFor(uid, 'cm'), 'cm');
  try {
    kvSet(db, `context:${roundId}`, JSON.stringify({ markdown, rows: JSON.parse(rowsJson) }));
    kvSet(db, 'context:latest', roundId);
  } finally { db.close(); }
}
export function loadContextSnapshot(uid: string, roundId?: string): string | null {
  const db = openDb(fileFor(uid, 'cm'), 'cm');
  try {
    const id = roundId ?? kvGet(db, 'context:latest');
    const raw = id ? kvGet(db, `context:${id}`) : undefined;
    return raw ? (JSON.parse(raw) as { markdown: string }).markdown : null;
  } finally { db.close(); }
}

export function deleteCmDb(uid: string) { deleteDbFile(uid, 'cm'); }

// ---------- G1: cabinet history, one-time shares and undo records live in the CM DB ----------

export function addHistoryEvent(uid: string, ev: EntryEvent) {
  registerCustomer(uid);
  const db = openDb(fileFor(uid, 'cm'), 'cm');
  try {
    db.prepare('INSERT INTO history (id, entry_id, at, json) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json')
      .run(ev.id, ev.entryId, ev.at, JSON.stringify(ev));
  } finally { db.close(); }
}

export function loadHistory(uid: string, entryId?: string): EntryEvent[] {
  if (!fs.existsSync(fileFor(uid, 'cm'))) return [];
  const db = openDb(fileFor(uid, 'cm'), 'cm');
  try {
    const rows = (entryId
      ? db.prepare('SELECT json FROM history WHERE entry_id = ? ORDER BY at').all(entryId)
      : db.prepare('SELECT json FROM history ORDER BY at').all()) as { json: string }[];
    return rows.map((r) => JSON.parse(r.json) as EntryEvent);
  } finally { db.close(); }
}

export function deleteHistoryFor(uid: string, entryId: string) {
  if (!fs.existsSync(fileFor(uid, 'cm'))) return;
  const db = openDb(fileFor(uid, 'cm'), 'cm');
  try { db.prepare('DELETE FROM history WHERE entry_id = ?').run(entryId); } finally { db.close(); }
}

export function loadShares(uid: string): Share[] {
  if (!fs.existsSync(fileFor(uid, 'cm'))) return [];
  const db = openDb(fileFor(uid, 'cm'), 'cm');
  try {
    return (db.prepare('SELECT json FROM shares').all() as { json: string }[]).map((r) => JSON.parse(r.json) as Share);
  } finally { db.close(); }
}

export function putShare(uid: string, share: Share) {
  registerCustomer(uid);
  const db = openDb(fileFor(uid, 'cm'), 'cm');
  try {
    db.prepare('INSERT INTO shares (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json')
      .run(share.id, JSON.stringify(share));
  } finally { db.close(); }
}

export function putUndoRecord(uid: string, rec: UndoRecord) {
  registerCustomer(uid);
  const db = openDb(fileFor(uid, 'cm'), 'cm');
  try {
    db.prepare('INSERT INTO undo (token, at, json) VALUES (?, ?, ?) ON CONFLICT(token) DO UPDATE SET json = excluded.json')
      .run(rec.undoToken, rec.timestamp, JSON.stringify(rec));
  } finally { db.close(); }
}

export function listUndoRecords(uid: string): UndoRecord[] {
  if (!fs.existsSync(fileFor(uid, 'cm'))) return [];
  const db = openDb(fileFor(uid, 'cm'), 'cm');
  try {
    return (db.prepare('SELECT json FROM undo ORDER BY at').all() as { json: string }[]).map((r) => JSON.parse(r.json) as UndoRecord);
  } finally { db.close(); }
}

export function getUndoRecord(uid: string, token: string): UndoRecord | undefined {
  if (!fs.existsSync(fileFor(uid, 'cm'))) return undefined;
  const db = openDb(fileFor(uid, 'cm'), 'cm');
  try {
    const r = db.prepare('SELECT json FROM undo WHERE token = ?').get(token) as { json: string } | undefined;
    return r ? (JSON.parse(r.json) as UndoRecord) : undefined;
  } finally { db.close(); }
}

export function removeUndoRecord(uid: string, token: string): boolean {
  if (!fs.existsSync(fileFor(uid, 'cm'))) return false;
  const db = openDb(fileFor(uid, 'cm'), 'cm');
  try {
    db.prepare('DELETE FROM undo WHERE token = ?').run(token);
    return true;
  } finally { db.close(); }
}

/** Upsert one cabinet entry row (the Abel app writes entries with their full CabinetEntry record). */
export function putEntry(uid: string, e: ArchEntry) {
  registerCustomer(uid);
  const db = openDb(fileFor(uid, 'cm'), 'cm');
  try {
    ensureColumns(db);
    db.prepare(`INSERT INTO entries
      (id, title, detail, goal_ids, proposed_by, via_message_id, evidence, status, dispute_reason, created_at, observed, risk, auto_accepted, doc)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title, detail = excluded.detail, goal_ids = excluded.goal_ids,
        via_message_id = excluded.via_message_id, evidence = excluded.evidence, status = excluded.status,
        dispute_reason = excluded.dispute_reason, observed = excluded.observed, risk = excluded.risk,
        auto_accepted = excluded.auto_accepted, doc = excluded.doc`)
      .run(e.id, e.title, e.detail, JSON.stringify(e.goalIds), e.proposedBy,
        e.viaMessageId ?? null, e.evidence ? JSON.stringify(e.evidence) : null,
        e.status, e.disputeReason ?? null, e.createdAt, e.observed ?? null, e.risk ?? null, e.autoAccepted ? 1 : 0,
        e.doc ? JSON.stringify(e.doc) : null);
  } finally { db.close(); }
}

export function removeEntry(uid: string, id: string) {
  if (!fs.existsSync(fileFor(uid, 'cm'))) return;
  const db = openDb(fileFor(uid, 'cm'), 'cm');
  try { db.prepare('DELETE FROM entries WHERE id = ?').run(id); } finally { db.close(); }
}
