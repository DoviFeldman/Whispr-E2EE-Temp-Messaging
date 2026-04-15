import { redis, ROOM_TTL } from '../../../lib/redis'
import { NextResponse } from 'next/server'

export async function POST(req) {
  const { roomId, tag, pubKey } = await req.json()
  if (!roomId || !tag || !pubKey) return NextResponse.json({ error: 'bad input' }, { status: 400 })

  const meta = await redis.get(`room:${roomId}:meta`)
  if (!meta) return NextResponse.json({ error: 'no room' }, { status: 404 })

  // Store the EC public key (not a secret)
  await redis.set(`room:${roomId}:key:${tag}`, pubKey, { ex: ROOM_TTL })
  return NextResponse.json({ ok: true })
}

export async function GET(req) {
  const { searchParams } = new URL(req.url)
  const roomId = searchParams.get('roomId')

  const [a, b] = await Promise.all([
    redis.get(`room:${roomId}:key:A`),
    redis.get(`room:${roomId}:key:B`),
  ])

  return NextResponse.json({ A: a || null, B: b || null })
}
