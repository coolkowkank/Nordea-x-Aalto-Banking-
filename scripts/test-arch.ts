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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
