import { FastifyInstance, FastifyPluginAsync } from "fastify";
import { initCallSchema } from "./call.schemas.js";
import { createLiveKitToken, endLiveKitRoom, getLiveKitBaseUrl, startRoomRecording, stopRecording } from "../livekit/livekit.service.js";
import { CallRepository } from "./call.repository.js";
import { CallStateMachine } from "./call.state-machine.js";
import { authenticate } from "../../shared/middleware/auth.middleware.js";
import { emitToUser } from "../realtime/realtime.service.js";
import { UserRepository } from "../user/user.repository.js";
import config from "../../config/index.js";

const callRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  const callRepo = new CallRepository();
  const userRepo = new UserRepository();

  // List endpoint for testing in postman
  app.get("/", async (request, reply) => {
    return {
      endpoints: [
        "POST /calls/initiate - Initiate a new call",
        "POST /calls/:id/accept - Accept an incoming call",
        "POST /calls/:id/reject - Reject an incoming call",
        "POST /calls/:id/end - Hang up / end a call",
        "POST /calls/:id/record/start - Start call recording",
        "POST /calls/:id/record/stop - Stop call recording"
      ],
      message: "Call routes are active"
    };
  });

  // Recent call history for the authenticated user
  app.get("/history", { preHandler: authenticate }, async (request, reply) => {
    const userId = request.user!.userId;
    const query = request.query as { limit?: string };
    const limit = Math.min(100, Math.max(1, parseInt(query.limit ?? "20", 10) || 20));

    const calls = await callRepo.getCallHistoryForUser(userId, limit);

    return reply.send({
      calls: calls.map((call) => {
        let durationSeconds: number | undefined;
        if (call.startedAt && call.endedAt) {
          durationSeconds = Math.max(
            0,
            Math.round((call.endedAt.getTime() - call.startedAt.getTime()) / 1000)
          );
        }

        return {
          id: call._id.toString(),
          callerId: call.callerId,
          calleeId: call.calleeId,
          receiverIds: call.receiverIds,
          callType: call.callType,
          status: call.status,
          durationSeconds,
          createdAt: call.createdAt?.toISOString(),
          startedAt: call.startedAt?.toISOString(),
          endedAt: call.endedAt?.toISOString(),
        };
      }),
    });
  });

  // Initiate a new call
  app.post("/initiate", { preHandler: authenticate }, async (request, reply) => {
    const body = initCallSchema.parse(request.body);
    const callerId = request.user!.userId;

    // Extract all receiver IDs (calleeId or receiverIds array)
    let receiverIds = body.receiverIds || [];
    if (receiverIds.length === 0 && body.calleeId) {
      receiverIds = [body.calleeId];
    }

    if (receiverIds.length === 0) {
      return reply.status(400).send({ message: "At least one receiver ID is required" });
    }

    if (receiverIds.includes(callerId)) {
      return reply.status(400).send({ message: "You cannot call yourself" });
    }

    // Check if user is already in an active call
    const activeCall = await callRepo.getActiveCallForUser(callerId);
    if (activeCall) {
      return reply.status(400).send({
        message: "You are already in an active call",
        callId: activeCall._id.toString()
      });
    }

    // Create call record in MongoDB
    const callRecord = await callRepo.createCall(
      callerId,
      receiverIds,
      body.callType,
      body.callMode,
      body.recording
    );
    const roomId = callRecord.roomId || callRecord._id.toString();

    // Generate token for the caller
    const token = await createLiveKitToken(callerId, roomId);

    // Notify all receivers in real time so they see an incoming call popup
    const caller = await userRepo.getUserById(callerId);
    const callId = callRecord._id.toString();
    for (const receiverId of receiverIds) {
      emitToUser(receiverId, "call:incoming", {
        callId,
        callerId,
        callerName: caller?.displayName ?? "Unknown",
        callerAvatar: caller?.avatarUrl ?? null,
        callType: callRecord.callType,
        callMode: callRecord.callMode,
        roomId,
      });
    }

    return reply.status(201).send({
      message: "Call initiated successfully",
      call: callRecord,
      token,
      roomName: roomId,
      url: getLiveKitBaseUrl()
    });
  });

  app.get("/:id", { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user!.userId;

    const callRecord = await callRepo.getCallById(id);
    if (!callRecord) {
      return reply.status(404).send({ message: "Call not found" });
    }

    const isAuthorized = callRecord.callerId === userId ||
      (callRecord.callMode === "conference"
        ? callRecord.receiverIds.includes(userId)
        : callRecord.calleeId === userId);

    if (!isAuthorized) {
      return reply.status(403).send({ message: "You are not authorized to view this call" });
    }

    return reply.send({ call: callRecord });
  });

  // Accept a call
  app.post("/:id/accept", { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const calleeId = request.user!.userId;
    const callRecord = await callRepo.getCallById(id);
    if (!callRecord) {
      return reply.status(404).send({ message: "Call not found" });
    }

    // Validate authorization: callee must be in the receivers list or equal to calleeId
    const isAuthorized = callRecord.callMode === "conference"
      ? callRecord.receiverIds.includes(calleeId)
      : callRecord.calleeId === calleeId;

    if (!isAuthorized) {
      return reply.status(403).send({ message: "You are not authorized to accept this call" });
    }

    if (!CallStateMachine.isValidTransition(callRecord.status, "active")) {
      return reply.status(400).send({
        message: `Cannot transition call from '${callRecord.status}' to 'active'`
      });
    }

    // Update status to active
    await callRepo.updateCallStatus(id, "active");
    callRecord.status = "active";

    const roomId = callRecord.roomId || id;

    // Generate token for the callee
    const token = await createLiveKitToken(calleeId, roomId);

    // Notify the caller that the call was accepted
    emitToUser(callRecord.callerId, "call:accepted", {
      callId: id,
      calleeId,
      roomId,
    });

    // Stop ringing on other receivers (conference) since the call is now active
    for (const otherReceiverId of callRecord.receiverIds) {
      if (otherReceiverId !== calleeId) {
        emitToUser(otherReceiverId, "call:cancelled", { callId: id });
      }
    }

    return reply.send({
      message: "Call accepted successfully",
      call: callRecord,
      token,
      roomName: roomId,
      url: getLiveKitBaseUrl()
    });
  });

  // Reject a call
  app.post("/:id/reject", { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const calleeId = request.user!.userId;

    const callRecord = await callRepo.getCallById(id);
    if (!callRecord) {
      return reply.status(404).send({ message: "Call not found" });
    }

    const isAuthorized = callRecord.callMode === "conference"
      ? callRecord.receiverIds.includes(calleeId)
      : callRecord.calleeId === calleeId;

    if (!isAuthorized) {
      return reply.status(403).send({ message: "You are not authorized to reject this call" });
    }

    if (!CallStateMachine.isValidTransition(callRecord.status, "rejected")) {
      return reply.status(400).send({
        message: `Cannot transition call from '${callRecord.status}' to 'rejected'`
      });
    }

    await callRepo.updateCallStatus(id, "rejected");

    emitToUser(callRecord.callerId, "call:rejected", {
      callId: id,
      calleeId,
    });

    return reply.send({ message: "Call rejected successfully" });
  });

  // End a call (Hang up)
  app.post("/:id/end", { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user!.userId;

    const callRecord = await callRepo.getCallById(id);
    if (!callRecord) {
      return reply.status(404).send({ message: "Call not found" });
    }

    const isAuthorized = callRecord.callerId === userId || 
      (callRecord.callMode === "conference" 
        ? callRecord.receiverIds.includes(userId) 
        : callRecord.calleeId === userId);

    if (!isAuthorized) {
      return reply.status(403).send({ message: "You are not authorized to end this call" });
    }

    if (callRecord.status === "ended") {
      await endLiveKitRoom(callRecord.roomId || id);
      return reply.send({ message: "Call already ended" });
    }

    if (!CallStateMachine.isValidTransition(callRecord.status, "ended")) {
      return reply.status(400).send({
        message: `Cannot transition call from '${callRecord.status}' to 'ended'`
      });
    }

    await callRepo.updateCallStatus(id, "ended");
    await endLiveKitRoom(callRecord.roomId || id);

    // Notify all other participants that the call has ended
    const participantIds = new Set([callRecord.callerId, ...callRecord.receiverIds]);
    participantIds.delete(userId);
    for (const participantId of participantIds) {
      emitToUser(participantId, "call:ended", { callId: id });
    }

    return reply.send({ message: "Call ended successfully" });
  });

  // Start call recording (LiveKit Egress)
  app.post("/:id/record/start", { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user!.userId;

    const callRecord = await callRepo.getCallById(id);
    if (!callRecord) {
      return reply.status(404).send({ message: "Call not found" });
    }

    const isAuthorized = callRecord.callerId === userId || callRecord.receiverIds.includes(userId);
    if (!isAuthorized) {
      return reply.status(403).send({ message: "You are not authorized to record this call" });
    }

    // Start LiveKit Egress (recording)
    const roomName = callRecord.roomId || id;
    const timestamp = Date.now();
    const fileOutput = { filepath: `/recordings/room-${roomName}-${timestamp}.mp4` };
    const egress = await startRoomRecording(roomName, fileOutput);

    await callRepo.updateCallStatus(id, callRecord.status, {
      recording: true,
      recordingStartedAt: new Date(),
      egressId: egress.egressId
    });

    return reply.send({ message: "Call recording started successfully", egressId: egress.egressId });
  });

  // Stop call recording (LiveKit Egress)
  app.post("/:id/record/stop", { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user!.userId;

    const callRecord = await callRepo.getCallById(id);
    if (!callRecord) {
      return reply.status(404).send({ message: "Call not found" });
    }

    const isAuthorized = callRecord.callerId === userId || callRecord.receiverIds.includes(userId);
    if (!isAuthorized) {
      return reply.status(403).send({ message: "You are not authorized to stop recording this call" });
    }

    if (!callRecord.egressId) {
      return reply.status(400).send({ message: "No active recording (egressId missing)" });
    }

    await stopRecording(callRecord.egressId);
    await callRepo.updateCallStatus(id, callRecord.status, {
      recording: false,
      recordingEndedAt: new Date()
    });

    return reply.send({ message: "Call recording stopped successfully" });
  });

  // HTML WebRTC Tester Page
  app.get("/test", async (request, reply) => {
    reply.type("text/html");
    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LiveKit WebRTC Call Tester</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&display=swap" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/livekit-client/dist/livekit-client.umd.min.js"></script>
  <style>
    :root {
      --bg: #0b0f19;
      --card-bg: rgba(255, 255, 255, 0.03);
      --card-border: rgba(255, 255, 255, 0.08);
      --primary: #4f46e5;
      --primary-hover: #4338ca;
      --primary-glow: rgba(79, 70, 229, 0.4);
      --success: #10b981;
      --danger: #ef4444;
      --text: #f3f4f6;
      --text-muted: #9ca3af;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      font-family: 'Outfit', sans-serif;
    }

    body {
      background-color: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 2rem 1rem;
      background-image: 
        radial-gradient(circle at 10% 20%, rgba(79, 70, 229, 0.15) 0%, transparent 40%),
        radial-gradient(circle at 90% 80%, rgba(16, 185, 129, 0.1) 0%, transparent 40%);
    }

    header {
      text-align: center;
      margin-bottom: 2.5rem;
    }

    h1 {
      font-size: 2.5rem;
      font-weight: 800;
      background: linear-gradient(135deg, #a5b4fc 0%, #818cf8 50%, #34d399 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 0.5rem;
    }

    p.subtitle {
      color: var(--text-muted);
      font-size: 1.1rem;
    }

    .container {
      width: 100%;
      max-width: 1100px;
      display: grid;
      grid-template-columns: 1fr;
      gap: 2rem;
    }

    @media (min-width: 768px) {
      .container {
        grid-template-columns: 320px 1fr;
      }
    }

    .panel {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      backdrop-filter: blur(16px);
      border-radius: 1.25rem;
      padding: 1.75rem;
      display: flex;
      flex-direction: column;
      gap: 1.5rem;
      box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.37);
    }

    .form-group {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    label {
      font-size: 0.85rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
    }

    input, select {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--card-border);
      padding: 0.85rem 1rem;
      border-radius: 0.75rem;
      color: #fff;
      font-size: 0.95rem;
      outline: none;
      transition: all 0.3s ease;
    }

    input:focus {
      border-color: var(--primary);
      box-shadow: 0 0 0 3px var(--primary-glow);
    }

    button {
      background: var(--primary);
      border: none;
      color: white;
      padding: 1rem;
      border-radius: 0.75rem;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.3s ease;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
    }

    button:hover {
      background: var(--primary-hover);
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(79, 70, 229, 0.3);
    }

    button:active {
      transform: translateY(0);
    }

    button.disconnect {
      background: var(--danger);
    }

    button.disconnect:hover {
      background: #dc2626;
      box-shadow: 0 4px 12px rgba(239, 68, 68, 0.3);
    }

    .status-badge {
      display: flex;
      align-items: center;
      gap: 0.50rem;
      font-size: 0.9rem;
      font-weight: 600;
      padding: 0.5rem 1rem;
      border-radius: 2rem;
      align-self: flex-start;
      background: rgba(255, 255, 255, 0.05);
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--text-muted);
    }

    .status-dot.connected { background: var(--success); box-shadow: 0 0 8px var(--success); }
    .status-dot.connecting { background: #f59e0b; box-shadow: 0 0 8px #f59e0b; }
    .status-dot.disconnected { background: var(--danger); box-shadow: 0 0 8px var(--danger); }

    .video-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 1.5rem;
      min-height: 450px;
    }

    @media (min-width: 992px) {
      .video-grid {
        grid-template-columns: 1fr 1fr;
      }
    }

    .video-box {
      background: #060913;
      border: 1px solid var(--card-border);
      border-radius: 1.25rem;
      overflow: hidden;
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: inset 0 0 20px rgba(0, 0, 0, 0.8);
    }

    .video-box video {
      width: 100%;
      height: 100%;
      object-fit: cover;
      transform: scaleX(-1); /* mirror local video */
    }

    /* Don't mirror remote video */
    .video-box.remote video {
      transform: scaleX(1);
    }

    .video-label {
      position: absolute;
      bottom: 1rem;
      left: 1rem;
      background: rgba(0, 0, 0, 0.6);
      backdrop-filter: blur(8px);
      padding: 0.4rem 0.8rem;
      border-radius: 0.5rem;
      font-size: 0.85rem;
      font-weight: 500;
      border: 1px solid rgba(255, 255, 255, 0.1);
      z-index: 10;
    }

    .placeholder-text {
      color: var(--text-muted);
      font-size: 1rem;
      text-align: center;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.5rem;
    }

    .placeholder-text svg {
      width: 48px;
      height: 48px;
      stroke: var(--text-muted);
      opacity: 0.4;
    }
  </style>
</head>
<body>

  <header>
    <h1>WebRTC Call Tester</h1>
    <p class="subtitle">Quick-test LiveKit audio and video connectivity</p>
  </header>

  <div class="container">
    <!-- Configuration panel -->
    <div class="panel">
      <div class="status-badge">
        <div id="status-dot" class="status-dot disconnected"></div>
        <span id="status-text">Disconnected</span>
      </div>

      <div class="form-group">
        <label for="ws-url">LiveKit Host URL</label>
        <input type="text" id="ws-url" value="${config.livekitUrl}" placeholder="ws://localhost:7880">
      </div>

      <div class="form-group">
        <label for="token">LiveKit Token</label>
        <input type="text" id="token" placeholder="Paste generated JWT token here">
      </div>

      <button id="connect-btn">Connect & Start</button>
    </div>

    <!-- Video streams grid -->
    <div class="video-grid">
      <!-- Local stream -->
      <div class="video-box" id="local-video-box">
        <div class="video-label">Local Camera (You)</div>
        <div class="placeholder-text" id="local-placeholder">
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
          Camera feed not active
        </div>
      </div>

      <!-- Remote stream -->
      <div class="video-box remote" id="remote-video-box">
        <div class="video-label">Remote Stream (Peer)</div>
        <div class="placeholder-text" id="remote-placeholder">
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
          </svg>
          No remote peer connected
        </div>
      </div>
    </div>
  </div>

  <script>
    const LiveKitClient = window.LivekitClient || window.LiveKit || window.LiveKitClient;
    let currentRoom = null;
    const connectBtn = document.getElementById('connect-btn');
    const tokenInput = document.getElementById('token');
    const wsUrlInput = document.getElementById('ws-url');
    const statusDot = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');

    const localVideoBox = document.getElementById('local-video-box');
    const remoteVideoBox = document.getElementById('remote-video-box');
    const localPlaceholder = document.getElementById('local-placeholder');
    const remotePlaceholder = document.getElementById('remote-placeholder');

    function updateStatus(state, text) {
      statusDot.className = 'status-dot ' + state;
      statusText.innerText = text;
    }

    async function toggleConnection() {
      if (currentRoom) {
        // Disconnect
        await currentRoom.disconnect();
        return;
      }

      const token = tokenInput.value.trim();
      const wsUrl = wsUrlInput.value.trim();

      if (!token) {
        alert('Please paste a valid LiveKit JWT Token first.');
        return;
      }

      connectBtn.disabled = true;
      connectBtn.innerText = 'Connecting...';
      updateStatus('connecting', 'Connecting...');

      try {
        const room = new LiveKitClient.Room({
          adaptiveStream: true,
          dynacast: true,
        });

        currentRoom = room;

        // Setup remote stream subscriber listeners
        room
          .on(LiveKitClient.RoomEvent.TrackSubscribed, (track, publication, participant) => {
            if (track.kind === 'video') {
              remotePlaceholder.style.display = 'none';
              
              // Remove old remote video if any
              const existingVideo = remoteVideoBox.querySelector('video');
              if (existingVideo) existingVideo.remove();
              
              const el = track.attach();
              remoteVideoBox.appendChild(el);
            } else if (track.kind === 'audio') {
              const el = track.attach();
              remoteVideoBox.appendChild(el); // Attach audio to play
            }
          })
          .on(LiveKitClient.RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
            track.detach();
            if (track.kind === 'video') {
              const videoEl = remoteVideoBox.querySelector('video');
              if (videoEl) videoEl.remove();
              remotePlaceholder.style.display = 'flex';
            }
          })
          .on(LiveKitClient.RoomEvent.Disconnected, () => {
            console.log('Room disconnected');
            cleanupRoomUI();
          });

        // Connect to LiveKit Room
        await room.connect(wsUrl, token);
        
        updateStatus('connected', 'Connected');
        connectBtn.disabled = false;
        connectBtn.innerText = 'Disconnect';
        connectBtn.classList.add('disconnect');

        // Share camera and microphone
        await room.localParticipant.setCameraEnabled(true);
        await room.localParticipant.setMicrophoneEnabled(true);

        // Display local stream in the local camera box
        room.localParticipant.trackPublications.forEach((publication) => {
          if (publication.track && publication.track.kind === 'video') {
            localPlaceholder.style.display = 'none';
            
            const existingVideo = localVideoBox.querySelector('video');
            if (existingVideo) existingVideo.remove();

            const el = publication.track.attach();
            localVideoBox.appendChild(el);
          }
        });

      } catch (err) {
        console.error('Failed to connect to LiveKit:', err);
        alert('Connection failed: ' + err.message);
        cleanupRoomUI();
      }
    }

    function cleanupRoomUI() {
      currentRoom = null;
      connectBtn.disabled = false;
      connectBtn.innerText = 'Connect & Start';
      connectBtn.classList.remove('disconnect');
      updateStatus('disconnected', 'Disconnected');

      // Clear local video element
      const localVideo = localVideoBox.querySelector('video');
      if (localVideo) localVideo.remove();
      localPlaceholder.style.display = 'flex';

      // Clear remote video element
      const remoteVideo = remoteVideoBox.querySelector('video');
      if (remoteVideo) remoteVideo.remove();
      remotePlaceholder.style.display = 'flex';
    }

    connectBtn.addEventListener('click', toggleConnection);
  </script>
</body>
</html>
    `;
  });
};

export default callRoutes;
