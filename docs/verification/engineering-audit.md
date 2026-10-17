# Alibi: independent engineering audit and hackathon readiness review

**Date:** 2026-10-16 · **Mode:** read-only. No paid APIs were called, no scenarios were run, and no existing file was changed.
**Evidence labels:** [code] = direct source inspection · [recorded] = persisted runtime evidence in `data/verify.db` and `docs/verification/traces/` · [run-now] = executed during this audit · [claim] = stated in docs, not independently verified here.

## 1. Overall verdict

Alibi is a well-built, honest, **single-pass** CI-forensics pipeline:
- Real Nemotron calls through Token Factory form hypotheses, propose a verdict, and write a patch.
- Deterministic rules choose and judge experiments.
- Experiments and fix validation run in a hardened local Docker sandbox.

The recorded evidence matches the verification report and the three traces exactly.

**It is not an iterative coding agent today.** As built, it cannot become a valid submission without three things that don't exist yet: a public repository (0 commits), a demo URL, and a video. In its current form, a public deployment with a live key could have its credits drained by anonymous visitors.

## 2. Verified facts vs. unverified claims

| Claim | Status | Evidence |
|---|---|---|
| Live Nemotron calls via Token Factory, consumed by the app | Verified [recorded] | `data/verify.db`: 11 investigation `model_calls`, all `ok`; models `nvidia/Nemotron-3_5-Lightning`, `nvidia/nemotron-3-super-120b-a12b`, `nvidia/Nemotron-3-Ultra-550b-a55b` |
| Live Tavily searches consumed by the app | Verified [recorded] | `external_search` experiments `passed` with 8–12 stored sources per run |
| Scenario A (code regression) | Verified [recorded] | `inv_mvafpl2qc5b70829`: reproduce exits `[1]`, repeat `[1×10]`, parent `[0,0,0]`; Ultra fix and revert both validated |
| Maven: Ultra fix rejected, Guava 20.0 pin validated | Verified [recorded] | Both runs (`inv_mvafqt2z65feba2c`, `inv_mvafugsd9090b5d1`): model patch `failed`, exits `[1,1,1]`; pin `validated`, exits `[0,0,0]`. Trace shows the cause (`toString()` format change) |
| Flaky: quarantine rather than a code fix | Verified [recorded] | `inv_mvafruodc197d442`: repeat exits `[0,1,0,0,0,1,0,0,0,0]`, parent `[1,0,1]`, only a quarantine candidate, validated 10/10 |
| All test runs had networking disabled | Verified [recorded] + [code] | Every docker experiment's environment has `network: none`; `runner/docker.ts buildDockerArgs` |
| Fresh-sandbox validation | Verified with a caveat [code] | `WorkspacePool.fresh` (`pipeline/experiments.ts:41`) clones into a new directory after `rmSync` (`runner/workspace.ts:44`). **Caveat:** the per-repository dependency cache (`cacheDirFor`, `workspace.ts:28`) is shared and mounted read-write across the failing workspace and every candidate |
| Single-pass, deterministic experiment selection | Verified [code] | See §3. The model affects only *whether* `repeat`/`external_search` are added (`investigate.ts:509, 531`) |
| Sandbox is local Docker; no Serverless Jobs | Verified [code] | Only `runner/docker.ts` spawns workloads; no Nebius job client exists |
| Existing tests pass | Partially re-verified [run-now] | Network-free subset this audit: server 61/61 (6 files), web 9/9, typecheck 0 errors. `runner.test.ts` (Docker + npm registry) and Playwright were **not** re-run here [claim: previously 67/67 and 2/2] |
| Draft PR creation, real webhook delivery from GitHub | **Unverified** | Implemented (`integrations/github.ts createDraftPr`, `app.ts` webhook route), but only unit-tested with signed synthetic payloads |
| A GitHub Jest/Maven repository investigated end to end | **Unverified** | The only real GitHub run recorded (`expressjs/express`) is Mocha, so it ended inconclusive with no experiments |
| No secrets or local paths in publishable files | Verified for patterns [run-now] | No `/Users/`, usernames, `/private/tmp`, or key-shaped strings (`tvly-`, `eyJ…`, `ghp_`, `sk-`, `Bearer …`) in README, docs, traces, fixtures, deploy, e2e, scripts, `server/src`, `web/src`. `.env` was not read in this audit (the earlier byte-level scan is [claim]) |

## 3. Architecture (as implemented)

1. **Intake and parsing.**
   - Demo: `pipeline/intake.ts startDemo` → `InvestigationQueue.enqueue` → `InvestigationRun.run` (`investigate.ts:113`) → `collect` (`:156`) reads `fixtures/scenarios/<id>/ci-log.txt` and computes the git diff (`analysis/diff.ts commitDiff`).
   - GitHub: `startFromGitHubRun` → `collectGitHub` (`:258`) uses `GitHubClient.listJobs/jobLog/compareDiff`.
   - Then `redactSecrets` → `extractFacts` (Jest/Maven/Mocha) → `selectExcerpts`.
2. **Hypotheses:** `formHypotheses` (`:388`) → `modelStep('triage')` → `TriageSchema`. Cited quotes are checked by `verifyQuote`.
3. **Model calls:** `modelStep` (`:329ff`) handles live, replay, and heuristic modes, the per-investigation `Budget` (`ALIBI_MAX_MODEL_CALLS`, default 8), and logging to `model_calls`.
4. **Experiment selection and policy:**
   - `plan` (`:474`) always adds reproduce and compare_parent.
   - It adds `repeat` if a flaky or infrastructure hypothesis exists **or the model requested it** (`:509`).
   - It adds `external_search` if the category, diff, or a model request warrants it (`:529–531`).
   - The test selection comes only from parsed log facts (`selection()`). Commands come from fixed templates (`runner/frameworks.ts testCommand`, `validateSelection`).
5. **Sandbox execution:** `execute` (`:543`) → `runTestExperiment` (`pipeline/experiments.ts`) → `runContainer` (`runner/docker.ts`): uid 1000, `--cap-drop ALL`, read-only root, `--network none`, resource limits. Dependency install runs with network access (`workspace.ts prepareWorkspace`).
6. **Results feeding later decisions:**
   - Deterministic rules mark each hypothesis supported or contradicted (`pipeline/effects.ts experimentEffect`).
   - The results reach the model **once**, in `weigh` (`:658`, `prompts.ts verdictPrompt`).
   - The reproduce output reaches the patch model once (`patchPrompt`).
   - Nothing feeds a further experiment choice.
7. **Remediation:**
   - `remediate` (`:720`) builds candidates: quarantine, pin, Ultra patch, revert.
   - `materialize` (`pipeline/remediation.ts`) restricts model edits to the files the model was shown and applies `checkPatchPolicy`.
   - `validatePatch` (`:802`) uses `pool.fresh` + `applyPatch` + targeted runs + suite.
   - Re-validation goes through `revalidate` (`:857`, `POST /api/patches/:id/validate`).
   - A failed Ultra patch is **not retried** with its failure output.
8. **Ledger and verdict:**
   - `store.addEvidence` builds an ordered, typed ledger, append-only at the API level, with no hashing.
   - Verdict: `assessConfidence` + `reconcileVerdict` (`pipeline/confidence.ts`), then `finalize`.

### Model usage map [code]

| Step | Model (chosen by) | Input | Output controls | On failure |
|---|---|---|---|---|
| triage | `nvidia/Nemotron-3_5-Lightning`. Picked by `resolveModels` (`llm/models.ts`) from the live `/v1/models` catalog via regex preferences; override `ALIBI_MODEL_TRIAGE` (honored only if in the catalog) | **Not the whole log.** Metadata, parsed facts, the diff truncated to 24,000 chars (`analyzeDiff`), and log excerpts ≤ min(`ALIBI_MAX_LOG_CHARS`, 60,000) chars (`investigate.ts:390`) | `json_schema` (falls back to `json_object` and then none on a 400), `enable_thinking: false` for Nemotron (`client.ts:197`), `max_tokens` 3000, temperature 0.2, Zod validation + 1 repair round | Retries (408/409/425/429/5xx, max 3, honors `Retry-After`); 120 s timeout; on error or invalid output → `heuristicTriage`, labeled, with a limitation recorded |
| verdict | `nvidia/nemotron-3-super-120b-a12b` (role `reasoning`; `ALIBI_MODEL_REASONING`) | Hypotheses, executed experiment summaries (counts, observations), diff summary, ≤6 source excerpts | Same; `max_tokens` 2500 | Same → `heuristicVerdict`; the model's verdict is always capped by the rubric |
| patch | `nvidia/Nemotron-3-Ultra-550b-a55b` (role `deep`; `ALIBI_MODEL_DEEP`) | Root cause, signature, last 6,000 chars of reproduce output, diff ≤12,000 chars, ≤4 implicated files (<20 KB each) | Same; `max_tokens` 6000 | No fallback: deterministic candidates only. Edits outside the files shown are rejected |
| connection test | Triage model | Fixed tiny prompt | `max_tokens` 400 | Error returned to the caller |

The catalog lookup (`listModels`) is cached for 10 minutes, and `/api/status` triggers it.

### Intake surface [code]

| Path | Endpoint / tool | Driven by the UI end to end? |
|---|---|---|
| Demo scenarios | `POST /api/investigations/demo` | Yes (Overview, Run sample modal) |
| GitHub run URL | `POST /api/investigations/github` | Yes (Integrations form; needs `GITHUB_TOKEN`) |
| GitHub webhook | `POST /api/webhooks/github` (HMAC; auto-investigate opt-in) | Deliveries listed in the UI; never exercised by real GitHub |
| CLI | `scripts/run-investigation.ts` | No (terminal) |
| GitHub App / manual log upload | Not implemented | — |

### Is it an iterative coding agent?

**No.**
- The model never observes an experiment result and then chooses the next action.
- Experiments are chosen once, up front, by `plan()` from fixed rules plus menu flags.
- The patch model writes code once; when validation fails (Maven), nothing feeds that failure back for another attempt.

It *is* an agentic pipeline that writes code (the Ultra patch) and runs and tests code (Docker), with model-proposed hypotheses and deterministic, falsifying experiments.

## 4. Claims that overstate, and cost-control findings

**Overstatements:**
- `README.md` "Live vs. simulated" lists GitHub Actions as **Live** including "webhooks, draft PRs": these are implemented but unverified against GitHub.
- `docs/HACKATHON_SUBMISSION.md` says "Alibi investigates a failed GitHub Actions run end to end." Only fixtures plus one Mocha run (inconclusive) are recorded.
- The Overview copy "only confirms a cause when an experiment proves it" is accurate for code and dependency regressions, which need a validated fix. For flaky tests, "confirmed" comes from the rubric (intermittency plus parent comparison), which is strong evidence, not proof.

**Public-demo cost exposure.** If deployed as-is with live keys (`ALIBI_DEMO_READONLY` defaults to `false`), an anonymous visitor can trigger paid calls through:

1. `POST /api/integrations/nebius/test` (`app.ts:411`): **no rate limit, no demo guard.** Each request makes 1 paid Lightning call plus a forced catalog refresh. Unlimited.
2. `POST /api/integrations/tavily/test` (`app.ts:434`): **no rate limit, no demo guard.** Unlimited Tavily credits.
3. `POST /api/investigations/demo` (`:194`): rate limit 120/hour per `req.ip`. With `trustProxy: true` (`app.ts:57`), `req.ip` comes from `X-Forwarded-For`, so unless a proxy overwrites that header it can be **spoofed** to get around the limit. There is no queue cap unless the demo-readonly flag is set.
4. `POST /api/investigations/:id/rerun` (`:215`): same spoofable limiter, and **no queue cap even in demo-readonly mode**.
5. `POST /api/investigations/github` (`:202`): any public repo when demo-readonly is off and `GITHUB_TOKEN` is set.
6. `POST /api/patches/:id/validate` (`:254`): no model cost, but unbounded Docker CPU (denial-of-service).
7. `GET /api/status`: free catalog calls only (cached).

There is **no global or daily spend cap**. The per-investigation cap is 8 model calls, but each call can make up to 2 HTTP requests (repair round) plus retries. Recorded cost is about $0.003–0.006 per investigation [recorded]. The worst case is bounded by `max_tokens` at roughly $0.10 per investigation (estimate). Endpoint 1 alone can drain $50 at roughly $0.0005 per request.

**Replays don't survive a fresh clone.** Recorded live replays exist only in git-ignored `data/replays/`, and `fixtures/scenarios/*/replay.json` doesn't exist. A deployment cloned from git would show **Heuristic**, not Replay, until `npm run demo:export-replays` is run and the result committed.

## 5. Hackathon assessment (criteria as quoted in the brief)

| Criterion | Current assessment | Strongest evidence | Biggest weakness | One high-value improvement |
|---|---|---|---|---|
| Technological Implementation | Solid engineering and an effective, tiered use of Token Factory | 3 Nemotron models with clear roles, schema-validated JSON, the `enable_thinking` fix, a hardened sandbox, 70 network-free tests passing | Single pass; Ultra's failed fix is never retried with feedback; experiments run in local Docker rather than "in Token Factory" | Bounded loop, including an Ultra patch retry that receives the actual failing test output |
| Design | A complete, coherent product, not a proof of concept | Evidence Ledger, verdict evolution, honest Live/Replay/Heuristic labels, responsive UI, E2E tests | Nobody outside this machine can use it: no URL | A replay-first public deployment with a tightly capped live run |
| Potential Impact | Credible problem and audience; evidence limited to fixtures | Maven run: Alibi **rejected a plausible model-written fix** that broke an existing test, and validated a working one instead | Only 3 synthetic fixtures; no Jest or Maven failure from a real public repository | Investigate one real public Jest repository failure end to end through the GitHub-URL path |
| Quality of the Idea | Non-obvious: the model proposes, experiments falsify, a rubric caps model confidence | Verdict capped at "probable" until a fix validated (recorded verdict histories) | The "agent" part is thin: rules choose experiments | Let Nemotron pick the next allowlisted experiment with a stated prediction, then check that prediction against the actual result |

### Submission items

| Item | Status |
|---|---|
| Working project | Present locally; not reachable by judges |
| Track (Coding and Agentic Engineering) | Chosen. Fit risk: the track text says "run, and test code in Token Factory"; Alibi tests code in Docker, local or on a VM |
| Project description | Draft present (`docs/HACKATHON_SUBMISSION.md`); URL fields empty |
| Demo URL | **Missing** |
| Public YouTube video ≤ 3 min | **Missing** (script present: `docs/DEMO_SCRIPT.md`) |
| Public repository | **Missing** (0 commits) |
| OSS license visible at repo top | `LICENSE` (MIT) present; visible only once the repo is published |
| README with setup and Nemotron/Token Factory usage | Present and updated; GitHub "Live" row **overstated** (draft PRs, webhooks) |
| Other Nebius services highlighted | Correctly says none. AI Cloud is unused unless deployed there |
| Feedback on Token Factory, AI Cloud, NVIDIA tools | Token Factory and Tavily draft only (`live-cloud-verification.md §10`); **AI Cloud and NVIDIA tools missing** |
| Pre-dating explanation | Not needed if built in-period. There is no git history to show that; commit now |

## 6. Milestone plan (today: Fri 16 Oct; freeze: Tue 27 Oct; submit by Fri 30 Oct, 10:00 PDT)

Options ranked by dependency and value:
1. **C** (deploy, mandatory), with its cost guards.
2. **A-remainder** (fix the overstated rows; commit replays). The browser-test guard part of A is already done.
3. **B** (loop): highest score upside, highest risk.
4. **D** (one real repository).
5. **E** (keep Docker and say so; moving to Serverless Jobs is too risky for the time left).

| Date | Work | Effort |
|---|---|---|
| Fri 16 eve | First git commit (private), `demo:export-replays` + commit replays, fix the two overstated doc rows | 1 evening |
| Sat 17 | Cost guards: demo guard + limiter on `/api/integrations/*/test`; `trustProxy` off unless behind a proxy that overwrites the header; queue cap on rerun; global daily live-call cap in `modelStep` (fall back to Replay when exceeded); demo-readonly defaults to Replay for scenarios, with ≤ N live runs a day | 1 day |
| Sun 18 | Deploy with `deploy/setup-vm.sh`, preferably on a **Nebius AI Cloud VM** (then "runs on Nebius AI Cloud" becomes true for the sandbox host); HTTPS; smoke test from outside; publish the repo | 1 day |
| **Cut line, Sun 18** | **Ships even if everything else slips:** public repo, capped replay-first demo URL, single-pass Alibi as documented | — |
| Mon 19 – Thu 23 eves | B: bounded loop behind `ALIBI_LOOP=1`, with unit tests (fake model) and a patch-retry-with-feedback step | 5 evenings |
| Sat 24 | Live-run the 3 scenarios with the loop (about $0.10 total), regenerate traces, compare against single-pass; if not green, ship single-pass | 1 day |
| Sun 25 | D: one real public Jest failure via the GitHub URL path (read-only), trace it | 1 day (optional) |
| Mon 26 – Tue 27 eves | Freeze: full regression, redeploy, final docs | 2 evenings |
| Wed 28 – Fri 30 | Video, Devpost form, feedback (Token Factory, AI Cloud, NVIDIA), submit early on the 29th | — |

## 7. Minimum viable iterative loop (design only; not implemented)

- **Tool allowlist:**
  - `reproduce(commit: failing|parent, seed?)`
  - `repeat(n ≤ 20)`
  - `run_test(selection)`, where the selection must come from parsed failing tests or test files that exist in the repo (`validateSelection` + existence check)
  - `search(query ≤ 200 chars)`, at most 3 per investigation
  - `propose_patch` (Ultra) → `validate(patch)` in a fresh sandbox
  - `conclude`
  
  Model-supplied commands or paths outside these are rejected and recorded as a policy-rejection ledger entry.
- **Loop contract:** each iteration sends Super the hypotheses, the ledger so far, and the **actual** result of the last experiment (exit codes, pass/fail counts, ≤2 KB output tail), plus the remaining budget. It returns `{hypothesis_updates[], next: {tool, args, prediction, rationale} | conclude}`, validated with Zod.
- **Bounds:** ≤4 experiment iterations, ≤6 model calls, ≤40k input tokens and ≤$0.05 estimated per investigation. A global daily cap is enforced in `modelStep`. Duplicate tool and argument pairs are rejected.
- **Policy:** the deterministic planner runs first (reproduce plus parent are always present). The loop only adds experiments. `effects.ts` and `confidence.ts` remain the only authority for support and verdict caps.
- **Patch:** Ultra writes the patch; it is validated in a fresh sandbox; on failure, **one** retry with the failing output. A fix counts only if it passes the targeted runs and the suite.
- **Stopping rule:** stop on `conclude`, on budget exhaustion, when no allowlisted action remains, or after two consecutive iterations that don't change any hypothesis status. Then the rubric decides; with no discriminating result, the verdict is "inconclusive".
- **Model tiers:**
  - Lightning (thinking off): initial triage.
  - Super: per-iteration decisions, which need reasoning over results and are cheap ($0.30/$0.90 per M).
  - Ultra: only for patch synthesis and its single retry.
  - Nano: fallback only.
- **Trace:** reuse the `traces/*.md` format with one section per iteration: model call, parsed decision, policy result, experiment, observation, hypothesis delta.
- **Acceptance criteria:**
  - A fake-model test proves that iteration 2's prompt contains iteration 1's real exit codes.
  - A contradiction test: a fake model predicts "deterministic failure", the repeat shows 2/10 failures, and the next decision and hypothesis statuses change accordingly.
  - Disallowed tools and arguments are rejected, never executed.
  - Budget exhaustion stops the loop.
  - Maven: the retried Ultra patch, given the failing test output, is validated or honestly fails.
  - All three scenarios keep their classifications in replayed traces.
  - With `ALIBI_LOOP` off, behavior is unchanged.

## 8. Risks that could invalidate the submission

1. No demo URL or video means not scored. **Highest.**
2. Credit drain on a public deployment: endpoints 1–4 in §4.
3. Unpublished repository with no history: the license is not visible, and in-period construction can't be shown.
4. Track-fit challenge ("in Token Factory") if Docker execution isn't explained, or isn't hosted on Nebius AI Cloud.
5. Fresh-clone deployment silently in Heuristic mode because replays aren't committed.
6. The demo host must run Docker; serverless hosting won't work.
7. Overstated GitHub claims (draft PRs, webhooks) being probed by judges.

## 9. Single most valuable next action

**Close the paid-call holes and publish a replay-first, capped public demo**, ideally on a Nebius AI Cloud VM:
- Guard `/api/integrations/*/test`.
- Disable header-trusting IP detection unless behind a proxy that overwrites it.
- Add a global daily live-call cap.
- Commit the replays.

This is what makes the submission valid; everything else is score improvement.
