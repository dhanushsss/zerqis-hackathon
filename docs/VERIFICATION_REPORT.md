# Verification report

> **Update 2026-10-16:** the two "NOT VERIFIED" rows below (live Nemotron and Tavily) predate the API keys. Both were later verified live; see [verification/live-cloud-verification.md](verification/live-cloud-verification.md).

Date: 2026-10-16 · Host: macOS (Darwin 27), Node 20.19.6, Docker Engine 29.5.3 (Rancher Desktop), OpenJDK 17, Maven 3.9.12.

This report lists what was actually executed and observed. Anything not verified is marked **NOT VERIFIED** with the reason.

## Summary

| Requirement | Status | Evidence |
|---|---|---|
| App builds and starts | ✅ Verified | `npm run build`; `node server/dist/index.js` serves the API and SPA (deep links → 200, unknown API → JSON 404) |
| Dashboard loads and navigates | ✅ Verified | Web tests (7) plus the Playwright E2E; screenshots in `docs/img/` |
| Sample investigation runs end to end | ✅ Verified | All three scenarios via API and UI (results below) |
| Runtime Nemotron call via Nebius Token Factory | ❌ **NOT VERIFIED** | No `NEBIUS_API_KEY` available. Client is unit-tested against the documented OpenAI-compatible API with mocked HTTP |
| Structured, validated model output | ✅ Verified (mocked transport) | Zod schemas, `json_schema` → `json_object` degradation, repair round: `llm.test.ts` |
| Evidence Ledger records real observations | ✅ Verified | 16–19 ledger records per scenario, with log-line, experiment, git, and GitHub API provenance |
| Real test execution in the sandbox | ✅ Verified | 48 container test runs across 13 experiments in the three stored investigations; exit codes captured |
| Candidate fix validated against a regression test | ✅ Verified | 3/3 scenarios: candidate passes targeted runs plus the full suite |
| Persistence and revisiting | ✅ Verified | SQLite; `store.test.ts`; investigations reload after server restart |
| GitHub Actions integration | ✅ Partially verified | Real public run (`expressjs/express` run 37953351037): run metadata, failed job, 2,216-line log via signed redirect, redaction, parent commit, compare diff, Mocha failure signature, rerun, dedupe. Webhooks verified with signed test payloads. **Draft PR creation NOT VERIFIED** (would write to a repository you control; not yet authorized) |
| Tavily runtime search | ❌ **NOT VERIFIED** | No `TAVILY_API_KEY` available. Client unit-tested with mocked HTTP; the investigation records a labeled "skipped" step |
| Public deployment | ❌ **NOT DONE** | No hosting credentials. Provisioning script prepared: `deploy/setup-vm.sh` |
| Public GitHub repository | ❌ **NOT DONE** | Owner chose to keep the code local for now |
| Nebius Sandboxes / Serverless Jobs | Not used | Experiments run in the local Docker sandbox; documented as such |

## Commands executed and results

```text
$ npm run typecheck
  server: tsc --noEmit → 0 errors
  web:    tsc --noEmit → 0 errors

$ npm test
  server  Test Files 7 passed (7)   Tests 65 passed (65)     # includes real Docker sandbox test
  web     Test Files 1 passed (1)   Tests 7 passed (7)

$ npm run build
  web: vite build ✓ ; server: tsc ✓

$ npx playwright test
  ✓ e2e/demo.spec.ts › a sample investigation runs end to end: hypotheses → sandbox experiments → validated fix → verdict
  1 passed (37.9s)
```

Server test files: `analysis/analysis.test.ts` (signature parsing for all three recorded logs plus Mocha, long-log selection under budget, quote verification, redaction, diff analysis, Wilson interval), `pipeline/pipeline.test.ts` (experiment-effect rules, confidence rubric, verdict capping, quarantine and pin candidates, heuristic fallback, seed sequence), `llm/llm.test.ts` (JSON extraction, loose enums, retries on 429/503, no retry on 401, no key leakage, structured-output degradation, repair, model resolution), `integrations/integrations.test.ts` (Tavily request shape, errors, primary-source rules; GitHub URL parsing, HMAC verification, token not forwarded on log redirect, permission hints), `db/store.test.ts` (round trip, cascade, filters, dedupe, interrupted runs, settings), `app.test.ts` (webhook auth, duplicate deliveries, ignored events, validation errors, 404/412, no secrets in status, settings, public demo restrictions), `runner/runner.test.ts` (docker hardening flags, argv-only test names, selection validation, Surefire parsing, patch policy, **real Docker reproduce plus fix validation**).

## Sandbox experiments actually executed

Stored investigations (heuristic reasoning mode; experiments live):

**flaky-jest** (`inv_mva0fb4v2180ee83`) → flaky_test, confirmed, strong
| Experiment | Commit | Result (exit codes) |
|---|---|---|
| reproduce (CI seed 1849273600) | 8aac301d | 1/1 failed `[1]` |
| repeat 10× (seeds 65537·k) | 8aac301d | 2/10 failed `[0,1,0,0,0,1,0,0,0,0]`; observed 20%, 95% CI 6–51% |
| compare parent | 33b2d8e8 | 2/3 failed `[1,0,1]` |
| validate quarantine 10× | 8aac301d + patch | 0/10 failed |
| regression suite | 8aac301d + patch | 0/1 failed |

**code-regression** (`inv_mva0fb1nc7070ffa`) → code_regression, confirmed, strong
| Experiment | Commit | Result |
|---|---|---|
| reproduce | bf957272 | 1/1 failed `[1]` |
| repeat 10× | bf957272 | 10/10 failed |
| compare parent | e737f841 | 0/3 failed |
| validate revert 3× | bf957272 + patch | 0/3 failed |
| regression suite | bf957272 + patch | 0/1 failed |

**maven-dependency** (`inv_mva0fayf4a50f5f9`) → dependency_regression, confirmed, strong
| Experiment | Commit | Result |
|---|---|---|
| reproduce (`mvn -B -o test`) | 89c36cf2 | 1/1 failed `[1]`: `cannot find symbol toStringHelper` |
| repeat | — | skipped (compile errors are deterministic) |
| compare parent | 3b1e09cf | 0/1 failed (5/5 tests pass) |
| external search | — | skipped (no Tavily key) |
| validate pin to 20.0, 3× | 89c36cf2 + patch | 0/3 failed |

Ground truth for the Maven scenario was checked independently: `javap` on `guava-20.0.jar` lists `Objects.toStringHelper(...)`; `guava-21.0.jar` does not.

Flake fixture ground truth: over seeds 1–100,000 the ordering test fails 18.3% of the time (computed directly from `planDeliveries`).

## Real GitHub run (read-only)

`POST /api/investigations/github` with `https://github.com/expressjs/express/actions/runs/37953351037` (token from the local `gh` session, passed only through the process environment):

- Run metadata, head SHA `72fe09ed24`, parent `cf6722bf89`, branch `test/native-http-passthrough`, failed job *Node.js 16 - ubuntu-latest*
- Log downloaded via signed redirect: 2,216 lines (145 KB); 1 secret-like value redacted; 3 excerpts (2.9 KB) selected
- Signature: `mocha: node:http pass-through res should support res.writeEarlyHints() — Uncaught AssertionError [ERR_ASSERTION]: …`
- Experiments: honestly skipped (Mocha is not yet supported in the sandbox); verdict **inconclusive** with that limitation
- Re-submitting the same run URL returned the same investigation (`duplicate: true`)
- Fork-PR head commit `72fe09ed24` checked out successfully via fetch-by-SHA fallback

Defects found by this real-world test and fixed: zero-job failed runs produced a vague error (now explained); fork-PR commits were not checkout-able; remediation attempted a checkout when no experiment could run; Mocha failures were not parsed.

## To complete verification

1. Add `NEBIUS_API_KEY` to `.env`, restart, and on **Integrations** click *Send a test inference*. Record the resolved model IDs here. Then run each scenario in `live` mode (`npx tsx scripts/run-investigation.ts <id> live`) and confirm the **Model calls** tab shows `ok` calls with token counts. Run `npm run demo:export-replays` to copy `data/replays/*.json` into `fixtures/scenarios/<id>/replay.json` so the public demo can replay real Nemotron output.
2. Add `TAVILY_API_KEY`, click *Run a test search*, and re-run `maven-dependency`; the **Sources** tab should list Guava release-note results.
3. Publish the repository, deploy with `deploy/setup-vm.sh`, and verify `https://<host>/api/health` plus one remote sample investigation.
4. Optional: push a demo repository with a failing workflow, then verify webhook → auto-investigation and draft PR creation.
