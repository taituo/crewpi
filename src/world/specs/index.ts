import type { WorldSpec } from "../types.ts";
import { tickerSpec } from "./ticker.ts";

/** The worlds that exist. A world file remembers the name of its spec and refuses to be opened with another. */
export const SPECS: Record<string, WorldSpec<any>> = { ticker: tickerSpec };
