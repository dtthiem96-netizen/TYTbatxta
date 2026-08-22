/*
 * Service Worker - thông báo cuộc gọi khám từ xa theo điểm trạm.
 *
 * Nhiệm vụ duy nhất của tệp này là hiện thông báo hệ thống khi máy chủ gõ cửa,
 * kể cả lúc trình duyệt đã đóng tab Bảng điều khiển. Ở đây KHÔNG có bộ nhớ đệm
 * ngoại tuyến: trang chính vẫn tải thẳng từ mạng như trước, thêm việc đệm tài
 * nguyên sẽ làm một tính năng thông báo trở thành nguồn gốc của lỗi "sao trang
 * không cập nhật" - cái giá quá đắt cho thứ không ai yêu cầu.
 *
 * Bản tin đẩy tới đây là bản tin RỖNG (xem netlify/lib/push.ts). Nội dung hiển
 * thị được lấy về ngay lúc nhận, nên thông tin luôn là mới nhất và không có dữ
 * liệu khám chữa bệnh nào đi qua máy chủ đẩy của bên thứ ba.
 */

const TOKEN_CACHE = "tyt-notify-token-v1";
const TOKEN_KEY = "https://tyt.local/notify-token";
const PANEL_URL = "/tram";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

/*
 * Phiếu đăng nhập do trang chính gửi sang.
 *
 * Service Worker không đọc được localStorage, mà lượt hỏi chi tiết cuộc gọi thì
 * bắt buộc phải có danh tính. Trang chính gửi phiếu qua postMessage; ở đây cất
 * vào Cache Storage (cùng gốc, giống phạm vi bảo vệ của localStorage) để phiếu
 * còn nguyên sau khi Service Worker bị hệ điều hành tắt đi rồi đánh thức lại.
 */
self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "AUTH_TOKEN") {
    event.waitUntil(
      caches
        .open(TOKEN_CACHE)
        .then((cache) => cache.put(TOKEN_KEY, new Response(String(data.token || ""))))
    );
  }
  if (data.type === "CLEAR_TOKEN") {
    event.waitUntil(caches.delete(TOKEN_CACHE));
  }
});

async function readToken() {
  try {
    const cache = await caches.open(TOKEN_CACHE);
    const hit = await cache.match(TOKEN_KEY);
    if (!hit) return "";
    return (await hit.text()).trim();
  } catch (err) {
    return "";
  }
}

/** Hỏi máy chủ xem đang có cuộc gọi nào đổ chuông tới tài khoản này. */
async function pendingCalls() {
  const token = await readToken();
  if (!token) return [];
  try {
    const res = await fetch("/api/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: "pending" })
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.calls) ? data.calls : [];
  } catch (err) {
    return [];
  }
}

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      const calls = await pendingCalls();

      /* Không lấy được chi tiết (phiếu hết hạn, mất mạng, hoặc cuộc gọi vừa được
         người khác nhận) thì vẫn phải hiện một thông báo tối giản: im lặng nuốt
         mất bản tin còn tệ hơn, vì cán bộ sẽ không biết là có người đang gọi. */
      if (!calls.length) {
        await self.registration.showNotification("Có cuộc gọi khám từ xa", {
          body: "Mở Bảng điều khiển điểm trạm để xem chi tiết.",
          icon: "/logo.png",
          badge: "/logo.png",
          tag: "tyt-call-generic",
          requireInteraction: true,
          data: { url: PANEL_URL }
        });
        return;
      }

      const call = calls[0];
      const extra = calls.length > 1 ? ` (+${calls.length - 1} cuộc gọi khác đang chờ)` : "";
      await self.registration.showNotification(
        call.escalated ? "⚠ Cuộc gọi chưa ai tiếp nhận" : "📞 Cuộc gọi khám từ xa",
        {
          body: `${call.patientName} đang gọi tới ${call.stationName || call.stationCode}.${extra}`,
          icon: "/logo.png",
          badge: "/logo.png",
          // Cùng một cuộc gọi chỉ chiếm một chỗ trên khay thông báo dù đẩy nhiều lần.
          tag: `tyt-call-${call.roomId}`,
          renotify: true,
          requireInteraction: true,
          vibrate: [200, 100, 200, 100, 200],
          data: { url: `${PANEL_URL}?call=${encodeURIComponent(call.roomId)}`, roomId: call.roomId }
        }
      );
    })()
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || PANEL_URL;

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // Đã có tab Bảng điều khiển đang mở thì đưa tab đó lên chứ không mở thêm tab mới.
      for (const client of windows) {
        if (client.url.includes("/tram") || client.url.includes("/bacsi")) {
          await client.focus();
          client.postMessage({ type: "OPEN_CALL", roomId: event.notification.data?.roomId || "" });
          return;
        }
      }
      await self.clients.openWindow(target);
    })()
  );
});
