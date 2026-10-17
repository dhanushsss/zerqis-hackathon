/**
 * Runs one demo investigation end to end from the command line and prints the
 * ledger. Usage: npx tsx scripts/run-investigation.ts <scenarioId> [auto|live|replay|heuristic]
 */
import { join } from 'node:path';
import { config } from '../server/src/config.js';
import { openDatabase } from '../server/src/db/database.js';
import { Store } from '../server/src/db/store.js';
import { GitHubClient } from '../server/src/integrations/github.js';
import { TokenFactoryClient } from '../server/src/llm/client.js';
import { startDemo } from '../server/src/pipeline/intake.js';
import { InvestigationQueue } from '../server/src/pipeline/queue.js';

const [scenario = 'code-regression', mode = 'auto'] = process.argv.slice(2);
const store = new Store(openDatabase(join(config.dataDir, process.env.ALIBI_DB ?? 'alibi.db')));
const deps = { store, llm: new TokenFactoryClient(), github: new GitHubClient() };
const queue = new InvestigationQueue(deps);
const t0 = Date.now();
const inv = await startDemo(store, queue, scenario, { mode: mode as 'auto' });
await queue.drain();
const b = store.bundle(inv.id)!;
const i = b.investigation;
console.log(`\n${i.id} ${i.status} mode=${i.mode} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`signature: ${i.failureSignature}`);
console.log(`classification=${i.classification} verdict=${i.verdict} confidence=${i.confidence?.label} remediation=${i.remediationType}`);
if (i.error) console.log('ERROR', i.error);
console.log('\nHypotheses:');
for (const h of b.hypotheses) console.log(`  ${h.key} [${h.category}/${h.status}] ${h.cause}`);
console.log('\nExperiments:');
for (const e of b.experiments) console.log(`  ${e.kind.padEnd(16)} ${e.status.padEnd(8)} ${e.commitSha?.slice(0, 8) ?? ''} ${e.observation ?? e.reason}`);
console.log('\nPatches:');
for (const p of b.patches) console.log(`  ${p.status.padEnd(10)} ${p.origin.padEnd(13)} ${p.title} — ${p.validation?.summary ?? ''}`);
console.log('\nVerdict history:');
for (const v of i.verdictHistory) console.log(`  ${v.stage}: ${v.verdict ?? '—'} (${v.confidence}) ${v.note}`);
console.log('\nLimitations:', i.limitations);
console.log(`\nLedger: ${b.evidence.length} records; model calls: ${b.modelCalls.length}`);
