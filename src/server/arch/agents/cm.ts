/**
 * The CONTEXT MEMORY agent. It owns the shared context cabinet and opens ONLY the
 * Context Memory DB (plus the shared bus). It retrieves entries for other agents by
 * message, finalises build rounds, keeps the cabinet coherent, and maintains memory
 * against decay by ASKING other agents - it never opens their databases.
 * Boundary pinned by the AC1 source-scan test: this module imports no other agent's store.
 */
import { newId, now } from '../types.js';
import type { AgentMessage, ArchEntry, StaleFlag } from '../types.js';
import { words, overlaps } from '../text.js';
import { loadCmDb, saveCmDb, storeRoundRecord } from '../store/cmStore.js';
import { appendMessage, findMessage, loadBus, setCabinetParkedMirror, updateMessage } from '../store/busStore.js';
import { registerHandler } from '../dispatcher.js';
import { loadRound, roundDone, recordStaleFlags } from '../rounds.js';

export const PARKED_WORDING = 'The cabinet is parked: the Context Memory agent is not reading or supplying it. Your entries are kept - nothing was deleted. Reconnect the cabinet explicitly to resume.';

interface RefreshItem { entryId: string; title: string; goalIds: string[]; goalTitles: string[]; was: number }
interface RefreshResult { entryId: string; title: string; was: number; now: number; changed: boolean; matched: number }

/** Active, evidence-carrying entries (optionally limited to goals in play). */
function decayCandidates(uid: string, goalIds?: string[]): ArchEntry[] {
  const cm = loadCmDb(uid);
  return cm.entries.filter((e) =>
    e.status === 'active' && e.evidence?.total != null &&
    (!goalIds || e.goalIds.some((g) => goalIds.includes(g))));
}

/**
 * Decay detection (AC8): the CM agent detects possible decay from stored evidence and asks
 * the Nordea agent to confirm or refresh - it cannot and does not read the Nordea DB.
 * Step one: it needs goal titles for the linked goals, so it asks the personal agent.
 */
function startDecayCheck(uid: string, roundId: string, goalIds?: string[]) {
  const candidates = decayCandidates(uid, goalIds);
  if (!candidates.length) {
    // Nothing with stored evidence: no decay work. Both participants are done.
    roundDone(uid, roundId, 'nordea');
    roundDone(uid, roundId, 'cm');
    return;
  }
  const ids = [...new Set(candidates.flatMap((e) => e.goalIds))];
  appendMessage(uid, {
    from: 'cm', to: 'personal', type: 'query', status: 'pending',
    summary: `Context Memory agent asks the personal agent for the titles of ${ids.length} goal${ids.length === 1 ? '' : 's'} linked to stored evidence.`,
    payload: { purpose: 'decay-titles', roundId, goalIds: ids },
  });
}

function handleMessage(uid: string, msg: AgentMessage) {
  const payload = (msg.payload ?? {}) as Record<string, unknown>;

  // --- A question for the cabinet (from the personal agent, in-app or external client).
  if (msg.type === 'query' && typeof payload.question === 'string') {
    const cm = loadCmDb(uid);
    if (cm.parked) {
      appendMessage(uid, {
        from: 'cm', to: msg.from, type: 'reply',
        summary: 'Context Memory agent answers: the cabinet is parked, so it supplies nothing.',
        payload: { inReplyTo: msg.id, from: 'cm-db', parked: true, matchedEntries: [] },
      });
    } else {
      const q = words(payload.question);
      const hits = cm.entries
        .filter((e) => overlaps(q, words(`${e.title} ${e.detail}`)))
        .map((e) => ({ id: e.id, title: e.title, detail: e.detail, status: e.status, evidence: e.evidence ?? null }));
      appendMessage(uid, {
        from: 'cm', to: msg.from, type: 'reply',
        summary: `Context Memory agent returns ${hits.length} entr${hits.length === 1 ? 'y' : 'ies'} from the Context Memory DB.`,
        payload: { inReplyTo: msg.id, from: 'cm-db', matchedEntries: hits },
      });
    }
    updateMessage(uid, msg.id, { status: 'answered' });
    return;
  }

  // --- Build round kickoff for decay maintenance (import / resume / turn-on triggers).
  if (msg.type === 'round-start' && payload.trigger === 'decay' && typeof payload.roundId === 'string') {
    const cm = loadCmDb(uid);
    if (cm.parked) {
      appendMessage(uid, { from: 'cm', to: 'user', type: 'inform', summary: 'Decay round skipped: the cabinet is parked.' });
      roundDone(uid, payload.roundId, 'nordea');
      roundDone(uid, payload.roundId, 'cm');
      return;
    }
    startDecayCheck(uid, payload.roundId);
    return;
  }

  // --- The personal agent shared goal titles for a contribution round.
  if (msg.type === 'inform' && typeof payload.roundId === 'string' && Array.isArray(payload.goals)) {
    const goals = payload.goals as { id: string; title: string }[];
    appendMessage(uid, {
      from: 'cm', to: 'nordea', type: 'query', status: 'pending',
      summary: `Context Memory agent asks the Nordea agent for transaction insights relevant to ${goals.length} goal${goals.length === 1 ? '' : 's'}.`,
      payload: { purpose: 'contribute', roundId: payload.roundId, goals },
    });
    return;
  }

  // --- The personal agent answered with goal titles for the decay check.
  if (msg.type === 'reply' && payload.purpose === 'decay-titles' && typeof payload.roundId === 'string') {
    const goals = (payload.goals ?? []) as { id: string; title: string }[];
    const titleById = new Map(goals.map((g) => [g.id, g.title]));
    const candidates = decayCandidates(uid);
    const items: RefreshItem[] = candidates.map((e) => ({
      entryId: e.id,
      title: e.title,
      goalIds: e.goalIds,
      goalTitles: e.goalIds.map((id) => titleById.get(id)).filter((t): t is string => !!t),
      was: e.evidence!.total!,
    }));
    appendMessage(uid, {
      from: 'cm', to: 'nordea', type: 'refresh', status: 'pending',
      summary: `Context Memory agent asks the Nordea agent to confirm or refresh the values behind ${items.length} stored entr${items.length === 1 ? 'y' : 'ies'}.`,
      payload: { purpose: 'refresh', roundId: payload.roundId, items },
    });
    return;
  }

  // --- The Nordea agent answered a contribution query: proposals are in review; now decay.
  if (msg.type === 'reply' && payload.purpose === 'contribute' && typeof payload.roundId === 'string') {
    startDecayCheck(uid, payload.roundId);
    return;
  }

  // --- The Nordea agent answered a refresh request: apply confirmed decay.
  if (msg.type === 'reply' && payload.purpose === 'refresh' && typeof payload.roundId === 'string') {
    const results = (payload.results ?? []) as RefreshResult[];
    const changed = results.filter((r) => r.changed);
    const flags: StaleFlag[] = [];
    if (changed.length) {
      const cm = loadCmDb(uid);
      for (const r of changed) {
        const entry = cm.entries.find((e) => e.id === r.entryId && e.status === 'active');
        if (!entry) continue;
        entry.status = 'stale';
        flags.push({ entryId: r.entryId, title: r.title, was: r.was, nowIs: r.now });
        appendMessage(uid, {
          from: 'cm', to: 'personal', type: 'flag-stale',
          summary: `Context Memory agent flags "${r.title}" stale: the matched total changed from ${r.was} EUR to ${r.now} EUR.`,
          payload: { entryId: r.entryId, was: r.was, now: r.now },
        });
      }
      saveCmDb(cm);
      appendMessage(uid, { from: 'cm', to: 'user', type: 'inform', summary: `Re-check before reuse: ${flags.length} accepted entr${flags.length === 1 ? 'y was' : 'ies were'} flagged stale against current bank data; refreshed figures wait in merge review.` });
    }
    recordStaleFlags(uid, payload.roundId, flags);
    roundDone(uid, payload.roundId, 'cm');
    return;
  }

  // --- Customer / app control messages.
  if (msg.type === 'control') {
    const control = payload.control as string;

    if (control === 'status') {
      const cm = loadCmDb(uid);
      appendMessage(uid, {
        from: 'cm', to: 'app', type: 'reply',
        summary: 'Context Memory agent reports its own status.',
        payload: { inReplyTo: msg.id, parked: !!cm.parked, entries: cm.entries.length, hasActiveEntry: cm.entries.some((e) => e.status === 'active') },
      });
      updateMessage(uid, msg.id, { status: 'answered' });
      return;
    }

    if (control === 'park' || control === 'resume') {
      const want = control === 'park';
      const cm = loadCmDb(uid);
      if (!!cm.parked !== want) {
        cm.parked = want || undefined;
        saveCmDb(cm);
        setCabinetParkedMirror(uid, want);
        appendMessage(uid, { from: 'cm', to: 'user', type: 'inform', summary: want
          ? `You parked the cabinet: ${cm.entries.length} entr${cm.entries.length === 1 ? 'y' : 'ies'} kept, nothing deleted. Until you reconnect it, no agent reads the cabinet and no proposals are accepted into it.`
          : 'You reconnected the cabinet. The Context Memory agent reads and supplies it again.' });
      }
      appendMessage(uid, { from: 'cm', to: 'app', type: 'reply', summary: `Cabinet ${want ? 'parked' : 'resumed'}.`, payload: { inReplyTo: msg.id, parked: want, entries: cm.entries.length } });
      updateMessage(uid, msg.id, { status: 'answered' });
      return;
    }

    if (control === 'review-decision') {
      const messageId = payload.messageId as string;
      const accept = payload.accept === true;
      const proposal = findMessage(uid, messageId);
      if (!proposal) {
        appendMessage(uid, { from: 'cm', to: 'app', type: 'reply', summary: 'No such proposal.', payload: { inReplyTo: msg.id, error: 'No such proposal.', statusCode: 404 } });
        updateMessage(uid, msg.id, { status: 'answered' });
        return;
      }
      if (!accept) {
        updateMessage(uid, messageId, { status: 'rejected' });
        appendMessage(uid, { from: 'cm', to: 'nordea', type: 'inform', summary: `You rejected the proposal "${proposal.summary}". The Context Memory DB was not changed.` });
        appendMessage(uid, { from: 'cm', to: 'app', type: 'reply', summary: 'Proposal rejected.', payload: { inReplyTo: msg.id, rejected: true } });
        updateMessage(uid, msg.id, { status: 'answered' });
        return;
      }
      const cm = loadCmDb(uid);
      if (cm.parked) {
        appendMessage(uid, { from: 'cm', to: 'app', type: 'reply', summary: PARKED_WORDING, payload: { inReplyTo: msg.id, error: PARKED_WORDING, statusCode: 409 } });
        updateMessage(uid, msg.id, { status: 'answered' });
        return;
      }
      updateMessage(uid, messageId, { status: 'accepted' });
      const p = (proposal.payload ?? {}) as { goalIds?: string[]; detail?: string; transactionIds?: string[]; total?: number };
      const entry: ArchEntry = {
        id: newId('entry'),
        title: proposal.summary,
        detail: p.detail ?? '',
        goalIds: p.goalIds ?? [],
        proposedBy: 'nordea',
        viaMessageId: proposal.id,
        evidence: { transactionIds: p.transactionIds, total: p.total },
        status: 'active',
        createdAt: now(),
      };
      cm.entries.push(entry); // only the CM agent writes the Context Memory DB
      saveCmDb(cm);
      appendMessage(uid, { from: 'cm', to: 'user', type: 'inform', summary: `Context Memory agent added "${entry.title}" to the cabinet after your approval.` });
      appendMessage(uid, { from: 'cm', to: 'app', type: 'reply', summary: 'Proposal accepted into the cabinet.', payload: { inReplyTo: msg.id, entry } });
      updateMessage(uid, msg.id, { status: 'answered' });
      return;
    }

    if (control === 'dispute') {
      const entryId = payload.entryId as string;
      const reason = String(payload.reason ?? '').trim();
      const cm = loadCmDb(uid);
      const entry = cm.entries.find((e) => e.id === entryId);
      if (!entry) {
        appendMessage(uid, { from: 'cm', to: 'app', type: 'reply', summary: 'No such cabinet entry.', payload: { inReplyTo: msg.id, error: 'No such cabinet entry.', statusCode: 404 } });
        updateMessage(uid, msg.id, { status: 'answered' });
        return;
      }
      entry.status = 'disputed';
      entry.disputeReason = reason;
      saveCmDb(cm);
      appendMessage(uid, { from: 'cm', to: 'user', type: 'inform', summary: `You disputed "${entry.title}": ${entry.disputeReason}. It stays visible, marked disputed, until you resolve or delete it.` });
      appendMessage(uid, { from: 'cm', to: 'app', type: 'reply', summary: 'Entry disputed.', payload: { inReplyTo: msg.id, entry } });
      updateMessage(uid, msg.id, { status: 'answered' });
      return;
    }

    if (control === 'explain') {
      const entryId = payload.entryId as string;
      const cm = loadCmDb(uid);
      const entry = cm.entries.find((e) => e.id === entryId);
      if (!entry) {
        appendMessage(uid, { from: 'cm', to: 'app', type: 'reply', summary: 'No such cabinet entry.', payload: { inReplyTo: msg.id, error: 'No such cabinet entry.', statusCode: 404 } });
        updateMessage(uid, msg.id, { status: 'answered' });
        return;
      }
      const via = entry.viaMessageId ? findMessage(uid, entry.viaMessageId) : undefined;
      appendMessage(uid, { from: 'cm', to: 'app', type: 'reply', summary: `Explanation for "${entry.title}".`, payload: { inReplyTo: msg.id, entry, via: via ?? null } });
      updateMessage(uid, msg.id, { status: 'answered' });
      return;
    }

    if (control === 'finalize-round') {
      const roundId = payload.roundId as string;
      const round = loadRound(uid, roundId);
      if (round) {
        // The CM agent stores the structured round record in its own DB (AC4/AC6).
        storeRoundRecord(uid, JSON.stringify(round));
      }
      // Confirm to the round engine: the round is 'stored' only on this reply (F13).
      appendMessage(uid, {
        from: 'cm', to: 'app', type: 'reply',
        summary: `Context Memory agent confirms round ${roundId} is stored in the Context Memory DB.`,
        payload: { inReplyTo: msg.id, roundId, stored: !!round, proposals: round?.proposals.length ?? 0, staleFlags: round?.staleFlags.length ?? 0 },
      });
      appendMessage(uid, { from: 'cm', to: 'user', type: 'inform', summary: `Context Memory agent finalised build round ${roundId}: ${round?.proposals.length ?? 0} proposal${(round?.proposals.length ?? 0) === 1 ? '' : 's'} for review, ${round?.staleFlags.length ?? 0} stale flag${(round?.staleFlags.length ?? 0) === 1 ? '' : 's'}; the round record is stored in the Context Memory DB.` });
      updateMessage(uid, msg.id, { status: 'answered' });
      return;
    }
  }
}

registerHandler('cm', handleMessage);

/** Park/resume publishing: keep the bus mirror in sync when state is loaded elsewhere. */
export function publishParkState(uid: string) {
  setCabinetParkedMirror(uid, !!loadCmDb(uid).parked);
}
