import { Redis } from '@upstash/redis'

export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
})

export const ROOM_TTL = 48 * 60 * 60 // 48 hours in seconds

// Extend TTL on every new message
export async function touchRoom(roomId) {
  await redis.expire(`room:${roomId}:meta`, ROOM_TTL)
  await redis.expire(`room:${roomId}:messages`, ROOM_TTL)
}
