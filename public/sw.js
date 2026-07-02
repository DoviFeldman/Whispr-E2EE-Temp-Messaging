self.addEventListener('install', e => e.waitUntil(self.skipWaiting()))
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()))

self.addEventListener('push', e => {
  const data = e.data?.json?.() ?? {}
  e.waitUntil((async () => {
    // Skip the notification if the room is already open and visible
    const url = data.url || '/'
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    if (wins.some(w => w.visibilityState === 'visible' && w.url.includes(url))) return
    await self.registration.showNotification(data.title || 'whispr', {
      body: data.body || 'new message',
      icon: '/icon',
      badge: '/icon',
      tag: data.roomId || 'whispr',
      data: { url },
      silent: false,
    })
  })())
})

self.addEventListener('notificationclick', e => {
  e.notification.close()
  const url = e.notification.data?.url || '/'
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes(url) && 'focus' in client) return client.focus()
      }
      if (clients.openWindow) return clients.openWindow(url)
    })
  )
})
