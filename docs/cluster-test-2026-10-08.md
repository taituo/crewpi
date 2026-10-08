# Live test in the k3s cluster, 2026-10-08

What this is: the combined code of all branches (`integration/test-deploy`: P0a + Prompt 04 + CLI + Prompt 05 + OptChat fixes) deployed over the existing Crew installation, with the four agents running on a **real model**: `muse-spark-1.3-contributor` through the home gateway (OpenAI-compatible, tool calls verified first). Not a benchmark: one afternoon, a handful of runs.

## Setup
- Build and deploy with `deploy.sh` (no RESET): the existing volume was **upgraded in place**. All 5 migrations ran on a database written by an older build; 46 messages and the old approval survived (the old approval has no decider `sub`, as expected). A backup of the data was taken first.
- Typecheck had to be fixed before the deploy script would accept the code (two `string | undefined` in `registry.ts`).
- Old Crew image tags (50) were removed; Entropi and the other namespaces were not touched.
- Herdr workspace `crew-test`: pane 1 workspace logs, pane 2 a live view (`crew handoffs` + `crew case incidents` run inside the pod every 4 s), pane 3 an opencode agent (Muse Spark, free tier) used as an independent tester.

## Results
| What | Result |
|---|---|
| Incident, operator asks Ops (run 1) | Ops -> Developer -> Reviewer -> Ops as 3 handoffs, all completed; approval asked with `requested_by_sub` = the operator's real Keycloak id; an approver who did not start it approved; ConfigMap changed, pod `Running`, decision recorded in the case |
| Incident, approver asks (run 2) | 6 handoffs in total over both runs; agents used `case_add_fact` with tool names as sources (5 facts, 0 conflicts); the approval's requester was the asking approver; **her own attempt to approve was refused (403, separation of duties)**, the admin's approval went through; `checkout-api` `Running` with `POOL_SIZE=10` |
| Operator tries to approve | 403 (not an approver) |
| Watchdog | `watchdog: temporal` reported by the API; escalation itself is covered by the automated end-to-end test, not provoked live |
| Independent tester (opencode / Muse Spark, 7 checks) | 7/7 PASS: viewer cannot post; a private chat is invisible (404) to viewer, approver **and admin**; no domain events, handoffs, case or presence leak the private chat; Insight answered with a real status overview. Two of the checks were re-run by hand and agreed |

## Findings
1. **Muse Spark 1.3 can run the whole loop** (investigate, delegate, write facts, request approval) but chose its own route: in run 1 Ops reused a branch reviewed in an earlier session instead of asking again (it remembered it); run 2 had to be told explicitly to ask for a new review.
2. Facts are written but their **sources are tool names**, not ids a person can open (`tool:k8s_logs`): fine for audit, weak for verification.
3. The Insight reply contained a visible self-correction ("Fixing that formatting error...") before the content: model quality, not a platform fault.
4. My own progress script printed empty handoff lists in run 1 because of a quoting bug; the chain had happened. Lesson kept: read the system's state, not just my own poll output.
5. One of three full test-suite runs failed a CLI test that passes alone (a timing flake under load); not fixed yet.
6. opencode asks permission for every directory outside its project; "always allow" was granted for the test kit directory only, until opencode restarts.

## Not tested
Temporal escalation live with a real model; attention/bets branch (not deployed); multi-user concurrency; cost and latency numbers; recovery after the pod is killed mid-handoff.
