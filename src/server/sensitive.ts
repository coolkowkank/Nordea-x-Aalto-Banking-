/**
 * One shared sensitive-topic matcher (code backstop, word-bounded so "reunion" and
 * "drugstore" are NOT hits). Used by the Abel privacy guard and by the architecture's
 * AC7 risk rules (F21). Extend here, not in copies.
 */
export const SENSITIVE_TOPIC = /\b(health|illness|ill|sick|cancer|diagnos\w*|pregnan\w*|baby on the way|ivf|divorc\w*|separation|separated|affair|therap\w*|depress\w*|anxiety|anxious|panic attack|disabilit\w*|disabled|surgery|hospitali[sz]\w*|debt collectors?|debt|gambl\w*|addict\w*|religion|religious|church|mosque|prayer|politic\w*|election|trade union|dating|sexual\w*|ethnic\w*)\b/i;

export const isSensitiveTopic = (text: string) => SENSITIVE_TOPIC.test(text);
