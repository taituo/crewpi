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

## Reading the tester's run critically (opencode / Muse Spark, session read in full)
The tester ran 7 checks with 8 real commands. Its report is honest (it flagged that the DM already existed and that the Insight reply corrected itself), but "7/7 PASS" is stronger than the evidence in places.

| Check | Verdict on the evidence |
|---|---|
| 1 viewer cannot post | **Strong.** Real `403 your role is view-only` |
| 2 owner can write to a DM | **Weak as a creation test.** `created:false`: it reused an existing DM, so DM *creation* was not exercised. The post was accepted and woke the real Ops agent |
| 3 others get 404 on the DM | **Right but incomplete without a positive control.** A 404 for everyone would look the same. Verified by hand: the owner reads 3 messages, carol, dave and alice get 404 |
| 4, 5 events and case of the DM: 404 | **Weak.** In a DM no handoff or fact can exist at all (the service refuses), so there was little to leak; the 404 comes from the channel visibility rule, not from the new code |
| 6 nothing about the DM in handoffs/events | **Vacuous as written.** Handoffs and events never contain message text, so "secret not found" could not fail. The real vectors are listed below |
| 7 Insight answers | **Passes, with a caveat.** The content is the demo's *fixture* data (one invented story), consistent with the cluster only through `markCheckoutFixed()`; and the reply starts with two visible self-corrections |

The brief stated the expected result for every check. That invites confirmation: the tester reported the real HTTP codes, which keeps it honest, but a brief that does not say what to expect would be a better test.

### Vectors it did not try, checked afterwards by hand
| Vector | Result |
|---|---|
| Live SSE stream of a viewer and of an admin while the owner writes in the DM | 0 events naming the DM, 0 occurrences of the message text. **Positive control:** the owner's own stream carries the DM events and the text |
| Presence while the DM agent works | `working: []` for everyone |
| Agent memory written in the DM | Ops saved a note ("favourite colour is teal"); its scope is `channel:dm-...` and **only the owner sees it** (carol, dave, alice: 9 notes, none from the DM) |
| Approvals and audit | no DM approvals; no audit line mentions the DM |

### What it adds up to
Privacy of the private chat holds on every path that was tried (REST, channel-scoped APIs, SSE, presence, memory, approvals, audit), and the one check that looked strongest in the report (6) proved the least. Not covered: a DM whose agent asks for a live-system approval (SECURITY.md says audit titles may then leak), and DM *creation*.

## Round 3 (QA agents, Muse Spark via opencode): delegation result return
- `liveqa` (read-only drive of the live cluster as a user) found: an agent that delegates with `ask_agent` never heard the answer (msgs 97-101: Ops promised to report back, Developer answered, handoff `completed`, Ops never woken). Cause: nothing delivered a finished handoff to the requester. Fixed by the `return` consumer (commit "Deliver the outcome of a handoff...", tested first, 3 tests).
- Re-test on the redeployed cluster (msgs 110-114, verified by me from the channel itself): new handoff ask:776 ops->developer, 4 events (requested, accepted, in_progress, completed), Developer answered in the channel, Ops posted the 5 lines ~7.8 s later, no duplicates.
- Two QA rounds were wasted by my own briefs: I named a channel where Ops is not a member (the system notice said so correctly), and I asked a question Ops could answer from its memory of the old promise. A QA test of "does X get delivered" needs a fresh question each time.
- Still open from QA: naming `@developer` in the human message makes both agents answer (dual dispatch, msgs 99+101); the old handoff's `resultRef` pointed at the direct answer; `createdAt` of agent messages is the task creation time, not the completion time (do not use it as latency).
- `redteam` (9 attacks on the synthetic tools): all pass; my mutation check caught 8/8 mutations, so the tests are real. Merged as `test/world-tools-redteam.test.ts`.
