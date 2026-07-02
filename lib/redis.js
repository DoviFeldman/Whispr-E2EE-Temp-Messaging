import { Redis } from '@upstash/redis'

export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
})

export const ROOM_TTL = 90 * 24 * 60 * 60  // 90 days — room stays joinable
export const MESSAGES_TTL = 48 * 60 * 60   // 48 hours — messages auto-wipe

// Extend TTLs on every new message
export async function touchRoom(roomId) {
  await redis.expire(`room:${roomId}:meta`, ROOM_TTL)
  await redis.expire(`room:${roomId}:messages`, MESSAGES_TTL)
  await redis.expire(`room:${roomId}:privateMessages`, MESSAGES_TTL)
  await redis.expire(`room:${roomId}:push`, ROOM_TTL)
}
