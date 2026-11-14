// Service worker: เก็บไฟล์แอปไว้ในเครื่อง เปิดออฟไลน์ได้หลังเปิดครั้งแรก
// เปลี่ยนเลข VERSION ทุกครั้งที่แก้ไฟล์ เพื่อให้เครื่องที่ติดตั้งไว้อัปเดตตาม
const VERSION = 'noise-meter-v1';
const FILES = [
  './', './index.html', './style.css', './app.js',
  './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// เครือข่ายก่อน (ได้ไฟล์ใหม่เสมอเมื่อมีเน็ต) ถ้าล้มเหลวใช้ของที่เก็บไว้
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok && new URL(e.request.url).origin === location.origin) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('./index.html')))
  );
});
