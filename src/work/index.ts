import { db } from "../db.ts";
import { EventBus } from "./events.ts";
import { CaseService } from "./case.ts";
import { HandoffService } from "./handoffs.ts";

/** The process-wide bus and handoff service over the workspace database. Tests build their own over a scratch database. */
export const bus = new EventBus(db);
export const handoffs = new HandoffService(bus);
export const cases = new CaseService(bus);
