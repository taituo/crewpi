import type { WorldSpec } from "../types.ts";
import { itopsSpec } from "../itops/spec.ts";
import { tickerSpec } from "./ticker.ts";

/** The worlds that exist. A world file remembers the name of its spec and refuses to be opened with another. */
export const SPECS: Record<string, WorldSpec<any>> = { ticker: tickerSpec, "itops:oracle": itopsSpec("oracle"), "itops:naive": itopsSpec("naive"), "itops:none": itopsSpec("none") };
