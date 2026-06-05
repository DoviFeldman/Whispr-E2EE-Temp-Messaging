'use client'

import { useState, useEffect } from 'react'
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

function generateLinkPin(len = 14) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  return Array.from(crypto.getRandomValues(new Uint8Array(len)))
    .map(b => chars[b % chars.length]).join('')
}

async function pinToRoomId(pin) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('whispr-pin-v1:' + pin))
  return btoa(String.fromCharCode(...new Uint8Array(buf).slice(0, 12)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

export default function Home() {
  const router = useRouter()

  // ── Main (PIN-link) chat ──────────────────────────────────────────────────
  const [usePassword, setUsePassword] = useState(false)
  const [password, setPassword] = useState('')
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState(null) // { shareUrl, password, roomId, linkPin }
  const [copied, setCopied] = useState(false)
  const [copiedPw, setCopiedPw] = useState(false)

  // ── Legacy (ECDH 2-party) chat ────────────────────────────────────────────
  const [showLegacy, setShowLegacy] = useState(false)
  const [legacyUsePassword, setLegacyUsePassword] = useState(false)
  const [legacyPassword, setLegacyPassword] = useState('')
  const [legacyCreating, setLegacyCreating] = useState(false)
  const [legacyCreated, setLegacyCreated] = useState(null)
  const [legacyCopied, setLegacyCopied] = useState(false)
  const [legacyCopiedPw, setLegacyCopiedPw] = useState(false)

  // ── Manual PIN chat ───────────────────────────────────────────────────────
  const [pin, setPin] = useState('')
  const [pinError, setPinError] = useState('')
  const [joiningPin, setJoiningPin] = useState(false)

  // ── Install button (mobile only) ──────────────────────────────────────────
  const [installPrompt, setInstallPrompt] = useState(null)
  const [showInstall, setShowInstall] = useState(false)
  const [showIosHint, setShowIosHint] = useState(false)

  // ── Narrow screen detection (subtitle wrapping) ───────────────────────────
  const [isNarrow, setIsNarrow] = useState(false)

  useEffect(() => {
    const mobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)
    if (mobile) setShowInstall(true)
    const handler = e => { e.preventDefault(); setInstallPrompt(e) }
    window.addEventListener('beforeinstallprompt', handler)
    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [])

  useEffect(() => {
    const check = () => setIsNarrow(window.innerWidth < 640)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  const handleInstall = async () => {
    if (installPrompt) {
      installPrompt.prompt()
      const { outcome } = await installPrompt.userChoice
      if (outcome === 'accepted') setInstallPrompt(null)
    } else if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) {
      setShowIosHint(true)
      setTimeout(() => setShowIosHint(false), 3000)
    }
  }

  // ── Handlers: PIN-link ────────────────────────────────────────────────────
  const handleTogglePassword = (e) => {
    setUsePassword(e.target.checked)
    if (e.target.checked && !password) setPassword(generatePassword())
  }

  const createChat = async () => {
    setCreating(true)
    const linkPin = generateLinkPin()
    const roomId = await pinToRoomId(linkPin)
    let passwordHash = null
    if (usePassword && password) passwordHash = await hashPassword(password)
    await fetch('/api/create-room', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinRoomId: roomId, passwordHash }),
    })
    setCreated({ shareUrl: `${window.location.origin}/p#${linkPin}`, password: usePassword ? password : null, roomId, linkPin })
    setCreating(false)
  }

  const openChat = () => {
    sessionStorage.setItem(`whispr:${created.roomId}:pin`, created.linkPin)
    router.push(`/room/${created.roomId}#${created.linkPin}`)
  }

  const resetMain = () => { setCreated(null); setPassword(''); setUsePassword(false) }

  // ── Handlers: Legacy ──────────────────────────────────────────────────────
  const handleLegacyTogglePassword = (e) => {
    setLegacyUsePassword(e.target.checked)
    if (e.target.checked && !legacyPassword) setLegacyPassword(generatePassword())
  }

  const createLegacyRoom = async () => {
    setLegacyCreating(true)
    let passwordHash = null
    if (legacyUsePassword && legacyPassword) passwordHash = await hashPassword(legacyPassword)
    const res = await fetch('/api/create-room', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passwordHash }),
    })
    const { roomId } = await res.json()
    setLegacyCreated({ url: `${window.location.origin}/room/${roomId}`, password: legacyUsePassword ? legacyPassword : null })
    setLegacyCreating(false)
  }

  const closeLegacy = () => {
    setShowLegacy(false)
    setLegacyCreated(null)
    setLegacyPassword('')
    setLegacyUsePassword(false)
  }

  // ── Handlers: PIN ─────────────────────────────────────────────────────────
  const handlePinJoin = async () => {
    const trimmed = pin.trim()
    if (trimmed.length < 4) { setPinError('min 4 characters'); return }
    if (!/^[a-zA-Z0-9]+$/.test(trimmed)) { setPinError('letters and numbers only'); return }
    setJoiningPin(true)
    setPinError('')
    const roomId = await pinToRoomId(trimmed)
    sessionStorage.setItem(`whispr:${roomId}:pin`, trimmed)
    await fetch('/api/create-room', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinRoomId: roomId }),
    })
    router.push(`/room/${roomId}`)
  }

  const copy = async (text, setCopiedFn) => {
    await navigator.clipboard.writeText(text)
    setCopiedFn(true)
    setTimeout(() => setCopiedFn(false), 1800)
  }

  // ── Legacy view ───────────────────────────────────────────────────────────
  if (showLegacy) {
    return (
      <main style={main}>
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', width: '100%' }}>
            <div>
              <h1 style={h1}>whispr</h1>
              <p style={sub}>legacy · 2-party · ecdh encrypted</p>
            </div>
            <button onClick={closeLegacy} style={ghostBtn}>← back</button>
          </div>

          {!legacyCreated ? (
            <>
              <label style={checkLabel}>
                <input type="checkbox" checked={legacyUsePassword} onChange={handleLegacyTogglePassword} style={{ accentColor: '#444', marginRight: 8 }} />
                password protect this chat
              </label>
              {legacyUsePassword && (
                <div style={{ width: '100%' }}>
                  <p style={hint}>share this password separately, before the link.</p>
                  <div style={pwRow}>
                    <span style={pwText}>{legacyPassword}</span>
                    <button onClick={() => copy(legacyPassword, setLegacyCopiedPw)} style={smallBtn}>
                      {legacyCopiedPw ? 'copied' : 'copy'}
                    </button>
                  </div>
                </div>
              )}
              <button onClick={createLegacyRoom} disabled={legacyCreating} style={bigBtn}>
                {legacyCreating ? 'creating...' : 'create link'}
              </button>
            </>
          ) : (
            <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 14 }}>
              {legacyCreated.password && (
                <div>
                  <p style={hint}>password</p>
                  <div style={pwRow}>
                    <span style={pwText}>{legacyCreated.password}</span>
                    <button onClick={() => copy(legacyCreated.password, setLegacyCopiedPw)} style={smallBtn}>
                      {legacyCopiedPw ? 'copied' : 'copy'}
                    </button>
                  </div>
                </div>
              )}
              <div>
                <p style={hint}>chat link · expires 48h after last message</p>
                <div style={pwRow}>
                  <span style={{ ...pwText, fontSize: 11, wordBreak: 'break-all' }}>{legacyCreated.url}</span>
                  <button onClick={() => copy(legacyCreated.url, setLegacyCopied)} style={smallBtn}>
                    {legacyCopied ? 'copied' : 'copy'}
                  </button>
                </div>
              </div>
              <button onClick={() => router.push(legacyCreated.url)} style={bigBtn}>open chat →</button>
              <button onClick={() => { setLegacyCreated(null); setLegacyPassword(''); setLegacyUsePassword(false) }} style={ghostBtn}>
                create another
              </button>
            </div>
          )}
        </div>
        <p style={footer}>messages are encrypted in your browser · the server never sees them</p>
        {showInstall && <InstallBtn onInstall={handleInstall} showHint={showIosHint} />}
      </main>
    )
  }

  // ── Main view ─────────────────────────────────────────────────────────────
  return (
    <main style={main}>
      <div style={card}>
        <div style={{ width: '100%' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
            <h1 style={h1}>whispr</h1>
            <button onClick={() => setShowLegacy(true)} style={legacyBtn}>legacy link chat →</button>
          </div>
          <p style={{ ...sub, whiteSpace: isNarrow ? 'normal' : 'nowrap' }}>48h temporary · end-to-end encrypted · no logs · open source · self hostable</p>
        </div>

        {!created ? (
          <>
            <label style={checkLabel}>
              <input type="checkbox" checked={usePassword} onChange={handleTogglePassword} style={{ accentColor: '#444', marginRight: 8 }} />
              password protect this chat
            </label>
            {usePassword && (
              <div style={{ width: '100%' }}>
                <p style={hint}>share this password separately, before the link.</p>
                <div style={pwRow}>
                  <span style={pwText}>{password}</span>
                  <button onClick={() => copy(password, setCopiedPw)} style={smallBtn}>
                    {copiedPw ? 'copied' : 'copy'}
                  </button>
                </div>
              </div>
            )}
            <button onClick={createChat} disabled={creating} style={bigBtn}>
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
              <p style={hint}>share link · anyone with this opens the chat</p>
              <div style={pwRow}>
                <span style={{ ...pwText, fontSize: 11, wordBreak: 'break-all' }}>{created.shareUrl}</span>
                <button onClick={() => copy(created.shareUrl, setCopied)} style={smallBtn}>
                  {copied ? 'copied' : 'copy'}
                </button>
              </div>
            </div>
            <button onClick={openChat} style={bigBtn}>open chat →</button>
            <button onClick={resetMain} style={ghostBtn}>create another</button>
          </div>
        )}

        <div style={divider} />

        <input
          type="text"
          placeholder="create/join chat with pin"
          value={pin}
          onChange={e => { setPin(e.target.value.slice(0, 20)); setPinError('') }}
          onKeyDown={e => e.key === 'Enter' && handlePinJoin()}
          maxLength={20}
          autoComplete="off"
          spellCheck={false}
          style={pinInputStyle}
        />
        {pinError && <p style={{ margin: '0', fontSize: 11, color: '#f66' }}>{pinError}</p>}
        <button
          onClick={handlePinJoin}
          disabled={joiningPin || pin.length < 4}
          style={{ ...bigBtn, opacity: pin.length < 4 ? 0.4 : 1 }}
        >
          {joiningPin ? 'joining...' : 'join with pin →'}
        </button>
      </div>

      <p style={footer}>messages are encrypted in your browser · the server never sees them</p>
      {showInstall && <InstallBtn onInstall={handleInstall} showHint={showIosHint} />}
    </main>
  )
}

function InstallBtn({ onInstall, showHint }) {
  return (
    <div style={{ position: 'fixed', bottom: 24, left: 20, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5 }}>
      {showHint && (
        <div style={{ background: '#1e1e1e', borderRadius: 8, padding: '6px 10px', fontSize: 10, color: '#888', fontFamily: 'monospace', whiteSpace: 'nowrap', marginBottom: 4 }}>
          tap ↑ share → add to home screen
        </div>
      )}
      <button onClick={onInstall} style={{
        width: 44, height: 44, borderRadius: '50%', background: '#1e1e1e',
        border: '1px solid #2a2a2a', color: '#666', fontSize: 18, cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'monospace',
      }}>↓</button>
      <span style={{ fontSize: 9, color: '#3a3a3a', fontFamily: 'monospace', textAlign: 'center', lineHeight: 1.4 }}>
        download for{'\n'}notifications
      </span>
    </div>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────

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
const sub = { margin: 0, fontSize: 10, color: '#444' }
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
const legacyBtn = {
  background: 'none', border: 'none', color: '#2e2e2e', fontFamily: 'monospace',
  fontSize: 10, cursor: 'pointer', padding: 0, letterSpacing: 0.3, flexShrink: 0,
}
const footer = { position: 'fixed', bottom: 16, fontSize: 10, color: '#333' }
const divider = { width: '100%', height: 1, background: '#1e1e1e' }
const pinInputStyle = {
  width: '100%', background: '#1e1e1e', border: 'none', borderRadius: 12,
  padding: '13px 14px', color: '#ccc', fontFamily: 'monospace', fontSize: 14,
  outline: 'none', boxSizing: 'border-box', letterSpacing: 1,
}
