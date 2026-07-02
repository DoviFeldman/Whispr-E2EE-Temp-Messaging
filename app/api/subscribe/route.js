import { redis, ROOM_TTL } from '../../../lib/redis'
import { NextResponse } from 'next/server'

export async function POST(req) {
  try {
    const { roomId, tag, subscription } = await req.json()

    if (!roomId || !tag || !subscription?.endpoint) {
      return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
    }

    // Verify room exists
    const meta = await redis.get(`room:${roomId}:meta`)
    if (!meta) return NextResponse.json({ error: 'Room not found' }, { status: 404 })

    const key = `room:${roomId}:push`

    // Same device may rejoin with a new tag (PIN rooms) — drop its stale entries
    const existing = await redis.hgetall(key)
    if (existing) {
      for (const [t, stored] of Object.entries(existing)) {
        const sub = typeof stored === 'string' ? JSON.parse(stored) : stored
        if (t !== tag && sub?.endpoint === subscription.endpoint) {
          await redis.hdel(key, t)
        }
      }
    }

    await redis.hset(key, { [tag]: JSON.stringify(subscription) })
    await redis.expire(key, ROOM_TTL)

    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: 'Failed to subscribe' }, { status: 500 })
  }
}
