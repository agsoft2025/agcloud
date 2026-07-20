import { ObjectId } from "mongodb";
import { signAccessToken } from "../../src/shared/security/jwt.js";

export function mintAccessToken(userId: string, email: string): string {
  return signAccessToken(userId, email);
}

export function authHeader(userId: string, email: string): { authorization: string } {
  return { authorization: `Bearer ${mintAccessToken(userId, email)}` };
}

export function makeUserDoc(overrides: Record<string, unknown> = {}) {
  const _id = (overrides._id as ObjectId) ?? new ObjectId();
  return {
    _id,
    email: overrides.email ?? `user-${_id.toString().slice(-6)}@example.com`,
    passwordHash: overrides.passwordHash ?? "",
    displayName: overrides.displayName ?? "Test User",
    presenceStatus: overrides.presenceStatus ?? "offline",
    isBlocked: overrides.isBlocked ?? false,
    status: overrides.status ?? "active",
    createdAt: overrides.createdAt ?? new Date(),
    ...overrides,
  };
}

export function makeCallDoc(overrides: Record<string, unknown> = {}) {
  const _id = (overrides._id as ObjectId) ?? new ObjectId();
  return {
    _id,
    callerId: overrides.callerId ?? "caller-1",
    calleeId: overrides.calleeId ?? "callee-1",
    receiverIds: overrides.receiverIds ?? ["callee-1"],
    callMode: overrides.callMode ?? "one-to-one",
    status: overrides.status ?? "initiated",
    callType: overrides.callType ?? "audio",
    recording: overrides.recording ?? false,
    participants: overrides.participants ?? {
      "callee-1": { status: "invited", invitedAt: new Date(), invitedBy: "caller-1" },
    },
    createdAt: overrides.createdAt ?? new Date(),
    roomId: overrides.roomId ?? _id.toString(),
    ...overrides,
  };
}

export function makeDeviceDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: overrides._id ?? new ObjectId(),
    userId: overrides.userId ?? "user-1",
    platform: overrides.platform ?? "ios",
    token: overrides.token ?? "device-token-abc",
    createdAt: overrides.createdAt ?? new Date(),
    ...overrides,
  };
}
