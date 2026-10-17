# Trace: code-regression

Investigation `inv_mvafpl2qc5b70829` · mode **live** · 2026-10-16T03:55:12.242Z · alibi-demo/pricing-engine @ `bf9572720abd` (parent `e737f84129fa`)

Input given to the agent: the CI log (74 lines, 0 redactions), the commit diff, and build metadata. The scenario's expected answer (`fixtures/scenarios/code-regression/scenario.json → expected`) is never included in any prompt.

Failure signature (deterministic parser): `jest: test/discounts.test.js › discountRate applies 10% at exactly the $100.00 threshold (+1 more) — expect(received).toBe(expected) // Object.is equality`

## Model call — triage: form competing hypotheses

| Model | Role | Status | Latency | Tokens in / out |
|---|---|---|---|---|
| `nvidia/Nemotron-3_5-Lightning` | triage | ok | 2825 ms | 1962 / 655 |

**Prompt (sanitized summary):** system prompt = Alibi triage instructions (cite verbatim log quotes, 2–4 competing hypotheses, choose from the experiment menu reproduce/repeat/compare_parent/external_search). User message = build metadata, deterministic log facts, the commit diff, and 3 selected log excerpts (1697 chars of 4795).

**Parsed decision:**

- **H1** [code_regression, prior high] Operator regression: `>=` changed to `>` in tier qualification, causing exact threshold amounts to fall through to the default rate 0.
  - requested experiments: compare_parent, reproduce; next: compare_parent
- **H2** [code_regression, prior medium] New `roundCents` function silently truncates the discount calculation, producing incorrect rates for edge-case subtotals.
  - requested experiments: reproduce; next: reproduce
- **H3** [infrastructure, prior low] Tax.js `Object.freeze` and `hasOwnProperty` change introduced a module loading side-effect that corrupts the discounts module scope.
  - requested experiments: external_search; next: external_search
- search queries: `alibi CI forensics discount tier operator regression`, `jest test discountRate threshold > vs >=`

## Experiment plan (deterministic policy, not the model)

The planner turns the requested menu items into fixed command templates. The model never supplies commands.

### Reproduce the failure — failed

- Why: Re-run test/discounts.test.js at the failing commit in a clean, offline sandbox.
- Commit: `bf9572720abd` · selection: test/discounts.test.js · backend: docker · duration: 868 ms
- Command: `node node_modules/jest/bin/jest.js --ci --json --outputFile=/work/.alibi/result-exp_mvafpnqj01f7d577-1.json --runTestsByPath test/discounts.test.js`
- Exit codes: 1
- Observation: 1/1 run failed — failing: discountRate applies 10% at exactly the $100.00 threshold; discountRate applies 15% from $250
- Effect: Supports H1: The failure reproduced in a clean sandbox at the failing commit.; Supports H2: The failure reproduced in a clean sandbox at the failing commit.; Contradicts H3: The failure reproduced offline in a clean sandbox, away from the original CI infrastructure.

```text
    > 14 |     expect(discountRate(25000)).toBe(0.15);
         |                                 ^
      15 |   });
      16 |
      17 |   test('applies 20% from $500', () => {

      at Object.toBe (test/discounts.test.js:14:33)

Test Suites: 1 failed, 1 total
Tests:       2 failed, 3 passed, 5 total
Snapshots:   0 total
Time:        0.362 s
Ran all test suites within paths "test/discounts.test.js".
Test results written to: .alibi/result-exp_mvafpnqj01f7d577-1.json
```

### Run the failing test 10× with varied seeds — failed

- Why: Measures intermittency at the same commit. Seeds are attempt × 65537 so every run is replayable. 10 runs bound, but do not pin down, the true failure rate.
- Commit: `bf9572720abd` · selection: test/discounts.test.js · backend: docker · duration: 8648 ms
- Command: `node node_modules/jest/bin/jest.js --ci --json --outputFile=/work/.alibi/result-exp_mvafpnqjcf023574-10.json --seed=655370 --runTestsByPath test/discounts.test.js`
- Exit codes: 1 (seed 65537), 1 (seed 131074), 1 (seed 196611), 1 (seed 262148), 1 (seed 327685), 1 (seed 393222), 1 (seed 458759), 1 (seed 524296), 1 (seed 589833), 1 (seed 655370)
- Observation: 10/10 runs failed — failing: discountRate applies 10% at exactly the $100.00 threshold; discountRate applies 15% from $250 (observed failure rate 100%, 95% CI 72–100%)
- Effect: Supports H1: Failed deterministically: 10/10 runs.; Supports H2: Failed deterministically: 10/10 runs.

```text
    > 14 |     expect(discountRate(25000)).toBe(0.15);
         |                                 ^
      15 |   });
      16 |
      17 |   test('applies 20% from $500', () => {

      at Object.toBe (test/discounts.test.js:14:33)

Test Suites: 1 failed, 1 total
Tests:       2 failed, 3 passed, 5 total
Snapshots:   0 total
Time:        0.355 s
Ran all test suites within paths "test/discounts.test.js".
Test results written to: .alibi/result-exp_mvafpnqjcf023574-1.json
```

### Compare against the parent commit — passed

- Why: Runs the same selection at the parent e737f84129fa. If the parent passes, the failing commit introduced the failure.
- Commit: `e737f84129fa` · selection: test/discounts.test.js · backend: docker · duration: 2597 ms
- Command: `node node_modules/jest/bin/jest.js --ci --json --outputFile=/work/.alibi/result-exp_mvafpnqjd6b637ff-3.json --seed=131074 --runTestsByPath test/discounts.test.js`
- Exit codes: 0, 0 (seed 65537), 0 (seed 131074)
- Observation: 0/3 runs failed (observed failure rate 0%, 95% CI 0–56%)
- Effect: Supports H1: The parent commit passed 3/3 runs of the same selection.; Supports H2: The parent commit passed 3/3 runs of the same selection.

### Search for external evidence — passed

- Why: A hypothesis implicates an external dependency or service; search release notes, issues, and status pages for corroboration.
- Commit: `—` · selection: — · backend: tavily · duration: 4866 ms
- Command: `tavily.search("alibi CI forensics discount tier operator regression") | tavily.search("jest test discountRate threshold > vs >=")`
- Observation: 2 Tavily queries returned 8 result(s), 0 from primary sources.
- Effect: Search results are leads that can corroborate a hypothesis; they are not proof on their own.
  - secondary — [Alibi - Cyber Forensics | Tactical Equipment](https://alibiglobal.in) (query: “alibi CI forensics discount tier operator regression”, retrieved 2026-10-16T03:55:34.757Z)
  - secondary — [Alibi Global's Success: Scaling Cyber Forensics Nationwide ...](https://www.youtube.com/watch?v=kryogNuYzEk&xstg=CAMSBhUDzO3xHw%3D%3D) (query: “alibi CI forensics discount tier operator regression”, retrieved 2026-10-16T03:55:34.758Z)
  - secondary — [Solve Cloud Forensics at Scale](https://www.darktrace.com/forensic-acquisition-investigation) (query: “alibi CI forensics discount tier operator regression”, retrieved 2026-10-16T03:55:34.758Z)
  - secondary — [From Alert to Evidence: Evaluating AI Agents for Cyber Forensic Triage | SANS Institute](https://www.sans.edu/cyber-research/from-alert-evidence-evaluating-ai-agents-cyber-forensic-triage) (query: “alibi CI forensics discount tier operator regression”, retrieved 2026-10-16T03:55:34.758Z)
  - secondary — [Configuring code coverage in Jest, the right way](https://www.valentinog.com/blog/jest-coverage) (query: “jest test discountRate threshold > vs >=”, retrieved 2026-10-16T03:55:37.237Z)
  - secondary — [Vitest vs Jest](https://www.speakeasy.com/blog/vitest-vs-jest) (query: “jest test discountRate threshold > vs >=”, retrieved 2026-10-16T03:55:37.237Z)
  - secondary — [Jest Code Coverage: Branches, Lines, Functions and Thresholds](https://www.youtube.com/watch?v=Kf0OCNmoIeA&vl=en-US&xstg=CAMSBhUDzO3xHw%3D%3D) (query: “jest test discountRate threshold > vs >=”, retrieved 2026-10-16T03:55:37.238Z)
  - secondary — [Jest testing: Top features and how to use them - LogRocket Blog](https://blog.logrocket.com/jest-testing-top-features) (query: “jest test discountRate threshold > vs >=”, retrieved 2026-10-16T03:55:37.238Z)

## Hypothesis revisions (deterministic effect rules)

- **H1** Operator regression: `>=` changed to `>` in tier qualification, causing exact threshold amounts to fall through to the default rate 0. → **supported**
  - supports: The failure reproduced in a clean sandbox at the failing commit.
  - supports: Failed deterministically: 10/10 runs.
  - supports: The parent commit passed 3/3 runs of the same selection.
- **H2** New `roundCents` function silently truncates the discount calculation, producing incorrect rates for edge-case subtotals. → **refuted**
  - supports: The failure reproduced in a clean sandbox at the failing commit.
  - supports: Failed deterministically: 10/10 runs.
  - supports: The parent commit passed 3/3 runs of the same selection.
- **H3** Tax.js `Object.freeze` and `hasOwnProperty` change introduced a module loading side-effect that corrupts the discounts module scope. → **refuted**
  - contradicts: The failure reproduced offline in a clean sandbox, away from the original CI infrastructure.

## Model call — reasoning: weigh the evidence

| Model | Role | Status | Latency | Tokens in / out |
|---|---|---|---|---|
| `nvidia/nemotron-3-super-120b-a12b` | reasoning | ok | 2269 ms | 2218 / 231 |

**Prompt (sanitized summary):** system prompt = Alibi verdict instructions (base conclusions only on the ledger; "confirmed" needs a discriminating experiment). User message = hypotheses, the executed experiments with actual pass/fail counts, the diff summary, and external sources marked as leads.

**Parsed decision:**

- classification **code_regression**, proposed verdict **confirmed**, primary H1
- Discount logic uses strict greater-than instead of greater-or-equal, causing exact thresholds ($100, $250) to skip intended tiers.
- H1: supported — Deterministic failure reproduced at current commit; parent commit passes same test; failure persists across retries.
- H2: refuted — No experiment tested H2; but given H1 explains all observations precisely, H2 is unnecessary.
- H3: refuted — External search yielded no actionable evidence; no experiment isolated tax-module side effects.
- recommended: code_patch (remediation: code_patch)

## Model call — deep: write a targeted fix

| Model | Role | Status | Latency | Tokens in / out |
|---|---|---|---|---|
| `nvidia/Nemotron-3-Ultra-550b-a55b` | deep | ok | 1278 ms | 2459 / 388 |

**Prompt (sanitized summary):** system prompt = smallest fix, full file contents, no CI/test edits. User message = root cause, failure signature, sandbox failure output, commit diff, current contents of the implicated files.

**Parsed decision:**

- The root cause is the operator regression in discountRate: the condition changed from `>=` to `>` in the tier qualification logic. This causes exact threshold amounts (10000, 25000, 50000 cents) to fall through to the default rate 0. The fix is to change the comparison back to `>=` so that orders meeting the exact threshold qualify for the tier.
- files: `src/discounts.js`

## Fix validation (fresh sandbox per candidate)

### Targeted fix by Nemotron-3-Ultra-550b-a55b — **validated** (model)

Passed 3/3 targeted runs and the full regression suite.

```diff
diff --git a/src/discounts.js b/src/discounts.js
index 3aaa7ed..e268867 100644
--- a/src/discounts.js
+++ b/src/discounts.js
@@ -9,7 +9,7 @@ const TIERS = [
 ];
 
 function discountRate(subtotalCents) {
-  const tier = TIERS.find((t) => subtotalCents > t.minCents);
+  const tier = TIERS.find((t) => subtotalCents >= t.minCents);
   return tier ? tier.rate : 0;
 }
```
- validate_patch: 0/3 runs failed (observed failure rate 0%, 95% CI 0–56%) · exit codes 0, 0, 0
- regression_suite: 0/1 run failed · exit codes 0

### Revert src/discounts.js, src/tax.js to the parent commit — **validated** (deterministic)

Passed 3/3 targeted runs and the full regression suite.

```diff
diff --git a/src/discounts.js b/src/discounts.js
index 3aaa7ed..91b0fa3 100644
--- a/src/discounts.js
+++ b/src/discounts.js
@@ -1,7 +1,7 @@
 'use strict';
 
-// Volume discount tiers, highest first. An order qualifies for a tier when its
-// subtotal exceeds `minCents`.
+// Volume discount tiers. An order qualifies for a tier when its subtotal is at
+// least `minCents`.
 const TIERS = [
   { minCents: 50000, rate: 0.2 },
   { minCents: 25000, rate: 0.15 },
@@ -9,17 +9,15 @@ const TIERS = [
 ];
 
 function discountRate(subtotalCents) {
-  const tier = TIERS.find((t) => subtotalCents > t.minCents);
-  return tier ? tier.rate : 0;
-}
-
-function roundCents(value) {
-  return Math.floor(value);
+  for (const tier of TIERS) {
+    if (subtotalCents >= tier.minCents) return tier.rate;
+  }
+  return 0;
 }
 
 function applyDiscount(subtotalCents) {
   const rate = discountRate(subtotalCents);
-  const discountCents = roundCents(subtotalCents * rate);
+  const discountCents = Math.floor(subtotalCents * rate);
   return { rate, discountCents, totalCents: subtotalCents - discountCents };
 }
 
diff --git a/src/tax.js b/src/tax.js
index 69fa225..20c6b20 100644
--- a/src/tax.js
+++ b/src/tax.js
@@ -1,9 +1,9 @@
 'use strict';
 
-const RATES = Object.freeze({ CA: 0.0725, NY: 0.04, TX: 0.0625 });
+const RATES = { CA: 0.0725, NY: 0.04, TX: 0.0625 };
 
 function salesTax(amountCents, state) {
-  const rate = Object.prototype.hasOwnProperty.call(RATES, state) ? RATES[state] : 0;
+  const rate = RATES[state] ?? 0;
   return Math.round(amountCents * rate);
 }
```
- validate_patch: 0/3 runs failed (observed failure rate 0%, 95% CI 0–56%) · exit codes 0, 0, 0
- regression_suite: 0/1 run failed · exit codes 0

## Final verdict

**confirmed — code_regression** (evidence: strong)

- Failure reproduced in a clean sandbox at the failing commit.
- Repeated 10×: 10 failed, 0 passed (observed 100%, 95% CI 72%–100%).
- Parent commit: 0/3 runs failed.
- A candidate fix passed the failing selection and the regression suite (Targeted fix by Nemotron-3-Ultra-550b-a55b; Revert src/discounts.js, src/tax.js to the parent commit).

**Verdict history:**
- Hypotheses formed: none — 3 competing hypotheses; no experiment has run yet.
- Experiments weighed: probable — Observed — reproduction 1/1 failed; repeated runs 10/10 failed; parent commit 0/3 failed. Evidence rubric: moderate. "Confirmed" requires strong experimental evidence; the evidence rubric rates it moderate.
- Remediation tested: confirmed — Evidence rubric: strong.

**Limitations:**
- Only tested discount logic; did not isolate roundCents behavior or tax module interactions directly.

Evidence ledger: 30 records in `data/verify.db` (investigation `inv_mvafpl2qc5b70829`).
