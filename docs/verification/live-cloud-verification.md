# Live cloud verification

**Date:** 2026-10-16 · **Host:** macOS (Darwin 27), Node 20.19.6, Docker Engine 29.5.3 (Rancher Desktop), Maven 3.9 / Temurin 17 images
**Scope:** verify the existing Alibi implementation against live Nebius Token Factory and Tavily, and run the three benchmark scenarios. Only approved fixes were made (two, listed below).

## Summary

| Check | Status | Evidence |
|---|---|---|
| Nebius authentication | PASS | `GET /v1/models` → 200, request id `2a43a626…`, 557 ms |
| NVIDIA Nemotron model available | PASS | Catalog lists `nvidia/Nemotron-3_5-Lightning`, `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`, `nvidia/nemotron-3-super-120b-a12b`, `nvidia/Nemotron-3-Ultra-550b-a55b`, `nvidia/Nemotron-3.5-Super-VL` |
| Live Nemotron inference | PASS (after fix #1) | Before the fix: HTTP 200 but all 300 completion tokens were reasoning and `content` was prose (`finish_reason: length`). After the fix: valid JSON, 19 tokens, 814 ms (request `e15efa34…`) |
| Alibi consumes real inference | PASS | 11/11 investigation model calls `ok` via `json_schema`, 0 repair rounds, 0 heuristic fallbacks (`data/verify.db`, table `model_calls`) |
| Tavily live search | PASS | 1 probe (request `38278ce2…`, 5 results, 4 primary) + 10 in-investigation requests, all 200 |
| Alibi consumes real search results | PASS | Results stored as `sources` and `external_source` ledger records with URL, title, excerpt, score, query, retrieval time |
| Evidence provenance | PASS | 30–34 ledger records per run, each typed (observed fact / hypothesis / experiment result / external source / inference / assumption) with log-line, experiment, git, URL, or model provenance |
| Sandbox execution location identified | PASS | **Local Docker** on the developer machine. No Nebius Serverless Jobs integration exists in the code |
| Nebius Serverless Jobs live run | NOT RUN | Not configured or implemented |
| Code regression scenario | PASS | See table below and `traces/code-regression.md` |
| Maven regression scenario | PASS | `traces/maven-dependency.md`; model-written fix correctly **rejected**, pin validated |
| Flaky-test scenario | PASS | `traces/flaky-jest.md` |
| Fresh-sandbox patch validation | PASS | Each candidate gets a new checkout (`WorkspacePool.fresh`), `git apply` of the stored diff, then targeted runs + suite; failed candidates stay `failed` |
| Existing regression suite | PASS | typecheck 0 errors; server 67/67; web 9/9; build OK; Playwright 2/2 |
| License visible at repo top | PARTIAL | `LICENSE` (MIT) exists at the repo root, but the repository is not published |
| README claims match verified behavior | FAIL | README and `docs/VERIFICATION_REPORT.md` still say no live Nemotron/Tavily call was made, and don't name the verified model IDs. They are out of date, though not overstated |
| Demo URL responds | BLOCKED | No deployment exists |

## 1. Repository state

- **Before:** no commits. Both real API keys were in `.env.example`, a file that is **not** git-ignored and would have been committed; `.env` did not exist, so the app ran without keys. A byte-level scan found the keys nowhere else.
- **Remediation (approved):** `.env.example` was renamed to `.env` (git-ignored, mode 600) and `.env.example` was regenerated with blank placeholders. No key value was printed. Nothing was committed, so git history is clean. Rotating both keys is still advisable if this folder is synced or shared.
- **After:** still no commits. Changed files: `server/src/llm/client.ts`, `server/src/llm/llm.test.ts`, `server/src/pipeline/investigate.ts`, `server/src/pipeline/confidence.ts`, `server/src/pipeline/pipeline.test.ts`, plus this report and `traces/`.

## 2. Nebius Token Factory

| Check | Result |
|---|---|
| Configuration | `NEBIUS_API_KEY` present (value never printed); base URL `https://api.tokenfactory.nebius.com/v1` |
| Authentication | 200 on `/v1/models` |
| Model discovery | 27 models, 5 Nemotron. Alibi's resolver selected **triage** `nvidia/Nemotron-3_5-Lightning`, **reasoning** `nvidia/nemotron-3-super-120b-a12b`, **deep** `nvidia/Nemotron-3-Ultra-550b-a55b`, and correctly excluded the vision model `Nemotron-3.5-Super-VL` |
| Inference (raw) | Lightning with `response_format: json_schema` and no other flags: 200, `finish_reason: length`, 300/300 reasoning tokens, `content` = "Here's a thinking process: …". The JSON schema was **not** enforced |
| Application integration | Through `TokenFactoryClient.chatJson`: before fix #1 it "passed" only after a repair round and returned placeholder values (`"..."`). After the fix, all 11 investigation calls returned schema-valid JSON on the first attempt |
| Structured output | Zod validation + one repair round + `json_schema → json_object → none` degradation are unit-tested; live calls never needed degradation |
| Failure handling | Invalid model `nvidia/does-not-exist-model` → `ModelError` kind `http`, status 404, 1 attempt (404 is not retried), message contains no key |

**Fix #1 (approved):** for Nemotron models, `chatJson` now sends `chat_template_kwargs: { enable_thinking: false }`. Regression test: `llm.test.ts › disables Nemotron reasoning so content stays JSON`.

`nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` is available but was not called; the resolver prefers Lightning for triage.

## 3. Tavily

- Configuration: `TAVILY_API_KEY` present (never printed).
- Live probe via `tavilySearch()`: query `guava 21.0 release notes com.google.common.base.Objects.toStringHelper removed` returned 5 results in 1.8 s, including **guava.dev 20.0 Objects API**, **guava.dev deprecated list**, and the **google/guava Release21 wiki**, all marked primary.
- In investigations: 10 requests across 4 runs. Each result is persisted with title, URL, excerpt (≤700 chars), score, published date, query, and retrieval time, and linked to the hypothesis that triggered the search.
- Separation from proof: search results are typed `external_source` and are never counted by the confidence rubric as experimental evidence. In Scenario B, fixes were judged only by sandbox runs.
- Missing key, 4xx, 429/5xx retry, and timeout handling are unit-tested with mocks only. Live failure paths were not exercised, to avoid spending credits on deliberate errors.
- Observation: in the code-regression and flaky runs, the triage model requested web searches for purely local bugs (2 queries each, 0–1 primary results). That's harmless, but it spends search credits.

## 4. The investigation loop as it actually runs

```
CI log + diff ─► deterministic parser/redaction ─► [Nemotron Lightning] triage: 2–4 hypotheses + requested experiments (menu only)
             ─► deterministic planner + policy: fixed command templates, validated test selection, no model-supplied commands
             ─► local Docker sandbox: reproduce / repeat / parent (network off, non-root, read-only root, CPU/mem/pid limits)
             ─► Tavily (only if a hypothesis or the diff implicates an external dependency, or the model asked)
             ─► deterministic effect rules mark each hypothesis supported / contradicted
             ─► [Nemotron Super] verdict over the executed results ─► rubric caps "confirmed" unless evidence is strong
             ─► candidates: [Nemotron Ultra] targeted fix + deterministic pin/quarantine/revert ─► fresh-sandbox validation
             ─► final verdict + ledger
```

- **Model influence:** the model decides the hypotheses, which menu experiments to request (repeat / external search), the verdict proposal, and a code fix. It does **not** choose experiments iteratively: results go back to the model once, at the verdict stage. **Alibi is single-pass, not an iterative agent loop.** No runtime evidence supports claiming one.
- **Hypothesis revision after experiments:** happens through deterministic rules plus the verdict model's assessment. Examples: Scenario A H2/H3 refuted, Scenario B H2/H4 refuted, Scenario C H1 (code regression) refuted.
- **Safety boundary:** commands come only from templates in `runner/frameworks.ts`. Model text is never executed. Patch edits are limited to the files shown to the model and pass `checkPatchPolicy` (no `.github/`, traversal, mode changes, or binaries).
- **Sandbox location:** local Docker on this machine. Neither the README, the UI, nor `docs/HACKATHON_SUBMISSION.md` claims Nebius-hosted sandboxing. The submission doc lists "Nebius AI Cloud (deployment target)", which is aspirational until the app is deployed there.

## 5. Benchmark results (strict live mode: `npx tsx scripts/run-investigation.ts <id> live`, DB `data/verify.db`)

| Scenario | Model calls | Sandbox runs (exit codes) | Outcome | Fix validation | Trace |
|---|---|---|---|---|---|
| A · code-regression `inv_mvafpl2qc5b70829` | Lightning, Super, Ultra (3 ok) | reproduce 1/1 fail (1); repeat 10/10 fail (1×10); parent 0/3 fail (0,0,0) | **confirmed / code_regression / strong**; H1 = "`>=` changed to `>`" | Ultra fix ✅ 3/3 + suite; revert ✅ 3/3 + suite | `traces/code-regression.md` |
| B · maven-dependency `inv_mvafugsd9090b5d1` (re-run after fix #2; first run `inv_mvafqt2z65feba2c` gave the same outcome) | Lightning, Super, Ultra (3 ok) | reproduce 1/1 fail (compile); repeat skipped (deterministic); parent 0/1 fail (0) | **confirmed / dependency_regression / strong**; H1 = "Guava 21.0 removed toStringHelper" | Ultra fix ❌ 3/3 fail (`InventoryItemTest#rendersReadableToString`: it changed the toString format); pin to 20.0 ✅ 3/3 | `traces/maven-dependency.md` |
| C · flaky-jest `inv_mvafruodc197d442` | Lightning, Super (2 ok; no code patch justified) | reproduce with CI seed 1/1 fail; repeat 2/10 fail (seeds 2·65537, 6·65537); parent 2/3 fail | **confirmed / flaky_test / strong**; code-regression hypothesis refuted | quarantine ✅ 10/10 + suite | `traces/flaky-jest.md` |

Expected answers live only in `fixtures/scenarios/*/scenario.json → expected` and are not referenced by any prompt or by the production pipeline.

## 6. Evidence checks

- Reported failures come from actual command output; exit codes and output tails are stored per run and shown in the traces.
- Observed facts, hypotheses, inferences, external sources, and assumptions are stored as distinct kinds.
- Sources are recorded only from returned Tavily results; a search with no results records none.
- The remediation diff is the exact stored `patch.diff` that `applyPatch` applies in validation (same field, see traces).
- Failed candidates remain `failed` (Scenario B). Inconclusive investigations stay inconclusive (verified earlier with the real `expressjs/express` run).
- Duplicate re-validation returns 409; malformed model output is covered by unit tests (repair, then a clear `invalid_output` error).
- **Fix #2 (approved):** limitations written by the verdict model *before* fix validation could contradict later results (B said remediation was "not empirically validated" after the pin passed). They are now prefixed "Before fix validation:", and a deterministic line summarizes actual fix outcomes. Regression test: `pipeline.test.ts › remediation summary`; confirmed at runtime in B's re-run.
- No key was found in `web/dist`, `server/dist`, `data/`, `docs/`, `fixtures/`, `.env.example`, or live API responses (`/api/status`, `/api/settings`, `/api/model-calls`, an investigation bundle).
- The ledger is append-only at the API level (there is no update or delete endpoint for records, only cascade deletion with the investigation). It is **not** tamper-proof: there is no hashing or signing.

## 7. Tests run

| Command | Result |
|---|---|
| `npm run typecheck` | 0 errors |
| `NEBIUS_API_KEY= TAVILY_API_KEY= npm test` | server 67/67 (incl. real Docker sandbox test), web 9/9 |
| `npm run build` | OK |
| `NEBIUS_API_KEY= TAVILY_API_KEY= npx playwright test` | 2/2 |

All of these use mocks or local Docker only. The live checks above were run separately with scratch scripts and the CLI.

## 8. Cost and usage

Token Factory (prices: Super $0.30 / $0.90 per 1M in / out from third-party listings; Lightning and Nano assumed ≤ Super; Ultra assumed $1.00 / $3.00 as a conservative upper bound):

| Model | Calls | Tokens in | Tokens out | Est. cost |
|---|---|---|---|---|
| nvidia/Nemotron-3_5-Lightning | 7 (incl. 3 verification probes) | 8,389 | 4,604 | $0.0067 |
| nvidia/nemotron-3-super-120b-a12b | 4 | 9,720 | 1,218 | $0.0040 |
| nvidia/Nemotron-3-Ultra-550b-a55b | 3 | 5,857 | 1,383 | $0.0100 |
| **Total** | **14** (+1 deliberate 404, + free catalog calls) | **23,966** | **7,205** | **≈ $0.021** |

Super and Ultra were called once per scenario run. Tavily: 11 requests (1 probe + 10 in investigations).

## 9. Blockers, limitations, next actions

- **Single-pass reasoning:** experiments do not feed back into a model-chosen next experiment. Describe Alibi accordingly, or implement the bounded loop (not done here, per instructions).
- **E2E/CI goes live when `.env` has keys:** Playwright's webServer reads `.env`, and "auto" mode would make paid calls. Proposed fix: pin `NEBIUS_API_KEY=` / `TAVILY_API_KEY=` (or `defaultMode: heuristic`) in `playwright.config.ts`. **Not applied**; awaiting approval.
- **README and older docs are stale:** update the model IDs, live-verification status, and the single-pass description. **Not applied**; awaiting approval.
- **Recorded replays:** live runs wrote `data/replays/*.json` (real Nemotron outputs). Run `npm run demo:export-replays` before deploying so a key-less demo can replay them.
- **Sandbox isolation:** Docker shares the host kernel. The install step has network access, and Maven plugins run during it.
- **Not tested live:** Tavily error paths, Token Factory 429/timeout paths (unit-tested only), GitHub draft PR creation, deployment.

## 10. Hackathon readiness

- **License:** MIT `LICENSE` at the repo root ✅. It becomes visible on GitHub once the repo is published.
- **README model and service claims:** must be updated to state that triage uses `nvidia/Nemotron-3_5-Lightning`, verdicts use `nvidia/nemotron-3-super-120b-a12b`, and patches use `nvidia/Nemotron-3-Ultra-550b-a55b`, all through **Nebius Token Factory** (the only Nebius service used). Serverless Jobs and Endpoints are **not** used. AI Cloud hosting is not yet done.
- **Demo URL:** none ❌.
- **Bundle secrets:** none ✅.

### Draft feedback for Token Factory and Tavily

- **Token Factory:**
  - Nemotron 3.x reasoning is on by default, and the reasoning text arrives in `content` rather than `reasoning_content`. It silently overrides `response_format: json_schema`, and nothing in the docs mentions it.
  - Documenting `chat_template_kwargs.enable_thinking` (or a `reasoning_effort` equivalent) on the structured-output page would have saved a debugging round.
  - What worked well: fast catalog, clear 404 for unknown models, an `x-request-id` header on the responses we inspected, detailed `usage.completion_tokens_details.reasoning_tokens`.
  - Missing: an official per-model price table we could find programmatically (we had to rely on third-party listings).
- **Tavily:**
  - Worked first time. Results were relevant to exact symbol/version queries and included primary sources (guava.dev, the project wiki). `request_id` and `response_time` aid tracing.
  - Friction: `published_date` was missing for the documentation pages we retrieved (2 of the 5 probe results had none).
