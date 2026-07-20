import { vi } from "vitest";

// Import before anything that transitively imports "livekit-server-sdk"
// (livekit.service.ts, livekit.routes.ts, call.routes.ts).
export const livekitMocks = {
  deleteRoom: vi.fn().mockResolvedValue(undefined),
  listRooms: vi.fn().mockResolvedValue([]),
  startRoomCompositeEgress: vi.fn().mockResolvedValue({ egressId: "egress-123" }),
  stopEgress: vi.fn().mockResolvedValue({ egressId: "egress-123" }),
  toJwt: vi.fn().mockResolvedValue("fake.livekit.jwt"),
  webhookReceive: vi.fn(),
};

vi.mock("livekit-server-sdk", () => {
  class RoomServiceClient {
    deleteRoom(...args: unknown[]) {
      return livekitMocks.deleteRoom(...args);
    }
    listRooms(...args: unknown[]) {
      return livekitMocks.listRooms(...args);
    }
  }
  class EgressClient {
    startRoomCompositeEgress(...args: unknown[]) {
      return livekitMocks.startRoomCompositeEgress(...args);
    }
    stopEgress(...args: unknown[]) {
      return livekitMocks.stopEgress(...args);
    }
  }
  class AccessToken {
    constructor(_key?: string, _secret?: string, _opts?: unknown) {}
    addGrant(_grant: unknown) {}
    toJwt(...args: unknown[]) {
      return livekitMocks.toJwt(...args);
    }
  }
  class WebhookReceiver {
    constructor(_key?: string, _secret?: string) {}
    receive(...args: unknown[]) {
      return livekitMocks.webhookReceive(...args);
    }
  }
  return { RoomServiceClient, EgressClient, AccessToken, WebhookReceiver };
});
