import { Room } from "livekit-client";

let room: Room | null = null;
const defaultUrl = import.meta.env.VITE_LIVEKIT_URL ?? "ws://localhost/rtc";

export async function connectToLiveKit(token: string, url = defaultUrl) {
  if (room) {
    room.disconnect();
  }

  room = new Room();

  await room.connect(url, token, {
    autoSubscribe: true
  });

  room.on("disconnected", () => {
    room = null;
  });

  return room;
}

export function getRoom() {
  return room;
}
