/**
 * R2: the owner's pass table, kept with its exact names.
 * Levels: 0 "No-risk certified", 1 "Review everything pass certified", 2 "High-risk pass certified".
 * Modes: "No permission" = every level passes; "Review everything" = levels 1 and 2 cannot pass;
 * "High risk mode" = only level 2 cannot pass. Cards that cannot pass wait in "waiting for you".
 * Pure function only. How a level is assigned, approval IDs, and activation timing are undecided.
 */
export type ApprovalLevel = 0 | 1 | 2;
export type PermissionMode = 'No permission' | 'Review everything' | 'High risk mode';
export const LEVEL_NAMES: Record<ApprovalLevel, string> = {
  0: 'No-risk certified (level 0)',
  1: 'Review everything pass certified (level 1)',
  2: 'High-risk pass certified (level 2)',
};
export function canPass(mode: PermissionMode, level: ApprovalLevel): boolean {
  if (mode === 'No permission') return true;
  if (mode === 'Review everything') return level === 0;
  return level !== 2; // High risk mode
}

export const PERMISSION_MODES: PermissionMode[] = ['No permission', 'Review everything', 'High risk mode'];
/** Owner: the existing default stays "Review everything". */
export const DEFAULT_MODE: PermissionMode = 'Review everything';
export const asMode = (v: unknown): PermissionMode | undefined => PERMISSION_MODES.find((m) => m === v);

/**
 * Rubric the User AI follows (explainable, HIGHEST applicable level wins). USER cards only.
 *  L2 high-risk: sensitive personal content, OR an unsupported/inferred personal conclusion, OR intended external disclosure/offers.
 *  L1 review: evidenced, non-sensitive personal context.
 *  L0 no-risk: non-sensitive facts or intent the customer stated directly, or generic non-personal content.
 * Direct input never lowers a sensitive topic to L0. The code sensitivity guard (risk.ts) is a FLOOR, not a complete
 * wordlist guarantee. The assigner writes level + reason; the reason is audit text, not a self-certification.
 */
export const RUBRIC = 'L2: sensitive personal content, an inferred/unsupported personal conclusion, or intended external disclosure or offers. L1: evidenced non-sensitive personal context. L0: non-sensitive facts or intent stated directly by the customer, or generic non-personal content. Highest applicable level wins.';
import { createHash } from 'node:crypto';
/** Consent version: covers what the customer consents to (title, detail, level, source). Timestamps, order and status are not part of it. */
export function contentHash(c: { title: string; detail: string; level: ApprovalLevel; source: string }): string {
  const n = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').trim();
  return createHash('sha256').update([n(c.title), n(c.detail), c.level, c.source].join('\u0001')).digest('hex').slice(0, 10);
}
/** The approval ID contains the level and the consent version: apv-L<level>-<hash>; a missing level is apv-L2-x<hash> (UNKNOWN). */
export function makeApprovalId(level: ApprovalLevel, suffix: string): string { return `apv-L${level}-${suffix}`; }
export const isUnknownId = (id: string) => /^apv-L2-x[0-9a-f]+$/.test(id);
/** The User AI assigner (code rubric floor): level for a USER card from what the code can see. */
export function assignLevel(c: { risk: 'low' | 'medium' | 'high'; observed: 'observed' | 'inferred'; direct: boolean }): { level: ApprovalLevel; reason: string } {
  if (c.risk === 'high') return { level: 2, reason: 'sensitive topic, inference or disclosure' };
  if (c.observed === 'inferred') return { level: 2, reason: 'unsupported or inferred personal conclusion' };
  if (c.direct) return { level: 0, reason: 'non-sensitive fact or intent stated directly by the customer' };
  return { level: 1, reason: 'evidenced non-sensitive personal context' };
}
/**
 * The EFFECTIVE approval of a user card, derived from the card's own content at pass time (never from the claim alone):
 * the claim is valid only when its level is 0-2, its id carries that level AND the consent version matches the current
 * content. Missing, invalid, unparseable or stale (content changed) claims are UNKNOWN: effective level 2, id apv-L2-x<hash>.
 * The sensitivity floor can only raise a claimed level to 2.
 */
export function effectiveApproval(payload: unknown, c: { title: string; detail: string; source: string; risk: 'low' | 'medium' | 'high' }): { id: string; level: ApprovalLevel; unknown: boolean; reason: string } {
  const claim = readApproval(payload);
  const withLevel = (level: ApprovalLevel) => makeApprovalId(level, contentHash({ ...c, level }));
  if (!claim || claim.id !== withLevel(claim.level)) {
    const h = contentHash({ ...c, level: 2 });
    return { id: `apv-L2-x${h}`, level: 2, unknown: true, reason: claim ? 'approval no longer matches the card content' : 'the AI gave no valid level' };
  }
  const level: ApprovalLevel = c.risk === 'high' ? 2 : claim.level;
  return { id: withLevel(level), level, unknown: false, reason: '' };
}
/** A proposal carries a claim only when payload.approval has a valid level AND an id that contains that same level. */
export function readApproval(payload: unknown): { id: string; level: ApprovalLevel } | null {
  const a = (payload as { approval?: { id?: unknown; level?: unknown } } | undefined)?.approval;
  if (!a || (a.level !== 0 && a.level !== 1 && a.level !== 2) || typeof a.id !== 'string') return null;
  return a.id.startsWith(`apv-L${a.level}-`) && a.id.length > 7 ? { id: a.id, level: a.level } : null;
}
