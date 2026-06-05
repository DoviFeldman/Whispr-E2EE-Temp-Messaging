import { redis, ROOM_TTL } from '../../../lib/redis'
import { NextResponse } from 'next/server'
import { randomBytes } from 'crypto'

export async function POST(req) {
  try {
    const body = await req.json()
    const { passwordHash, pinRoomId } = body

    // PIN-based room: use deterministic room ID derived from PIN client-side
    // SET NX so joining an existing pin room is a no-op
    if (pinRoomId) {
      const meta = {
        createdAt: Date.now(),
        isPinRoom: true,
        hasPassword: !!passwordHash,
        passwordHash: passwordHash || null,
      }
      await redis.set(`room:${pinRoomId}:meta`, JSON.stringify(meta), { ex: ROOM_TTL, nx: true })
      return NextResponse.json({ roomId: pinRoomId })
    }

    // Regular room
    const roomId = randomBytes(12).toString('base64url')
    const meta = {
      createdAt: Date.now(),
      hasPassword: !!passwordHash,
      passwordHash: passwordHash || null,
    }
    await redis.set(`room:${roomId}:meta`, JSON.stringify(meta), { ex: ROOM_TTL })
    await redis.del(`room:${roomId}:messages`)

    return NextResponse.json({ roomId })
  } catch (e) {
    return NextResponse.json({ error: 'Failed to create room' }, { status: 500 })
  }
}
