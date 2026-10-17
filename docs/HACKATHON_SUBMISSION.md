# Zerqis — Nebius × NVIDIA Global AI Hackathon submission

**Track:** Coding & Agentic Engineering
**Tagline:** Don't just explain the failure. Prove it.
**Repository:** _add public GitHub URL_ · **Demo:** _add deployed URL_ · **Video:** _add YouTube URL_

## Inspiration
Every engineer has watched a red CI build and argued with a teammate about whether their change caused it. AI assistants now summarize the error in seconds. But a summary is a guess that sounds confident: it can't tell a flaky test from a real regression, and it never checks itself. We wanted an agent that behaves like a good engineer: it suspects several causes, runs the experiment that tells them apart, and shows its work.

## What it does
Zerqis investigates a failed GitHub Actions run end to end:

1. **Reads the evidence.** It downloads the job log (or uses a recorded fixture in demo mode), redacts secrets, and parses Jest, Maven, pytest, and Mocha failures into a stable failure signature. It analyzes the commit diff for dependency bumps and docs-only changes.
2. **Forms competing hypotheses** with **NVIDIA Nemotron on Nebius Token Factory**, as schema-validated JSON. Each log quote the model cites is machine-checked, and unverifiable quotes are flagged.
3. **Runs experiments in an isolated sandbox.** It reproduces the failure, using the exact Jest seed the CI run printed. It repeats the test with replayable seeds to measure a flake rate with a confidence interval, compares the parent commit, and searches Tavily for release notes, issues, and incidents.
4. **Weighs the evidence.** Nemotron proposes a verdict, but deterministic rules decide what each experiment supports or contradicts. An evidence rubric caps "confirmed" unless a discriminating experiment ran.
5. **Proves a fix.** It generates candidates (quarantine, dependency pin, model-written fix, revert), applies each in a fresh sandbox, and re-runs the failing test plus the regression suite. When the target is a GitHub repository, you can review the diff and open a draft PR.

All of it is recorded in the **Evidence Ledger**, which keeps observed facts, model hypotheses, experiment results, external sources, inferences, and assumptions separate. Every record links to its provenance: log lines, a container run with exit codes and seeds, a URL, or a model ID.

## The non-obvious part: long context plus controlled experiments
Long-context models are good at reading a 2,000-line CI log and proposing what might be wrong. But a long context also produces more plausible stories, and nothing in the context window can tell the stories apart. Zerqis pairs the two halves. Nemotron does the wide reading: it selects relevant regions from huge logs, cross-references the diff, and proposes alternatives. A deterministic experiment planner then turns those hypotheses into **controlled software experiments** whose outcomes are facts. The model never runs commands. The model proposes the hypotheses, the planner chooses which experiments to run, and the sandbox answers. This is a single pass: the model weighs the results once rather than choosing experiments iteratively.

## How we built it
- **Models:** NVIDIA Nemotron via Nebius Token Factory, verified live: `nvidia/Nemotron-3_5-Lightning` (triage), `nvidia/nemotron-3-super-120b-a12b` (verdict), `nvidia/Nemotron-3-Ultra-550b-a55b` (patches). IDs are resolved from the live `/v1/models` catalog. Reasoning is disabled per request so answers stay schema-valid JSON. We use structured output (`json_schema`, degrading to `json_object`), Zod validation with a repair round, retries with `Retry-After`, a call budget, and per-stage fallback that is always labeled.
- **Sandbox:** Docker containers run non-root with no capabilities, a read-only root, no network during tests, bounded CPU, memory, and PIDs, timeouts, and capped output. Fixed command templates; test names are passed as argv.
- **Integrations:** the GitHub REST API (runs, jobs, logs via signed redirect, artifacts, compare diffs, PR association, HMAC-verified idempotent webhooks, Git Data API draft PRs) and the Tavily Search API at investigation time.
- **App:** a TypeScript Fastify API, SQLite, and a React dashboard. Tested with Vitest (including a real Docker sandbox test) and an end-to-end Playwright test that runs a full investigation through the UI.

## Demo scenarios (deterministic, real execution)
- **Flaky Jest test:** a docs-only commit fails. The CI seed reproduces it, 2/10 seeded runs fail (95% CI 6–51%), and the parent fails too. Quarantine is validated over 10 runs.
- **Maven dependency regression:** Guava 20.0 → 21.0 removed `Objects.toStringHelper`, verified against the real published JARs. The parent passes and a pin to 20.0 is validated. Nemotron Ultra's code fix **failed** an existing test and was rejected, which is the point: model output has to pass the sandbox.
- **Code regression:** `>=` became `>` in a refactor. It fails 10/10, the parent passes, and Ultra's one-line fix passes targeted tests plus the suite.

## Challenges
- Making flaky behavior **reproducible on stage** without faking it. We used Jest's seed so every run is replayable, and we report a measured flake rate with an honest interval.
- Running Maven **offline** in the sandbox. Surefire lazily resolves its JUnit provider and launcher, so the install phase resolves them explicitly without executing test code.
- Keeping the model honest: quote verification, deterministic effect rules, and a verdict cap.

## What's next
Remote sandbox backends (Nebius Token Factory Sandboxes), more frameworks (Gradle, Go; pytest beyond the requirements.txt layout), test-history-aware flake priors, and check-run annotations on the failing PR.

## Built with
NVIDIA Nemotron · Nebius Token Factory · Tavily · GitHub Actions API · TypeScript · Fastify · React · SQLite · Docker · Vitest · Playwright
