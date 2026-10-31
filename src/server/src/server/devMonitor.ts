// Read-only developer monitoring surface ("doctor's scope" for the Context Cabinet).
// It only READS state, through the same access-gateway rules the app itself uses
// (preview mode: no access-log writes, no reward changes). It never changes data.
import type { Express, Request, Response } from 'express';
import { db } from './db.js';
import { previewCabinetForAgent, hasActiveShare } from './accessGateway.js';
import { getAllAgents } from './agentRegistry.js';
import { feedStatus } from './nordeaFeed.js';
import { CabinetEntry } from '../types.js';

function serialize(e: CabinetEntry) {
  return {
    id: e.id,
    type: e.type,
    title: e.title,
    detail: e.detail,
    source: e.source,
    status: e.status,
    private: e.private,
    reviewed: e.reviewed,
    readableBy: e.readableBy,
    updatedAt: e.updatedAt,
  };
}

function lastRead(userId: string, agentId: string) {
  const log = db.getAccessLog(userId).find((l) => l.agentId === agentId);
  return log ? { at: log.timestamp, itemsReadCount: log.itemsReadCount, blockedCount: log.blockedCount } : null;
}

export function registerDevMonitor(app: Express) {
  app.get('/api/dev/monitor', (req: Request, res: Response) => {
    const userId = (req.query.userId as string) || 'lauri';
    const user = db.getUser(userId);
    if (!user) return res.status(404).json({ error: 'User not found', code: 'NO_USER' });

    const all = db.getCabinetEntries(userId).filter((e) => e.status !== 'archived');

    // What each configured agent may read right now (no logging, no side effects).
    const abel = previewCabinetForAgent(userId, 'abel');
    const adviser = previewCabinetForAgent(userId, 'adviser');
    const abelOk = new Set(abel.allowed.map((e) => e.id));
    const adviserOk = new Set(adviser.allowed.map((e) => e.id));

    // The adviser may only actually read while a one-time share is active.
    const shareActive = hasActiveShare(userId, 'adviser');

    // Collaborative list: cards the gateway allows BOTH sides to read. Eligibility
    // to be read by the Nordea side right now additionally requires the active share.
    const collaborative = all
      .filter((e) => abelOk.has(e.id) && adviserOk.has(e.id))
      .map((e) => ({ ...serialize(e), eligibleNow: shareActive }));
    const collaborativeIds = new Set(collaborative.map((e) => e.id));

    res.json({
      generatedAt: new Date().toISOString(),
      userId,
      userName: user.name,
      storage: db.status(),
      feed: feedStatus(),
      // Configured agent manifests (static roles), not proof of running agents.
      agents: getAllAgents(),
      share: { agentId: 'adviser', active: shareActive },
      panels: {
        // User role's context cards (customer/document sourced), annotated with
        // whether the user agent (Abel) may read each one.
        user: {
          managingAgent: 'abel',
          entries: all
            .filter((e) => e.source !== 'nordea')
            .map((e) => ({ ...serialize(e), agentCanRead: abelOk.has(e.id), shared: collaborativeIds.has(e.id) })),
        },
        collaborative: { shareActive, entries: collaborative },
        // Nordea role's context cards (bank-produced observations). reviewed=false
        // means the customer has not confirmed the observation yet.
        nordea: {
          managingAgent: 'adviser',
          entries: all
            .filter((e) => e.source === 'nordea')
            .map((e) => ({ ...serialize(e), pendingConfirmation: !e.reviewed, shared: collaborativeIds.has(e.id) })),
        },
      },
      // Real event streams the app already records: every add/change/removal with
      // who did it (you / abel / nordea) and every audited gateway read.
      events: db.getState().entryHistory.filter((h) => h.userId === userId).slice(-40).reverse(),
      accessLog: db.getAccessLog(userId).slice(0, 20),
      // Observed activity per agent, from the audited access log only (never from
      // configured manifests or timers). null when nothing has been observed.
      activity: {
        abel: lastRead(userId, 'abel'),
        adviser: lastRead(userId, 'adviser'),
        offers: lastRead(userId, 'offers'),
      },
      // seed/demo holds the fictional customers lauri, eeva and alex (seed/README.md),
      // so the page can label that data as fictional rather than real bank data.
      demoPersona: ['lauri', 'eeva', 'alex'].includes(userId),
    });
  });
}
