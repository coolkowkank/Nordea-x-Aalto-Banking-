import { db } from '../db.js';
import {
  AgentId, ArchEntry, Bus, CmDb, Goal, NordeaDb, UserDb,
  loadUserDb, saveUserDb, loadCmDb, saveCmDb, loadNordeaDb, saveNordeaDb, nordeaFileExists,
  loadBus, saveBus, deleteDb, postMessage, newId, now,
} from './store.js';

/**
 * The three agents. Each one opens only its own database file (see store.ts);
 * anything crossing a boundary is an explicit message on the bus.
 */

export class ArchError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const requireAgentOn = (u: UserDb, a: AgentId) => {
  if (u.agentsOff.includes(a)) throw new ArchError(409, `${a} agent is off. Turn it on first.`);
};

const personalLabel = (u: UserDb) => (u.personalAgent.mode === 'external' ? u.personalAgent.externalName || 'External personal agent' : 'Abel');

/**
 * The agreed answer guardrail: a reply may only contain numbers that came from the
 * retrieved facts themselves. Anything else is rejected and falls back to plain wording.
 */
export function groundNumbers(reply: string, factSources: string[]): { reply: string; grounded: boolean } {
  const allowed = new Set(factSources.flatMap((s) => s.match(/\d[\d\s.,]*\d|\d/g) ?? []).map((n) => n.replace(/[\s.,]/g, '')));
  const used = (reply.match(/\d[\d\s.,]*\d|\d/g) ?? []).map((n) => n.replace(/[\s.,]/g, ''));
  const bad = used.filter((n) => !allowed.has(n));
  if (!bad.length) return { reply, grounded: true };
  return { reply: 'I have some related context, but I cannot verify those figures against your data, so I would rather not quote numbers. Ask me about your goals or shared context in general terms and I will answer from what is stored.', grounded: false };
}

/** Nordea DB starts as a one-time copy of the customer's bank data the app already holds. */
function ensureNordeaDb(uid: string): NordeaDb {
  const existing = loadNordeaDb(uid);
  if (existing) return existing;
  const fresh: NordeaDb = {
    userId: uid,
    accounts: db.getBankAccounts(uid).map((a) => ({ ...a })),
    transactions: db.getTransactions(uid).map((t) => ({ ...t })),
  };
  saveNordeaDb(fresh);
  return fresh;
}

// ---------- Direct input to the personal agent (NEVER through the sync airlock) ----------

export function addGoalDirect(uid: string, title: string, detail = ''): Goal {
  const u = loadUserDb(uid);
  requireAgentOn(u, 'personal');
  const goal: Goal = { id: newId('goal'), title: title.trim(), detail: detail.trim(), createdAt: now() };
  u.goals.push(goal);
  saveUserDb(u);
  const bus = loadBus(uid);
  postMessage(bus, { from: 'personal', to: 'user', type: 'inform', summary: `${personalLabel(u)} saved goal "${goal.title}" in the User DB. No sync airlock - direct input is yours.` });
  saveBus(uid, bus);
  return goal;
}

// ---------- Personal agent chat (Abel in-app, or the connected external agent) ----------

const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'what', 'from', 'your', 'you', 'have', 'about', 'are', 'was', 'were', 'will', 'would', 'should', 'could', 'all', 'any', 'how', 'when', 'where', 'why', 'who']);
const words = (s: string) => s.toLowerCase().split(/[^a-z0-9€]+/).filter((w) => w.length >= 3 && !STOPWORDS.has(w));
const overlaps = (a: string[], b: string[]) => a.some((w) => b.includes(w));

// Goal words also map to transaction categories ("save" -> savings transfers, "car" -> transport).
const CATEGORY_HINTS: Record<string, string[]> = {
  save: ['savings_transfer', 'savings_transfer_in'], saving: ['savings_transfer', 'savings_transfer_in'], savings: ['savings_transfer', 'savings_transfer_in'],
  car: ['transport'], commute: ['transport'], travel: ['transport'],
  house: ['housing'], flat: ['housing'], apartment: ['housing'], rent: ['housing'], home: ['housing'],
};

export function chat(uid: string, text: string): { reply: string; used: string[] } {
  const u = loadUserDb(uid);
  requireAgentOn(u, 'personal');
  const trimmed = text.trim();
  const goalMatch = trimmed.match(/^(?:my goal is|goal:|add goal)\s+(.+)/i);
  if (goalMatch) {
    const g = addGoalDirect(uid, goalMatch[1]);
    return { reply: `Saved "${g.title}" as a goal in your User DB. Direct input goes straight in - the sync airlock only gates things your connected personal agent pulls in from WhatsApp, calendar, notes or email.`, used: ['user-db'] };
  }

  const q = words(trimmed);
  const used: string[] = [];
  const parts: string[] = [];
  const factSources: string[] = [];

  // 1. The personal agent's own store.
  const goalHits = u.goals.filter((g) => overlaps(q, words(`${g.title} ${g.detail}`)));
  const factHits = u.personalFacts.filter((f) => overlaps(q, words(f.text)));
  if (goalHits.length || factHits.length) {
    used.push('user-db');
    for (const g of goalHits) { parts.push(`Goal: ${g.title}${g.detail ? ` (${g.detail})` : ''}.`); factSources.push(`${g.title} ${g.detail}`); }
    for (const f of factHits.slice(0, 3)) { parts.push(`From your ${f.source}: ${f.text}`); factSources.push(f.text); }
  }

  // 2. Shared context: the personal agent must ASK the CM agent - an explicit message pair.
  const bus = loadBus(uid);
  const cm = loadCmDb(uid);
  const entryHits = cm.entries.filter((e) => e.status === 'active' && overlaps(q, words(`${e.title} ${e.detail}`)));
  if (entryHits.length || goalHits.length) {
    const query = postMessage(bus, { from: 'personal', to: 'cm', type: 'query', summary: `${personalLabel(u)} asks the Context Memory agent for cabinet entries about: ${trimmed.slice(0, 80)}` });
    const replyPayload = entryHits.map((e) => e.id);
    postMessage(bus, { from: 'cm', to: 'personal', type: 'reply', summary: `Context Memory agent returns ${entryHits.length} cabinet entr${entryHits.length === 1 ? 'y' : 'ies'}.`, payload: { inReplyTo: query.id, entryIds: replyPayload }, status: 'answered' });
    if (entryHits.length) {
      used.push('context-memory-db');
      for (const e of entryHits.slice(0, 3)) { parts.push(`Shared context (via the Context Memory agent): ${e.title} - ${e.detail}`); factSources.push(`${e.title} ${e.detail} ${e.evidence?.total ?? ''}`); }
    }
  }
  saveBus(uid, bus);

  // 3. Guardrail: the personal agent never touches the Nordea DB.
  const bankish = ['balance', 'account', 'spent', 'spend', 'transaction', 'salary', 'money', 'save', 'saving'].some((w) => trimmed.toLowerCase().includes(w));
  if (!parts.length) {
    if (bankish) return { reply: `I don't have your bank data - as your personal agent I only read your User DB and shared context the Context Memory agent hands me. Nordea's agent can propose goal-related insights to the cabinet for your review.`, used };
    return { reply: `I don't have enough context to answer that yet. All I have is what's in your User DB (${u.goals.length} goal${u.goals.length === 1 ? '' : 's'}) and ${cm.entries.length} shared cabinet entr${cm.entries.length === 1 ? 'y' : 'ies'}.`, used };
  }
  if (bankish && !used.includes('context-memory-db')) parts.push(`For actual account figures, Nordea's agent works from the Nordea DB - I can't read it directly.`);
  const grounded = groundNumbers(parts.join(' '), factSources);
  return { reply: grounded.reply, used };
}

// ---------- Agent-to-agent queries over the message bus (transport for the demo client) ----------

/**
 * One agent asks another a question; the answering agent reads ONLY its own database and
 * replies on the bus. This is the transport the separate personal-agent client process uses:
 * the server never composes the client's final answer - it only relays these messages.
 */
export function agentQuery(uid: string, to: 'cm' | 'nordea', question: string): { reply: Record<string, unknown>; messageId: string } {
  const u = loadUserDb(uid);
  requireAgentOn(u, 'personal');
  requireAgentOn(u, to);
  const q = words(question);
  const bus = loadBus(uid);
  const query = postMessage(bus, { from: 'personal', to, type: 'query', summary: `${personalLabel(u)} asks the ${to === 'cm' ? 'Context Memory' : 'Nordea'} agent: ${question.slice(0, 80)}` });

  let replyPayload: Record<string, unknown>;
  if (to === 'cm') {
    const cm = loadCmDb(uid);
    const hits = cm.entries
      .filter((e) => overlaps(q, words(`${e.title} ${e.detail}`)))
      .map((e) => ({ id: e.id, title: e.title, detail: e.detail, status: e.status, evidence: e.evidence ?? null }));
    replyPayload = { from: 'cm-db', matchedEntries: hits };
    postMessage(bus, { from: 'cm', to: 'personal', type: 'reply', summary: `Context Memory agent returns ${hits.length} entr${hits.length === 1 ? 'y' : 'ies'} from the Context Memory DB.`, payload: { inReplyTo: query.id, ...replyPayload }, status: 'answered' });
  } else {
    const nordea = ensureNordeaDb(uid);
    const hinted = new Set(q.flatMap((w) => CATEGORY_HINTS[w] ?? []));
    const matches = nordea.transactions.filter((t) =>
      hinted.has(t.category) || overlaps(q, words(`${t.category} ${t.description ?? ''}`)));
    const total = Math.round(matches.reduce((s2, t) => s2 + Math.abs(t.amount), 0) * 100) / 100;
    const categories = [...new Set(matches.map((t) => t.category))];
    replyPayload = {
      from: 'nordea-db',
      matchCount: matches.length,
      totalAbsEur: total,
      categories,
      sample: matches.slice(0, 3).map((t) => ({ date: t.date, category: t.category, amount: t.amount, description: t.description ?? null })),
    };
    postMessage(bus, { from: 'nordea', to: 'personal', type: 'reply', summary: `Nordea agent returns an aggregate over ${matches.length} transaction${matches.length === 1 ? '' : 's'} from the Nordea DB (no account identifiers).`, payload: { inReplyTo: query.id, ...replyPayload }, status: 'answered' });
  }
  saveBus(uid, bus);
  return { reply: replyPayload, messageId: query.id };
}

// ---------- Connect / disconnect the personal agent ----------

export function connectExternalAgent(uid: string, name: string) {
  const u = loadUserDb(uid);
  u.personalAgent = { mode: 'external', externalName: name.trim() || 'External agent', connectedAt: now() };
  saveUserDb(u);
  const bus = loadBus(uid);
  postMessage(bus, { from: 'personal', to: 'user', type: 'inform', summary: `${u.personalAgent.externalName} set as the personal agent (SIMULATED - no live external connection). Abel steps aside; syncs from WhatsApp/calendar/notes/email arrive via the demo endpoint and wait in the airlock for your approval.` });
  saveBus(uid, bus);
  return u.personalAgent;
}

export function disconnectPersonalAgent(uid: string) {
  const u = loadUserDb(uid);
  const was = personalLabel(u);
  u.personalAgent = { mode: 'abel' };
  saveUserDb(u);
  const bus = loadBus(uid);
  postMessage(bus, { from: 'personal', to: 'user', type: 'inform', summary: `${was} disconnected. Abel is the in-app personal agent again; nothing else was deleted.` });
  saveBus(uid, bus);
  return u.personalAgent;
}

// ---------- Sync airlock (ONLY for the connected personal agent's ingestion) ----------

export function stageSync(uid: string, source: string, items: { kind: string; text: string }[]) {
  const u = loadUserDb(uid);
  requireAgentOn(u, 'personal');
  if (u.personalAgent.mode !== 'external') throw new ArchError(409, 'No external personal agent is connected, so there is nothing to sync. Direct input to Abel never goes through the airlock.');
  if (!items.length) throw new ArchError(400, 'A sync needs at least one item.');
  const bus = loadBus(uid);
  const batch = { id: newId('air'), at: now(), source, items: items.map((i) => ({ id: newId('item'), kind: i.kind, text: i.text })), status: 'pending' as const };
  bus.airlock.push(batch);
  postMessage(bus, { from: 'personal', to: 'user', type: 'inform', summary: `${personalLabel(u)} synced ${items.length} item${items.length === 1 ? '' : 's'} from ${source}. Waiting in the airlock for your approval - nothing enters the User DB without it.` });
  saveBus(uid, bus);
  return batch;
}

export function decideAirlock(uid: string, batchId: string, approve: boolean) {
  const bus = loadBus(uid);
  const batch = bus.airlock.find((b) => b.id === batchId);
  if (!batch) throw new ArchError(404, 'No such airlock batch.');
  if (batch.status !== 'pending') throw new ArchError(409, `This batch is already ${batch.status}.`);
  batch.status = approve ? 'approved' : 'rejected';
  batch.decidedAt = now();
  if (approve) {
    const u = loadUserDb(uid);
    for (const item of batch.items) u.personalFacts.push({ id: item.id, source: batch.source, text: item.text, at: now(), viaAirlockId: batch.id });
    saveUserDb(u);
    postMessage(bus, { from: 'personal', to: 'user', type: 'inform', summary: `Airlock approved: ${batch.items.length} item${batch.items.length === 1 ? '' : 's'} from ${batch.source} added to the User DB.` });
  } else {
    postMessage(bus, { from: 'personal', to: 'user', type: 'inform', summary: `Airlock rejected: ${batch.items.length} item${batch.items.length === 1 ? '' : 's'} from ${batch.source} discarded, never stored.` });
  }
  saveBus(uid, bus);
  return batch;
}

// ---------- Goal-filtered bank contributions (Nordea agent -> CM agent, user reviews) ----------

export function contribute(uid: string) {
  const u = loadUserDb(uid);
  requireAgentOn(u, 'nordea');
  requireAgentOn(u, 'cm');
  const nordea = ensureNordeaDb(uid);
  if (!nordea.transactions.length) throw new ArchError(409, 'The Nordea DB has no transactions yet. Load bank data first (scripts/load_data.py).');
  // Boundaries stay explicit: the personal agent hands goal TITLES to the CM agent,
  // the CM agent asks the Nordea agent, and only proposals come back.
  const goals = u.goals;
  const bus = loadBus(uid);
  const cm = loadCmDb(uid);
  const share = postMessage(bus, { from: 'personal', to: 'cm', type: 'inform', summary: `${personalLabel(u)} shares ${goals.length} goal title${goals.length === 1 ? '' : 's'} with the Context Memory agent for contribution filtering.`, payload: { goals: goals.map((g) => g.title) } });
  const q = postMessage(bus, { from: 'cm', to: 'nordea', type: 'query', summary: `Context Memory agent asks the Nordea agent for transaction insights relevant to ${goals.length} goal${goals.length === 1 ? '' : 's'}.`, payload: { goals: goals.map((g) => g.title), inReplyTo: share.id } });

  const proposals: { messageId: string; title: string; detail: string; matched: number; total: number }[] = [];
  const alreadyPending = new Set(bus.messages.filter((m) => m.type === 'propose' && m.status === 'pending').map((m) => m.summary));
  for (const goal of goals) {
    const gw = words(`${goal.title} ${goal.detail}`);
    const hinted = new Set(gw.flatMap((w) => CATEGORY_HINTS[w] ?? []));
    const matches = nordea.transactions.filter((t) =>
      overlaps(gw, words(`${t.description ?? ''} ${t.counterparty ?? ''}`)) || hinted.has(t.category));
    if (!matches.length) continue;
    const total = Math.round(matches.reduce((s, t) => s + Math.abs(t.amount), 0) * 100) / 100;
    const title = `Activity related to goal "${goal.title}"`;
    if (alreadyPending.has(title)) continue; // no duplicate pending proposals
    const detail = `${matches.length} transaction${matches.length === 1 ? '' : 's'} totalling ${total} EUR relate to this goal (matched on category and description keywords). Proposed by the Nordea agent from the Nordea DB only - the raw transactions stay there.`;
    const msg = postMessage(bus, {
      from: 'nordea', to: 'cm', type: 'propose', status: 'pending',
      summary: title,
      payload: { inReplyTo: q.id, goalIds: [goal.id], detail, transactionIds: matches.slice(0, 25).map((t) => t.id), total },
    });
    proposals.push({ messageId: msg.id, title, detail, matched: matches.length, total });
  }
  // Staleness: if an accepted entry's underlying facts changed, the CM agent flags it stale
  // and the Nordea agent supplies the refreshed values as a new proposal for review.
  const staleFlags: { entryId: string; title: string; was: number; nowIs: number }[] = [];
  for (const goal of goals) {
    const linked = cm.entries.filter((e) => e.status === 'active' && e.goalIds.includes(goal.id));
    if (!linked.length) continue;
    const gw = words(`${goal.title} ${goal.detail}`);
    const hinted = new Set(gw.flatMap((w) => CATEGORY_HINTS[w] ?? []));
    const matches = nordea.transactions.filter((t) =>
      overlaps(gw, words(`${t.description ?? ''} ${t.counterparty ?? ''}`)) || hinted.has(t.category));
    const total = Math.round(matches.reduce((s2, t) => s2 + Math.abs(t.amount), 0) * 100) / 100;
    for (const entry of linked) {
      const old = entry.evidence?.total;
      if (old != null && old !== total) {
        entry.status = 'stale';
        postMessage(bus, { from: 'cm', to: 'personal', type: 'flag-stale', summary: `Context Memory agent flags "${entry.title}" stale: the matched total changed from ${old} EUR to ${total} EUR.`, payload: { entryId: entry.id, was: old, now: total } });
        postMessage(bus, { from: 'personal', to: 'nordea', type: 'refresh', summary: `Personal agent asks the Nordea agent for the current values behind "${entry.title}".`, payload: { entryId: entry.id, goalIds: [goal.id] } });
        if (!bus.messages.some((m) => m.type === 'propose' && m.status === 'pending' && m.summary === entry.title)) {
          postMessage(bus, { from: 'nordea', to: 'cm', type: 'propose', status: 'pending',
            summary: entry.title,
            payload: { goalIds: [goal.id], detail: `${matches.length} transactions totalling ${total} EUR relate to this goal (refreshed after the earlier values went stale). Proposed by the Nordea agent from the Nordea DB only.`, transactionIds: matches.slice(0, 25).map((t) => t.id), total, refreshOf: entry.id } });
        }
        staleFlags.push({ entryId: entry.id, title: entry.title, was: old, nowIs: total });
      }
    }
  }
  if (staleFlags.length) saveCmDb(cm);
  postMessage(bus, { from: 'nordea', to: 'cm', type: 'reply', summary: `Nordea agent proposes ${proposals.length} goal-relevant cabinet entr${proposals.length === 1 ? 'y' : 'ies'} (nothing else leaves the Nordea DB).`, payload: { inReplyTo: q.id }, status: 'answered' });
  saveBus(uid, bus);
  return { askedVia: q.id, proposals, staleFlags, skippedGoals: goals.length - proposals.length, existingCabinetEntries: cm.entries.length };
}

export function reviewQueue(uid: string) {
  const bus = loadBus(uid);
  return bus.messages.filter((m) => m.type === 'propose' && m.status === 'pending');
}

export function decideProposal(uid: string, messageId: string, accept: boolean): ArchEntry | { rejected: true } {
  const bus = loadBus(uid);
  const msg = bus.messages.find((m) => m.id === messageId && m.type === 'propose');
  if (!msg) throw new ArchError(404, 'No such proposal.');
  if (msg.status !== 'pending') throw new ArchError(409, `This proposal is already ${msg.status}.`);
  msg.status = accept ? 'accepted' : 'rejected';
  if (!accept) {
    postMessage(bus, { from: 'cm', to: 'nordea', type: 'inform', summary: `You rejected the proposal "${msg.summary}". The Context Memory DB was not changed.` });
    saveBus(uid, bus);
    return { rejected: true };
  }
  const cm = loadCmDb(uid);
  const p = (msg.payload ?? {}) as { goalIds?: string[]; detail?: string; transactionIds?: string[]; total?: number };
  const entry: ArchEntry = {
    id: newId('entry'),
    title: msg.summary,
    detail: p.detail ?? '',
    goalIds: p.goalIds ?? [],
    proposedBy: 'nordea',
    viaMessageId: msg.id,
    evidence: { transactionIds: p.transactionIds, total: p.total },
    status: 'active',
    createdAt: now(),
  };
  cm.entries.push(entry); // only the CM agent writes the Context Memory DB
  saveCmDb(cm);
  postMessage(bus, { from: 'cm', to: 'user', type: 'inform', summary: `Context Memory agent added "${entry.title}" to the cabinet after your approval.` });
  saveBus(uid, bus);
  return entry;
}

// ---------- Explain / dispute ----------

export function explainEntry(uid: string, entryId: string) {
  const cm = loadCmDb(uid);
  const entry = cm.entries.find((e) => e.id === entryId);
  if (!entry) throw new ArchError(404, 'No such cabinet entry.');
  const bus = loadBus(uid);
  const via = entry.viaMessageId ? bus.messages.find((m) => m.id === entry.viaMessageId) : undefined;
  const u = loadUserDb(uid);
  const goals = entry.goalIds.map((id) => u.goals.find((g) => g.id === id)?.title).filter(Boolean);
  return {
    entry,
    explanation: {
      who: entry.proposedBy === 'nordea' ? 'Proposed by the Nordea agent from the Nordea DB' : entry.proposedBy === 'user' ? 'Added by you directly' : `Proposed by the ${entry.proposedBy} agent`,
      when: entry.createdAt,
      why: goals.length ? `Matched your goal${goals.length === 1 ? '' : 's'}: ${goals.join(', ')}` : 'No goal link recorded',
      reviewedBy: via ? `You accepted it in merge review (message ${via.id}, ${via.at})` : 'No review message recorded',
      evidence: entry.evidence ?? null,
      status: entry.status,
      disputeReason: entry.disputeReason ?? null,
    },
  };
}

export function disputeEntry(uid: string, entryId: string, reason: string) {
  const cm = loadCmDb(uid);
  const entry = cm.entries.find((e) => e.id === entryId);
  if (!entry) throw new ArchError(404, 'No such cabinet entry.');
  entry.status = 'disputed';
  entry.disputeReason = reason.trim();
  saveCmDb(cm);
  const bus = loadBus(uid);
  postMessage(bus, { from: 'cm', to: 'user', type: 'inform', summary: `You disputed "${entry.title}": ${entry.disputeReason}. It stays visible, marked disputed, until you resolve or delete it.` });
  saveBus(uid, bus);
  return entry;
}

// ---------- Separate controls: off, disconnect, delete ----------

export function setAgentOff(uid: string, agent: AgentId, off: boolean) {
  const u = loadUserDb(uid);
  u.agentsOff = off ? [...new Set([...u.agentsOff, agent])] : u.agentsOff.filter((a) => a !== agent);
  saveUserDb(u);
  const bus = loadBus(uid);
  postMessage(bus, { from: agent, to: 'user', type: 'inform', summary: `${agent} agent turned ${off ? 'off' : 'on'}. Its database was not touched.` });
  saveBus(uid, bus);
  return u.agentsOff;
}

export function deleteDatabase(uid: string, which: 'user' | 'cm' | 'nordea') {
  deleteDb(uid, which);
  const bus = loadBus(uid);
  postMessage(bus, { from: which === 'user' ? 'personal' : which, to: 'user', type: 'inform', summary: `The ${which === 'cm' ? 'Context Memory' : which === 'user' ? 'User' : 'Nordea'} DB was deleted on your request. Other databases and message history were not touched.` });
  saveBus(uid, bus);
}

// ---------- Overview ----------

export function archState(uid: string) {
  const u = loadUserDb(uid);
  const cm = loadCmDb(uid);
  const bus = loadBus(uid);
  const nordea = nordeaFileExists(uid) ? loadNordeaDb(uid) : null;
  return {
    userId: uid,
    agents: {
      personal: { mode: u.personalAgent.mode, name: personalLabel(u), simulated: u.personalAgent.mode === 'external', off: u.agentsOff.includes('personal') },
      cm: { off: u.agentsOff.includes('cm') },
      nordea: { off: u.agentsOff.includes('nordea') },
    },
    databases: {
      user: { goals: u.goals.length, personalFacts: u.personalFacts.length, profile: !!u.profileName },
      contextMemory: { entries: cm.entries.length, disputed: cm.entries.filter((e) => e.status === 'disputed').length },
      nordea: nordea ? { accounts: nordea.accounts.length, transactions: nordea.transactions.length } : null,
    },
    queues: {
      airlock: bus.airlock.filter((b) => b.status === 'pending'),
      review: bus.messages.filter((m) => m.type === 'propose' && m.status === 'pending'),
    },
    messages: bus.messages.slice(-40).reverse(),
  };
}
