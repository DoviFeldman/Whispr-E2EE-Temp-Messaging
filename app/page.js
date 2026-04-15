'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

async function hashPassword(pw) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pw))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

function generatePassword(len = 8) {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789'
  return Array.from(crypto.getRandomValues(new Uint8Array(len)))
    .map(b => chars[b % chars.length]).join('')
}

export default function Home() {
  const router = useRouter()
  const [usePassword, setUsePassword] = useState(false)
  const [password, setPassword] = useState('')
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState(null) // { url, password }
  const [copied, setCopied] = useState(false)
  const [copiedPw, setCopiedPw] = useState(false)

  const handleTogglePassword = (e) => {
    setUsePassword(e.target.checked)
    if (e.target.checked && !password) setPassword(generatePassword())
  }

  const createRoom = async () => {
    setCreating(true)
    let passwordHash = null
    if (usePassword && password) {
      passwordHash = await hashPassword(password)
    }
    const res = await fetch('/api/create-room', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passwordHash }),
    })
    const { roomId } = await res.json()
    const url = `${window.location.origin}/room/${roomId}`
    setCreated({ url, password: usePassword ? password : null })
    setCreating(false)
  }

  const copy = async (text, setCopiedFn) => {
    await navigator.clipboard.writeText(text)
    setCopiedFn(true)
    setTimeout(() => setCopiedFn(false), 1800)
  }

  return (
    <main style={main}>
      <div style={card}>
        <h1 style={h1}>whispr</h1>
        <p style={sub}>temporary · end-to-end encrypted · no logs</p>

        {!created ? (
          <>
            <label style={checkLabel}>
              <input
                type="checkbox"
                checked={usePassword}
                onChange={handleTogglePassword}
                style={{ accentColor: '#444', marginRight: 8 }}
              />
              password protect this chat
            </label>

            {usePassword && (
              <div style={{ width: '100%' }}>
                <p style={hint}>remember to paste this before copying the chat link so it's saved.</p>
                <div style={pwRow}>
                  <span style={pwText}>{password}</span>
                  <button onClick={() => copy(password, setCopiedPw)} style={smallBtn}>
                    {copiedPw ? 'copied' : 'copy'}
                  </button>
                </div>
              </div>
            )}

            <button onClick={createRoom} disabled={creating} style={bigBtn}>
              {creating ? 'creating...' : 'create chat link'}
            </button>
          </>
        ) : (
          <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 14 }}>
            {created.password && (
              <div>
                <p style={hint}>password</p>
                <div style={pwRow}>
                  <span style={pwText}>{created.password}</span>
                  <button onClick={() => copy(created.password, setCopiedPw)} style={smallBtn}>
                    {copiedPw ? 'copied' : 'copy'}
                  </button>
                </div>
              </div>
            )}
            <div>
              <p style={hint}>chat link · expires 48h after last message</p>
              <div style={pwRow}>
                <span style={{ ...pwText, fontSize: 11, wordBreak: 'break-all' }}>{created.url}</span>
                <button onClick={() => copy(created.url, setCopied)} style={smallBtn}>
                  {copied ? 'copied' : 'copy'}
                </button>
              </div>
            </div>

            <button onClick={() => router.push(created.url)} style={bigBtn}>open chat →</button>
            <button onClick={() => { setCreated(null); setPassword(''); setUsePassword(false) }} style={ghostBtn}>
              create another
            </button>
          </div>
        )}
      </div>

      <p style={footer}>messages are encrypted in your browser · the server never sees them</p>
    </main>
  )
}

const main = {
  minHeight: '100dvh', display: 'flex', flexDirection: 'column',
  alignItems: 'center', justifyContent: 'center',
  background: '#111', color: '#ccc', fontFamily: 'monospace', padding: 24,
}
const card = {
  display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 16,
  width: '100%', maxWidth: 380,
}
const h1 = { margin: 0, fontSize: 28, color: '#ddd', fontWeight: 400, letterSpacing: 2 }
const sub = { margin: 0, fontSize: 11, color: '#444' }
const checkLabel = { display: 'flex', alignItems: 'center', fontSize: 13, color: '#777', cursor: 'pointer', userSelect: 'none' }
const hint = { margin: '0 0 6px', fontSize: 11, color: '#555' }
const pwRow = {
  display: 'flex', alignItems: 'center', gap: 10,
  background: '#1e1e1e', borderRadius: 10, padding: '9px 12px',
  justifyContent: 'space-between',
}
const pwText = { fontSize: 13, color: '#aaa', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const smallBtn = {
  background: 'none', border: '1px solid #333', borderRadius: 6, padding: '4px 10px',
  color: '#666', fontFamily: 'monospace', fontSize: 11, cursor: 'pointer', flexShrink: 0,
}
const bigBtn = {
  width: '100%', background: '#1e1e1e', border: 'none', borderRadius: 12,
  padding: '13px 0', color: '#999', fontFamily: 'monospace', fontSize: 14,
  cursor: 'pointer', letterSpacing: 1,
}
const ghostBtn = {
  background: 'none', border: 'none', color: '#444', fontFamily: 'monospace',
  fontSize: 12, cursor: 'pointer', padding: 0, textAlign: 'left',
}
const footer = { position: 'fixed', bottom: 16, fontSize: 10, color: '#333' }
