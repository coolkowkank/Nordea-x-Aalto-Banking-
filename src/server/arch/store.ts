import fs from 'fs';
import path from 'path';
import type { BankAccount, Transaction } from '../../types.js';

/**
 * The three-database architecture, kept physically separate on purpose:
 * one JSON file per database per customer, next to (never inside) the app's own data.
 * An agent only ever opens its own file; everything between agents is an explicit message.
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
export interface PersonalAgentSettings { mode: 'abel' | 'external'; externalName?: string; connectedAt?: string; }
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
  status: 'active' | 'disputed';
  disputeReason?: string;
  createdAt: string;
}
export interface CmDb { userId: string; entries: ArchEntry[]; }
export interface NordeaDb { userId: string; accounts: BankAccount[]; transactions: Transaction[]; }

export type MessageType = 'propose' | 'query' | 'reply' | 'inform';
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

function fileFor(uid: string, db: 'user' | 'cm' | 'nordea' | 'bus') {
  const safe = uid.replace(/[^a-z0-9_-]/gi, '_');
  return path.join(ARCH_DIR, `${safe}.${db}.json`);
}
function read<T>(file: string, fallback: () => T): T {
  try {
    if (!fs.existsSync(file)) return fallback();
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return fallback();
  }
}
function write(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

const emptyUser = (userId: string): UserDb => ({ userId, goals: [], personalFacts: [], personalAgent: { mode: 'abel' }, agentsOff: [] });
const emptyCm = (userId: string): CmDb => ({ userId, entries: [] });
const emptyBus = (): Bus => ({ messages: [], airlock: [] });

export const loadUserDb = (uid: string): UserDb => read(fileFor(uid, 'user'), () => emptyUser(uid));
export const saveUserDb = (d: UserDb) => write(fileFor(d.userId, 'user'), d);
export const loadCmDb = (uid: string): CmDb => read(fileFor(uid, 'cm'), () => emptyCm(uid));
export const saveCmDb = (d: CmDb) => write(fileFor(d.userId, 'cm'), d);
export const loadBus = (uid: string): Bus => read(fileFor(uid, 'bus'), emptyBus);
export const saveBus = (uid: string, b: Bus) => write(fileFor(uid, 'bus'), b);
export const nordeaFileExists = (uid: string) => fs.existsSync(fileFor(uid, 'nordea'));
export const loadNordeaDb = (uid: string): NordeaDb | null =>
  nordeaFileExists(uid) ? read(fileFor(uid, 'nordea'), () => ({ userId: uid, accounts: [], transactions: [] })) : null;
export const saveNordeaDb = (d: NordeaDb) => write(fileFor(d.userId, 'nordea'), d);

/** Delete one database, and only that one. */
export function deleteDb(uid: string, which: 'user' | 'cm' | 'nordea') {
  const f = fileFor(uid, which);
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

export function postMessage(bus: Bus, m: Omit<AgentMessage, 'id' | 'at' | 'status'> & { status?: AgentMessage['status'] }): AgentMessage {
  const msg: AgentMessage = { id: newId('msg'), at: now(), status: 'read', ...m };
  bus.messages.push(msg);
  return msg;
}
export { now, fileFor };
