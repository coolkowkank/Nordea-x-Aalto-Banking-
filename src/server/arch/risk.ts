/**
 * AC7: risk levels are decided by CODE RULES, never by an agent's judgement.
 * High risk waits for the customer; everything else can be stored automatically once the
 * customer has set standing permissions (first start). Deletions stay customer-driven.
 */
import type { AgentMessage } from './types.js';

export type Risk = 'low' | 'medium' | 'high';

/** Sensitive topics always wait for the customer (AC7). */
const SENSITIVE = ['health', 'medical', 'doctor', 'therapy', 'therapist', 'drug', 'religion', 'church', 'mosque', 'prayer', 'political', 'politics', 'election', 'union', 'dating', 'sexual', 'ethnicity', 'ethnic'];

export function assessProposalRisk(proposal: AgentMessage): Risk {
  const p = (proposal.payload ?? {}) as { detail?: string; observed?: string; forOffers?: boolean; shareBeyond?: boolean };
  if (p.forOffers === true || p.shareBeyond === true) return 'high'; // offers, or shared beyond the three agents
  if (p.observed === 'inferred') return 'high'; // an inference about the customer
  const text = `${proposal.summary} ${p.detail ?? ''}`.toLowerCase();
  if (SENSITIVE.some((w) => text.includes(w))) return 'high'; // a sensitive topic
  if (proposal.from === 'personal' && p.observed === 'observed') return 'low'; // the customer's own direct input
  return 'medium'; // observed aggregates from the bank side
}
