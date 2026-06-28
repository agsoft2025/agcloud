# agcloud Frontend (Web): Specification

> **Date:** 2026-04-16
> **Scope:** Web application specification for agcloud calling platform
> **Priorities:** Performance, UX, Lightweight bundle
> **Stack:** SvelteKit + TypeScript + Vite + LiveKit Client SDK

---

## Table of Contents
1. [Goals & Constraints](#1-goals--constraints)
2. [Tech Stack & Rationale](#2-tech-stack--rationale)
3. [Performance Budgets](#3-performance-budgets)
4. [Application Architecture](#4-application-architecture)
5. [Screen Specifications & Mockups](#5-screen-specifications--mockups)
6. [Component Library](#6-component-library)
7. [State Management](#7-state-management)
8. [LiveKit Integration](#8-livekit-integration)
9. [Real-Time Notifications](#9-real-time-notifications)
10. [PWA & Offline Behavior](#10-pwa--offline-behavior)
11. [Accessibility (a11y)](#11-accessibility-a11y)
12. [Performance Optimization](#12-performance-optimization)
13. [Security (Frontend)](#13-security-frontend)
14. [Testing Strategy](#14-testing-strategy)
15. [Build & Deployment](#15-build--deployment)

---

## 1. Goals & Constraints

### 1.1 Primary Goals

| Goal | Target |
|------|--------|
| **First contentful paint** | <1.0s on 4G |
| **Time to interactive** | <2.5s on 4G |
| **Initial JS bundle (gzipped)** | <80 KB |
| **Total payload first load** | <250 KB |
| **Call answer latency** | <500ms after click |
| **Lighthouse score** | >95 (Perf, A11y, Best Practices, SEO) |
| **Web Vitals** | LCP <2.5s, INP <200ms, CLS <0.1 |

### 1.2 UX Principles

1. **Calling first** — minimum clicks to call someone (target: 2 clicks)
2. **Predictable** — every action gives immediate visual feedback (<100ms)
3. **Recoverable** — clear errors with concrete next steps
4. **Quiet** — no spinners where skeletons work; no toasts where status bars work
5. **Keyboard-friendly** — every action reachable via keyboard
6. **Progressive disclosure** — simple by default; advanced features on demand

### 1.3 Non-Goals (MVP)

- Server-side rendering of authenticated pages (we render the shell SSR, then hydrate)
- Internationalization (Phase 2 — but architecture supports it)
- Desktop-grade keyboard shortcuts (Phase 2)
- Themes beyond light/dark (Phase 2)

---

## 2. Tech Stack & Rationale

### 2.1 Framework: SvelteKit

| Why SvelteKit | Detail |
|---------------|--------|
| **Smallest bundles** | Compiled output, no runtime — typical app is 30-50% smaller than React |
| **No Virtual DOM** | Direct DOM updates; lower CPU on mobile |
| **Built-in stores** | No Redux/Zustand needed for our scope |
| **File-based routing** | Less boilerplate, easier mental model |
| **SSR + SPA hybrid** | SSR the shell for fast first paint, SPA for app interactions |
| **Vite under the hood** | Fastest dev server, instant HMR |
| **Excellent DX** | Single-file components, scoped CSS, TypeScript-native |

**Bundle comparison** (Hello World + router + state):

| Framework | Min+gzip |
|-----------|----------|
| React + React Router + Zustand | ~60 KB |
| Vue 3 + Vue Router + Pinia | ~50 KB |
| Preact + Wouter + Signals | ~12 KB |
| **SvelteKit** | **~10 KB** |
| Solid + Solid Router | ~15 KB |

### 2.2 Full Stack Choices

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Framework | **SvelteKit** | Smallest bundle, excellent DX |
| Language | **TypeScript** (strict) | Catch bugs at compile time |
| Bundler | **Vite** (built into SvelteKit) | Fast dev, ESM-native |
| Styling | **PicoCSS** + **Open Props** + scoped CSS | Tiny CSS framework + design tokens; no utility-class bloat |
| Icons | **Lucide** (tree-shaken, SVG) | Only ship icons we use |
| LiveKit | **livekit-client** (official SDK) | Required |
| HTTP | **Native fetch** + thin wrapper | No axios needed |
| Date | **date-fns** (tree-shaken) | Only import used functions |
| Forms | **Native + Zod validation** | No form library needed |
| Animations | **CSS transitions** + Web Animations API | No animation library |
| Testing | **Vitest** + **Playwright** | Same Vite pipeline |

**Avoided heavy dependencies:** No Redux, MobX, Lodash, Moment.js, jQuery, Bootstrap, Material UI.

---

## 3. Performance Budgets

### 3.1 Bundle Size Budgets

| Asset | Budget (gzipped) | Hard Limit |
|-------|------------------|------------|
| Initial JS (route 0) | 80 KB | 120 KB |
| Per-route JS (lazy) | 30 KB | 50 KB |
| Initial CSS | 15 KB | 25 KB |
| Web fonts (subset) | 30 KB | 50 KB |
| Service Worker | 10 KB | 20 KB |
| **Total first-load** | **250 KB** | **350 KB** |

CI fails if any budget exceeded. Tracked via `bundlesize` or `size-limit`.

### 3.2 Runtime Performance Budgets

| Metric | Budget |
|--------|--------|
| Main thread blocking (per task) | <50ms |
| Event handler response | <100ms |
| Route transition | <300ms |
| Call screen mount (after token received) | <200ms |
| Video first frame after join | <800ms |

### 3.3 Network Budgets

| Endpoint | Target Time-to-Byte |
|----------|---------------------|
| `GET /api/users/me` | <200ms p95 |
| `POST /api/calls/initiate` | <400ms p95 |
| LiveKit WebSocket connect | <500ms p95 |
| First video frame | <1s p95 |

---

## 4. Application Architecture

### 4.1 High-Level Structure

```
+-------------------------------------------------------+
|                      Browser                          |
|                                                       |
|  +----------------------------------------+           |
|  |          Service Worker (PWA)          |           |
|  |  - Cache shell (HTML, JS, CSS)         |           |
|  |  - Offline fallback                    |           |
|  |  - Push notifications                  |           |
|  +-------------------+--------------------+           |
|                      |                                |
|                      v                                |
|  +----------------------------------------+           |
|  |        SvelteKit App (SPA shell)       |           |
|  |                                        |           |
|  |  +-------------+  +-----------------+  |           |
|  |  |   Routes    |  |  Component Lib  |  |           |
|  |  | (file-based)|  | (Button, Avatar |  |           |
|  |  |             |  |  Modal, Toast)  |  |           |
|  |  +------+------+  +-----------------+  |           |
|  |         |                              |           |
|  |         v                               |           |
|  |  +----------------------------------+  |           |
|  |  |       Stores (Svelte)            |  |           |
|  |  |  authStore | callStore | userStore|  |           |
|  |  +------+---------------+-----------+  |           |
|  |         |               |              |           |
|  |         v               v              |           |
|  |  +-----------+   +-------------+       |           |
|  |  |  API      |   |  LiveKit    |       |           |
|  |  |  Client   |   |  Client     |       |           |
|  |  +-----------+   +-------------+       |           |
|  +----------------------------------------+           |
+--------+--------------------+-------------------------+
         |                    |                          
         v                    v                          
  HTTPS REST           WSS + UDP (WebRTC)               
  + WSS (presence)     to LiveKit                       
         |                    
         v                    
  Backend API          
```

### 4.2 Routing Map

```
/                       (redirects to /home if authed, /signin if not)
/signin                 (public)
/signup                 (public)
/forgot-password        (public)
/reset-password         (public, token in URL)

/home                   (authed) - default dashboard, recent calls
/contacts               (authed)
/contacts/:id           (authed) - contact detail / call history
/calls                  (authed) - full call history
/calls/:id              (authed) - call detail (recording, participants)
/call/:roomName         (authed) - **active call screen**
/settings               (authed)
/settings/profile       (authed)
/settings/devices       (authed) - mic/cam/speaker chooser
/settings/notifications (authed)
/settings/privacy       (authed)
```

### 4.3 Folder Structure

```
src/
  app.html                          # HTML shell (minimal)
  app.css                           # Global tokens + reset
  service-worker.ts
  hooks.client.ts                   # Client-side hooks (auth, errors)
  hooks.server.ts                   # SSR auth check
  lib/
    api/
      client.ts                     # fetch wrapper, token refresh
      auth.api.ts
      user.api.ts
      call.api.ts
    livekit/
      LiveKitClient.ts              # SDK wrapper
      useCall.ts                    # call state hook (Svelte action)
      audio-output.ts               # speaker selection helpers
    stores/
      auth.store.ts
      call.store.ts
      user.store.ts
      presence.store.ts
      toast.store.ts
    components/
      Button.svelte
      Avatar.svelte
      Modal.svelte
      Toast.svelte
      VideoTile.svelte
      CallControls.svelte
      ContactList.svelte
      ...
    utils/
      time.ts
      format.ts
      a11y.ts                       # focus traps, screen reader helpers
      web-vitals.ts                 # report to backend
  routes/
    +layout.svelte                  # root layout (toast container, nav)
    +layout.ts                      # auth check, prefetch user
    +page.svelte                    # / redirector
    signin/+page.svelte
    signup/+page.svelte
    home/+page.svelte
    contacts/+page.svelte
    contacts/[id]/+page.svelte
    calls/+page.svelte
    call/[roomName]/+page.svelte    # active call (full screen)
    settings/
      +layout.svelte                # settings sidebar
      profile/+page.svelte
      devices/+page.svelte
      ...
  static/
    icons/                          # PWA icons
    manifest.webmanifest
```

---

## 5. Screen Specifications & Mockups

### 5.1 Sign In

**Goal:** Minimum-friction return path. Email + password (with optional OAuth).

```
+----------------------------------------------+
|                                              |
|              [agcloud Logo]                   |
|                                              |
|              Welcome back                    |
|                                              |
|         +--------------------------+         |
|         | Email                    |         |
|         | you@example.com          |         |
|         +--------------------------+         |
|                                              |
|         +--------------------------+         |
|         | Password         [eye]   |         |
|         | ********                 |         |
|         +--------------------------+         |
|                                              |
|         [ ] Remember me  Forgot password?    |
|                                              |
|         +--------------------------+         |
|         |        Sign in           |         |
|         +--------------------------+         |
|                                              |
|              ---  or  ---                    |
|                                              |
|         [ Continue with Google ]             |
|         [ Continue with Apple  ]             |
|                                              |
|       Don't have an account? Sign up         |
|                                              |
+----------------------------------------------+
```

**Behaviors:**
- Submit on `Enter` from any field
- Show password toggle (eye icon)
- Inline field errors (red border + message below)
- Disable submit while pending; spinner inside button
- On success: redirect to `/home` or original target (`?from=` param)
- Failed signin: brief toast + focus to password field
- Lockout after 10 failed attempts (server-enforced) → show "Too many attempts" with 15-min countdown

**Performance:**
- Form is HTML-only — works without JS hydration
- Page weight: <30 KB total
- No external CSS or fonts blocked render

---

### 5.2 Sign Up

```
+----------------------------------------------+
|                                              |
|              [agcloud Logo]                   |
|                                              |
|             Create your account              |
|                                              |
|         +--------------------------+         |
|         | Display name             |         |
|         +--------------------------+         |
|                                              |
|         +--------------------------+         |
|         | Email                    |         |
|         +--------------------------+         |
|                                              |
|         +--------------------------+         |
|         | Password (8+ chars)      |         |
|         +--------------------------+         |
|         [====---] Strength: Good             |
|                                              |
|         [ ] I agree to Terms & Privacy       |
|                                              |
|         +--------------------------+         |
|         |    Create account        |         |
|         +--------------------------+         |
|                                              |
|       Already have an account? Sign in       |
|                                              |
+----------------------------------------------+
```

**Behaviors:**
- Real-time password strength meter (zxcvbn lite, ~12KB lazy-loaded only on this page)
- Email format validation on blur
- Email uniqueness checked on blur (debounced 500ms)
- Disclosure required before submit
- After signup: send verification email, redirect to `/home` with banner "Verify your email"

---

### 5.3 Home (Recents)

**Goal:** Get to a call in 2 clicks.

```
+----------------------------------------------------+
| agcloud  [Search contacts...]      [@] John     v   |
+----------------------------------------------------+
|                                                    |
|  [Recents]  Contacts   Calls   Settings            |
|  ========                                          |
|                                                    |
|  +----------------------------------------------+ |
|  |  [SC] Sarah Chen                       [Call]| |
|  |       <- 5 min ago         2:34       [Video]| |
|  +----------------------------------------------+ |
|                                                    |
|  +----------------------------------------------+ |
|  |  [JD] John Doe                         [Call]| |
|  |       -> 2h ago           12:01              | |
|  +----------------------------------------------+ |
|                                                    |
|  +----------------------------------------------+ |
|  |  [MM] Maria Mendes (3)                       | |
|  |  x    Missed call yesterday            [Call]| |
|  +----------------------------------------------+ |
|                                                    |
|  +----------------------------------------------+ |
|  |  [TS] Group: Team Standup (4)          [Join]| |
|  |       Yesterday               45:12          | |
|  +----------------------------------------------+ |
|                                                    |
|     ... infinite scroll ...                        |
|                                                    |
+----------------------------------------------------+
| [Home]  [Calls]  [Contacts]  [Settings]  (mobile)  |
+----------------------------------------------------+
```

**Behaviors:**
- Top search bar: instant filter + jump to contact (Cmd/Ctrl+K opens command palette)
- `<-` / `->` icons indicate inbound/outbound; `x` = missed (red)
- Each row: avatar, name, direction + timestamp + duration, tap "Call" or "Video"
- Press-and-hold contact to see context menu (Voice call, Video call, Message, Block)
- Presence dot on avatar (green=online, gray=offline, blue=in-call)
- Real-time presence updates via WebSocket (debounced UI updates)
- Sticky header with search; content scrolls beneath
- Mobile: bottom nav bar; desktop: top nav bar

**Performance:**
- Initial 20 items rendered; virtualized list past 50 (use `svelte-virtual-list`, ~3KB)
- Avatars: lazy-loaded via `IntersectionObserver`, `<img loading="lazy">`
- Skeleton shimmer for first paint while data loads
- Optimistic UI: tapping "Call" immediately shows ringing screen

---

### 5.4 Contacts

```
+----------------------------------------------------+
| agcloud  [Search contacts...]      [@] John     v   |
+----------------------------------------------------+
|  Recents  [Contacts]  Calls   Settings             |
|           ==========                               |
|                                                    |
|              [+ New Contact]                       |
|                                                    |
|  A                                                 |
|  +----------------------------------------------+ |
|  | (o) [AC] Alice Cooper          [Call] [Video]| |
|  +----------------------------------------------+ |
|  | (o) [AM] Adam Miller           [Call] [Video]| |
|  +----------------------------------------------+ |
|                                                    |
|  M                                                 |
|  +----------------------------------------------+ |
|  | (o) [MM] Maria Mendes          [Call] [Video]| |
|  +----------------------------------------------+ |
|                                                    |
|  S                                                 |
|  +----------------------------------------------+ |
|  | (o) [SC] Sarah Chen   .online [Call] [Video] | |
|  +----------------------------------------------+ |
|                                                    |
+----------------------------------------------------+

Legend:  (o) avatar  .online = green dot
```

**Behaviors:**
- Alphabetical with sticky letter headers
- Online contacts can be filtered with toggle
- Right-side scroll bar shows alphabet quick-jump on long lists
- Tap row → contact detail page

---

### 5.5 Incoming Call (Modal Overlay)

```
+----------------------------------------------+
|                                              |
|             INCOMING CALL                    |
|                                              |
|             +-------------+                  |
|             |             |                  |
|             |   [SC]      |   <-- pulse      |
|             |             |       animation  |
|             +-------------+                  |
|                                              |
|              Sarah Chen                      |
|                                              |
|        Video call ringing...                 |
|                                              |
|                                              |
|     +-----------+      +------------+        |
|     |  Decline  |      |   Accept   |        |
|     |    ✕      |      |     ✓      |        |
|     +-----------+      +------------+        |
|                                              |
|              [Reply with message]            |
|                                              |
+----------------------------------------------+
```

**Behaviors:**
- Renders as full-screen overlay regardless of current route
- Pulse animation on avatar (CSS-only, GPU-accelerated)
- Custom ringtone (Web Audio API, looping) with volume tied to system
- Auto-dismiss after 30s → marks as missed, sends "missed call" notification
- Decline (✕) → instant close, send `/calls/:id/reject`
- Accept (✓) → navigate to `/call/:roomName`, request mic/cam permission early
- Keyboard: `Esc` = decline, `Enter` = accept
- Browser tab title flashes "Incoming call - Sarah Chen"
- Browser favicon changes to red dot

**Permission UX:**
- If mic/cam permission not yet granted, show this AFTER tap Accept (not before — user expectation)
- If denied, show "Permission needed to call. Click here to grant." with a clear path

---

### 5.6 Active Call (1:1)

```
+--------------------------------------------------+
| <- Back                            [Min] [Max]   |   <-- minimal top bar
+--------------------------------------------------+
|                                                  |
|                                                  |
|                                                  |
|              [REMOTE VIDEO]                      |
|             (full screen)                        |
|                                                  |
|                                                  |
|                                                  |
|              Sarah Chen                          |
|              Connected · 00:03:42                |
|                                                  |
|                                                  |
|                              +-------------+     |
|                              |             |     |
|                              |   [YOU]     |     |
|                              |  (PiP)      |     |
|                              |             |     |
|                              +-------------+     |
|                                                  |
+--------------------------------------------------+
|       [Mic]  [Vid]  [End]  [Cam]  [...]          |
|                                                  |
|  Network: ●●●○○ Good                             |
+--------------------------------------------------+
```

**Behaviors:**
- Remote video fills screen (object-fit: cover)
- Local video in draggable PiP (bottom-right default), can pinch to zoom on mobile
- Auto-hide controls after 3s of no input; tap/move shows them
- End button = red, larger (×1.5 hit target)
- "..." menu: Switch camera, share screen, start recording (if allowed), invite others
- Network quality indicator (5 dots) — derived from LiveKit `connectionQuality` event
- If degraded → automatic switch to lower quality (LiveKit dynacast handles this)
- If `network: poor` for 5s → toast: "Connection unstable"
- If disconnected → reconnect modal with retry; don't drop call immediately
- Press space = mute toggle, V = video toggle, E = end call

**Permission states:**
- Mic permission denied: show banner with "Click to allow microphone"
- Camera permission denied: show banner; video tile shows initials avatar
- No camera at all: hide camera button, show audio-only call icon

**Audio output:**
- Speaker dropdown (only on supported browsers via `setSinkId`)
- Earpiece/loudspeaker toggle on mobile

---

### 5.7 Active Call (Group, 2x2 grid)

```
+--------------------------------------------------+
| < Back   Group: Team Standup        00:05:21     |
+--------------------------------------------------+
|                          |                       |
|                          |                       |
|       [ALICE]            |        [BOB]          |
|                          |                       |
|                          |     [speaking]        |
|       (muted)            |                       |
|                          |                       |
+--------------------------+-----------------------+
|                          |                       |
|                          |                       |
|       [CARLA]            |        [YOU]          |
|                          |                       |
|                          |                       |
|                          |     (muted)           |
|                          |                       |
+--------------------------+-----------------------+
|   [Mic]  [Vid]  [End]  [Cam]  [Share]  [People]  |
|                                                  |
|  4 participants  · Network: ●●●●○ Good           |
+--------------------------------------------------+
```

**Behaviors:**
- 1 person: full-screen
- 2: 1:1 layout
- 3-4: 2x2 grid
- 5-9: 3x3 grid
- 10+: paginated grid OR speaker view (active speaker large, thumbnails on side)
- Active speaker outlined with subtle ring
- Tap a tile to make it the focus (speaker view)
- "People" panel: list of participants, mute-others (if host), kick (if host)
- Screen share takes over main area; participants relegated to thumbnails

**Performance:**
- Use `transform` for layout transitions (GPU-accelerated)
- Pause video subscription on off-screen tiles (LiveKit `setEnabled(false)`)
- Disable video for participants in speaker view but not focused → save bandwidth

---

### 5.8 Call History

```
+----------------------------------------------------+
|  Recents  Contacts  [Calls]  Settings              |
|                     =======                        |
|                                                    |
|  All  Missed  Outgoing  Incoming  [filter v]       |
|                                                    |
|  Today                                             |
|  +----------------------------------------------+ |
|  | <- [SC] Sarah Chen      14:32      2:34  [i] | |
|  +----------------------------------------------+ |
|  | x  [MM] Maria Mendes    13:01     missed [i] | |
|  +----------------------------------------------+ |
|                                                    |
|  Yesterday                                         |
|  +----------------------------------------------+ |
|  | -> [JD] John Doe        16:45    12:01   [i] | |
|  +----------------------------------------------+ |
|  | -> Group: Team Stand    09:00    45:12   [i] | |
|  +----------------------------------------------+ |
|                                                    |
|  Earlier                                           |
|  ...                                               |
|                                                    |
+----------------------------------------------------+
```

**Behaviors:**
- `[i]` icon → opens call detail (recording link if available, participants, quality stats)
- Filters by direction, date range, participant
- Cursor-based pagination (load more on scroll)
- Group calls show "Group: <name>" with participant count
- Search calls by participant name

---

### 5.9 Settings

```
+----------------------------------------------------+
| <- Settings                                        |
+----------------------------------------------------+
|                                                    |
|  Profile                                           |
|  +----------------------------------------------+ |
|  | [@] John Doe                                 | |
|  | john@example.com                  [Edit >]   | |
|  +----------------------------------------------+ |
|                                                    |
|  Audio & Video                                     |
|  +----------------------------------------------+ |
|  | Microphone     Built-in Microphone      v    | |
|  | Speaker        Built-in Output          v    | |
|  | Camera         FaceTime HD              v    | |
|  | [Test microphone]  [Test camera]             | |
|  +----------------------------------------------+ |
|                                                    |
|  Notifications                                     |
|  +----------------------------------------------+ |
|  | Incoming calls                  [ON]         | |
|  | Missed call alerts              [ON]         | |
|  | Sound when ringing              [ON]         | |
|  | Browser notifications           [ Allow ]    | |
|  +----------------------------------------------+ |
|                                                    |
|  Privacy                                           |
|  +----------------------------------------------+ |
|  | Allow calls from        [Contacts only v]    | |
|  | Block list                  0 users    [>]   | |
|  | Show online status              [ON]         | |
|  +----------------------------------------------+ |
|                                                    |
|  About                                             |
|  +----------------------------------------------+ |
|  | Version 1.0.0                                | |
|  | Terms of Service              [>]            | |
|  | Privacy Policy                [>]            | |
|  | Sign out                      [Sign out]     | |
|  +----------------------------------------------+ |
|                                                    |
+----------------------------------------------------+
```

**Behaviors:**
- Device selectors enumerate via `navigator.mediaDevices.enumerateDevices()`
- "Test microphone": shows live VU meter (Web Audio API analyser)
- "Test camera": shows preview in modal
- Browser notifications button → triggers `Notification.requestPermission()`
- Sign out: clears tokens, calls `/auth/signout`, redirects to `/signin`

---

### 5.10 Empty States

| Screen | Empty State |
|--------|-------------|
| **Recents** | Illustration + "No calls yet. Tap a contact to start." + [Browse contacts] button |
| **Contacts** | "Add your first contact" + [+ Add contact] CTA |
| **Call History** | "No calls match these filters" |
| **Search results** | "No contacts found" |

---

### 5.11 Error States

| Error | Display |
|-------|---------|
| Network offline | Top banner "Offline · Reconnecting..." (yellow) |
| API 5xx | Inline error in component + retry button |
| Permission denied (mic/cam) | Modal: "We need microphone access to call" + step-by-step guide per browser |
| Browser unsupported | Friendly page: "agcloud needs a modern browser. Try Chrome, Firefox, Edge, or Safari." |
| Account locked | "Account temporarily locked due to suspicious activity. Try again in 15 min" |
| LiveKit connection failed | Retry with backoff; after 3 fails show "Connection failed. Check network." |

---

## 6. Component Library

Lightweight, accessible, and Svelte-native. No third-party UI library.

### 6.1 Atoms

| Component | Notes |
|-----------|-------|
| `Button` | Variants: primary, secondary, danger, ghost; sizes: sm, md, lg; loading state |
| `Input` | Label, error, hint, prefix/suffix slots |
| `Avatar` | Initials fallback, presence dot, size prop |
| `Icon` | Wraps Lucide SVG; sets `aria-hidden` unless labelled |
| `Badge` | Numeric badge (notifications) |
| `Toggle` | Accessible switch (`role="switch"`) |
| `Checkbox` / `Radio` | Native + custom styling |
| `Spinner` | CSS-only |
| `Skeleton` | Shimmer for content loading |

### 6.2 Molecules

| Component | Notes |
|-----------|-------|
| `Modal` | Focus trap, `Esc` closes, body scroll lock, `role="dialog"` |
| `Toast` | Auto-dismiss, screen reader live region (`aria-live=polite`) |
| `DropdownMenu` | Keyboard navigation, ARIA menu pattern |
| `Tabs` | Keyboard arrow navigation |
| `Tooltip` | Delay-on-hover, `role="tooltip"` |

### 6.3 Calling Components

| Component | Notes |
|-----------|-------|
| `VideoTile` | Wraps `<video>`; handles missing video → avatar; muted indicator; speaker glow |
| `CallControls` | Mic/Video/End/Camera/Share/More buttons; auto-hide after 3s |
| `IncomingCallOverlay` | Full-screen modal; pulse animation; ringtone control |
| `ParticipantList` | Sidebar with mute/kick (host); presence states |
| `NetworkIndicator` | 5 dots showing connection quality |
| `DeviceSelector` | Mic/cam/speaker chooser; live device list |

### 6.4 Component API Style

```svelte
<!-- Button.svelte -->
<script lang="ts">
  type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
  type Size = 'sm' | 'md' | 'lg';

  export let variant: Variant = 'primary';
  export let size: Size = 'md';
  export let loading = false;
  export let disabled = false;
  export let type: 'button' | 'submit' = 'button';
</script>

<button
  class="btn btn-{variant} btn-{size}"
  class:loading
  {type}
  disabled={disabled || loading}
  on:click
>
  {#if loading}<Spinner />{/if}
  <slot />
</button>
```

---

## 7. State Management

### 7.1 Svelte Stores (Built-in)

No external state library. Svelte's `writable`, `readable`, `derived` cover everything.

```typescript
// auth.store.ts
import { writable, derived } from 'svelte/store';

interface AuthState {
  user: User | null;
  accessToken: string | null;
  status: 'idle' | 'authenticating' | 'authenticated' | 'error';
}

const initialState: AuthState = {
  user: null,
  accessToken: null,
  status: 'idle'
};

function createAuthStore() {
  const { subscribe, set, update } = writable<AuthState>(initialState);
  return {
    subscribe,
    signin: async (email: string, password: string) => { /* ... */ },
    signout: () => { /* ... */ },
    refresh: async () => { /* ... */ }
  };
}

export const auth = createAuthStore();
export const isAuthenticated = derived(auth, $auth => $auth.status === 'authenticated');
```

### 7.2 Store Catalog

| Store | Scope | Persisted? |
|-------|-------|-----------|
| `auth` | Global | Refresh token in `httpOnly` cookie; access token in memory only |
| `user` | Global | Cached in `sessionStorage` for fast restore |
| `presence` | Global | Not persisted; refreshed via WebSocket |
| `call` | Per-call | Not persisted (active session only) |
| `toast` | Global | Not persisted |
| `theme` | Global | Persisted in `localStorage` |
| `devices` | Global | Selected devices in `localStorage` |

### 7.3 Reactivity Patterns

- Derived stores for computed values (e.g., `isCalleeOnline = derived([presence, callee], ...)`)
- `$store` syntax in components for auto-subscribe + auto-cleanup
- Avoid prop drilling; use stores for app-wide state, props for local state

---

## 8. LiveKit Integration

### 8.1 Client Setup

```typescript
import { Room, RoomEvent, Track } from 'livekit-client';

const room = new Room({
  adaptiveStream: true,           // automatic quality adjustment
  dynacast: true,                 // pause unused video
  videoCaptureDefaults: {
    resolution: { width: 1280, height: 720 }
  },
  publishDefaults: {
    simulcast: true,
    videoSimulcastLayers: [
      { width: 320, height: 180, fps: 15, bitrate: 150_000 },
      { width: 640, height: 360, fps: 25, bitrate: 500_000 },
      { width: 1280, height: 720, fps: 30, bitrate: 1_500_000 }
    ]
  }
});

await room.connect(LIVEKIT_URL, accessToken, { autoSubscribe: true });
```

### 8.2 Event Handling

```typescript
room
  .on(RoomEvent.ParticipantConnected, p => callStore.addParticipant(p))
  .on(RoomEvent.ParticipantDisconnected, p => callStore.removeParticipant(p))
  .on(RoomEvent.TrackSubscribed, (track, pub, participant) => {
    callStore.attachTrack(participant.sid, track);
  })
  .on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
    callStore.updateQuality(participant.sid, quality);
  })
  .on(RoomEvent.ActiveSpeakersChanged, speakers => {
    callStore.setActiveSpeakers(speakers.map(s => s.sid));
  })
  .on(RoomEvent.Disconnected, reason => {
    if (reason === DisconnectReason.SERVER_SHUTDOWN) {
      // attempt reconnect
    }
  });
```

### 8.3 Reconnection Strategy

LiveKit handles transient disconnects automatically. We add UX layer:

| Event | UI Response |
|-------|-------------|
| `RoomEvent.Reconnecting` | Toast: "Reconnecting..." (yellow) |
| `RoomEvent.Reconnected` | Toast: "Reconnected" (green, auto-dismiss 2s) |
| `RoomEvent.Disconnected` | Modal: "Call ended" with reason; retry button if recoverable |

### 8.4 Bandwidth Optimization

- **Subscribe selectively:** off-screen tiles call `track.setEnabled(false)`
- **Adaptive stream:** LiveKit auto-selects layer based on tile size
- **Dynacast:** SFU stops forwarding unused layers
- **Audio-only fallback:** if bitrate <100 Kbps for 5s, prompt user to disable video

### 8.5 Permission Flow

```typescript
async function requestMediaPermissions() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: { width: 1280, height: 720 }
    });
    stream.getTracks().forEach(t => t.stop()); // We just wanted permission
    return { audio: true, video: true };
  } catch (err) {
    if (err.name === 'NotAllowedError') return { audio: false, video: false };
    if (err.name === 'NotFoundError') return { audio: true, video: false }; // No camera
    throw err;
  }
}
```

---

## 9. Real-Time Notifications

### 9.1 In-App (WebSocket)

A persistent WebSocket connection (separate from LiveKit) keeps user updated on:
- Incoming calls (when not in a call)
- Presence changes of contacts
- New missed calls

```typescript
// stores/realtime.store.ts
const ws = new WebSocket(`${WS_URL}/realtime?token=${accessToken}`);
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  switch (msg.type) {
    case 'incoming_call':   callStore.handleIncoming(msg.payload); break;
    case 'presence_update': presenceStore.update(msg.payload); break;
    case 'call_missed':     toast.info(`Missed call from ${msg.payload.from}`); break;
  }
};
```

Reconnection: exponential backoff (1s, 2s, 4s, 8s, max 30s). Heartbeat every 25s (server expects 30s).

### 9.2 Web Push (Background)

For when the tab is closed or backgrounded.

- Use **VAPID** keys
- Service worker handles `push` event → `self.registration.showNotification(...)`
- Click notification → focus existing tab or open new window to `/call/:roomName`
- Permission prompt deferred until user opts in via Settings (don't ask on first visit)

```javascript
// service-worker.ts
self.addEventListener('push', (event) => {
  const data = event.data.json();
  if (data.type === 'incoming_call') {
    event.waitUntil(
      self.registration.showNotification(data.from.displayName, {
        body: 'Incoming video call',
        icon: '/icons/icon-192.png',
        badge: '/icons/badge.png',
        tag: `call-${data.callId}`,
        renotify: true,
        requireInteraction: true,
        actions: [
          { action: 'accept', title: 'Accept' },
          { action: 'decline', title: 'Decline' }
        ],
        data: { callId: data.callId, roomName: data.roomName }
      })
    );
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { callId, roomName } = event.notification.data;
  const url = event.action === 'accept' ? `/call/${roomName}` : '/home';
  event.waitUntil(clients.openWindow(url));
});
```

---

## 10. PWA & Offline Behavior

### 10.1 PWA Capabilities

| Capability | Support |
|-----------|---------|
| Install to home screen | Yes (manifest + icons) |
| Offline shell | Yes (precache app shell + critical CSS) |
| Background notifications | Yes (Web Push + Service Worker) |
| Splash screen | Yes (manifest config) |
| Standalone display | Yes (no browser UI when launched) |

### 10.2 Service Worker Caching Strategy

| Asset | Strategy |
|-------|----------|
| HTML shell | Network-first, fallback to cached shell |
| JS/CSS (hashed) | Cache-first, immutable for 1 year |
| Images (avatars) | Stale-while-revalidate, max 7 days |
| API responses | NEVER cached (auth-sensitive) |

Library: **Workbox** (selected modules only, ~7KB) or hand-rolled (~3KB) — choose hand-rolled for our scope.

### 10.3 Offline Behavior

- **Read-only screens** (recents, history) work from cache when offline
- **Write actions** (initiate call, send message) queued and retried on reconnect
- **Active call** → cannot start a call offline; clear message: "Connect to internet to start a call"
- **Mid-call disconnect** → LiveKit attempts reconnect; show banner

### 10.4 manifest.webmanifest

```json
{
  "name": "agcloud",
  "short_name": "agcloud",
  "start_url": "/",
  "display": "standalone",
  "theme_color": "#0066ff",
  "background_color": "#ffffff",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/icons/maskable-512.png", "sizes": "512x512", "purpose": "maskable" }
  ],
  "shortcuts": [
    { "name": "New Call", "url": "/contacts" }
  ]
}
```

---

## 11. Accessibility (a11y)

### 11.1 WCAG 2.1 AA Compliance

| Requirement | Implementation |
|-------------|---------------|
| **Color contrast** | 4.5:1 for text, 3:1 for UI; tested with axe |
| **Keyboard navigation** | All actions reachable; visible focus ring; no keyboard traps |
| **Screen reader labels** | `aria-label` on icon buttons, `aria-live` for toasts |
| **Forms** | `<label>` with `for`, error association via `aria-describedby` |
| **Modals** | `role="dialog"`, focus trap, return focus on close |
| **Skip links** | "Skip to main content" before nav |
| **Heading hierarchy** | Sequential (no skipping levels) |
| **Reduced motion** | Respect `prefers-reduced-motion` (no pulse animations) |

### 11.2 Calling-Specific a11y

- Announce participants joining/leaving via `aria-live` polite region
- Announce mute state changes
- Announce active speaker via subtle live region
- Captions/transcripts (Phase 2 — but reserve UI space)
- Call duration announced every 5 minutes (configurable)

### 11.3 Internationalization Foundations (MVP-ready)

- All strings in `src/lib/i18n/en.ts` (no hardcoded strings)
- Date/time formatting via `Intl.DateTimeFormat` (zero JS overhead)
- Number formatting via `Intl.NumberFormat`
- RTL-friendly CSS using logical properties (`margin-inline-start`, etc.)

---

## 12. Performance Optimization

### 12.1 Initial Load

| Technique | Implementation |
|-----------|---------------|
| **Code splitting** | Route-based (SvelteKit auto), lazy-load heavy modules (zxcvbn, recording UI) |
| **Critical CSS inline** | First-paint CSS in `<style>` in `app.html`; rest async |
| **Resource hints** | `<link rel="preconnect">` to API + LiveKit; `<link rel="preload">` for critical font |
| **Web fonts** | Subset Latin only; `font-display: swap`; self-hosted to avoid Google fetch |
| **Compression** | Brotli (level 11) for static; gzip fallback |
| **HTTP/3** | Enabled at CDN/edge |
| **Prefetch** | SvelteKit auto-prefetches on link hover/touchstart |

### 12.2 Runtime

| Technique | Implementation |
|-----------|---------------|
| **Avoid re-renders** | Svelte's fine-grained reactivity (no virtual DOM diff) |
| **Virtualize lists** | `svelte-virtual-list` for >50 items |
| **Image optimization** | WebP/AVIF served via `<picture>`; explicit width/height to avoid CLS |
| **Lazy images** | `loading="lazy"` (native) |
| **Debounce inputs** | Search box: 200ms debounce |
| **Throttle events** | Scroll: 16ms (1 frame); resize: 100ms |
| **`requestIdleCallback`** | Non-critical work (analytics, prefetching) |

### 12.3 Video Performance

- Use `transform` for video tile layouts (avoid layout reflow)
- `will-change: transform` only during animations (not always)
- Hardware-accelerated codecs preferred: H.264 baseline first
- Cap simulcast layers based on viewport size (don't request 1080p for 320px tile)
- Use CSS `aspect-ratio` to reserve video tile space (no CLS)

### 12.4 Network

- Persistent HTTP/2 connection to API (single connection, multiplexed)
- WebSocket keepalive (single connection for presence + signaling)
- Conditional GET (`If-None-Match`) on cacheable endpoints
- API response compression (Brotli/gzip)

### 12.5 Memory

- Cleanup on route changes: cancel in-flight requests, dispose LiveKit subscriptions
- Avoid memory leaks: every event listener has a corresponding remove
- Local video: stop tracks when leaving call (`stream.getTracks().forEach(t => t.stop())`)

### 12.6 Web Vitals Reporting

```typescript
// utils/web-vitals.ts
import { onLCP, onINP, onCLS, onFCP, onTTFB } from 'web-vitals';

[onLCP, onINP, onCLS, onFCP, onTTFB].forEach(fn =>
  fn(({ name, value, rating }) => {
    navigator.sendBeacon('/api/metrics/web-vitals', JSON.stringify({
      name, value, rating, url: location.pathname
    }));
  })
);
```

Backend forwards to Prometheus / monitoring tool.

---

## 13. Security (Frontend)

### 13.1 Token Storage

| Token | Storage | Why |
|-------|---------|-----|
| **Access token** (short TTL) | In-memory (Svelte store) | Not exposed to XSS via `localStorage` |
| **Refresh token** | `httpOnly`, `secure`, `sameSite=strict` cookie | Protected from JavaScript |
| **CSRF token** | Cookie + custom header (double submit) | Prevent CSRF on state-changing routes |

### 13.2 Content Security Policy

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self' 'wasm-unsafe-eval';
  style-src 'self' 'unsafe-inline';
  connect-src 'self' wss://livekit.agcloud.example.com https://api.agcloud.example.com;
  img-src 'self' data: https:;
  media-src 'self' blob:;
  font-src 'self';
  frame-ancestors 'none';
  base-uri 'self';
  form-action 'self';
```

### 13.3 Other Security Headers

| Header | Value |
|--------|-------|
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains; preload` |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `camera=(self), microphone=(self), geolocation=()` |

### 13.4 XSS Protection

- Svelte auto-escapes `{expr}` interpolations
- Never use `{@html ...}` with user content
- Sanitize markdown via DOMPurify (only if introducing rich text)
- Don't pass user content to `eval`, `Function`, `setTimeout(string)`

### 13.5 Sensitive UI

- Password fields: `autocomplete="current-password"` / `new-password`
- Hide password by default; toggle with eye icon
- Don't display full email in URLs
- Logout clears all in-memory state and reloads page

---

## 14. Testing Strategy

### 14.1 Pyramid

| Layer | Coverage | Tools |
|-------|----------|-------|
| **Unit** (utils, stores, formatters) | 80%+ | Vitest |
| **Component** | All atoms + key molecules | Vitest + @testing-library/svelte |
| **E2E** (critical flows) | Signin, call initiate, accept, end | Playwright |
| **Visual regression** | Key screens | Playwright + Argos / Chromatic |
| **A11y** | All pages on commit | axe-core via Playwright |
| **Performance** | Lighthouse on PR builds | Lighthouse CI; budgets enforced |
| **Cross-browser** | Chrome, Firefox, Safari (desktop + mobile) | Playwright + BrowserStack |

### 14.2 Critical E2E Scenarios

1. **Signup → email verification → first call** (happy path end-to-end)
2. **Signin → home → call from recents → accept → end → call appears in history**
3. **Incoming call notification → accept → both peers see/hear each other** (uses fake media in Chromium)
4. **Call with permission denial → graceful messaging**
5. **Network drop during call → reconnect → call continues**
6. **Browser refresh during active call → resume call**

### 14.3 LiveKit Testing

- Use **fake media** flag in Chromium for E2E (`--use-fake-ui-for-media-stream --use-fake-device-for-media-stream`)
- Mock LiveKit SDK in unit tests
- Run full E2E against staging LiveKit instance (real WebRTC)

---

## 15. Build & Deployment

### 15.1 Build Pipeline

```
git push -> CI:
  -> install (pnpm)
  -> lint (eslint, prettier)
  -> type-check (svelte-check)
  -> unit tests (Vitest)
  -> build (vite)
  -> bundle size check (size-limit)
  -> E2E tests (Playwright, parallel)
  -> Lighthouse CI (perf budgets)
  -> deploy preview (Cloudflare Pages / Netlify / Vercel)
  -> manual approval -> production
```

### 15.2 Hosting

**Recommendation:** **Cloudflare Pages** or **Netlify**

| Why | Detail |
|-----|--------|
| Static + edge functions | SvelteKit adapter works out of the box |
| Global CDN | Low latency worldwide |
| Free tier sufficient for MVP | |
| Preview deployments per PR | Reviewable URLs |
| Built-in HTTPS + HTTP/3 | Zero config |

### 15.3 Environment Configuration

```bash
# .env.production
PUBLIC_API_URL=https://api.agcloud.example.com
PUBLIC_LIVEKIT_URL=wss://livekit.agcloud.example.com
PUBLIC_VAPID_KEY=BNJ...                      # Web Push public key
PUBLIC_SENTRY_DSN=https://...                # Optional error tracking
PUBLIC_BUILD_VERSION=1.0.0
```

`PUBLIC_` prefix exposes to client (SvelteKit convention). Never expose secrets.

### 15.4 Caching Strategy at CDN

| Path | Cache | TTL |
|------|-------|-----|
| `/_app/immutable/*` | Public, immutable | 1 year |
| `/index.html` | No-cache (always revalidate) | 0 |
| `/manifest.webmanifest` | Public, must-revalidate | 1 hour |
| `/icons/*` | Public, immutable | 1 year |

### 15.5 Rollback Plan

- Cloudflare/Netlify: rollback to previous deployment via dashboard (single click)
- Service worker: bump version on every deploy; old SW invalidates cache
- Feature flags via remote config (e.g., LaunchDarkly or simple JSON endpoint) for kill-switch on bad releases

---

## Appendix A: Page Weight Calculator

Track per-route page weight in CI. Example expected sizes:

| Route | Goal | Critical Path |
|-------|------|---------------|
| `/signin` | <40 KB | Auth form, no app shell |
| `/home` | <120 KB | App shell + recent calls |
| `/call/:room` | <180 KB | App shell + LiveKit (~40KB gzipped) + call UI |
| `/settings` | <100 KB | App shell + settings UI |

## Appendix B: Browser Support Matrix

| Browser | Version | Status |
|---------|---------|--------|
| Chrome | Last 2 stable | Full support |
| Firefox | Last 2 stable | Full support |
| Edge | Last 2 stable | Full support |
| Safari (macOS) | 16+ | Full support |
| Safari (iOS) | 16+ | Full support; H.264-only video |
| Samsung Internet | Latest | Full support |
| Opera | Latest | Full support |
| **Not supported** | IE 11, old Android browsers | Show "browser unsupported" page |

## Appendix C: Tech Decisions Summary

| Decision | Choice | One-Line Rationale |
|----------|--------|---------------------|
| Framework | SvelteKit | Smallest bundle, no VDOM, built-in stores |
| Bundler | Vite | Fast dev, ESM-native, included in SvelteKit |
| Styling | PicoCSS + scoped CSS + Open Props | Tiny, no utility-class bloat |
| State | Svelte stores | No external lib needed |
| HTTP | fetch + thin wrapper | Zero deps |
| Forms | Native + Zod | Zero form library |
| Icons | Lucide tree-shaken SVGs | Pay only for icons used |
| Testing | Vitest + Playwright | Same Vite pipeline; modern |
| Hosting | Cloudflare Pages or Netlify | Edge CDN, preview deploys, free MVP tier |
| Push | Web Push (VAPID) + FCM | Standards-based, works everywhere |
| Auth tokens | Access in memory, refresh in httpOnly cookie | XSS + CSRF resistant |
