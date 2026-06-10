import { redis, touchRoom } from '../../../lib/redis'
import { NextResponse } from 'next/server'

export async function POST(req) {
  try {
    const { roomId, encryptedPayload, iv, senderTag, members, isFile, fileName, fileType } = await req.json()

    if (!roomId || !encryptedPayload || !Array.isArray(members) || members.length !== 2) {
      return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
    }
    if (!members.includes(senderTag)) {
      return NextResponse.json({ error: 'Sender not a member' }, { status: 400 })
    }

    // Verify room exists
    const meta = await redis.get(`room:${roomId}:meta`)
    if (!meta) return NextResponse.json({ error: 'Room not found' }, { status: 404 })

    const message = {
      id: Date.now() + Math.random().toString(36).slice(2),
      // Server only ever sees encrypted blobs - never plaintext
      encryptedPayload,
      iv,
      senderTag,
      // The two senderTags allowed to see this whisper (sorted, server-visible only)
      members: [...members].sort(),
      ts: Date.now(),
      isFile: !!isFile,
      fileName: fileName || null,
      fileType: fileType || null,
    }

    await redis.rpush(`room:${roomId}:whispers`, JSON.stringify(message))
    await touchRoom(roomId)

    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: 'Failed to send' }, { status: 500 })
  }
}
