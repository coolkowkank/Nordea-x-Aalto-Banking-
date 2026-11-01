/**
 * npm run migrate:legacy - move data/cabinet-db.json into the three agent databases
 * (User / Context Memory / Nordea), verify every record field-by-field, and delete the
 * legacy file only when verification passes. Safe to re-run after a crash or failure.
 */
import { runLegacyMigration } from '../src/server/arch/legacyMigrate.js';

const r = runLegacyMigration();
if (r.alreadyDone) {
  console.log('cabinet-db.json is already gone - nothing to migrate.');
  process.exit(0);
}
for (const f of r.failures) console.error(`FAIL: ${f}`);
if (!r.ok) {
  console.error(`Migration aborted with ${r.failures.length} problem(s). cabinet-db.json was NOT deleted.`);
  process.exit(1);
}
const kinds = r.ledger.filter((l) => l.rows > 0);
for (const l of kinds) console.log(`  ${l.kind}: ${l.rows} record(s) verified (${l.sourceHash})`);
console.log(`Migration verified: ${r.ledger.reduce((n, l) => n + l.rows, 0)} records across ${kinds.length} kinds. cabinet-db.json deleted.`);
