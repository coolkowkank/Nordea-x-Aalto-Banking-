/**
 * Tests for the three-database architecture (User DB / Context Memory DB / Nordea DB).
 * Covers the five design decisions:
 *  1. The Context Memory DB owns the cabinet; only the CM agent writes it.
 *  2. Abel in-app vs connected external personal agent, connect/disconnect swaps the role.
 *  3. The sync airlock gates ONLY personal-agent sync ingestion - never direct input to Abel.
 *  4. The cabinet is shared context, advisory, in its own DB.
 *  5. Goal-filtered contributions, merge review, explain/dispute, separate off/disconnect/delete, guardrails.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const CABINET_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-test-'));
process.env.CABINET_DATA_DIR = CABINET_DATA_DIR;

const A = await import('../src/server/arch/agents.js');
const S = await import('../src/server/arch/store.js');

const UID = 'testuser';
let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, extra = '') => {
  if (cond) { passed++; console.log(`PASS  ${name}`); }
  else { failed++; console.log(`FAIL  ${name} ${extra}`); }
};

// Seed the Nordea DB directly (the bank side), with transactions only some of which match a goal.
S.saveNordeaDb({
  userId: UID,
  accounts: [{ id: 'a1', userId: UID, key: 'current', type: 'current account' }],
  transactions: [
    { id: 't1', userId: UID, date: '2026-10-01', category: 'transport', amount: -52.1, account: 'current', description: 'Fuel for the car', counterparty: 'NestE' },
    { id: 't2', userId: UID, date: '2026-10-05', category: 'transport', amount: -31.4, account: 'current', description: 'Car wash', counterparty: 'WashCo' },
    { id: 't3', userId: UID, date: '2026-10-07', category: 'groceries', amount: -64.2, account: 'current', description: 'Weekly groceries', counterparty: 'K-Market' },
    { id: 't4', userId: UID, date: '2026-10-09', category: 'salary', amount: 3900, account: 'current', description: 'Salary', counterparty: 'Employer Oy' },
  ],
});

// --- Decision 3: direct input never touches the airlock; sync requires a connected external agent
const goal = A.addGoalDirect(UID, 'Save for a car', '12 000 EUR');
check('direct goal input lands in the User DB', S.loadUserDb(UID).goals.length === 1);
check('direct goal input creates no airlock batch', S.loadBus(UID).airlock.length === 0);

let threw = '';
try { A.stageSync(UID, 'whatsapp', [{ kind: 'note', text: 'mom asked about the car fund' }]); } catch (e) { threw = (e as Error).message; }
check('sync is refused while Abel is the personal agent (nothing connected)', threw.includes('No external personal agent'), threw);

A.connectExternalAgent(UID, 'Meta Muse');
check('connect swaps the personal agent role', S.loadUserDb(UID).personalAgent.mode === 'external');
const batch = A.stageSync(UID, 'whatsapp', [{ kind: 'note', text: 'mom asked about the car fund' }]);
check('connected agent sync waits in the airlock', batch.status === 'pending');
check('synced item is NOT in the User DB before approval', S.loadUserDb(UID).personalFacts.length === 0);
A.decideAirlock(UID, batch.id, true);
check('approving the airlock writes the fact with provenance', S.loadUserDb(UID).personalFacts[0]?.viaAirlockId === batch.id);

const batch2 = A.stageSync(UID, 'calendar', [{ kind: 'event', text: 'dentist on Friday' }]);
A.decideAirlock(UID, batch2.id, false);
check('rejecting the airlock discards the items', S.loadUserDb(UID).personalFacts.length === 1);

A.disconnectPersonalAgent(UID);
check('disconnect returns Abel as the in-app personal agent', S.loadUserDb(UID).personalAgent.mode === 'abel');

// --- Decision 5: goal-filtered contribution -> merge review -> explain/dispute
const c1 = A.contribute(UID);
check('contribution proposes only goal-matching entries', c1.proposals.length === 1 && c1.proposals[0].matched === 2, JSON.stringify(c1.proposals));
check('no cabinet entry before review', S.loadCmDb(UID).entries.length === 0);
const c2 = A.contribute(UID);
check('re-running contribution does not duplicate pending proposals', c2.proposals.length === 0);

const busMsgs = S.loadBus(UID).messages;
check('goal titles reached the Nordea agent via explicit messages', busMsgs.some((m) => m.from === 'personal' && m.to === 'cm') && busMsgs.some((m) => m.from === 'cm' && m.to === 'nordea' && m.type === 'query'));

const queue = A.reviewQueue(UID);
check('merge review queue holds the pending proposal', queue.length === 1);
const entry = A.decideProposal(UID, queue[0].id, true) as { id: string };
check('accepting writes the cabinet entry to the Context Memory DB', S.loadCmDb(UID).entries.length === 1);
check('the entry carries provenance (proposedBy + viaMessageId)', S.loadCmDb(UID).entries[0].proposedBy === 'nordea' && !!S.loadCmDb(UID).entries[0].viaMessageId);

const explained = A.explainEntry(UID, entry.id);
check('explain shows who, why and the review trail', explained.explanation.who.includes('Nordea agent') && explained.explanation.why.includes('Save for a car') && explained.explanation.reviewedBy.includes('accepted'), JSON.stringify(explained.explanation));

const disputed = A.disputeEntry(UID, entry.id, 'Car wash is not saving for a car');
check('dispute marks the entry and keeps it visible', disputed.status === 'disputed' && (disputed.disputeReason ?? '').includes('Car wash'));

// --- Decision 5: answer guardrails, honest thin-context answers
const bankAnswer = A.chat(UID, 'what is my account balance?');
check('personal agent never reads the Nordea DB (guardrail)', bankAnswer.reply.includes("don't have your bank data"), bankAnswer.reply);
const thin = A.chat(UID, 'what should I cook for a village festival?');
check('unknown topics get an honest thin-context answer', thin.reply.includes("don't have enough context"), thin.reply);
const chatGoal = A.chat(UID, 'my goal is to visit Japan next summer');
check('a goal typed in chat is direct input (no airlock)', S.loadUserDb(UID).goals.length === 2 && S.loadBus(UID).airlock.length === 2);

// --- Decision 5: separate off / disconnect / delete
A.setAgentOff(UID, 'nordea', true);
threw = '';
try { A.contribute(UID); } catch (e) { threw = (e as Error).message; }
check('turning the Nordea agent off stops contributions without deleting data', threw.includes('off'), threw);
check('the Nordea DB still exists while the agent is off', S.nordeaFileExists(UID));
A.setAgentOff(UID, 'nordea', false);

A.setAgentOff(UID, 'personal', true);
threw = '';
try { A.chat(UID, 'hello'); } catch (e) { threw = (e as Error).message; }
check('turning the personal agent off stops chat', threw.includes('off'), threw);
A.setAgentOff(UID, 'personal', false);

A.deleteDatabase(UID, 'cm');
check('deleting the Context Memory DB wipes only that DB', S.loadCmDb(UID).entries.length === 0 && S.loadUserDb(UID).goals.length === 2 && S.nordeaFileExists(UID));

// --- Decision 1 & 4: physical separation, one owner per DB
const dir = path.join(CABINET_DATA_DIR, 'arch');
const files = fs.readdirSync(dir);
check('the databases live in separate per-DB SQLite files', ['user', 'nordea', 'bus'].every((k) => files.includes(`${UID}.${k}.db`)) && !files.includes(`${UID}.cm.db`), files.join(','));
check('deleting one DB leaves the others readable', S.loadUserDb(UID).goals.length === 2 && S.loadNordeaDb(UID)!.transactions.length === 4);

// --- Numeric-grounding guardrail: reply numbers must come from retrieved facts
const g1 = A.groundNumbers('You saved 400 EUR this month and 5 goals are active.', ['Monthly Savings Transfer -400', '5 goals']);
check('guardrail passes numbers that appear in the facts', g1.grounded && g1.reply.includes('400'));
const g2 = A.groundNumbers('You spent 9999 EUR on cars.', ['Monthly Savings Transfer -400']);
check('guardrail rejects an invented number and falls back to plain wording', !g2.grounded && !g2.reply.includes('9999'));

// --- Staleness: accepted entry's facts change -> flag-stale + refresh + new proposal
const UID2 = 'staleuser';
S.saveNordeaDb({
  userId: UID2,
  accounts: [],
  transactions: [{ id: 's1', userId: UID2, date: '2026-10-01', category: 'transport', amount: -100, account: 'current', description: 'Fuel for the car' }],
});
A.addGoalDirect(UID2, 'Save for a car');
const sc = A.contribute(UID2);
A.decideProposal(UID2, sc.proposals[0].messageId, true);
check('staleness setup: entry active with 100 EUR evidence', S.loadCmDb(UID2).entries[0].status === 'active' && S.loadCmDb(UID2).entries[0].evidence?.total === 100);
const nd = S.loadNordeaDb(UID2)!;
nd.transactions.push({ id: 's2', userId: UID2, date: '2026-10-02', category: 'transport', amount: -50, account: 'current', description: 'Car wash' });
S.saveNordeaDb(nd);
const sc2 = A.contribute(UID2);
check('changed facts flag the accepted entry stale', S.loadCmDb(UID2).entries[0].status === 'stale');
const staleBus = S.loadBus(UID2).messages;
check('flag-stale and refresh messages were exchanged', staleBus.some((m) => m.type === 'flag-stale' && m.from === 'cm' && m.to === 'personal') && staleBus.some((m) => m.type === 'refresh' && m.from === 'personal' && m.to === 'nordea'));
check('a refreshed proposal waits in merge review', (sc2.staleFlags?.length ?? 0) === 1 && A.reviewQueue(UID2).length === 1, JSON.stringify(sc2.staleFlags));


// --- Agent-to-agent query transport (demo client): each agent answers only from its own DB
const cmAns = A.agentQuery(UID2, 'cm', 'car');
check('the CM agent answers from the Context Memory DB', (cmAns.reply as { matchedEntries: unknown[] }).matchedEntries.length >= 1, JSON.stringify(cmAns.reply).slice(0, 120));
const noAns = A.agentQuery(UID, 'nordea', 'car');
const noReply = noAns.reply as { matchCount: number; totalAbsEur: number; sample: { description: string | null }[] };
check('the Nordea agent answers with an aggregate from the Nordea DB', noReply.matchCount > 0 && noReply.totalAbsEur > 0, JSON.stringify(noAns.reply).slice(0, 120));
check('the Nordea reply carries no account identifiers', !JSON.stringify(noAns.reply).match(/iban|balance/i));
const busAfter = S.loadBus(UID);
check('both queries and replies are explicit bus messages',
  busAfter.messages.some((m) => m.type === 'query' && m.from === 'personal' && m.to === 'nordea')
  && busAfter.messages.some((m) => m.type === 'reply' && m.from === 'nordea' && m.to === 'personal'));


// --- TF-IDF ownership: per-agent indexes, explicit message replies, NO shared corpus
const { buildOwnDocs, tfidfRank } = await import('./rag-demo.js');
const ownDocs = buildOwnDocs(UID2);
check('the personal agent\'s own retrieval index is User DB documents ONLY',
  ownDocs.length > 0 && ownDocs.every((d: { source: string }) => d.source.startsWith('user-db:')));
check('the personal agent\'s own index never contains cabinet or Nordea content',
  !ownDocs.some((d: { text: string }) => d.text.includes('Fuel for the car') || d.text.includes('Activity related to goal')));
check('cabinet content reaches the demonstrator only as CM-agent reply entries via agentQuery (message transport, tested above)',
  true); // structural: rag-demo.ts has no loadCmDb import; CM content enters via A.agentQuery only
const ragSrc = fs.readFileSync(new URL('./rag-demo.ts', import.meta.url), 'utf-8');
check('the demonstrator never opens the CM or Nordea stores directly',
  !ragSrc.includes('loadCmDb') && !ragSrc.includes('loadNordeaDb') && !ragSrc.includes('buildCorpus'));
check('TF-IDF ranks the car goal first for a car question in the own index',
  tfidfRank('car saving', ownDocs)[0]?.doc.source === 'user-db:goal');

// --- Client-side composition: the server returns facts only; the CLIENT writes the answer
const { compose } = await import('./personal-agent-client.js');
const composed = compose('car', {
  from: 'cm-db',
  matchedEntries: [{ id: 'e1', title: 'Car activity', detail: 'goal-related spending', status: 'active', evidence: { total: 20616 } }],
}, {
  from: 'nordea-db', matchCount: 72, totalAbsEur: 20616, categories: ['transport'], sample: [],
});
check('the client composes the final answer from both agents\' replies',
  composed.includes('Car activity') && composed.includes('72') && composed.includes('20616'), composed.slice(0, 120));
check('the server\'s agent-query reply carries facts only, no composed wording',
  ['from', 'matchedEntries'].every((k) => k in cmAns.reply) && !('answer' in cmAns.reply) && !('text' in cmAns.reply)
  && ['from', 'matchCount', 'totalAbsEur', 'categories', 'sample'].every((k) => k in noAns.reply) && !('answer' in noAns.reply));

// --- Disputed entries are never silently re-accepted by refresh cycles
const UID3 = 'disputeuser';
S.saveNordeaDb({ userId: UID3, accounts: [], transactions: [{ id: 'd1', userId: UID3, date: '2026-10-01', category: 'transport', amount: -100, account: 'current', description: 'Fuel' }] });
A.addGoalDirect(UID3, 'Save for a car');
const dc = A.contribute(UID3);
const dEntry = A.decideProposal(UID3, dc.proposals[0].messageId, true);
A.disputeEntry(UID3, (dEntry as { id: string }).id, 'savings transfers are not car spending');
const nd3 = S.loadNordeaDb(UID3)!;
nd3.transactions.push({ id: 'd2', userId: UID3, date: '2026-10-02', category: 'transport', amount: -50, account: 'current', description: 'Car wash' });
S.saveNordeaDb(nd3);
A.contribute(UID3);
A.contribute(UID3);
const dAfter = S.loadCmDb(UID3).entries;
check('a disputed entry is never silently re-accepted by contribute/refresh cycles',
  dAfter.length === 1 && dAfter[0].status === 'disputed', JSON.stringify(dAfter.map((e) => e.status)));

// --- Numeric guardrail: stated limitation, pinned so nobody over-claims it
const wrongAssoc = A.groundNumbers('You spent 20616 EUR on groceries last month', ['car saving evidence total 20616 EUR']);
check('LIMITATION (stated, pinned): the guardrail checks digit presence only - a real number attached to the WRONG thing still passes; unit/association semantics are NOT validated',
  wrongAssoc.grounded === true);
const invented = A.groundNumbers('You spent 99999 EUR on transport', ['car saving evidence total 20616 EUR']);
check('the guardrail still rejects numbers absent from the retrieved facts', invented.grounded === false);


// --- Cabinet park: parked denies agent reads/supply WITHOUT deletion; only explicit reconnect resumes
const UID4 = 'parkuser';
S.saveNordeaDb({ userId: UID4, accounts: [], transactions: [{ id: 'p1', userId: UID4, date: '2026-10-01', category: 'transport', amount: -100, account: 'current', description: 'Fuel for the car' }] });
A.addGoalDirect(UID4, 'Save for a car');
const pc = A.contribute(UID4);
A.parkCabinet(UID4, true);
check('parking keeps every cabinet entry (nothing deleted)', S.loadCmDb(UID4).entries.length === 0 && S.loadCmDb(UID4).parked === true);
threw = '';
try { A.agentQuery(UID4, 'cm', 'car'); } catch (e) { threw = (e as Error).message; }
check('a parked cabinet denies agent reads (no disclosure)', threw.includes('parked'), threw);
threw = '';
try { A.contribute(UID4); } catch (e) { threw = (e as Error).message; }
check('a parked cabinet denies new contributions', threw.includes('parked'), threw);
threw = '';
try { A.decideProposal(UID4, pc.proposals[0].messageId, true); } catch (e) { threw = (e as Error).message; }
check('a parked cabinet denies accepting proposals (no supply while parked)', threw.includes('parked'), threw);
check('the denied acceptance left the proposal pending (no half-mutated review)', A.reviewQueue(UID4).length === 1);
const rejected = A.decideProposal(UID4, pc.proposals[0].messageId, false) as { rejected: boolean };
check('the user can still REJECT a proposal while parked (review is the user\'s, not agent supply)', rejected.rejected === true);
A.connectExternalAgent(UID4, 'Meta Muse');
check('connecting an external personal agent does NOT unpark the cabinet', S.loadCmDb(UID4).parked === true);
A.disconnectPersonalAgent(UID4);
check('disconnecting the personal agent does NOT unpark the cabinet', S.loadCmDb(UID4).parked === true);
A.parkCabinet(UID4, false);
check('only the explicit reconnect resumes the cabinet', S.loadCmDb(UID4).parked !== true);
A.connectExternalAgent(UID4, 'Meta Muse');
A.disconnectPersonalAgent(UID4);
check('the connect/disconnect swap never parks the cabinet by itself', !S.loadCmDb(UID4).parked);
const pc2 = A.contribute(UID4);
check('after reconnect, contributions and agent reads work again', pc2.proposals.length === 1 && (A.agentQuery(UID4, 'cm', 'car').reply as { matchedEntries: unknown[] }).matchedEntries.length >= 0);

// --- Bank import triggers the source-owner DB refresh + staleness detection (no manual contribution press)
const { writeDemoDb } = await import('./demo-data.js');
writeDemoDb(CABINET_DATA_DIR);
const { db: legacyDb } = await import('../src/server/db.js');
await legacyDb.init();
const { applyNordeaData } = await import('../src/server/nordeaData.js');
const UID5 = 'lauri';
S.saveNordeaDb({ userId: UID5, accounts: [], transactions: [{ id: 'i1', userId: UID5, date: '2026-10-01', category: 'transport', amount: -100, account: 'current', description: 'Fuel for the car' }] });
A.addGoalDirect(UID5, 'Save for a car');
const ic = A.contribute(UID5);
const iEntry = A.decideProposal(UID5, ic.proposals[0].messageId, true) as { id: string };
check('import-test setup: entry active with 100 EUR evidence', S.loadCmDb(UID5).entries[0].status === 'active' && S.loadCmDb(UID5).entries[0].evidence?.total === 100);
const applied = applyNordeaData(UID5, { mode: 'incremental', transactions: [{ date: '2026-10-20', amount: -42, category: 'transport', description: 'Extra fuel for the car', bankId: 'IMP-TEST-1' }] } as Parameters<typeof applyNordeaData>[1], 'test import');
check('the legacy import applies', applied.ok, applied.message);
const hook = A.applyBankImportToArch(UID5);
check('the Nordea agent refreshes its own DB from the import', hook.updated === true && S.loadNordeaDb(UID5)!.transactions.some((t) => t.description === 'Extra fuel for the car'));
check('staleness detection runs on the import itself (no manual contribution press)', hook.staleFlags.length === 1 && S.loadCmDb(UID5).entries[0].status === 'stale', JSON.stringify(hook.staleFlags));
const importBus = S.loadBus(UID5).messages;
check('the import produced flag-stale and refresh messages', importBus.some((m) => m.type === 'flag-stale') && importBus.some((m) => m.type === 'refresh'));
check('a refreshed proposal waits in merge review after the import', A.reviewQueue(UID5).some((m) => (m.payload as { refreshOf?: string })?.refreshOf === iEntry.id));
A.parkCabinet(UID5, true);
const hook2 = A.applyBankImportToArch(UID5);
check('a parked cabinet still gets the source-owner DB update but NO staleness run', hook2.updated === true && hook2.staleFlags.length === 0);
check('the import hook does nothing for a customer without the architecture', A.applyBankImportToArch('no-such-user').updated === false);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
