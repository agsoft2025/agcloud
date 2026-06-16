import { CallStatus } from "./call.schemas.js";

const VALID_TRANSITIONS: Record<CallStatus, CallStatus[]> = {
  initiated: ["active", "rejected", "ended", "missed"],
  active: ["ended"],
  rejected: [],
  ended: [],
  missed: [],
};

export class CallStateMachine {
  static isValidTransition(current: CallStatus, next: CallStatus): boolean {
    const validNextStates = VALID_TRANSITIONS[current] || [];
    return validNextStates.includes(next);
  }
}
