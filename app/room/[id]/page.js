'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'

// ── Crypto helpers ────────────────────────────────────────────────────────────

async function generateKeyPair() {
  return crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey'])
}

async function exportPublicKey(key) {
  const raw = await crypto.subtle.exportKey('raw', key)
  return btoa(String.fromCharCode(...new Uint8Array(raw)))
}

async function importPublicKey(b64) {
  const raw = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
  return crypto.subtle.importKey('raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, true, [])
}

async function deriveSharedKey(privateKey, otherPublicKey) {
  return crypto.subtle.deriveKey(
    { name: 'ECDH', public: otherPublicKey },
    privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

// Derives a deterministic AES-GCM key from a PIN using PBKDF2
async function derivePinKey(pin) {
  const enc = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(pin), { name: 'PBKDF2' }, false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode('whispr-salt-v1'), iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

// Derives the deterministic room ID from a PIN (must match page.js)
async function pinToRoomId(pin) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('whispr-pin-v1:' + pin))
  return btoa(String.fromCharCode(...new Uint8Array(buf).slice(0, 12)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

async function encryptMessage(sharedKey, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encoded = new TextEncoder().encode(text)
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, sharedKey, encoded)
  const ivB64 = btoa(String.fromCharCode(...iv))
  const dataB64 = btoa(String.fromCharCode(...new Uint8Array(cipher)))
  return { encryptedPayload: dataB64, iv: ivB64 }
}

async function decryptMessage(sharedKey, encryptedPayload, ivB64) {
  try {
    const iv = Uint8Array.from(atob(ivB64), c => c.charCodeAt(0))
    const data = Uint8Array.from(atob(encryptedPayload), c => c.charCodeAt(0))
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, sharedKey, data)
    return new TextDecoder().decode(plain)
  } catch {
    return '[decryption failed]'
  }
}

// Password hashing (SHA-256, hex)
async function hashPassword(pw) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pw))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

// ── Key exchange via Redis as a relay ────────────────────────────────────────

async function storeMyPublicKey(roomId, tag, pubKeyB64) {
  await fetch('/api/exchange-key', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roomId, tag, pubKey: pubKeyB64 }),
  })
}

async function fetchKeys(roomId) {
  const r = await fetch(`/api/exchange-key?roomId=${roomId}`)
  return r.json()
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function RoomPage() {
  const { id: roomId } = useParams()
  const router = useRouter()

  const [phase, setPhase] = useState('loading') // loading | pin | password | waiting | chatting | expired
  const [myTag, setMyTag] = useState(null)
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [sharedKey, setSharedKey] = useState(null)
  const [keyPairRef] = useState(() => ({ current: null }))
  const [lastSeen, setLastSeen] = useState(0)
  const [passwordInput, setPasswordInput] = useState('')
  const [passwordError, setPasswordError] = useState('')
  const [pinInput, setPinInput] = useState('')
  const [pinError, setPinError] = useState('')
  const [decryptedCache, setDecryptedCache] = useState({})
  const [status, setStatus] = useState('')
  const pollRef = useRef(null)
  const bottomRef = useRef(null)
  const fileInputRef = useRef(null)

  // Init: check room, handle PIN or ECDH setup
  const init = useCallback(async (skipPasswordCheck = false) => {
    // 1. Check room exists
    const infoRes = await fetch(`/api/room-info?roomId=${roomId}`)
    const info = await infoRes.json()
    if (!info.exists) { setPhase('expired'); return }

    // 2. PIN room — derive key from PIN, skip ECDH entirely
    if (info.isPinRoom) {
      const pin = sessionStorage.getItem(`whispr:${roomId}:pin`)
      if (!pin) { setPhase('pin'); return }

      if (info.hasPassword && !skipPasswordCheck) { setPhase('password'); return }

      // Verify the PIN matches this room (client-side check, no server round-trip)
      const expectedId = await pinToRoomId(pin)
      if (expectedId !== roomId) {
        sessionStorage.removeItem(`whispr:${roomId}:pin`)
        setPinError('wrong pin')
        setPhase('pin')
        return
      }

      const key = await derivePinKey(pin)
      setSharedKey(key)

      // Assign a random per-session tag so we can distinguish our own messages
      let tag = sessionStorage.getItem(`whispr:${roomId}:tag`)
      if (!tag) {
        tag = Array.from(crypto.getRandomValues(new Uint8Array(4)), b => b.toString(16).padStart(2, '0')).join('')
        sessionStorage.setItem(`whispr:${roomId}:tag`, tag)
      }
      setMyTag(tag)
      setPhase('chatting')
      return
    }

    // 3. Password check (regular rooms)
    if (info.hasPassword && !skipPasswordCheck) {
      setPhase('password')
      return
    }

    // 4. Assign tag A or B (regular 2-party ECDH rooms)
    const keysRes = await fetchKeys(roomId)
    let tag
    if (!keysRes.A) tag = 'A'
    else if (!keysRes.B) tag = 'B'
    else {
      const stored = sessionStorage.getItem(`whispr:${roomId}:tag`)
      if (stored === 'A' || stored === 'B') tag = stored
      else { setStatus('Chat is full (2 participants max)'); setPhase('expired'); return }
    }
    setMyTag(tag)
    sessionStorage.setItem(`whispr:${roomId}:tag`, tag)

    // 5. Generate or restore key pair
    let kp = keyPairRef.current
    if (!kp) {
      const stored = sessionStorage.getItem(`whispr:${roomId}:keypair`)
      if (stored) {
        const { pub, priv } = JSON.parse(stored)
        const pubKey = await crypto.subtle.importKey('raw', Uint8Array.from(atob(pub), c => c.charCodeAt(0)), { name: 'ECDH', namedCurve: 'P-256' }, true, [])
        const privKey = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(priv), c => c.charCodeAt(0)), { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey'])
        kp = { publicKey: pubKey, privateKey: privKey }
      } else {
        kp = await generateKeyPair()
        const pubRaw = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))))
        const privRaw = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey))))
        sessionStorage.setItem(`whispr:${roomId}:keypair`, JSON.stringify({ pub: pubRaw, priv: privRaw }))
      }
      keyPairRef.current = kp
    }
    const myPubB64 = await exportPublicKey(kp.publicKey)
    await storeMyPublicKey(roomId, tag, myPubB64)

    // 6. Try to find other party's key
    const otherTag = tag === 'A' ? 'B' : 'A'
    const keys2 = await fetchKeys(roomId)
    if (keys2[otherTag]) {
      const otherPub = await importPublicKey(keys2[otherTag])
      const sk = await deriveSharedKey(kp.privateKey, otherPub)
      setSharedKey(sk)
      setPhase('chatting')
    } else {
      setPhase('waiting')
    }
  }, [roomId, keyPairRef])

  useEffect(() => { init() }, [init])

  // Poll for keys + messages
  useEffect(() => {
    if (phase === 'expired' || phase === 'loading' || phase === 'password' || phase === 'pin') return

    pollRef.current = setInterval(async () => {
      // If still waiting for other party (regular rooms only)
      if (phase === 'waiting' && myTag) {
        const otherTag = myTag === 'A' ? 'B' : 'A'
        const keys = await fetchKeys(roomId)
        if (keys[otherTag]) {
          const otherPub = await importPublicKey(keys[otherTag])
          const sk = await deriveSharedKey(keyPairRef.current.privateKey, otherPub)
          setSharedKey(sk)
          setPhase('chatting')
        }
        return
      }

      // Fetch new messages
      if (phase === 'chatting' && sharedKey) {
        const r = await fetch(`/api/get-messages?roomId=${roomId}&since=${lastSeen}`)
        const data = await r.json()
        if (!data.exists) { setPhase('expired'); return }
        if (data.messages.length > 0) {
          setMessages(prev => {
            const ids = new Set(prev.map(m => m.id))
            const newOnes = data.messages.filter(m => !ids.has(m.id))
            return [...prev, ...newOnes]
          })
          setLastSeen(data.messages[data.messages.length - 1].ts)
        }
      }
    }, 1500)

    return () => clearInterval(pollRef.current)
  }, [phase, sharedKey, roomId, lastSeen, myTag, keyPairRef])

  // Decrypt messages as they arrive
  useEffect(() => {
    if (!sharedKey) return
    messages.forEach(async (m) => {
      if (decryptedCache[m.id]) return
      const plain = await decryptMessage(sharedKey, m.encryptedPayload, m.iv)
      setDecryptedCache(prev => ({ ...prev, [m.id]: plain }))
    })
  }, [messages, sharedKey, decryptedCache])

  // Auto-scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [decryptedCache])

  const handlePasswordSubmit = async () => {
    const infoRes = await fetch(`/api/room-info?roomId=${roomId}`)
    const info = await infoRes.json()
    const hashed = await hashPassword(passwordInput)
    if (hashed !== info.passwordHash) {
      setPasswordError('wrong password')
      return
    }
    setPasswordError('')
    init(true)
  }

  const handlePinSubmit = async () => {
    const trimmed = pinInput.trim()
    if (trimmed.length < 4) { setPinError('min 4 characters'); return }
    const expectedId = await pinToRoomId(trimmed)
    if (expectedId !== roomId) { setPinError('wrong pin'); return }
    setPinError('')
    sessionStorage.setItem(`whispr:${roomId}:pin`, trimmed)
    init()
  }

  const sendText = async () => {
    if (!input.trim() || !sharedKey) return
    const { encryptedPayload, iv } = await encryptMessage(sharedKey, input.trim())
    await fetch('/api/send-message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId, encryptedPayload, iv, senderTag: myTag }),
    })
    setInput('')
  }

  const sendFile = async (file) => {
    if (!sharedKey) return
    const b64 = await new Promise((res, rej) => {
      const r = new FileReader()
      r.onload = () => res(r.result)
      r.onerror = rej
      r.readAsDataURL(file)
    })
    const { encryptedPayload, iv } = await encryptMessage(sharedKey, b64)
    await fetch('/api/send-message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roomId, encryptedPayload, iv, senderTag: myTag,
        isFile: true, fileName: file.name, fileType: file.type,
      }),
    })
  }

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText() }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  if (phase === 'loading') return <Screen><Dim>connecting...</Dim></Screen>
  if (phase === 'expired') return (
    <Screen>
      <Dim>{status || 'this link has expired or does not exist.'}</Dim>
      <BackLink onClick={() => router.push('/')}>← back</BackLink>
    </Screen>
  )

  if (phase === 'pin') return (
    <Screen>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%', maxWidth: 340 }}>
        <Dim>enter the pin to join this chat.</Dim>
        <input
          autoFocus
          type="text"
          placeholder="enter pin"
          value={pinInput}
          onChange={e => { setPinInput(e.target.value.slice(0, 20)); setPinError('') }}
          onKeyDown={e => e.key === 'Enter' && handlePinSubmit()}
          maxLength={20}
          autoComplete="off"
          spellCheck={false}
          style={inputStyle}
        />
        {pinError && <Dim style={{ color: '#f66', fontSize: 12 }}>{pinError}</Dim>}
        <button onClick={handlePinSubmit} style={btnStyle}>join</button>
        <BackLink onClick={() => router.push('/')}>← back</BackLink>
      </div>
    </Screen>
  )

  if (phase === 'password') return (
    <Screen>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%', maxWidth: 340 }}>
        <Dim>this chat is password protected.</Dim>
        <input
          autoFocus
          type="password"
          placeholder="enter password"
          value={passwordInput}
          onChange={e => setPasswordInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handlePasswordSubmit()}
          style={inputStyle}
        />
        {passwordError && <Dim style={{ color: '#f66', fontSize: 12 }}>{passwordError}</Dim>}
        <button onClick={handlePasswordSubmit} style={btnStyle}>enter</button>
        <BackLink onClick={() => router.push('/')}>← back</BackLink>
      </div>
    </Screen>
  )

  if (phase === 'waiting') return (
    <Screen>
      <Dim>waiting for the other person to join...</Dim>
      <Dim style={{ fontSize: 11, marginTop: 6, opacity: 0.5 }}>share the link to start the encrypted chat</Dim>
    </Screen>
  )

  // Chatting
  return (
    <div style={outerStyle}>
      <div style={msgsStyle}>
        {messages.map(m => {
          const isMe = m.senderTag === myTag
          const plain = decryptedCache[m.id]
          const isDataUrl = plain && plain.startsWith('data:')
          return (
            <div key={m.id} style={{ display: 'flex', justifyContent: isMe ? 'flex-end' : 'flex-start', marginBottom: 6 }}>
              <div style={{ ...bubbleStyle, background: isMe ? '#2a2a2a' : '#1e1e1e', maxWidth: '72%' }}>
                {plain === undefined && <Dim style={{ fontSize: 12 }}>decrypting...</Dim>}
                {plain && isDataUrl && m.isFile && m.fileType?.startsWith('image/') && (
                  <img src={plain} alt={m.fileName || 'image'} style={{ maxWidth: '100%', borderRadius: 6, display: 'block' }} />
                )}
                {plain && isDataUrl && m.isFile && !m.fileType?.startsWith('image/') && (
                  <a href={plain} download={m.fileName} style={{ color: '#aaa', fontSize: 13 }}>↓ {m.fileName}</a>
                )}
                {plain && !isDataUrl && (
                  <span style={{ fontSize: 14, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{plain}</span>
                )}
                <span style={{ fontSize: 10, opacity: 0.35, display: 'block', marginTop: 4, textAlign: isMe ? 'right' : 'left' }}>
                  {new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            </div>
          )
        })}
        {messages.length === 0 && <Dim style={{ textAlign: 'center', marginTop: 60 }}>e2e encrypted · messages expire 48h after last activity</Dim>}
        <div ref={bottomRef} />
      </div>

      <div style={inputBarStyle}>
        <input
          type="file"
          ref={fileInputRef}
          style={{ display: 'none' }}
          onChange={e => { if (e.target.files[0]) sendFile(e.target.files[0]); e.target.value = '' }}
        />
        <button onClick={() => fileInputRef.current?.click()} style={iconBtnStyle} title="attach file">
          ⊕
        </button>
        <textarea
          style={textareaStyle}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKey}
          placeholder="message"
          rows={1}
        />
        <button onClick={sendText} style={iconBtnStyle} title="send">↑</button>
      </div>
    </div>
  )
}

// ── Tiny styled helpers ───────────────────────────────────────────────────────

function Screen({ children }) {
  return (
    <div style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12, background: '#111', color: '#ccc', fontFamily: 'monospace' }}>
      {children}
    </div>
  )
}
function Dim({ children, style }) {
  return <span style={{ color: '#666', fontSize: 13, fontFamily: 'monospace', ...style }}>{children}</span>
}
function BackLink({ onClick, children }) {
  return <button onClick={onClick} style={{ background: 'none', border: 'none', color: '#555', cursor: 'pointer', fontSize: 13, fontFamily: 'monospace', marginTop: 8 }}>{children}</button>
}

const outerStyle = {
  display: 'flex', flexDirection: 'column', height: '100dvh',
  background: '#111', color: '#ccc', fontFamily: 'monospace',
}
const msgsStyle = {
  flex: 1, overflowY: 'auto', padding: '20px 16px 8px',
  display: 'flex', flexDirection: 'column',
}
const bubbleStyle = {
  padding: '8px 12px', borderRadius: 14, wordBreak: 'break-word',
}
const inputBarStyle = {
  display: 'flex', alignItems: 'flex-end', gap: 8,
  padding: '10px 12px 18px',
  background: '#111',
  borderTop: '1px solid #1e1e1e',
}
const textareaStyle = {
  flex: 1, background: '#1e1e1e', border: 'none', borderRadius: 12,
  padding: '10px 14px', color: '#ccc', fontFamily: 'monospace', fontSize: 14,
  resize: 'none', outline: 'none', lineHeight: 1.5,
  maxHeight: 120, overflowY: 'auto',
}
const iconBtnStyle = {
  background: 'none', border: 'none', color: '#555', cursor: 'pointer',
  fontSize: 20, padding: '6px', lineHeight: 1, flexShrink: 0,
  transition: 'color 0.15s',
}
const inputStyle = {
  background: '#1e1e1e', border: 'none', borderRadius: 10,
  padding: '10px 14px', color: '#ccc', fontFamily: 'monospace',
  fontSize: 14, outline: 'none', width: '100%', boxSizing: 'border-box',
}
const btnStyle = {
  background: '#1e1e1e', border: 'none', borderRadius: 10,
  padding: '10px 14px', color: '#888', fontFamily: 'monospace',
  fontSize: 13, cursor: 'pointer', width: '100%',
}
