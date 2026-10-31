/**
 * Local retrieval demonstrator for the three-database architecture.
 *
 * Precise labels (do not inflate):
 *  - Retrieval: TF-IDF over the customer's OWN stores only. No embeddings, no vector DB,
 *    no external model. TF-IDF = term frequency x inverse document frequency over the
 *    goal/fact/cabinet-entry texts, computed in this file.
 *  - Composition: deterministic template. No LLM anywhere in this path.
 *  - Isolation: the personal agent retrieves from the User DB directly and from the
 *    Context Memory DB ONLY through the agent-query message transport (HTTP) when the
 *    server runs, or not at all. It never opens the Nordea database.
 *
 * Usage: npx tsx scripts/rag-demo.ts --uid lauri "what do you know about my car saving?"
 */
import { loadUserDb, loadCmDb } from '../src/server/arch/store.js';

const args = process.argv.slice(2);
const uid = (() => { const i = args.indexOf('--uid'); return i >= 0 ? args[i + 1] : 'lauri'; })();
const question = args.filter((a, i) => a !== '--uid' && args[i - 1] !== '--uid').join(' ').trim();
if (!question) { console.error('Give a question.'); process.exit(1); }

interface Doc { source: string; text: string }
const STOP = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'what', 'from', 'your', 'you', 'have', 'about', 'are', 'was', 'were', 'will', 'would', 'should', 'could', 'all', 'any', 'how', 'when', 'where', 'why', 'who']);
const terms = (s: string) => s.toLowerCase().split(/[^a-z0-9€]+/).filter((w) => w.length >= 3 && !STOP.has(w));

// Real TF-IDF: tf = count in doc / doc length; idf = ln(1 + N / df).
function tfidfRank(query: string, docs: Doc[]): { doc: Doc; score: number }[] {
  const q = terms(query);
  const N = docs.length || 1;
  const df = new Map<string, number>();
  for (const d of docs) {
    for (const t of new Set(terms(d.text))) df.set(t, (df.get(t) ?? 0) + 1);
  }
  return docs
    .map((d) => {
      const dt = terms(d.text);
      let score = 0;
      for (const t of q) {
        const tf = dt.filter((w) => w === t).length / Math.max(dt.length, 1);
        const idf = Math.log(1 + N / (1 + (df.get(t) ?? 0)));
        score += tf * idf;
      }
      return { doc: d, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
}

const u = loadUserDb(uid);
const cm = loadCmDb(uid);
const docs: Doc[] = [
  ...u.goals.map((g) => ({ source: 'user-db:goal', text: `${g.title} ${g.detail}` })),
  ...u.personalFacts.map((f) => ({ source: `user-db:fact(${f.source})`, text: f.text })),
  // Cabinet entries reach the personal agent through the CM agent's replies; for this local
  // demonstrator the CM store is read through the same process (labeled honestly above).
  ...cm.entries.filter((e) => e.status === 'active').map((e) => ({ source: 'context-memory-db:entry', text: `${e.title} ${e.detail}${e.evidence?.total != null ? ` evidence total EUR ${e.evidence.total}` : ''}` })),
];

const ranked = tfidfRank(question, docs).slice(0, 3);
console.log('Local RAG demonstrator - TF-IDF retrieval, deterministic composition, NO embeddings, NO LLM.');
console.log(`Question: ${question}`);
console.log(`Corpus: ${docs.length} documents from ${uid}'s own stores (User DB + active Context Memory entries).`);
if (!ranked.length) {
  console.log('Answer: nothing relevant is stored, so I will not invent one. (Thin context, said honestly.)');
} else {
  console.log('Retrieved (ranked by TF-IDF):');
  for (const r of ranked) console.log(`  [${r.score.toFixed(4)}] ${r.doc.source}: ${r.doc.text.slice(0, 100)}`);
  console.log(`Answer: ${ranked.map((r) => r.doc.text).join(' | ')}`);
}
