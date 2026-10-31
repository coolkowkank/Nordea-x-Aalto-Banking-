/**
 * The orchestration layer: composes the three agents for the HTTP API. This is the app
 * server, NOT an agent - it never does an agent's retrieval for it. It opens rounds and
 * control messages, runs the dispatcher, reads reply payloads, and renders the customer's
 * own dashboard. Agents talk to each other only through bus messages.
 */
import { ArchError } from './types.js';
import type { AgentId, ArchEntry, BuildRound } from './types.js';
import { dispatchPending } from './dispatcher.js';
import { runRound } from './rounds.js';
import {
  beginChat, finishChat, postAgentQuery, readAgentReply, personalLabel,
} from './agents/personal.js';
import { PARKED_WORDING, publishParkState } from './agents/cm.js';
import './agents/nordea.js'; // side effect: registers the Nordea agent's bus handler
import { loadUserDb, saveUserDb, deleteUserDb } from './store/userStore.js';
import { loadCmDb, deleteCmDb } from './store/cmStore.js';
import { loadNordeaDb, nordeaFileExists, deleteNordeaDb } from './store/nordeaStore.js';
import { deleteContext, loadContext, renderContextMd } from './store/contextStore.js';
import {
  appendMessage, findMessage, getAgentsOff, setAgentsOff, loadBus,
} from './store/busStore.js';

// ---------- Coordination state (bus kv), with one-time migration from the legacy User DB field ----------

function getOff(uid: string): AgentId[] {
  const off = getAgentsOff(uid);
  if (off !== undefined) return off;
  const legacy = loadUserDb(uid).agentsOff ?? [];
  setAgentsOff(uid, legacy); // seed the coordination key; legacy field cleared below
  if (legacy.length) {
    const u = loadUserDb(uid);
    u.agentsOff = [];
    saveUserDb(u);
  }
  return legacy;
}

const requireAgentOn = (uid: string, a: AgentId) => {
  if (getOff(uid).includes(a)) throw new ArchError(409, `${a} agent is off. Turn it on first.`);
};

// ---------- Personal agent chat (Abel in-app, or the connected external agent) ----------

export function chat(uid: string, text: string): { reply: string; used: string[] } {
  const begin = beginChat(uid, text);
  if (begin.kind === 'direct') return begin.direct!;
  dispatchPending(uid, { maxDeliver: 10 }); // the CM agent itself answers the query now
  return finishChat(uid, begin);
}

// ---------- Agent-to-agent queries over the message bus (transport for the demo client) ----------

export function agentQuery(uid: string, to: 'cm' | 'nordea', question: string): { reply: Record<string, unknown>; messageId: string } {
  requireAgentOn(uid, 'personal');
  requireAgentOn(uid, to);
  const query = postAgentQuery(uid, to, question);
  dispatchPending(uid, { maxDeliver: 10 });
  const reply = readAgentReply(uid, query.id);
  if (to === 'cm' && (reply as { parked?: boolean }).parked) throw new ArchError(409, PARKED_WORDING);
  return { reply, messageId: query.id };
}

// ---------- Goal-filtered bank contributions as a build round (AC6) ----------

export function contribute(uid: string) {
  requireAgentOn(uid, 'nordea');
  requireAgentOn(uid, 'cm');
  // The agents report their own state by control message; the app never opens their DBs (F12).
  const cmStatus = controlRoundTrip(uid, 'cm', 'Context Memory agent status before a contribution round.', { control: 'status' }) as { parked?: boolean; entries?: number };
  if (cmStatus.parked) throw new ArchError(409, PARKED_WORDING); // the CM agent's own answer gates the round
  const counts = controlRoundTrip(uid, 'nordea', 'Prepare the Nordea DB for a contribution round.', { control: 'prepare' }) as { transactions?: number };
  if (!counts.transactions) throw new ArchError(409, 'The Nordea DB has no transactions yet. Load bank data first (scripts/load_data.py).');
  let goalCount: number | null = null;
  if (!getOff(uid).includes('personal')) {
    const pStatus = controlRoundTrip(uid, 'personal', 'Personal agent status before a contribution round.', { control: 'status' }) as { goals?: number };
    goalCount = pStatus.goals ?? null;
  }
  const round = runRound(uid, 'contribution');
  return {
    askedVia: round.id,
    proposals: round.proposals,
    staleFlags: round.staleFlags,
    skippedGoals: goalCount === null ? 0 : Math.max(0, goalCount - round.proposals.length),
    existingCabinetEntries: cmStatus.entries ?? 0,
    round: { id: round.id, state: round.state, steps: round.steps, maxSteps: round.maxSteps },
  };
}

export function reviewQueue(uid: string) {
  return loadBus(uid).messages.filter((m) => m.type === 'propose' && m.status === 'pending');
}

/** Send a control message to an agent, dispatch, and return its reply payload. */
function controlRoundTrip(uid: string, to: AgentId, summary: string, payload: Record<string, unknown>): Record<string, unknown> {
  const msg = appendMessage(uid, { from: 'app', to, type: 'control', status: 'pending', summary, payload });
  dispatchPending(uid, { maxDeliver: 10 });
  const reply = readControlReply(uid, msg.id);
  const err = reply as { error?: string; statusCode?: number };
  if (err.error) throw new ArchError(err.statusCode ?? 409, err.error);
  return reply;
}

function readControlReply(uid: string, controlMessageId: string): Record<string, unknown> {
  const reply = loadBus(uid).messages.find((m) => m.type === 'reply' && (m.payload as { inReplyTo?: string } | undefined)?.inReplyTo === controlMessageId);
  return (reply?.payload ?? {}) as Record<string, unknown>;
}

export function decideProposal(uid: string, messageId: string, accept: boolean): ArchEntry | { rejected: true } {
  const msg = findMessage(uid, messageId);
  if (!msg || msg.type !== 'propose') throw new ArchError(404, 'No such proposal.');
  if (msg.status !== 'pending') throw new ArchError(409, `This proposal is already ${msg.status}.`);
  const reply = controlRoundTrip(uid, 'cm', `Review decision on proposal ${messageId}.`, { control: 'review-decision', messageId, accept });
  if ((reply as { rejected?: boolean }).rejected) return { rejected: true };
  return (reply as { entry: ArchEntry }).entry;
}

// ---------- Explain / dispute ----------

export function explainEntry(uid: string, entryId: string) {
  const reply = controlRoundTrip(uid, 'cm', `Explain entry ${entryId}.`, { control: 'explain', entryId });
  const { entry, via } = reply as { entry: ArchEntry; via: { id: string; at: string } | null };
  // Goal titles come from the personal agent by message - the CM agent stores goal ids only.
  const q = appendMessage(uid, {
    from: 'app', to: 'personal', type: 'query', status: 'pending',
    summary: `The app asks the personal agent for the titles of ${entry.goalIds.length} goal${entry.goalIds.length === 1 ? '' : 's'} linked to "${entry.title}".`,
    payload: { purpose: 'explain-titles', goalIds: entry.goalIds },
  });
  dispatchPending(uid, { maxDeliver: 10 });
  const titlesReply = readControlReply(uid, q.id) as { goals?: { id: string; title: string }[] };
  const goals = (titlesReply.goals ?? []).map((g) => g.title);
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
  const reply = controlRoundTrip(uid, 'cm', `Dispute entry ${entryId}.`, { control: 'dispute', entryId, reason });
  return (reply as { entry: ArchEntry }).entry;
}

// ---------- Cabinet park (distinct from off, disconnect and delete) ----------

export function parkCabinet(uid: string, park: boolean) {
  const reply = controlRoundTrip(uid, 'cm', park ? 'Park the cabinet.' : 'Reconnect the cabinet.', { control: park ? 'park' : 'resume' });
  // Imports that arrived while parked updated the Nordea DB without detection: re-check now,
  // before the cabinet serves again (same guards as the original resume re-check).
  let staleFlags: BuildRound['staleFlags'] = [];
  if (!park) staleFlags = recheckBeforeReuse(uid);
  return { parked: park, entries: (reply as { entries?: number }).entries ?? 0, staleFlags };
}

/**
 * Re-check before reuse, with the original guards: only when both agents are on, the cabinet
 * is open, goals exist and an accepted entry could be stale. The Nordea agent refreshes its
 * own DB from core bank data first, then a decay round runs.
 */
function recheckBeforeReuse(uid: string): BuildRound['staleFlags'] {
  const off = getOff(uid);
  if (off.includes('cm') || off.includes('nordea') || off.includes('personal')) return [];
  // Same guards as before, but each agent reports its own state by control message (F12).
  const cmStatus = controlRoundTrip(uid, 'cm', 'Context Memory agent status before a decay re-check.', { control: 'status' }) as { parked?: boolean; hasActiveEntry?: boolean };
  if (cmStatus.parked || !cmStatus.hasActiveEntry) return [];
  const pStatus = controlRoundTrip(uid, 'personal', 'Personal agent status before a decay re-check.', { control: 'status' }) as { goals?: number };
  if (!pStatus.goals) return [];
  refreshNordeaFromCore(uid);
  return runRound(uid, 'decay').staleFlags;
}

/** Ask the Nordea agent to refresh its own DB from the bank's core data. */
function refreshNordeaFromCore(uid: string, inform?: string) {
  controlRoundTrip(uid, 'nordea', 'Refresh the Nordea DB from core bank data.', { control: 'refresh-from-core', ...(inform ? { inform } : {}) });
}

// ---------- Bank import: the source owner updates its DB, then decay detection runs ----------

export function applyBankImportToArch(uid: string): { updated: boolean; reason?: string; staleFlags: BuildRound['staleFlags'] } {
  if (!nordeaFileExists(uid)) return { updated: false, reason: 'the three-database architecture is not in use for this customer', staleFlags: [] };
  if (getOff(uid).includes('nordea')) return { updated: false, reason: 'the Nordea agent is off', staleFlags: [] };
  refreshNordeaFromCore(uid, 'Nordea agent updated the Nordea DB from the new bank import ({n} transactions, {m}) and re-checked accepted cabinet entries.');
  let staleFlags: BuildRound['staleFlags'] = [];
  if (!getOff(uid).includes('cm') && !getOff(uid).includes('personal')) {
    const cmStatus = controlRoundTrip(uid, 'cm', 'Context Memory agent status before a decay re-check.', { control: 'status' }) as { parked?: boolean };
    if (!cmStatus.parked) staleFlags = runRound(uid, 'decay').staleFlags;
  }
  return { updated: true, staleFlags };
}

// ---------- Separate controls: off, disconnect, delete ----------

export function setAgentOff(uid: string, agent: AgentId, off: boolean) {
  const current = getOff(uid);
  const next = off ? [...new Set([...current, agent])] : current.filter((a) => a !== agent);
  setAgentsOff(uid, next);
  appendMessage(uid, { from: agent, to: 'user', type: 'inform', summary: `${agent} agent turned ${off ? 'off' : 'on'}. Its database was not touched.` });
  // While the Nordea agent is off, imports do not touch its DB at all; while the CM agent is
  // off, imports update the Nordea DB without detection. Re-check before either serves again.
  if (!off && (agent === 'cm' || agent === 'nordea')) recheckBeforeReuse(uid);
  return next;
}

export function deleteDatabase(uid: string, which: 'user' | 'cm' | 'nordea') {
  if (which === 'user') deleteUserDb(uid);
  else if (which === 'cm') deleteCmDb(uid);
  else deleteNordeaDb(uid);
  // The shared context.md is derived from all three databases; with one wiped it is stale,
  // so the document is deleted too and rebuilt by the next build round.
  deleteContext(uid);
  appendMessage(uid, { from: which === 'user' ? 'personal' : which, to: 'user', type: 'inform', summary: `The ${which === 'cm' ? 'Context Memory' : which === 'user' ? 'User' : 'Nordea'} DB was deleted on your request. Other databases and message history were not touched.` });
}

// ---------- Overview (the customer's own dashboard - the app layer, not an agent) ----------

export function listEntries(uid: string) {
  return loadCmDb(uid);
}

export function archState(uid: string) {
  const off = getOff(uid);
  const u = loadUserDb(uid);
  const cm = loadCmDb(uid);
  const bus = loadBus(uid);
  const nordea = nordeaFileExists(uid) ? loadNordeaDb(uid) : null;
  return {
    userId: uid,
    agents: {
      personal: { mode: u.personalAgent.mode, name: personalLabel(u), simulated: u.personalAgent.mode === 'external', off: off.includes('personal') },
      cm: { off: off.includes('cm') },
      nordea: { off: off.includes('nordea') },
    },
    databases: {
      user: { goals: u.goals.length, personalFacts: u.personalFacts.length, profile: !!u.profileName },
      contextMemory: { entries: cm.entries.length, disputed: cm.entries.filter((e) => e.status === 'disputed').length, parked: !!cm.parked },
      nordea: nordea ? { accounts: nordea.accounts.length, transactions: nordea.transactions.length } : null,
    },
    contextMd: (() => { const d = loadContext(uid); return d ? renderContextMd(uid, d) : null; })(),
    queues: {
      airlock: bus.airlock.filter((b) => b.status === 'pending'),
      review: bus.messages.filter((m) => m.type === 'propose' && m.status === 'pending'),
    },
    messages: bus.messages.slice(-40).reverse(),
  };
}

// Re-export the personal agent's customer-facing API so callers have one entry point.
export {
  addGoalDirect, connectExternalAgent, disconnectPersonalAgent, stageSync, decideAirlock, groundNumbers,
} from './agents/personal.js';
export { publishParkState };
export { ArchError } from './types.js';
export { runRound } from './rounds.js';
