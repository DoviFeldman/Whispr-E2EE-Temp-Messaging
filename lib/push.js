import webpush from 'web-push'
import { redis } from './redis'

let configured = false
function ensureConfigured() {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
  const privateKey = process.env.VAPID_PRIVATE_KEY
  if (!publicKey || !privateKey) return false
  if (!configured) {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@whispr.local', publicKey, privateKey)
    configured = true
  }
  return true
}

// Best-effort push to everyone subscribed in the room except the sender.
// Payload is generic on purpose — it never contains message content, so E2EE holds.
// If onlyTags is given (private messages), only those members are notified.
export async function notifyRoom(roomId, senderTag, onlyTags = null) {
  try {
    if (!ensureConfigured()) return
    const key = `room:${roomId}:push`
    const subs = await redis.hgetall(key)
    if (!subs) return

    const payload = JSON.stringify({
      title: 'whispr',
      body: 'new message',
      roomId,
      url: `/room/${roomId}`,
    })

    await Promise.allSettled(
      Object.entries(subs).map(async ([tag, stored]) => {
        if (tag === senderTag) return
        if (onlyTags && !onlyTags.includes(tag)) return
        const subscription = typeof stored === 'string' ? JSON.parse(stored) : stored
        try {
          await webpush.sendNotification(subscription, payload)
        } catch (e) {
          // Subscription expired or unsubscribed — clean it up
          if (e?.statusCode === 404 || e?.statusCode === 410) {
            await redis.hdel(key, tag)
          }
        }
      })
    )
  } catch {
    // Push must never break message sending
  }
}
