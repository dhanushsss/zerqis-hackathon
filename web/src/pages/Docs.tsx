import { Link } from 'react-router-dom';
import { BRAND, pageTitle } from '../brand';
import { CodeBlock, Icon, useDocumentTitle } from '../components/ui';
import { MarketingPage, useHashScroll } from './marketing/MarketingLayout';

const TOC = [
  { id: 'start', label: 'Get started' },
  { id: 'modes', label: 'Reasoning modes' },
  { id: 'github', label: 'Investigate GitHub runs' },
  { id: 'support', label: 'Supported projects' },
  { id: 'outcomes', label: 'Reading the results' },
  { id: 'config', label: 'Configuration' },
  { id: 'limits', label: 'Limitations' },
];

export function Docs() {
  useDocumentTitle(pageTitle('Documentation'));
  useHashScroll();
  return (
    <MarketingPage>
      <div className="mk-container mk-docs">
        <aside className="mk-toc" aria-label="On this page">
          <span className="eyebrow">On this page</span>
          <nav>
            {TOC.map((t) => (
              <Link key={t.id} to={{ hash: `#${t.id}` }}>
                {t.label}
              </Link>
            ))}
          </nav>
        </aside>
        <article className="mk-prose">
          <span className="mk-kicker">Documentation</span>
          <h1 className="mk-h2">{BRAND.name} product guide</h1>
          <p className="mk-sub">{BRAND.description}</p>

          <h2 id="start">Get started</h2>
          <p>
            You need Node 20 or later, git, and a running Docker engine (Docker Desktop, Rancher Desktop, or Docker Engine). Every API key is optional: without keys,{' '}
            {BRAND.name} still runs real sandboxed experiments and labels its reasoning stages as heuristic or replay.
          </p>
          <CodeBlock
            text={[
              'npm ci',
              'cp .env.example .env        # optional: NEBIUS_API_KEY, TAVILY_API_KEY, GITHUB_TOKEN',
              'docker pull node:20-bookworm-slim',
              'docker pull maven:3.9-eclipse-temurin-17',
              'npm run build',
              'npm start                   # http://127.0.0.1:8787',
            ].join('\n')}
          />
          <p>
            Open the app and choose <strong>Run sample investigation</strong>. The first Maven run downloads dependencies into a cache (about one to two minutes); later
            investigations take about 30–60 seconds. For development with hot reload, use <code>npm run dev</code>.
          </p>

          <h2 id="modes">Reasoning modes</h2>
          <p>Sandbox experiments always execute for real. Only the model stages (forming hypotheses, weighing results, writing a fix) change with the mode, and every investigation is labelled with the mode it used.</p>
          <ul>
            <li>
              <strong>Live</strong>: NVIDIA Nemotron through Nebius Token Factory, when <code>NEBIUS_API_KEY</code> is set. Model IDs are resolved from your account's catalog at
              runtime.
            </li>
            <li>
              <strong>Replay</strong>: re-uses model outputs recorded from an earlier live run of a sample scenario.
            </li>
            <li>
              <strong>Heuristic</strong>: deterministic rules, no model.
            </li>
          </ul>
          <p>
            Tavily web search is optional (<code>TAVILY_API_KEY</code>). Search results are treated as leads, never as proof.
          </p>

          <h2 id="github">Investigate GitHub runs</h2>
          <ol>
            <li>
              Create a fine-grained token with <em>Actions: read</em>, <em>Contents: read</em>, and <em>Metadata: read</em>, and set <code>GITHUB_TOKEN</code>. Add{' '}
              <em>Contents: write</em> and <em>Pull requests: write</em> only if you want draft pull requests.
            </li>
            <li>
              On the <Link to="/integrations">Integrations</Link> page, paste a failed run URL such as <code>https://github.com/owner/repo/actions/runs/&lt;id&gt;</code>.
            </li>
            <li>
              For automatic investigations, add a repository webhook to <code>/api/webhooks/github</code> (content type JSON, event <em>Workflow runs</em>, secret{' '}
              <code>GITHUB_WEBHOOK_SECRET</code>) and enable auto-investigate in <Link to="/settings">Settings</Link>.
            </li>
          </ol>
          <p>Sandbox experiments clone public repositories at the failing commit. Logs, metadata, and diffs can also be read from private repositories the token can access.</p>

          <h2 id="support">Supported projects</h2>
          <ul>
            <li>
              <strong>Jest</strong> and <strong>Maven</strong>: reproduce, repeat, parent comparison, and fix validation.
            </li>
            <li>
              <strong>pytest</strong>, restricted layout: dependencies must be PyPI requirements in a root-level <code>requirements.txt</code> (optionally{' '}
              <code>requirements-dev.txt</code> or <code>requirements-test.txt</code>) that include <code>pytest</code>. Poetry, Pipenv, uv, conda, <code>pyproject.toml</code>-only
              projects, URL or VCS requirements, and packages that need a build step are refused with the reason. Verified against controlled fixtures only.
            </li>
            <li>
              <strong>TypeScript</strong>: single-package npm projects with <code>tsconfig.json</code> and <code>typescript</code> at the root, tests run by Jest through{' '}
              <code>ts-jest</code> or <code>babel-jest</code> with <code>@babel/preset-typescript</code>. Test failures run as Jest experiments; compiler failures re-run{' '}
              <code>tsc --noEmit -p tsconfig.json</code> (or <code>tsc -p tsconfig.build.json</code> when CI built that config). A fix for a type error must pass the type check
              and the Jest suite. Monorepos and workspaces, project references, ESM-only packages (<code>"type": "module"</code>), Jest without a TypeScript transform, other test
              runners (Vitest, Mocha), and bundler builds are refused before install, with the reason.
            </li>
            <li>
              <strong>Go</strong>: a single module with <code>go.mod</code> at the repository root (Go 1.24 or older). Modules download from <code>proxy.golang.org</code> and are
              verified against <code>go.sum</code>; tests run offline with <code>go test -json</code>, compile failures with <code>go build ./...</code>. Repeats use replayable{' '}
              <code>-shuffle</code> seeds (test order only). Fixes: dependency pins that restore <code>go.mod</code> and <code>go.sum</code>, quarantine with <code>t.Skip</code>,
              and fresh-sandbox validation. <code>go.work</code> workspaces, vendored dependencies, <code>replace</code> directives to local paths, a Go version newer than the
              sandbox, and cgo packages are refused before install.
            </li>
            <li>Other frameworks: log and diff analysis only, reported with an explicit inconclusive limitation.</li>
          </ul>
          <p>
            Jest (JavaScript) and Maven are verified on the sample scenarios, live and replayed. TypeScript, pytest, and Go support is verified on controlled test repositories; it has
            not yet been run against real-world projects.
          </p>

          <h2 id="outcomes">Reading the results</h2>
          <p>
            Each investigation ends with a verdict (<em>confirmed</em>, <em>probable</em>, or <em>inconclusive</em>), a classification, and an evidence-strength label explaining why.
            The <strong>Evidence Path</strong> connects failure, hypotheses, experiments, diagnosis, and remediation; the <strong>Evidence Ledger</strong> lists every record in
            order with its provenance.
          </p>
          <p>
            Candidate fixes are validated in a fresh sandbox against the repository's own tests. A fix that fails is shown as rejected, with its output. A validated fix passed those
            checks; it is not proof of correctness beyond them.
          </p>

          <h2 id="config">Configuration</h2>
          <p>
            All settings are server-side environment variables, listed with defaults in <code>.env.example</code>. Variable names keep their original prefix (for example <code>ALIBI_RUNNER</code>) so existing
            deployments keep working. Highlights:
          </p>
          <ul>
            <li>
              <code>ALIBI_MAX_MODEL_CALLS</code> (default 8) and <code>ALIBI_MAX_LOG_CHARS</code> bound model use per investigation.
            </li>
            <li>
              <code>ALIBI_RUNNER_CPUS</code>, <code>ALIBI_RUNNER_MEMORY</code>, and <code>ALIBI_RUNNER_TIMEOUT_SEC</code> bound each sandbox run.
            </li>
            <li>
              <code>ALIBI_DEMO_READONLY=true</code> turns on the public-demo mode: rate limits, no deletes, pull requests, or settings changes, and allow-listed repositories only.
            </li>
            <li>
              <code>ALIBI_LOOP=1</code> enables the experimental bounded agent loop (off by default).
            </li>
          </ul>

          <h2 id="limits">Limitations</h2>
          <ul>
            <li>There are no user accounts or authentication. Run {BRAND.name} on a trusted machine or behind your own access controls.</li>
            <li>The sandbox is the Docker engine on the host. It approximates the CI runner; causes specific to the runner image, caches, secrets, or network are not reproduced.</li>
            <li>Flake rates come from a small number of runs and are reported with a confidence interval.</li>
          </ul>

          <p className="mk-docs-back">
            <Link to="/overview" className="btn btn-primary">
              Open the app <Icon name="arrowRight" />
            </Link>
          </p>
        </article>
      </div>
    </MarketingPage>
  );
}
