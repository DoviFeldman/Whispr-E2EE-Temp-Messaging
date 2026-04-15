import { redis } from '../../../lib/redis'
import { NextResponse } from 'next/server'

export async function GET(req) {
  const { searchParams } = new URL(req.url)
  const roomId = searchParams.get('roomId')
  const since = parseInt(searchParams.get('since') || '0')

  if (!roomId) return NextResponse.json({ error: 'Missing roomId' }, { status: 400 })

  const meta = await redis.get(`room:${roomId}:meta`)
  if (!meta) return NextResponse.json({ exists: false, messages: [] })

  const raw = await redis.lrange(`room:${roomId}:messages`, 0, -1)
  const messages = raw
    .map(m => (typeof m === 'string' ? JSON.parse(m) : m))
    .filter(m => m.ts > since)

  return NextResponse.json({ exists: true, messages })
}
