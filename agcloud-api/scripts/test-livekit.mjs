#!/usr/bin/env node
/**
 * LiveKit smoke test
 *
 * Prerequisites:
 *   docker-compose up -d mongo redis livekit
 *   npm run dev  (in backend/)
 *
 * Usage:
 *   node backend/scripts/test-livekit.mjs
 */

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:3000";
const LIVEKIT = process.env.LIVEKIT_URL ?? "http://localhost:7880";

console.log("=== agcloud LiveKit smoke test ===\n");

// 1. Backend health
process.stdout.write("1. Backend health ... ");
const healthRes = await fetch(`${BACKEND}/health`).catch(() => null);
if (!healthRes?.ok) { console.log("FAIL — is backend running?"); process.exit(1); }
console.log("OK");

// 2. Request a token
process.stdout.write("2. Token request ... ");
const tokenRes = await fetch(`${BACKEND}/api/livekit/token`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ roomName: "test-room-001", identity: "venkat-test", name: "Venkat", ttl: 600 }),
});
if (!tokenRes.ok) {
  console.log(`FAIL — HTTP ${tokenRes.status}: ${await tokenRes.text()}`);
  process.exit(1);
}
const { token, livekitUrl } = await tokenRes.json();
if (!token || typeof token !== "string" || token.split(".").length !== 3) {
  console.log("FAIL — response is not a valid JWT:", token);
  process.exit(1);
}
console.log("OK");
console.log(`   LiveKit URL: ${livekitUrl}`);
console.log(`   Token (first 60 chars): ${token.slice(0, 60)}...`);

// 3. Create a room via API
process.stdout.write("\n3. Create room via API ... ");
const roomRes = await fetch(`${BACKEND}/api/livekit/rooms`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "test-room-001", emptyTimeout: 60 }),
});
if (roomRes.ok) {
  const room = await roomRes.json();
  console.log(`OK — room sid: ${room.sid}`);
} else {
  console.log(`FAIL — HTTP ${roomRes.status} (LiveKit may not be reachable from backend yet)`);
}

// 4. Probe LiveKit directly
process.stdout.write("\n4. LiveKit server reachable ... ");
const lkRes = await fetch(`${LIVEKIT}/rtc/validate`).catch(() => null);
if (!lkRes) {
  console.log("WARN — not reachable from host (OK if only inside Docker network)");
} else {
  // 401 = LiveKit is up, rejected unauthenticated request — expected
  console.log(`OK — HTTP ${lkRes.status} (401 = expected for no token)`);
}

// 5. Connect instructions
console.log("\n5. Connect with LiveKit CLI:");
console.log(`   lk room join --url ws://localhost:7880 --token "${token}"`);
console.log("\n   Or open https://agents-playground.livekit.io and paste:");
console.log(`   URL: ws://localhost:7880   Token: ${token}`);

console.log("\n=== Done ===");
