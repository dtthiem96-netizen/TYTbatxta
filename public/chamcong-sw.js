/* =============================================================================
   Service Worker của Phân hệ Chấm công - Chấm trực (phạm vi /chamcong).

   Chỉ giữ LỚP VỎ giao diện (trang, mã JS, logo) để ứng dụng cài trên màn hình
   chính mở được cả khi sóng yếu. Tuyệt đối KHÔNG cache /api/*: một lượt chấm
   công hay bảng công lấy từ bộ nhớ đệm là dữ liệu sai, còn tệ hơn báo mất mạng.
   Lớp vỏ luôn lấy bản mới từ mạng trước, chỉ dùng bản lưu khi mạng hỏng, nên
   sửa giao diện xong cán bộ nhận được ngay ở lần mở kế tiếp.
   ============================================================================= */
var CACHE = 'tyt-chamcong-shell-v1';
var SHELL = ['/chamcong', '/chamcong.js', '/logo.png'];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE)
      .then(function (cache) { return cache.addAll(SHELL); })
      .catch(function () { /* thiếu lớp vỏ ngoại tuyến thì phân hệ vẫn chạy bình thường */ })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys
          .filter(function (key) { return key.indexOf('tyt-chamcong-') === 0 && key !== CACHE; })
          .map(function (key) { return caches.delete(key); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.indexOf('/api/') === 0) return;

  var isPage = req.mode === 'navigate';
  if (!isPage && SHELL.indexOf(url.pathname) === -1) return;

  event.respondWith(
    fetch(req)
      .then(function (res) {
        if (res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (cache) { cache.put(isPage ? '/chamcong' : req, copy); });
        }
        return res;
      })
      .catch(function () {
        return caches.match(isPage ? '/chamcong' : req).then(function (hit) {
          return hit || new Response('Mất kết nối mạng. Vui lòng thử lại khi có sóng.', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
          });
        });
      })
  );
});
