export const THEMES = {
  cosmic:    ['Nebula', 'Quasar', 'Pulsar', 'Comet', 'Eclipse', 'Zenith', 'Aether', 'Void', 'Flux', 'Nova', 'Orbit', 'Meteor'],
  cryptid:   ['Wraith', 'Specter', 'Phantom', 'Shade', 'Banshee', 'Revenant', 'Apparition', 'Poltergeist', 'Umbra'],
  'deep-sea': ['Abyssal', 'Kraken', 'Leviathan', 'Nautilus', 'Triton', 'Pelagic', 'Bathyal', 'Hadal', 'Benthic'],
  glitch:    ['Cipher', 'Daemon', 'Vector', 'Kernel', 'Null', 'Hex', 'Packet', 'Buffer', 'Stack', 'Pragma', 'Sigil'],
}

function simpleHash(str) {
  return str.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0)
}

export function deriveTheme(roomId) {
  const keys = Object.keys(THEMES)
  return keys[simpleHash(roomId) % keys.length]
}

export function deriveName(senderTag, roomId) {
  const theme = THEMES[deriveTheme(roomId)]
  return theme[simpleHash(senderTag + roomId) % theme.length]
}
