// ═══════════════════════════════════════════════════════════════
//  은의길 플래너 — Service Worker
//  전략: Cache-First (앱 셸) + Network-First (동기화 API)
// ═══════════════════════════════════════════════════════════════

const CACHE_NAME   = 'camino-v3';
const FONT_CACHE   = 'camino-fonts-v1';
const RUNTIME_CACHE = 'camino-runtime-v1';

// 앱 셸: 설치 시 반드시 캐시할 핵심 파일
const APP_SHELL = [
  '/via-de-la-plata/',
  '/via-de-la-plata/index.html',
  '/via-de-la-plata/manifest.json'
];

// 외부 리소스 도메인 분류
const SYNC_DOMAINS   = ['api.jsonbin.io', 'api.frankfurter.app'];
const FONT_DOMAINS   = ['fonts.googleapis.com', 'fonts.gstatic.com'];

// ── 설치: 앱 셸 선점 캐시 ────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
      .catch(err => console.warn('[SW] Install failed:', err))
  );
});

// ── 활성화: 이전 캐시 정리 ─────────────────────────────────────
self.addEventListener('activate', event => {
  const VALID = [CACHE_NAME, FONT_CACHE, RUNTIME_CACHE];
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => !VALID.includes(k)).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── Fetch 전략 ──────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // 1. GET 이외 요청은 패스 (JSONBin PUT/POST 등)
  if (event.request.method !== 'GET') return;

  // 2. 동기화 API (JSONBin, 환율) → Network-First, 실패 시 무시
  if (SYNC_DOMAINS.some(d => url.hostname.includes(d))) {
    event.respondWith(networkOnly(event.request));
    return;
  }

  // 3. 구글 폰트 → Cache-First (폰트는 거의 안 바뀜)
  if (FONT_DOMAINS.some(d => url.hostname.includes(d))) {
    event.respondWith(cacheFirst(event.request, FONT_CACHE));
    return;
  }

  // 4. 앱 셸 (index.html, manifest) → Cache-First + 백그라운드 갱신
  if (url.pathname.startsWith('/via-de-la-plata')) {
    event.respondWith(staleWhileRevalidate(event.request));
    return;
  }

  // 5. 그 외 → Network-First
  event.respondWith(networkFirst(event.request));
});

// ── 전략 함수 ───────────────────────────────────────────────────

// Cache-First: 캐시 → 없으면 네트워크 → 캐시 저장
async function cacheFirst(request, cacheName) {
  const cache    = await caches.open(cacheName || CACHE_NAME);
  const cached   = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response && response.status === 200) {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Offline', { status: 503 });
  }
}

// Stale-While-Revalidate: 캐시 즉시 반환 + 백그라운드에서 네트워크 갱신
async function staleWhileRevalidate(request) {
  const cache  = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request).then(response => {
    if (response && response.status === 200) {
      cache.put(request, response.clone());
    }
    return response;
  }).catch(() => null);

  return cached || await fetchPromise || new Response('오프라인 — 앱 캐시를 불러올 수 없습니다.', {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

// Network-First: 네트워크 → 실패 시 캐시
async function networkFirst(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    const response = await fetch(request);
    if (response && response.status === 200) {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    return cached || new Response('Offline', { status: 503 });
  }
}

// Network-Only: 캐시 없이 그냥 네트워크만
async function networkOnly(request) {
  try {
    return await fetch(request);
  } catch {
    return new Response(JSON.stringify({ error: 'offline' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// ── 백그라운드 동기화 메시지 수신 ──────────────────────────────
//  인터넷 복구 시 앱에서 'SYNC_NOW' 메시지를 보내면 SW가 클라이언트에 알림
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data === 'SYNC_NOW') {
    // 모든 열린 클라이언트에 동기화 트리거 전송
    self.clients.matchAll().then(clients => {
      clients.forEach(client => client.postMessage('DO_SYNC'));
    });
  }
});
