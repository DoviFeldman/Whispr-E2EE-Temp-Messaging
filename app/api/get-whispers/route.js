import { redis } from '../../../lib/redis'
import { NextResponse } from 'next/server'

export async function GET(req) {
  const { searchParams } = new URL(req.url)
  const roomId = searchParams.get('roomId')
  const tag = searchParams.get('tag')
  const since = parseInt(searchParams.get('since') || '0')

  if (!roomId || !tag) return NextResponse.json({ error: 'Missing roomId or tag' }, { status: 400 })

  const meta = await redis.get(`room:${roomId}:meta`)
  if (!meta) return NextResponse.json({ exists: false, messages: [] })

  const raw = await redis.lrange(`room:${roomId}:whispers`, 0, -1)
  const messages = raw
    .map(m => (typeof m === 'string' ? JSON.parse(m) : m))
    // Only ever return a whisper to one of its two participants. This filter is the
    // whole privacy guarantee: non-members never receive the bytes.
    .filter(m => Array.isArray(m.members) && m.members.includes(tag))
    .filter(m => m.ts > since)

  return NextResponse.json({ exists: true, messages })
}
