'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { deriveName } from '../../../lib/names'

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

async function encryptMessage(sharedKey, text, name, color) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const payload = (name || color) ? JSON.stringify({ v: 1, name, color, text }) : text
  const encoded = new TextEncoder().encode(payload)
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

function parsePayload(plain) {
  if (!plain || plain === '[decryption failed]') return { text: plain, name: null, color: null }
  try {
    const obj = JSON.parse(plain)
    if (obj && obj.v === 1 && typeof obj.text === 'string') return { text: obj.text, name: obj.name || null, color: obj.color || null }
  } catch {}
  return { text: plain, name: null, color: null }
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
  const [roomType, setRoomType] = useState(null) // 'pin' | 'ecdh'
  const [isApp, setIsApp] = useState(false)
  const [displayName, setDisplayName] = useState(null)
  const [nameMap, setNameMap] = useState({})
  const [editingName, setEditingName] = useState(false)
  const [nameInput, setNameInput] = useState('')
  const [bubbleColor, setBubbleColor] = useState(null) // own bubble color; null = use default '#2a2a2a'
  const [colorMap, setColorMap] = useState({}) // senderTag -> color, for the other party
  const [pickingColor, setPickingColor] = useState(false)
  const [colorInput, setColorInput] = useState('')
  // ── Private message (private side-chat) state ──
  const [privateMsgs, setPrivateMsgs] = useState([])          // raw private messages I'm a member of
  const [privateCache, setPrivateCache] = useState({})        // id -> decrypted text
  const [lastSeenPrivate, setLastSeenPrivate] = useState(0)
  const [activePrivate, setActivePrivate] = useState(null)    // the other person's senderTag, or null
  const [privateInput, setPrivateInput] = useState('')
  const [privateMinimized, setPrivateMinimized] = useState(false)
  const [privateHeight, setPrivateHeight] = useState(280)
  const [privateMenuFor, setPrivateMenuFor] = useState(null)  // message id whose private action is showing
  const privateBottomRef = useRef(null)
  const pollRef = useRef(null)
  const bottomRef = useRef(null)
  const fileInputRef = useRef(null)
  const colorPickerRef = useRef(null)

  // Init: check room, handle PIN or ECDH setup
  const init = useCallback(async (skipPasswordCheck = false) => {
    // If a PIN-link URL was shared directly (/room/id#pin), sync the hash into sessionStorage
    const hashPin = window.location.hash.slice(1)
    if (hashPin && !sessionStorage.getItem(`whispr:${roomId}:pin`)) {
      sessionStorage.setItem(`whispr:${roomId}:pin`, hashPin)
    }

    // 1. Check room exists
    const infoRes = await fetch(`/api/room-info?roomId=${roomId}`)
    const info = await infoRes.json()
    if (!info.exists) { setPhase('expired'); return }

    // 2. PIN room — derive key from PIN, skip ECDH entirely
    if (info.isPinRoom) {
      setRoomType('pin')
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

    setRoomType('ecdh')

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
  useEffect(() => {
    setIsApp(window.matchMedia('(display-mode: standalone)').matches || !!window.navigator.standalone)
  }, [])

  useEffect(() => {
    if (phase !== 'chatting' || !myTag || !roomId) return
    const stored = sessionStorage.getItem(`whispr:${roomId}:displayName`)
    const name = stored || deriveName(myTag, roomId)
    if (!stored) sessionStorage.setItem(`whispr:${roomId}:displayName`, name)
    setDisplayName(name)

    const storedColor = sessionStorage.getItem(`whispr:${roomId}:bubbleColor`)
    if (storedColor) setBubbleColor(storedColor)
  }, [phase, myTag, roomId])

  useEffect(() => { if (editingName) setNameInput(displayName || '') }, [editingName, displayName])

  // Close color picker on outside click
  useEffect(() => {
    if (!pickingColor) return
    const handler = e => {
      if (colorPickerRef.current && !colorPickerRef.current.contains(e.target)) setPickingColor(false)
    }
    document.addEventListener('mousedown', handler)
    document.addEventListener('touchstart', handler)
    return () => { document.removeEventListener('mousedown', handler); document.removeEventListener('touchstart', handler) }
  }, [pickingColor])

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

        // Fetch new privates addressed to me (server only returns ones I'm a member of)
        const wr = await fetch(`/api/get-private-messages?roomId=${roomId}&tag=${myTag}&since=${lastSeenPrivate}`)
        const wdata = await wr.json()
        if (wdata.exists && wdata.messages.length > 0) {
          setPrivateMsgs(prev => {
            const ids = new Set(prev.map(m => m.id))
            const newOnes = wdata.messages.filter(m => !ids.has(m.id))
            return newOnes.length ? [...prev, ...newOnes] : prev
          })
          setLastSeenPrivate(wdata.messages[wdata.messages.length - 1].ts)
          // Auto-open the pane when a private arrives from someone (only if none open yet)
          const fromOther = wdata.messages.find(m => m.senderTag !== myTag)
          if (fromOther) setActivePrivate(prev => prev || fromOther.senderTag)
        }
      }
    }, 1500)

    return () => clearInterval(pollRef.current)
  }, [phase, sharedKey, roomId, lastSeen, lastSeenPrivate, myTag, keyPairRef])

  // Decrypt messages as they arrive
  useEffect(() => {
    if (!sharedKey) return
    messages.forEach(async (m) => {
      if (decryptedCache[m.id]) return
      const plain = await decryptMessage(sharedKey, m.encryptedPayload, m.iv)
      setDecryptedCache(prev => ({ ...prev, [m.id]: plain }))
      const { name, color } = parsePayload(plain)
      if (name && m.senderTag) {
        setNameMap(prev => prev[m.senderTag] === name ? prev : { ...prev, [m.senderTag]: name })
      }
      if (color && m.senderTag) {
        setColorMap(prev => prev[m.senderTag] === color ? prev : { ...prev, [m.senderTag]: color })
      }
    })
  }, [messages, sharedKey, decryptedCache])

  // Decrypt private messages as they arrive (same room key, reused helpers)
  useEffect(() => {
    if (!sharedKey) return
    privateMsgs.forEach(async (m) => {
      if (privateCache[m.id] !== undefined) return
      const plain = await decryptMessage(sharedKey, m.encryptedPayload, m.iv)
      setPrivateCache(prev => ({ ...prev, [m.id]: plain }))
    })
  }, [privateMsgs, sharedKey, privateCache])

  // Auto-scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [decryptedCache])

  // Auto-scroll the private pane
  useEffect(() => {
    privateBottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [privateCache, activePrivate, privateMinimized])

  // Save this room to the chat list in localStorage when we enter chatting phase
  useEffect(() => {
    if (phase !== 'chatting' || !roomType) return
    const pin = sessionStorage.getItem(`whispr:${roomId}:pin`)
    const hashPin = window.location.hash.slice(1)
    const type = roomType === 'ecdh' ? 'ecdh' : (hashPin ? 'pin-link' : 'pin')
    const entry = { roomId, type, pin: pin || null, lastMessage: '', lastTs: Date.now() }
    if (hashPin) entry.shareUrl = `${window.location.origin}/p#${hashPin}`
    try {
      const chats = JSON.parse(localStorage.getItem('whispr:chats') || '[]')
      const idx = chats.findIndex(c => c.roomId === roomId)
      if (idx >= 0) chats[idx] = { ...chats[idx], ...entry, lastMessage: chats[idx].lastMessage || '' }
      else chats.unshift(entry)
      chats.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0))
      localStorage.setItem('whispr:chats', JSON.stringify(chats))
    } catch {}
  }, [phase, roomType, roomId])

  // Update lastMessage in chat list when a new message is decrypted
  useEffect(() => {
    if (phase !== 'chatting' || !messages.length) return
    const last = messages[messages.length - 1]
    const plain = decryptedCache[last?.id]
    if (!plain) return
    const { text: plainText } = parsePayload(plain)
    const snippet = plainText.startsWith('data:') ? '📎 attachment' : plainText.slice(0, 80)
    try {
      const chats = JSON.parse(localStorage.getItem('whispr:chats') || '[]')
      const idx = chats.findIndex(c => c.roomId === roomId)
      if (idx >= 0) {
        chats[idx].lastMessage = snippet
        chats[idx].lastTs = last.ts
        chats.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0))
        localStorage.setItem('whispr:chats', JSON.stringify(chats))
      }
    } catch {}
  }, [decryptedCache, messages, roomId, phase])

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
    const { encryptedPayload, iv } = await encryptMessage(sharedKey, input.trim(), displayName, bubbleColor)
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
    const { encryptedPayload, iv } = await encryptMessage(sharedKey, b64, displayName, bubbleColor)
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

  // ── Private actions ──
  const startPrivate = (otherTag) => {
    if (!otherTag || otherTag === myTag) return
    setActivePrivate(otherTag)
    setPrivateMinimized(false)
    setPrivateMenuFor(null)
  }

  const sendPrivate = async () => {
    if (!privateInput.trim() || !sharedKey || !activePrivate || !myTag) return
    const members = [myTag, activePrivate].sort()
    const { encryptedPayload, iv } = await encryptMessage(sharedKey, privateInput.trim(), displayName, bubbleColor)
    await fetch('/api/send-private-message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId, encryptedPayload, iv, senderTag: myTag, members }),
    })
    setPrivateInput('')
  }

  // Drag the handle to resize the pane up/down
  const startPrivateDrag = (e) => {
    e.preventDefault()
    const startY = e.touches ? e.touches[0].clientY : e.clientY
    const startH = privateHeight
    const move = (ev) => {
      const y = ev.touches ? ev.touches[0].clientY : ev.clientY
      const next = Math.max(120, Math.min(window.innerHeight * 0.7, startH + (startY - y)))
      setPrivateHeight(next)
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      window.removeEventListener('touchmove', move)
      window.removeEventListener('touchend', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    window.addEventListener('touchmove', move, { passive: false })
    window.addEventListener('touchend', up)
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

  // Messages belonging to the currently open private (the pair [me, activePrivate])
  const privatePair = activePrivate ? [myTag, activePrivate].sort().join('|') : null
  const privateThread = privatePair
    ? privateMsgs.filter(m => (m.members || []).slice().sort().join('|') === privatePair)
    : []
  const privateLabel = activePrivate ? (nameMap[activePrivate] || activePrivate.slice(0, 5)) : ''

  // Chatting
  return (
    <div style={outerStyle}>
      {isApp && (
        <div style={{ padding: '10px 14px 8px', borderBottom: '1px solid #1a1a1a' }}>
          <button onClick={() => router.push('/app')} style={{ background: 'none', border: 'none', color: '#3a3a3a', fontFamily: 'monospace', fontSize: 14, cursor: 'pointer', padding: 0, letterSpacing: 1 }}>
            ← whispr
          </button>
        </div>
      )}
      <div style={msgsStyle}>
        {(() => {
          const firstInRun = new Set()
          messages.forEach((m, i) => {
            if (i === 0 || messages[i - 1].senderTag !== m.senderTag) firstInRun.add(m.id)
          })
          return messages.map(m => {
            const isMe = m.senderTag === myTag
            const plain = decryptedCache[m.id]
            const { text: msgText } = parsePayload(plain)
            const isDataUrl = msgText && msgText.startsWith('data:')
            const showLabel = firstInRun.has(m.id)
            const labelText = isMe
              ? (displayName || m.senderTag.slice(0, 5))
              : (nameMap[m.senderTag] || m.senderTag.slice(0, 5))
            const bgColor = isMe ? (bubbleColor || '#2a2a2a') : (colorMap[m.senderTag] || '#1e1e1e')
            return (
              <div key={m.id} style={{ display: 'flex', flexDirection: 'column', alignItems: isMe ? 'flex-end' : 'flex-start', marginBottom: 6 }}>
                <div style={{ display: 'flex', justifyContent: isMe ? 'flex-end' : 'flex-start', width: '100%' }}>
                  <div
                    style={{ ...bubbleStyle, background: bgColor, maxWidth: '72%', cursor: isMe ? 'default' : 'pointer' }}
                    onClick={isMe ? undefined : () => setPrivateMenuFor(prev => prev === m.id ? null : m.id)}
                  >
                    {showLabel && (
                      <div
                        style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'rgba(255,255,255,0.35)', fontFamily: 'monospace', marginBottom: 4, cursor: isMe ? 'pointer' : 'default', userSelect: 'none' }}
                        onClick={isMe ? () => setEditingName(true) : undefined}
                      >
                        {isMe && (editingName || pickingColor) && (
                          <span
                            onMouseDown={e => e.preventDefault()}
                            onClick={e => {
                              e.stopPropagation()
                              if (editingName) {
                                const trimmed = nameInput.trim()
                                if (trimmed) {
                                  sessionStorage.setItem(`whispr:${roomId}:displayName`, trimmed)
                                  setDisplayName(trimmed)
                                }
                                setEditingName(false)
                              }
                              setColorInput(bubbleColor || '#2a2a2a')
                              setPickingColor(true)
                            }}
                            title="change bubble color"
                            style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: bubbleColor || '#2a2a2a', border: '1px solid rgba(255,255,255,0.4)', cursor: 'pointer', flexShrink: 0 }}
                          />
                        )}
                        {isMe && editingName ? (
                          <input
                            autoFocus
                            value={nameInput}
                            onChange={e => setNameInput(e.target.value.slice(0, 24))}
                            onBlur={() => {
                              const trimmed = nameInput.trim()
                              if (trimmed) {
                                sessionStorage.setItem(`whispr:${roomId}:displayName`, trimmed)
                                setDisplayName(trimmed)
                              }
                              setEditingName(false)
                            }}
                            onKeyDown={e => {
                              if (e.key === 'Enter') e.target.blur()
                              if (e.key === 'Escape') { setEditingName(false); setNameInput(displayName || '') }
                            }}
                            style={{ background: 'transparent', border: 'none', borderBottom: '1px solid rgba(255,255,255,0.35)', color: 'rgba(255,255,255,0.6)', fontFamily: 'monospace', fontSize: 11, outline: 'none', padding: '0 2px', width: 90 }}
                          />
                        ) : labelText}
                        {isMe && pickingColor && (
                          <div
                            ref={colorPickerRef}
                            onClick={e => e.stopPropagation()}
                            style={{ position: 'absolute', top: '100%', right: 0, marginTop: 6, zIndex: 10, width: 180, boxSizing: 'border-box', background: '#1e1e1e', border: '1px solid #2a2a2a', borderRadius: 10, padding: 10, boxShadow: '0 4px 16px rgba(0,0,0,0.4)', display: 'flex', flexDirection: 'column', gap: 8, cursor: 'default' }}
                          >
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                              {THEME_COLORS.map(c => (
                                <span
                                  key={c}
                                  onClick={() => {
                                    sessionStorage.setItem(`whispr:${roomId}:bubbleColor`, c)
                                    setBubbleColor(c)
                                    setColorInput(c)
                                    setPickingColor(false)
                                  }}
                                  style={{
                                    display: 'inline-block', width: 18, height: 18, borderRadius: '50%', background: c,
                                    border: (bubbleColor || '#2a2a2a') === c ? '2px solid rgba(255,255,255,0.7)' : '1px solid rgba(255,255,255,0.2)',
                                    cursor: 'pointer',
                                  }}
                                />
                              ))}
                              <label
                                title="pick any color"
                                style={{ display: 'inline-block', width: 18, height: 18, borderRadius: '50%', background: 'conic-gradient(red, magenta, blue, cyan, lime, yellow, red)', border: '1px solid rgba(255,255,255,0.2)', cursor: 'pointer', position: 'relative', overflow: 'hidden' }}
                              >
                                <input
                                  type="color"
                                  value={bubbleColor || '#2a2a2a'}
                                  onChange={e => {
                                    const c = e.target.value
                                    sessionStorage.setItem(`whispr:${roomId}:bubbleColor`, c)
                                    setBubbleColor(c)
                                    setColorInput(c)
                                  }}
                                  style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0, cursor: 'pointer', border: 'none', padding: 0, margin: 0 }}
                                />
                              </label>
                            </div>
                            <input
                              value={colorInput}
                              onChange={e => {
                                const v = e.target.value.slice(0, 7)
                                setColorInput(v)
                                if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) {
                                  sessionStorage.setItem(`whispr:${roomId}:bubbleColor`, v)
                                  setBubbleColor(v)
                                }
                              }}
                              placeholder="#hex or rgb"
                              spellCheck={false}
                              style={{ background: 'transparent', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 6, color: '#ccc', fontFamily: 'monospace', fontSize: 11, outline: 'none', padding: '4px 6px', width: '100%', boxSizing: 'border-box' }}
                            />
                          </div>
                        )}
                      </div>
                    )}
                    {plain === undefined && <Dim style={{ fontSize: 12 }}>decrypting...</Dim>}
                    {msgText && isDataUrl && m.isFile && m.fileType?.startsWith('image/') && (
                      <img src={msgText} alt={m.fileName || 'image'} style={{ maxWidth: '100%', borderRadius: 6, display: 'block' }} />
                    )}
                    {msgText && isDataUrl && m.isFile && !m.fileType?.startsWith('image/') && (
                      <a href={msgText} download={m.fileName} style={{ color: '#aaa', fontSize: 13 }}>↓ {m.fileName}</a>
                    )}
                    {msgText && !isDataUrl && (
                      <span style={{ fontSize: 14, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{msgText}</span>
                    )}
                    <span style={{ fontSize: 10, opacity: 0.35, display: 'block', marginTop: 4, textAlign: isMe ? 'right' : 'left' }}>
                      {new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                </div>
                {!isMe && privateMenuFor === m.id && (
                  <button onClick={() => startPrivate(m.senderTag)} style={privateActionBtnStyle}>
                    🔒 message privately
                  </button>
                )}
              </div>
            )
          })
        })()}
        {messages.length === 0 && <Dim style={{ textAlign: 'center', marginTop: 60 }}>e2e encrypted · messages expire 48h after last activity</Dim>}
        <div ref={bottomRef} />
      </div>

      {/* Private message pane — only visible to the two participants */}
      {activePrivate && !privateMinimized && (
        <div style={{ ...privatePaneStyle, height: privateHeight }}>
          <div style={privateHandleStyle} onMouseDown={startPrivateDrag} onTouchStart={startPrivateDrag}>
            <div style={{ width: 36, height: 4, borderRadius: 2, background: '#3a3a3a' }} />
          </div>
          <div style={privateHeaderStyle}>
            <span style={{ fontSize: 12, color: '#888', fontFamily: 'monospace' }}>🔒 private · {privateLabel}</span>
            <div style={{ display: 'flex', gap: 2 }}>
              <button onClick={() => setPrivateMinimized(true)} style={privateIconBtn} title="minimize">▾</button>
              <button onClick={() => setActivePrivate(null)} style={privateIconBtn} title="close">✕</button>
            </div>
          </div>
          <div style={privateMsgsStyle}>
            {privateThread.map(m => {
              const isMe = m.senderTag === myTag
              const plain = privateCache[m.id]
              const { text: msgText } = parsePayload(plain)
              return (
                <div key={m.id} style={{ display: 'flex', justifyContent: isMe ? 'flex-end' : 'flex-start', marginBottom: 6 }}>
                  <div style={{ ...bubbleStyle, background: isMe ? (bubbleColor || '#2a2a2a') : '#1e1e1e', maxWidth: '80%' }}>
                    {plain === undefined
                      ? <Dim style={{ fontSize: 12 }}>decrypting...</Dim>
                      : <span style={{ fontSize: 14, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{msgText}</span>}
                    <span style={{ fontSize: 10, opacity: 0.35, display: 'block', marginTop: 4, textAlign: isMe ? 'right' : 'left' }}>
                      {new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                </div>
              )
            })}
            {privateThread.length === 0 && <Dim style={{ textAlign: 'center', marginTop: 20, fontSize: 12 }}>private · only you two can see this</Dim>}
            <div ref={privateBottomRef} />
          </div>
          <div style={privateInputBarStyle}>
            <textarea
              style={textareaStyle}
              value={privateInput}
              onChange={e => setPrivateInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendPrivate() } }}
              placeholder="private message"
              rows={1}
            />
            <button onClick={sendPrivate} style={iconBtnStyle} title="send">↑</button>
          </div>
        </div>
      )}
      {activePrivate && privateMinimized && (
        <button onClick={() => setPrivateMinimized(false)} style={privatePillStyle}>
          🔒 private chat with {privateLabel} · open
        </button>
      )}

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
// Muted preset swatches matching the app's dark/desaturated look — '#ccc' text stays legible on all of them
const THEME_COLORS = [
  '#2a2a2a', // default charcoal
  '#4a4030', // muted tan
  '#4a2f33', // muted red
  '#324a35', // muted green
  '#2f3a4a', // muted blue
  '#3d2f4a', // muted purple
  '#4a2f42', // muted pink
]
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
const privatePaneStyle = {
  display: 'flex', flexDirection: 'column', flexShrink: 0,
  background: '#141414', borderTop: '1px solid #2a2a2a',
}
const privateHandleStyle = {
  display: 'flex', justifyContent: 'center', alignItems: 'center',
  padding: '6px 0', cursor: 'ns-resize', touchAction: 'none', flexShrink: 0,
}
const privateHeaderStyle = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  padding: '0 14px 6px', flexShrink: 0,
}
const privateIconBtn = {
  background: 'none', border: 'none', color: '#777', cursor: 'pointer',
  fontSize: 14, padding: '2px 8px', lineHeight: 1,
}
const privateMsgsStyle = {
  flex: 1, overflowY: 'auto', padding: '4px 14px 8px',
  display: 'flex', flexDirection: 'column',
}
const privateInputBarStyle = {
  display: 'flex', alignItems: 'flex-end', gap: 8,
  padding: '8px 12px 12px', borderTop: '1px solid #1e1e1e', flexShrink: 0,
}
const privatePillStyle = {
  margin: '0 12px 10px', alignSelf: 'center',
  background: '#1e1e1e', border: '1px solid #2a2a2a', borderRadius: 20,
  color: '#aaa', fontFamily: 'monospace', fontSize: 12,
  padding: '8px 16px', cursor: 'pointer',
}
const privateActionBtnStyle = {
  marginTop: 4, alignSelf: 'flex-start',
  background: '#1e1e1e', border: '1px solid #2a2a2a', borderRadius: 8,
  color: '#aaa', fontFamily: 'monospace', fontSize: 11,
  padding: '4px 10px', cursor: 'pointer',
}
