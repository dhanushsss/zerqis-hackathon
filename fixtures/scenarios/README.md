# Demo scenarios

Three deterministic scenarios exercise the three main failure classes. Each one is a real git repository built from commit overlays in `commits/` with fixed authors and dates, so commit SHAs are identical on every machine. Each also has a **CI log fixture** (`ci-log.txt`) captured by actually running the CI command on the failing commit in the Zerqis sandbox and wrapping the output in GitHub Actions log format.

```bash
npm run demo:build            # builds data/demo-repos/<id> (idempotent; --force rebuilds)
npm run demo:capture-logs     # re-captures ci-log.txt for every scenario from real runs
npx tsx scripts/run-investigation.ts <id> [auto|live|replay|heuristic]
```

Reproduce any failure by hand:

```bash
cd data/demo-repos/<id>
git checkout HEAD      # failing commit;  git checkout HEAD~1 for the parent
npm ci && npx jest     # or: mvn -B test
```

---

## `flaky-jest` — checkout-service

| | |
|---|---|
| Failing commit | `8aac301d9325` docs: document retry queue tuning knobs (README only) |
| Parent | `33b2d8e8be3c` |
| Failure | `planDeliveries › delivers notifications in submission order` — `toEqual` order mismatch |
| Source of nondeterminism | `planDeliveries` adds `random() * jitterMs` to each delivery time. The test draws randomness from `jest.getSeed()`, so a run can be replayed with `jest --seed=<n>`. Across 100,000 seeds the true failure rate is **18.3%** |
| CI seed | `1849273600` (printed in the log by `--showSeed`; this seed fails) |

**Expected experiments**
1. *Reproduce* with `--seed=1849273600` at the failing commit → **fails** (exact replay of the CI run).
2. *Repeat* 10× with seeds `65537·k` → **2/10 fail** (attempts 2 and 6); observed 20%, Wilson 95% CI 6–51%.
3. *Compare parent* with the CI seed plus two seeds → **2/3 fail**: the failure predates the commit.
4. *Validate quarantine* (`test.skip` with an evidence comment) → test file passes 10/10 seeded runs; full suite passes.

**Expected ledger (abridged):** observed facts (failing test, CI seed, docs-only diff) → hypotheses (flaky test vs. infrastructure, plus code regression when a model proposes it) → reproduce result (contradicts infrastructure: it fails offline) → repeat result (supports flaky, contradicts regression) → parent result (supports flaky) → quarantine validated → final verdict.

**Expected diagnosis:** `flaky_test`, **confirmed**, strong evidence; remediation *quarantine*. The limitation notes that 10 runs bound but do not pin down the flake rate.

---

## `maven-dependency` — inventory-api

| | |
|---|---|
| Failing commit | `89c36cf227a2` build(deps): bump com.google.guava:guava from 20.0 to 21.0 (dependabot) |
| Parent | `3b1e09cfb847` |
| Failure | `InventoryItem.java:[50,23] cannot find symbol — method toStringHelper(InventoryItem) in class com.google.common.base.Objects` |
| Ground truth | Guava 21.0 removed `com.google.common.base.Objects.toStringHelper` (deprecated since 18.0 in favor of `MoreObjects.toStringHelper`). Verified with `javap` against the published 20.0 and 21.0 JARs |

**Expected experiments**
1. *Reproduce* (`mvn -B -o test`, offline) → **fails** at compilation.
2. *Repeat* → **skipped**: compile errors are deterministic.
3. *Compare parent* → **passes** (5/5 tests).
4. *External search* (when `TAVILY_API_KEY` is set) → queries such as `guava 21.0 release notes com.google.common.base.Objects.toStringHelper removed`.
5. *Validate pin* (`<guava.version>20.0`) → full build and 5 tests pass, 3/3 runs. With a model, a second, model-written candidate is validated the same way. In the 2026-10-16 live runs, Ultra's candidate rewrote `toString()` and failed `InventoryItemTest#rendersReadableToString` 3/3, so it was rejected.

**Expected diagnosis:** `dependency_regression`, **confirmed**, strong evidence; remediation *dependency_pin*.

---

## `code-regression` — pricing-engine

| | |
|---|---|
| Failing commit | `bf9572720abd` refactor: table-driven discount tiers and frozen tax rates |
| Parent | `e737f84129fa` |
| Failure | `discountRate applies 10% at exactly the $100.00 threshold` and `applies 15% from $250` |
| Ground truth | The refactor replaced `subtotalCents >= tier.minCents` with `subtotalCents > t.minCents`. The same commit also refactors `tax.js` harmlessly |

**Expected experiments**
1. *Reproduce* → **fails** (2 tests).
2. *Repeat* 10× (scheduled because a flaky hypothesis exists) → **10/10 fail**: refutes flakiness.
3. *Compare parent* → **0/3 fail**.
4. *Validate fix*: without a model, a deterministic revert of `src/discounts.js` and `src/tax.js` to the parent passes targeted runs and the full suite. With a model, a one-line `>` → `>=` patch is validated as well.

**Expected diagnosis:** `code_regression`, **confirmed**, strong evidence; remediation *code_patch*.

---

Pipeline regression tests for these scenarios: `server/src/analysis/analysis.test.ts` (signatures from each recorded log), `server/src/runner/runner.test.ts` (real sandbox reproduce plus fix validation on `code-regression`), and `e2e/demo.spec.ts` (full UI run).
