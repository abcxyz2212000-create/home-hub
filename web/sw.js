// Service worker: offline app shell + Web Push display.
// Bump CACHE when the list of files changes.
const CACHE = 'homehub-v5';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/config.js', 'js/supabase.js', 'js/schema.js', 'js/events.js', 'js/validate.js',
  'js/csv.js', 'js/zip.js', 'js/image.js', 'js/push.js', 'js/icons.js', 'js/charts.js', 'js/chores.js', 'js/shared.js', 'icons/icon-192.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Network first for the app's own files (so updates appear immediately), cache as offline fallback.
// Supabase requests (other origin) are never cached.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(fetch(event.request)
    .then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(event.request, copy));
      }
      return res;
    })
    .catch(() => caches.match(event.request, { ignoreSearch: true }).then((hit) => hit || caches.match('index.html'))));
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(self.registration.showNotification(data.title || '家の管理ハブ', {
    body: data.body || '',
    tag: data.tag || undefined,
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    data: { url: typeof data.url === 'string' && data.url.startsWith('#/') ? data.url : '#/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(self.registration.scope).href + event.notification.data.url;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) {
      if (c.url.startsWith(self.registration.scope) && 'focus' in c) {
        c.navigate(target);
        return c.focus();
      }
    }
    return self.clients.openWindow(target);
  }));
});
