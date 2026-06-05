'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

async function pinToRoomId(pin) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('whispr-pin-v1:' + pin))
  return btoa(String.fromCharCode(...new Uint8Array(buf).slice(0, 12)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

export default function PinLinkGateway() {
  const router = useRouter()
  const [status, setStatus] = useState('joining...')

  useEffect(() => {
    const pin = window.location.hash.slice(1).trim()
    if (!pin) { router.replace('/'); return }

    async function join() {
      const roomId = await pinToRoomId(pin)
      sessionStorage.setItem(`whispr:${roomId}:pin`, pin)
      await fetch('/api/create-room', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinRoomId: roomId }),
      })
      router.replace(`/room/${roomId}`)
    }

    join().catch(() => setStatus('something went wrong'))
  }, [router])

  return (
    <div style={{
      minHeight: '100dvh', display: 'flex', alignItems: 'center',
      justifyContent: 'center', background: '#111', color: '#555',
      fontFamily: 'monospace', fontSize: 13,
    }}>
      {status}
    </div>
  )
}
