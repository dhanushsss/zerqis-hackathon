import { join } from 'node:path';
import { buildApp } from './app.js';
import { config } from './config.js';
import { openDatabase } from './db/database.js';
import { Store } from './db/store.js';
import { GitHubClient } from './integrations/github.js';
import { TokenFactoryClient } from './llm/client.js';
import { InvestigationQueue } from './pipeline/queue.js';
import { buildAllDemoRepos } from './scenarios/build.js';

const store = new Store(openDatabase(join(config.dataDir, process.env.ALIBI_DB ?? 'alibi.db')));
const interrupted = store.failInterrupted();
const llm = new TokenFactoryClient();
const github = new GitHubClient();
const queue = new InvestigationQueue({ store, llm, github }, Number(process.env.ALIBI_CONCURRENCY ?? 1));

await buildAllDemoRepos();
const app = await buildApp({ store, llm, github, queue });
if (interrupted) app.log.warn(`${interrupted} investigation(s) were interrupted by the last shutdown and marked failed`);
app.log.info(
  `Nebius Token Factory: ${llm.configured ? 'configured' : 'NOT configured (heuristic/replay mode)'}; Tavily: ${config.tavily.apiKey ? 'configured' : 'not configured'}; GitHub: ${github.configured ? 'configured' : 'not configured'}`,
);
await app.listen({ port: config.port, host: config.host });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await app.close();
    store.db.close();
    process.exit(0);
  });
}
