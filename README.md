# whispr

Temporary, end-to-end encrypted chat. No accounts. No logs. Links expire 48h after last message.

## How it works

- Messages are encrypted in the browser with **ECDH + AES-GCM** (Web Crypto API)
- The server stores only encrypted blobs and EC public keys — **it never sees plaintext**
- Each chat room auto-expires from Redis 48h after the last message
- All unknown URLs redirect to the homepage (expired links look the same as non-existent ones)

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
3. Click Deploy

That's it. Your app is live.

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
