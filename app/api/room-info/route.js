import { redis } from '../../../lib/redis'
import { NextResponse } from 'next/server'

export async function GET(req) {
  const { searchParams } = new URL(req.url)
  const roomId = searchParams.get('roomId')

  if (!roomId) return NextResponse.json({ error: 'Missing roomId' }, { status: 400 })

  const meta = await redis.get(`room:${roomId}:meta`)
  if (!meta) return NextResponse.json({ exists: false })

  const parsed = typeof meta === 'string' ? JSON.parse(meta) : meta

  return NextResponse.json({
    exists: true,
    hasPassword: parsed.hasPassword,
    passwordHash: parsed.passwordHash,
  })
}
