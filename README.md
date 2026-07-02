# whispr

Temporary, end-to-end encrypted chat. No accounts. No logs. Messages wipe 48h after last activity. Rooms stay joinable for 90 days.

I think the main benifit of this website(and PWA app) is that its self hostable for free within just a few minutes, (you just need to make an upstash redis account and a vercel
account which can be done using github, then just put your redis URL and Token into vercel and then its deployed!) and that theres no accounts. no sign up, no accounts, no phone number, no email, and you can just start chatting knowing that no ones logging everyone who you speak to and when(theres no accounts, and no logging) and that its stored on your 
accounts vercel server. you could use a VPN for extra security so that vercel and AWS doesnt know your IP address to know that youre visiting this site. 


## Two ways to chat

**Chat link** — generates a private URL for a 2-person encrypted chat. Optional password protection. Share the link with one other person and messages are encrypted end-to-end with ECDH + AES-GCM.

**PIN chat** — type any 4–20 character PIN (letters and numbers, case-sensitive) and anyone else who enters the same PIN joins the same room. No limit on participants. The encryption key is derived directly from the PIN using PBKDF2, so anyone with the PIN can decrypt — no key exchange needed. Decide on a PIN beforehand, then create/join from the home page independently.

## How it works

- All encryption happens in the browser with the Web Crypto API — **the server never sees plaintext**
- Chat links use **ECDH + AES-GCM**: each participant generates an ephemeral keypair and a shared secret is derived
- PIN chats use **PBKDF2 → AES-GCM**: the PIN is stretched into a 256-bit key (100k iterations); everyone with the PIN gets the same key
- Room IDs for PIN chats are derived from the PIN via SHA-256, so the same PIN always maps to the same room
- Messages auto-wipe from Redis 48h after the last message; the room itself stays joinable for 90 days

---

## Deploy in ~5 minutes

### 1. Upstash Redis (free, takes 2 min)

1. Go to [upstash.com](https://upstash.com) → sign up free
2. Create a new Redis database (pick any region)
3. Copy **UPSTASH_REDIS_REST_URL** and **UPSTASH_REDIS_REST_TOKEN** from the dashboard

### 2. Push to GitHub

```bash
git init
git add .
git commit -m "init"
gh repo create whispr --public --push
# or push manually to github.com
```

### 3. Deploy to Vercel

1. Go to [vercel.com](https://vercel.com) → New Project → import your GitHub repo
2. Add environment variables:
   - `UPSTASH_REDIS_REST_URL` = your Upstash URL
   - `UPSTASH_REDIS_REST_TOKEN` = your Upstash token
   - `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` = for push notifications (see below)
3. Click Deploy

That's it. Your app is live.

### 4. Push notifications (optional but recommended)

## Push notifications setup (optional)

Notifications need three environment variables in Vercel (Project → Settings →
Environment Variables). They are **optional** — without them the app still works
completely normally, you just won't get push notifications when the app is closed,
and that's the only difference. Since this repo is public, these values are never
put in the code — they live only in Vercel's settings, which are private.

To create the keys, run this one command (no account or install needed):

    npx web-push generate-vapid-keys

Then add the three variables:

- `NEXT_PUBLIC_VAPID_PUBLIC_KEY` — the **Public Key** from the command above. This is
  the app's public identity for the browser push service. It's not a secret (the
  browser sees it anyway); the `NEXT_PUBLIC_` prefix is what lets the frontend read it.
- `VAPID_PRIVATE_KEY` — the **Private Key** from the same command. This is the secret
  that proves to Google/Apple's push servers that the notification really came from
  your server. Never commit it or share it.
- `VAPID_SUBJECT` — a contact address in the form `mailto:you@example.com`. Push
  services require it so they can reach the operator if something's wrong.

After adding them, redeploy. Then in any chat, tap the bell icon next to the message
box and allow notifications. On iPhone this only works from the installed app
(Share → Add to Home Screen, iOS 16.4+). The notification never contains message
text — just "new message" and the room link, so end-to-end encryption is unaffected.

(Doubled here so youll read it again)

Notifications let people get a "new message" alert even when the app is closed. The push payload
never contains message content — just a generic alert with the room link, so E2EE is preserved.

1. Generate a VAPID keypair (one command, no account needed):
   ```bash
   npx web-push generate-vapid-keys
   ```
2. Add the three env vars in Vercel (Project → Settings → Environment Variables):
   - `NEXT_PUBLIC_VAPID_PUBLIC_KEY` = the public key
   - `VAPID_PRIVATE_KEY` = the private key (keep secret)
   - `VAPID_SUBJECT` = `mailto:your-email@example.com`
3. Redeploy.

In a chat, tap the 🔔 button next to the message box to enable notifications on that device.

**On iPhone:** notifications only work when the app is added to the home screen
(Share → Add to Home Screen, requires iOS 16.4+) — open it from the home screen icon, then tap 🔔.

---

## Free tier limits

- **Vercel**: Hobby plan handles ~20-100 simultaneous visitors easily, 100GB bandwidth/mo
- **Upstash**: 10,000 requests/day free, ~200MB storage — comfortably handles 20-50 active chats

## Local dev

```bash
cp .env.example .env.local
# fill in your Upstash credentials
npm install
npm run dev
```





Notes!:

Room TTL Dead room storage Total w/ 500 active rooms 2 days (current) ~1.2 MB ~16 MB 7 days ~4 MB ~19 MB 14 days ~8 MB ~23 MB 30 days ~17 MB ~32 MB 90 days ~50 MB ~65 MB 180 days ~100 MB ~115 MB 365 days ~200 MB ~215 MB

Storage ceiling at 256 MB:

Max concurrent rooms: 256 MB / 30 KB = ~8,500 rooms At 2 users/room = ~17,000 concurrent users At a comfortable 50% margin = ~8,500 concurrent users, 4,250 rooms with 100 messages each (50 messages each person) Commands are the other constraint. At your current burn rate (31K used so far this month), and ~3–4 Redis ops per message sent + polling reads, the 500K/month cap is more likely to be the real ceiling before storage is.

(for the paid upstash redis account, dont do that, id just have to pay for the storage im using now, and by the time i hit $1 id just be using as much data as the whole free plan gives me! so i get up to $1 free a month on the free plan, theres no such thing as only $1 a month cause that is the free plan! $2 a month id get twice as much commands per month as the free plan, and so on and so forth)


