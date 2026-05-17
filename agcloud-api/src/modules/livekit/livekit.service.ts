import { AccessToken, RoomServiceClient, WebhookReceiver } from "livekit-server-sdk";
import { config } from "../../config/index.js";
import type {
  CreateRoomOptions,
  LiveKitWebhookEvent,
  RoomInfo,
  TokenRequest,
  TokenResponse,
} from "./livekit.types.js";

class LiveKitService {
  private readonly roomService: RoomServiceClient;
  private readonly webhookReceiver: WebhookReceiver;

  constructor() {
    const { apiKey, apiSecret, url } = config.livekit;
    this.roomService = new RoomServiceClient(url, apiKey, apiSecret);
    this.webhookReceiver = new WebhookReceiver(apiKey, apiSecret);
  }

  async createRoom(opts: CreateRoomOptions): Promise<RoomInfo> {
    const room = await this.roomService.createRoom({
      name: opts.name,
      emptyTimeout: opts.emptyTimeout ?? 300,
      maxParticipants: opts.maxParticipants ?? 0,
    });
    return {
      sid: room.sid,
      name: room.name,
      numParticipants: room.numParticipants,
      creationTime: Number(room.creationTime),
    };
  }

  async deleteRoom(roomName: string): Promise<void> {
    await this.roomService.deleteRoom(roomName);
  }

  async listRooms(): Promise<RoomInfo[]> {
    const rooms = await this.roomService.listRooms();
    return rooms.map((r) => ({
      sid: r.sid,
      name: r.name,
      numParticipants: r.numParticipants,
      creationTime: Number(r.creationTime),
    }));
  }

  async createToken(req: TokenRequest): Promise<TokenResponse> {
    const { apiKey, apiSecret, url } = config.livekit;
    const token = new AccessToken(apiKey, apiSecret, {
      identity: req.identity,
      name: req.name,
      ttl: req.ttl ?? 3600,
    });

    // Plain object grant — NOT new VideoGrant()
    token.addGrant({
      roomJoin: true,
      room: req.roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    // SDK v2: toJwt() returns Promise<string> — must await
    const jwt = await token.toJwt();
    return { token: jwt, livekitUrl: url };
  }

  verifyWebhook(rawBody: string, authHeader: string): LiveKitWebhookEvent {
    // Throws if HMAC signature is invalid — caller returns 401
    return this.webhookReceiver.receive(rawBody, authHeader);
  }
}

// Singleton — one RoomServiceClient per process
export const livekitService = new LiveKitService();
