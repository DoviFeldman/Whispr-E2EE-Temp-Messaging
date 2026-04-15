import { redis, ROOM_TTL, touchRoom } from '../../../lib/redis'
import { NextResponse } from 'next/server'

export async function POST(req) {
  try {
    const { roomId, encryptedPayload, senderTag, iv, isFile, fileName, fileType } = await req.json()

    if (!roomId || !encryptedPayload) {
      return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
    }

    // Verify room exists
    const meta = await redis.get(`room:${roomId}:meta`)
    if (!meta) return NextResponse.json({ error: 'Room not found' }, { status: 404 })

    const message = {
      id: Date.now() + Math.random().toString(36).slice(2),
      // Server only ever sees encrypted blobs - never plaintext
      encryptedPayload,
      iv,
      senderTag, // just "A" or "B", not an identity
      ts: Date.now(),
      isFile: !!isFile,
      fileName: fileName || null,
      fileType: fileType || null,
    }

    await redis.rpush(`room:${roomId}:messages`, JSON.stringify(message))
    await touchRoom(roomId)

    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: 'Failed to send' }, { status: 500 })
  }
}
