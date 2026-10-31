/**
 * The shared working document (AC2): one context.md per customer. All three agents may
 * READ the whole document - it is how every agent sees the context as a whole. Each agent
 * WRITES only its own section through the dedicated writer functions below; the AC1/AC2
 * source-scan test pins which agent module may call which writer.
 *
 * Physical form: a rendered markdown file per customer next to the agent databases, plus a
 * small JSON sidecar so sections can be updated independently. Neither file is an agent
 * database: no agent keeps private state here - this is the shared document itself.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ARCH_DIR } from './common.js';
import { now } from '../types.js';

export type ContextSection = 'customer' | 'memory' | 'nordea';

export interface ContextDoc {
  roundId: string | null;
  trigger: string | null;
  openedAt: string | null;
  finalisedAt: string | null;
  sections: Record<ContextSection, string>;
}

export interface RoundMeta { roundId: string; trigger: string }

const safeUid = (uid: string) => uid.replace(/[^a-z0-9_-]/gi, '_');
const jsonPath = (uid: string) => path.join(ARCH_DIR, `${safeUid(uid)}.context.json`);
export const contextMdPath = (uid: string) => path.join(ARCH_DIR, `${safeUid(uid)}.context.md`);

const emptyDoc = (): ContextDoc => ({ roundId: null, trigger: null, openedAt: null, finalisedAt: null, sections: { customer: '', memory: '', nordea: '' } });

export function loadContext(uid: string): ContextDoc | null {
  try { return JSON.parse(fs.readFileSync(jsonPath(uid), 'utf-8')) as ContextDoc; } catch { return null; }
}

export function renderContextMd(uid: string, doc: ContextDoc): string {
  return [
    `# Context - ${uid}`,
    '',
    `<!-- build round: ${doc.roundId ?? 'none'} (${doc.trigger ?? 'n/a'}) opened ${doc.openedAt ?? 'n/a'}, finalised ${doc.finalisedAt ?? 'not yet'} -->`,
    '',
    '## Customer',
    '',
    doc.sections.customer || '_nothing shared yet_',
    '',
    '## Context memory',
    '',
    doc.sections.memory || '_nothing relevant stored yet_',
    '',
    '## Nordea',
    '',
    doc.sections.nordea || '_no bank aggregates yet_',
    '',
  ].join('\n');
}

function save(uid: string, doc: ContextDoc) {
  fs.mkdirSync(ARCH_DIR, { recursive: true });
  fs.writeFileSync(jsonPath(uid), JSON.stringify(doc, null, 2));
  fs.writeFileSync(contextMdPath(uid), renderContextMd(uid, doc));
}

function writeSection(uid: string, section: ContextSection, markdown: string, meta?: RoundMeta) {
  const doc = loadContext(uid) ?? emptyDoc();
  if (meta && doc.roundId !== meta.roundId) {
    doc.roundId = meta.roundId;
    doc.trigger = meta.trigger;
    doc.openedAt = now();
    doc.finalisedAt = null;
  }
  doc.sections[section] = markdown.trim();
  save(uid, doc);
}

/** The personal agent's section (AC3): what the customer allows Nordea to see. */
export function writeCustomerSection(uid: string, markdown: string, meta?: RoundMeta) { writeSection(uid, 'customer', markdown, meta); }
/** The Context Memory agent's section (AC4): relevant earlier context, deduped, conflicts flagged. */
export function writeMemorySection(uid: string, markdown: string, meta?: RoundMeta) { writeSection(uid, 'memory', markdown, meta); }
/** The Nordea agent's section (AC5): aggregates with evidence - no identifiers, no raw transactions. */
export function writeNordeaSection(uid: string, markdown: string, meta?: RoundMeta) { writeSection(uid, 'nordea', markdown, meta); }

/** Round metadata: the Context Memory agent stamps the document when it finalises a round. */
export function writeHeader(uid: string, meta: RoundMeta & { finalise?: boolean }) {
  const doc = loadContext(uid) ?? emptyDoc();
  doc.roundId = meta.roundId;
  doc.trigger = meta.trigger;
  if (meta.finalise) doc.finalisedAt = now();
  else { doc.openedAt = now(); doc.finalisedAt = null; }
  save(uid, doc);
}

/** Read one section - e.g. the Nordea agent reads the Customer section to find the goals (F6). */
export function readSection(uid: string, section: ContextSection): string {
  return loadContext(uid)?.sections[section] ?? '';
}
