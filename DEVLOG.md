# whispr devlog

## what we built

Starting from a working 2-party ECDH link chat + manual PIN chat, we added a new primary chat type, a PWA, and a separate app UI — keeping the website completely unchanged.

---

## 1. PIN-link chat (new main chat type)

**The idea:** a chat link where the encryption key is embedded in the URL itself, so anyone with the link joins instantly — no PIN entry, no key exchange wait, multi-party.

**How it works:**
- A random 14-char mixed-case+numbers PIN is generated client-side
- Room ID = SHA-256 hash of the PIN (deterministic, same function as manual PIN rooms)
- Encryption key = PBKDF2 derived from the PIN (same as manual PIN rooms)
- The PIN lives in the URL hash fragment (`/room/abc123#xK7mP2nQr5`)

**Why the hash fragment:** the `#` part of a URL is never sent to the server — it's browser-only. This means the server never sees the PIN, never sees the encryption key, and cannot decrypt messages even with full database access. Genuine E2EE.

**Gateway route `/p`:** visiting `whispr.app/p#xK7mP2nQr5` reads the hash, stores the PIN in `sessionStorage`, calls `create-room` (idempotent via `SET NX`), then redirects to `/room/{derivedId}#xK7mP2nQr5`. The hash stays in the URL the whole session so users can copy-paste the address bar to share.

**Homepage changes:**
- "create chat link" (main button) now creates a PIN-link chat
- "legacy link chat →" (small, top-right) is the old 2-party ECDH flow
- Manual PIN section below the divider — unchanged

**Bugs fixed along the way:**
- Gateway was redirecting to `/room/{id}` without the hash → recipient lost the PIN. Fixed: redirect to `/room/{id}#${pin}`
- Room page didn't read the hash on direct navigation → added hash→sessionStorage sync at top of `init()`
- "Open chat →" button on homepage was pushing without the hash → added `#${linkPin}` to `router.push()`
- PIN rooms didn't support password protection → fixed `create-room` API to pass `passwordHash` through for PIN rooms, added password check inside the `isPinRoom` branch of the room page

---

## 2. PWA shell

**Files added:**
- `public/manifest.json` — name, theme color `#111111`, `start_url: "/app"`, icons
- `public/sw.js` — service worker: install/activate handlers + push notification handler (ready for VAPID)
- `public/icon.svg` — dark background, white "w", rounded corners
- `app/icon.js` — Next.js ImageResponse generates a 512×512 PNG at `/icon` for the manifest
- `app/components/ServiceWorkerRegistration.js` — client component that registers the SW on mount
- `app/layout.js` — adds manifest link, apple-touch-icon, apple PWA meta tags, mounts SW registration

**Install button (website, mobile only):**
- Small round circle, bottom-left, `↓` icon, tiny "download for notifications" label
- Only renders on mobile (`/iPhone|iPad|Android/i` user agent check)
- On Android/Chrome: triggers `beforeinstallprompt`
- On iOS: shows "tap ↑ share → add to home screen" tooltip for 3 seconds

---

## 3. App UI (`/app`)

The installed PWA opens at `/app` (`start_url` in manifest). The website at `/` is untouched.

**`app/app/page.js`** — the app home screen:
- Chat list from `localStorage` (`whispr:chats`), sorted by recency
- Sticky header: "whispr" logo (hold 600ms → copies `https://hailgallaxhar.com`) + `+` toggle
- Create panel (opens on `+`):
  - PIN input + `→` to join/create a PIN chat
  - `⊕` to generate a new PIN-link chat (shows share URL with copy button)
  - `⋯` dropdown: password protect toggle, create legacy chat, create legacy chat with password
- Each chat item shows name, last message preview, timestamp

**Room page additions (app-only):**
- `← whispr` back button — only renders in standalone PWA mode (`display-mode: standalone`), links to `/app`
- On entering chatting phase: saves room to `localStorage` chat list (type, PIN, shareUrl, timestamp)
- On message decrypt: updates `lastMessage` and `lastTs` in the chat list entry

**`app/page.js` (website):** identical to pre-PWA, zero changes to UX or logic. Only addition is the mobile install button.

---

## architecture notes

| concern | approach |
|---|---|
| PIN never reaches server | URL hash fragment, never in HTTP request |
| Multi-party encryption | PBKDF2 from PIN (same key for all participants) |
| Room ID privacy | SHA-256(PIN) stored in Redis — one-way, can't recover PIN |
| Chat persistence | `localStorage` on device, silent save on room entry |
| Website vs app | Separate routes (`/` and `/app`), no runtime detection needed |
| Push notifications | SW handler in place, needs VAPID keys to activate |
