# Review against the UniiChat spec (formerly OptChat)

Source: Victor Taelin's gist `91837951a5ce5b38f341ec1ba1df6449`. Reviewed revision `3c190e06f3` (2026-10-08). The previous revision `f51fe5c910` (2026-10-04, "OptChat") was replaced by a rewrite (+403/-706 lines) and the project is now called **UniiChat**. Our `src/optchat.ts` follows the older description; this lists what changed upstream and where Crew stands.

## What changed upstream (old -> new)
| Topic | Old (Oct 4) | New (Oct 8) |
|---|---|---|
| Due rule | `(T - first) / 2^(l+2)` (age from the pair's **first** message) | `(T - last) / 2^l` (from the **last** message). The gist states the old rule was a bug: it matched Taelin's push at 481 of 20,001 steps. |
| When to merge | whenever the view exceeds the budget (128 KB) | **sawtooth**: grow to 128 KB, then one batch merges down to 64 KB (average 96 KB); only pairs whose parent is already built |
| The view at restart | folded again from message 0 | **saved** (`view.json`) and loaded; never rebuilt |
| Compactor call | its own prompt and input | same system prompt and tools as the turns (never called), then a 16-32 KB context view (`<chat>`), then the task: reads the turns' prompt cache |
| Size control | clip afterwards | a 512-dash "ruler" in the task, then up to 5 "Too long ... cut before this mark" retries, keep the shortest |
| Cache marks | by character offsets (50k/80k/100k) | blocks of 4 lines; one mark on the last whole block, one on the request end |
| Logging | - | thoughts are never logged; message kinds `user, unii, tool, echo, work, note` |
| Prompt | COMPACT prompt | one shared prompt (turns + compactions) with sharper rules: zoom before acting, "say what you learned", tag items by kind, "never make anything look further along than it was", copy names/ids exactly |
| Name | OptChat / OptMem | UniiChat |

## Crew's state, item by item
| Spec point | Crew (`src/optchat.ts`, `runtime.ts`) | Verdict |
|---|---|---|
| Binary tree, free nodes when the source fits | leaves/nodes exist; **merge nodes always call the summarizer**, even if both children fit in one line | gap: join with a newline, no call |
| Node size 512 B | 480 B | close; fine |
| Due rule | used `(T - 1 - last) / 2^l`: right idea (from the last message), wrong by a term that is **not** constant across levels. Matched push at 140/400 steps. | **fixed on this branch**: `due(T, last, level) = (T - last) / 2^l`; test reproduces push exactly for 300 steps and fails with the old formula |
| Batch / sawtooth | no: `fitView` fits to one budget (6000 B) each time Pi compacts | gap, design difference (we build the view at compaction time, not per turn) |
| View saved, never rebuilt | rebuilt from leaves at each compaction (deterministic, the early part is stable - tested) | acceptable for compaction-time use; matters if we move to per-turn views |
| Only merge pairs whose parent is built | merges use extractive text for unbuilt parents | gap: view may contain lower-quality synthetic lines |
| Compactor = turns' system prompt + context view | separate `SUMMARY_SYSTEM`, **no context** (cannot resolve "do it") | gap; also a different provider is allowed, so cache sharing is not guaranteed anyway |
| Ruler + "Too long" retries | clip after the fact | gap |
| Zoom addressing | `#level.index` | spec uses `id+n` (message id and span): easier for the model; add as alias |
| `date(id)` instead of dates in lines | dates are inside the rendered lines | costs bytes; low priority |
| Thoughts not logged | only text and tool calls are logged | OK |
| One owner of the log | `workspace.sqlite`; Pi storage now has a lease lock | OK |
| Prompt rules | COMMON prompt has a weaker version of "zoom before relying on a detail" | gap: adopt "latest word in the view is the truth; zoom until whole before acting" |

## Suggested order (small, independent)
1. Done: due rule (exact push equivalence).
2. Free merge nodes (no call when `a + "\n" + b` fits) - cuts model calls.
3. Summary prompt and agent prompt wording from the spec (tag kinds, "avoid omissions", "never look further along").
4. Ruler + "Too long" retry loop with a keep-shortest rule.
5. `id+n` zoom alias.
6. Only merge built parents; then context view for compactions; the sawtooth/saved view only if we move to per-turn views.

The README of this repo still calls the feature "OptChat style"; rename when upstream naming settles.
