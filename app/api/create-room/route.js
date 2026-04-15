import { redis, ROOM_TTL } from '../../../lib/redis'
import { NextResponse } from 'next/server'
import { randomBytes } from 'crypto'

export async function POST(req) {
  try {
    const { passwordHash } = await req.json()

    const roomId = randomBytes(12).toString('base64url')

    const meta = {
      createdAt: Date.now(),
      hasPassword: !!passwordHash,
      // If password protected, store hash of password (hashed client-side with SHA-256)
      passwordHash: passwordHash || null,
    }

    await redis.set(`room:${roomId}:meta`, JSON.stringify(meta), { ex: ROOM_TTL })
    // Initialize empty message list
    await redis.del(`room:${roomId}:messages`)

    return NextResponse.json({ roomId })
  } catch (e) {
    return NextResponse.json({ error: 'Failed to create room' }, { status: 500 })
  }
}
