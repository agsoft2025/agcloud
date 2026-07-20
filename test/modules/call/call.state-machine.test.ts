import { describe, expect, it } from "vitest";
import { CallStateMachine } from "../../../src/modules/call/call.state-machine.js";
import type { CallStatus } from "../../../src/modules/call/call.schemas.js";

const ALL_STATUSES: CallStatus[] = ["initiated", "active", "rejected", "ended", "missed", "cancelled"];

describe("CallStateMachine.isValidTransition", () => {
  const allowed: Record<CallStatus, CallStatus[]> = {
    initiated: ["active", "rejected", "ended", "missed", "cancelled"],
    active: ["ended"],
    rejected: [],
    ended: [],
    missed: [],
    cancelled: [],
  };

  for (const from of ALL_STATUSES) {
    for (const to of ALL_STATUSES) {
      const expected = allowed[from].includes(to);
      it(`${expected ? "allows" : "rejects"} ${from} -> ${to}`, () => {
        expect(CallStateMachine.isValidTransition(from, to)).toBe(expected);
      });
    }
  }
});
