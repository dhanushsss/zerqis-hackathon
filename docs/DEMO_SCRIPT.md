# Demo script (under 3 minutes)

**Before recording**
- Set `NEBIUS_API_KEY` and `TAVILY_API_KEY`, then restart. On **Integrations**, click *Send a test inference*; the resolved Nemotron model IDs must appear. The sidebar should read "Nemotron live", "Sandbox ready", "Tavily on".
- Warm caches: run each scenario once (first Maven run downloads dependencies). Delete those runs, or keep them as history.
- Browser at 1440×900, zoom 100%. Start on **Overview**.
- Never claim anything the screen doesn't show. If a stage says *Replay* or *Heuristic*, say so.

| Time | Screen | Say |
|---|---|---|
| 0:00–0:15 | Overview | "CI is red. Was it my change, a flaky test, or a dependency? AI assistants will *explain* a failure. Zerqis *proves* it: it forms competing hypotheses with NVIDIA Nemotron, then runs experiments to test them." |
| 0:15–0:30 | Click **Investigate** on *Guava upgrade breaks inventory-api*. Detail page opens; the stepper starts | "A failed Dependabot bump. Zerqis pulls the log, redacts secrets, and parses the failure deterministically: a compile error, `toStringHelper` not found in Guava's `Objects`." |
| 0:30–0:55 | **Competing hypotheses** appear (purple *Live · Nemotron* badge) | "Nemotron on Nebius Token Factory proposes competing causes: the dependency bump, a code change, infrastructure. Every quote it cites is checked against the log; a fake quote gets flagged." |
| 0:55–1:25 | **Experiments** section: reproduce turns red, compare-parent turns green; open **Sources** | "Now experiments. In a locked-down container with no network, the failing commit fails to compile. The parent builds and passes. Tavily searches Guava's release notes for that exact symbol, and that result is a lead, not proof." |
| 1:25–1:50 | **Remediation**: diff, validation strip turns green; verdict history goes *probable → confirmed* | "Zerqis proposes fixes, applies each in a fresh sandbox, and re-runs the build and the full suite. Only when a fix passes does the verdict move from probable to confirmed." |
| 1:50–2:20 | Open the Run sample modal → *Flaky Jest test* (or open a finished one) → repeat experiment's 10 squares, then the experiment page with seeds | "Different failure: a docs-only commit broke CI. Zerqis replays the exact seed CI used, so it fails identically. Then it runs ten seeded runs: two fail, eight pass. That's 20% observed, with a 95% interval of 6 to 51%, and Zerqis says ten runs isn't enough to be precise. The parent commit fails the same way, so this commit is innocent." |
| 2:20–2:45 | **Evidence ledger** tab; click a *log lines* link and an *experiment* link | "Everything lands in the Evidence Ledger. Observed facts, model hypotheses, experiment results, external sources, inferences, and assumptions are labeled separately, and each one links back to log lines, the exact container run, or the source URL." |
| 2:45–2:58 | Verdict card: confidence basis | "Confidence comes from which experiments ran, not from the model grading itself. Zerqis: don't just explain the failure. Prove it." |

**Fallbacks.** If the live model call fails on camera, the stage shows *Heuristic* and the Model calls tab shows the error. Say so and continue, because the experiments are still real. If the queue is busy, open a completed investigation of the same scenario.
