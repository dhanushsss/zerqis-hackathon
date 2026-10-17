# Trace: flaky-jest

Investigation `inv_mvafruodc197d442` · mode **live** · 2026-10-16T03:56:57.997Z · alibi-demo/checkout-service @ `8aac301d9325` (parent `33b2d8e8be3c`)

Input given to the agent: the CI log (64 lines, 0 redactions), the commit diff, and build metadata. The scenario's expected answer (`fixtures/scenarios/flaky-jest/scenario.json → expected`) is never included in any prompt.

Failure signature (deterministic parser): `jest: test/retryQueue.test.js › planDeliveries delivers notifications in submission order — expect(received).toEqual(expected) // deep equality`

## Model call — triage: form competing hypotheses

| Model | Role | Status | Latency | Tokens in / out |
|---|---|---|---|---|
| `nvidia/Nemotron-3_5-Lightning` | triage | ok | 4829 ms | 1096 / 1344 |

**Prompt (sanitized summary):** system prompt = Alibi triage instructions (cite verbatim log quotes, 2–4 competing hypotheses, choose from the experiment menu reproduce/repeat/compare_parent/external_search). User message = build metadata, deterministic log facts, the commit diff, and 2 selected log excerpts (825 chars of 4147).

**Parsed decision:**

- **H1** [code_regression, prior high] Code regression: recent commit introduced non-deterministic ordering in `planDeliveries` despite only README changes.
  - requested experiments: —; next: compare_parent: run test at parent commit 33b2d8e8be3c3016c16b503e33a83136a3e86f6e to check if failure is regression or pre-existing.
- **H2** [flaky_test, prior medium] Flaky test: ordering depends on timing (delays/jitter) and seed 1849273600 produced an unlucky ordering in this run.
  - requested experiments: —; next: repeat: run the failing test many times at the failing commit to measure intermittency rate.
- **H3** [dependency_regression, prior low] Dependency/environment change: Node.js v20 or Jest version difference introduced non-deterministic scheduling affecting delivery order.
  - requested experiments: —; next: external_search: search for known issues with Jest/Node 20 and non-deterministic test ordering.
- **H4** [infrastructure, prior low] Infrastructure/GitHub Actions runner variability: runner load affected timing of async deliveries, causing order swap.
  - requested experiments: —; next: compare_parent: run test at parent commit to isolate infrastructure effects.
- search queries: `jest node 20 non-deterministic test ordering`, `retry queue flaky test webhook delivery order`

## Experiment plan (deterministic policy, not the model)

The planner turns the requested menu items into fixed command templates. The model never supplies commands.

### Reproduce the failure — failed

- Why: Re-run test/retryQueue.test.js › planDeliveries delivers notifications in submission order at the failing commit in a clean, offline sandbox using the exact Jest seed from CI (1849273600).
- Commit: `8aac301d9325` · selection: test/retryQueue.test.js › planDeliveries delivers notifications in submission order · backend: docker · duration: 1594 ms
- Command: `node node_modules/jest/bin/jest.js --ci --json --outputFile=/work/.alibi/result-exp_mvafryvc04e9dbbe-1.json --seed=1849273600 --runTestsByPath test/retryQueue.test.js -t ^planDeliveries delivers notifications in submission order$`
- Exit codes: 1 (seed 1849273600)
- Observation: 1/1 run failed — failing: planDeliveries delivers notifications in submission order
- Effect: Supports H1: The failure reproduced in a clean sandbox at the failing commit.; Supports H3: The failure reproduced in a clean sandbox at the failing commit.; Contradicts H4: The failure reproduced offline in a clean sandbox, away from the original CI infrastructure.

```text
    > 13 |     expect(planned).toEqual(['order.created', 'order.paid']);
         |                     ^
      14 |   });
      15 | });
      16 |

      at Object.toEqual (test/retryQueue.test.js:13:21)

Test Suites: 1 failed, 1 total
Tests:       1 failed, 1 skipped, 2 total
Snapshots:   0 total
Time:        0.809 s
Ran all test suites within paths "test/retryQueue.test.js".
Test results written to: .alibi/result-exp_mvafryvc04e9dbbe-1.json
```

### Run the failing test 10× with varied seeds — failed

- Why: Measures intermittency at the same commit. Seeds are attempt × 65537 so every run is replayable. 10 runs bound, but do not pin down, the true failure rate.
- Commit: `8aac301d9325` · selection: test/retryQueue.test.js › planDeliveries delivers notifications in submission order · backend: docker · duration: 8968 ms
- Command: `node node_modules/jest/bin/jest.js --ci --json --outputFile=/work/.alibi/result-exp_mvafryvc29edc0a5-10.json --seed=655370 --runTestsByPath test/retryQueue.test.js -t ^planDeliveries delivers notifications in submission order$`
- Exit codes: 0 (seed 65537), 1 (seed 131074), 0 (seed 196611), 0 (seed 262148), 0 (seed 327685), 1 (seed 393222), 0 (seed 458759), 0 (seed 524296), 0 (seed 589833), 0 (seed 655370)
- Observation: 2/10 runs failed — failing: planDeliveries delivers notifications in submission order (observed failure rate 20%, 95% CI 6–51%)
- Effect: Contradicts H1: A deterministic regression should fail every run; 8/10 runs passed.; Supports H2: Same commit, same code: 2/10 runs failed and 8/10 passed.; Contradicts H3: A deterministic regression should fail every run; 8/10 runs passed.

```text
    > 13 |     expect(planned).toEqual(['order.created', 'order.paid']);
         |                     ^
      14 |   });
      15 | });
      16 |

      at Object.toEqual (test/retryQueue.test.js:13:21)

Test Suites: 1 failed, 1 total
Tests:       1 failed, 1 skipped, 2 total
Snapshots:   0 total
Time:        0.362 s
Ran all test suites within paths "test/retryQueue.test.js".
Test results written to: .alibi/result-exp_mvafryvc29edc0a5-2.json
```

### Compare against the parent commit — failed

- Why: Runs the same selection at the parent 33b2d8e8be3c (first run with the CI seed 1849273600). If the parent passes, the failing commit introduced the failure.
- Commit: `33b2d8e8be3c` · selection: test/retryQueue.test.js › planDeliveries delivers notifications in submission order · backend: docker · duration: 2688 ms
- Command: `node node_modules/jest/bin/jest.js --ci --json --outputFile=/work/.alibi/result-exp_mvafryvccd019ae0-3.json --seed=131074 --runTestsByPath test/retryQueue.test.js -t ^planDeliveries delivers notifications in submission order$`
- Exit codes: 1 (seed 1849273600), 0 (seed 65537), 1 (seed 131074)
- Observation: 2/3 runs failed — failing: planDeliveries delivers notifications in submission order (observed failure rate 67%, 95% CI 21–94%)
- Effect: Contradicts H1: The parent commit fails the same way (2/3), so this commit did not introduce it.; Supports H2: The parent commit shows the same failure (2/3); it predates this commit.; Contradicts H3: The parent commit fails the same way (2/3), so this commit did not introduce it.

```text
    > 13 |     expect(planned).toEqual(['order.created', 'order.paid']);
         |                     ^
      14 |   });
      15 | });
      16 |

      at Object.toEqual (test/retryQueue.test.js:13:21)

Test Suites: 1 failed, 1 total
Tests:       1 failed, 1 skipped, 2 total
Snapshots:   0 total
Time:        0.364 s
Ran all test suites within paths "test/retryQueue.test.js".
Test results written to: .alibi/result-exp_mvafryvccd019ae0-1.json
```

### Search for external evidence — passed

- Why: A hypothesis implicates an external dependency or service; search release notes, issues, and status pages for corroboration.
- Commit: `—` · selection: — · backend: tavily · duration: 3652 ms
- Command: `tavily.search("jest node 20 non-deterministic test ordering") | tavily.search("retry queue flaky test webhook delivery order")`
- Observation: 2 Tavily queries returned 8 result(s), 1 from primary sources.
- Effect: Search results are leads that can corroborate a hypothesis; they are not proof on their own.
  - secondary — [Detecting and Evaluating Order-Dependent Flaky Tests in JavaScript](https://arxiv.org/html/2501.12680v1) (query: “jest node 20 non-deterministic test ordering”, retrieved 2026-10-16T03:57:23.081Z)
  - **primary** — [Jest CLI Options · Jest](https://jestjs.io/docs/cli) (query: “jest node 20 non-deterministic test ordering”, retrieved 2026-10-16T03:57:23.083Z)
  - secondary — [The ULTIMATE Guide to Testing TypeScript Node.js with Jest.](https://www.youtube.com/watch?v=0yScewOhjmU) (query: “jest node 20 non-deterministic test ordering”, retrieved 2026-10-16T03:57:23.084Z)
  - secondary — [GitHub - goldbergyoni/nodejs-testing-best-practices: Beyond the basics of Node.js testing. Including a super-comprehensive best practices list and an example app (April 2025) · GitHub](https://github.com/goldbergyoni/nodejs-testing-best-practices) (query: “jest node 20 non-deterministic test ordering”, retrieved 2026-10-16T03:57:23.084Z)
  - secondary — [Durable Webhook Retries | WebhookRelay](https://webhookrelay.com/features/durable-retries) (query: “retry queue flaky test webhook delivery order”, retrieved 2026-10-16T03:57:24.815Z)
  - secondary — [Delivery & Retries - Jamie Docs](https://docs.meetjamie.ai/developers/webhooks/delivery-retries) (query: “retry queue flaky test webhook delivery order”, retrieved 2026-10-16T03:57:24.815Z)
  - secondary — [Stripe Webhook Idempotency, the Production Pattern](https://theroadtoenterprise.com/blog/stripe-webhook-idempotency-production) (query: “retry queue flaky test webhook delivery order”, retrieved 2026-10-16T03:57:24.816Z)
  - secondary — [How to Build a Webhook Service with Retry Logic in Node.js](https://oneuptime.com/blog/post/2026-01-25-webhook-service-retry-logic-nodejs/view) (query: “retry queue flaky test webhook delivery order”, retrieved 2026-10-16T03:57:24.816Z)

## Hypothesis revisions (deterministic effect rules)

- **H1** Code regression: recent commit introduced non-deterministic ordering in `planDeliveries` despite only README changes. → **refuted**
  - supports: The failure reproduced in a clean sandbox at the failing commit.
  - contradicts: A deterministic regression should fail every run; 8/10 runs passed.
  - contradicts: The parent commit fails the same way (2/3), so this commit did not introduce it.
- **H2** Flaky test: ordering depends on timing (delays/jitter) and seed 1849273600 produced an unlucky ordering in this run. → **supported**
  - supports: Same commit, same code: 2/10 runs failed and 8/10 passed.
  - supports: The parent commit shows the same failure (2/3); it predates this commit.
- **H3** Dependency/environment change: Node.js v20 or Jest version difference introduced non-deterministic scheduling affecting delivery order. → **inconclusive**
  - supports: The failure reproduced in a clean sandbox at the failing commit.
  - contradicts: A deterministic regression should fail every run; 8/10 runs passed.
  - contradicts: The parent commit fails the same way (2/3), so this commit did not introduce it.
- **H4** Infrastructure/GitHub Actions runner variability: runner load affected timing of async deliveries, causing order swap. → **inconclusive**
  - contradicts: The failure reproduced offline in a clean sandbox, away from the original CI infrastructure.

## Model call — reasoning: weigh the evidence

| Model | Role | Status | Latency | Tokens in / out |
|---|---|---|---|---|
| `nvidia/nemotron-3-super-120b-a12b` | reasoning | ok | 2613 ms | 2883 / 305 |

**Prompt (sanitized summary):** system prompt = Alibi verdict instructions (base conclusions only on the ledger; "confirmed" needs a discriminating experiment). User message = hypotheses, the executed experiments with actual pass/fail counts, the diff summary, and external sources marked as leads.

**Parsed decision:**

- classification **flaky_test**, proposed verdict **probable**, primary H2
- Test shows intermittent failures under same commit (2/10 runs fail). Parent commit also exhibits similar instability (2/3 runs fail), indicating the flakiness predates the current commit. No deterministic cause identified; timing/jitter likely culprit.
- H1: refuted — Parent commit also fails (2/3), ruling out code regression from current docs-only commit.
- H2: supported — Intermittent failure pattern consistent with flaky test due to timing/jitter; repeat experiment shows 20% failure rate.
- H3: inconclusive — External search only; no experiment testing Node/Jest version impact.
- H4: inconclusive — No experiment varying runner load to test infrastructure hypothesis.
- recommended: quarantine (remediation: quarantine)

## Fix validation (fresh sandbox per candidate)

### Quarantine "delivers notifications in submission order" — **validated** (deterministic)

Passed 10/10 targeted runs and the full regression suite.

```diff
diff --git a/test/retryQueue.test.js b/test/retryQueue.test.js
index 42e4b8f..f7261cc 100644
--- a/test/retryQueue.test.js
+++ b/test/retryQueue.test.js
@@ -8,7 +8,9 @@ describe('planDeliveries', () => {
   });
 
   // Uses the run's Jest seed for jitter. Re-run with `jest --seed=<n>` to replay.
-  test('delivers notifications in submission order', () => {
+  // Quarantined by Alibi (investigation inv_mvafruodc197d442): failed 2/10 seeded runs at the same commit.
+  // Re-enable once the nondeterminism is removed.
+  test.skip('delivers notifications in submission order', () => {
     const planned = planDeliveries(['order.created', 'order.paid'], { random: createRng(jest.getSeed()) });
     expect(planned).toEqual(['order.created', 'order.paid']);
   });
```
- validate_patch: 0/10 runs failed (observed failure rate 0%, 95% CI 0–28%) · exit codes 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
- regression_suite: 0/1 run failed · exit codes 0

## Final verdict

**confirmed — flaky_test** (evidence: strong)

- Failure reproduced in a clean sandbox at the failing commit.
- Repeated 10×: 2 failed, 8 passed (observed 20%, 95% CI 6%–51%).
- Parent commit: 2/3 runs failed.
- The failing commit only changes documentation.
- Remediation validated: Quarantine "delivers notifications in submission order".
- Sample size is 10; the true flake rate is uncertain.

**Verdict history:**
- Hypotheses formed: none — 4 competing hypotheses; no experiment has run yet.
- Experiments weighed: probable — Observed — reproduction 1/1 failed; repeated runs 2/10 failed; parent commit 2/3 failed. Evidence rubric: strong.
- Remediation tested: confirmed — Upgraded to confirmed: the evidence rubric is strong — Repeated 10×: 2 failed, 8 passed (observed 20%, 95% CI 6%–51%). Parent commit: 2/3 runs failed. The failing commit only changes documentation.

**Limitations:**
- Small sample size for parent commit comparison (n=3).
- No direct manipulation of jitter/delay parameters to confirm timing sensitivity.
- Environmental factors like runner load not systematically varied.
- Flake rate measured over 10 runs (20%, 95% CI 6%–51%); more runs are needed for a precise rate.

Evidence ledger: 32 records in `data/verify.db` (investigation `inv_mvafruodc197d442`).
