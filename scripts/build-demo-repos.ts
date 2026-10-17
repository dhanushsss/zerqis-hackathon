/**
 * Builds the three deterministic demo repositories under data/demo-repos/<id>.
 * Each scenario commit overlays its directory onto the previous tree. Author,
 * committer and dates are fixed so the resulting commit SHAs are reproducible.
 */
import { buildAllDemoRepos } from '../server/src/scenarios/build.js';

const results = await buildAllDemoRepos({ force: process.argv.includes('--force') });
for (const r of results) {
  console.log(`${r.id.padEnd(18)} ${r.repoPath}`);
  for (const c of r.commits) console.log(`  ${c.sha.slice(0, 12)}  ${c.message}`);
}
