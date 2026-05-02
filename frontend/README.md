# agcloud Frontend

This frontend is the user-facing web application for `agcloud`, built as a SvelteKit app.

## Purpose
- User authentication and session management
- Contact list and presence display
- Call initiation and receiving flow
- In-call UI for audio/video, mute/unmute, screen share, and participant controls
- Display call history and recordings

## Recommended structure
- `src/routes/` — page routes and endpoints
- `src/lib/components/` — reusable UI components
- `src/lib/services/` — backend API client, LiveKit room service, notification service
- `src/lib/stores/` — application state management
- `src/assets/` — icons, styles, images

## LiveKit integration
- The frontend receives a LiveKit access token from the backend
- It connects to LiveKit via the standard SDK and joins a room
- All actual media transport, ICE, TURN, and SFU behavior is handled by LiveKit

## Local development
1. Install dependencies: `pnpm install`
2. Run the development server: `pnpm dev`

## Notes
- Use a proxy or CORS configuration so frontend calls to `/api/*` reach the backend during local dev
- Keep LiveKit-related client logic isolated in a `LiveKitService` wrapper
- Do not implement custom signaling or SDP handling in the frontend
