import { getStore } from "@netlify/blobs";
import { boundStationOf, canHandleAppointments, optionalAuth, safeId, servesAllStations } from "../lib/guard.js";

/**
 * Metadata của Netlify Blobs có kiểu Record<string, unknown>, nên contentType
 * phải được kiểm tra là chuỗi trước khi đưa vào header của Response.
 */
const asMime = (value: unknown, fallback: string) =>
  typeof value === "string" && value.trim() ? value.trim().toLowerCase() : fallback;

/* Module 0: Content-Type do người tải lên tự khai không còn được tin. Chỉ các
   loại hiển thị an toàn mới mở ngay trong trình duyệt; còn lại (HTML, SVG, JS,
   ...) bị trả về dạng tải xuống application/octet-stream. Mọi tệp kèm CSP
   "sandbox" (trừ PDF - trình xem PDF của Chrome từ chối chạy trong sandbox, và
   PDF không chạy được mã của trang) để tệp không bao giờ chạy mã trên tên miền
   của trạm. */
const INLINE_SAFE = /^(application\/pdf|image\/(png|jpeg|gif|webp)|video\/(mp4|webm|ogg|quicktime)|audio\/(mpeg|mp4|ogg|webm|wav)|text\/plain)$/;
const DOWNLOAD_OK = /^application\/(msword|vnd\.openxmlformats-officedocument\.[a-z.]+|vnd\.ms-excel|vnd\.ms-powerpoint)$/;

function servedHeaders(mime: string, id: string): Record<string, string> {
  const safeName = id.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120) || "tep";
  const inline = INLINE_SAFE.test(mime);
  const type = inline || DOWNLOAD_OK.test(mime) ? mime : "application/octet-stream";
  return {
    "Content-Type": type,
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${safeName}"`,
    "X-Content-Type-Options": "nosniff",
    ...(type === "application/pdf" ? {} : { "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'" })
  };
}

/** Kho tệp chứa thông tin cá nhân/sức khoẻ (cùng tên với cms.ts). */
const PRIVATE_ATTACHMENT_STORE = "private-attachments";

/**
 * GET /api/attachment?id=...
 *
 *   1. Kho công khai "attachments" (tài liệu, hình ảnh đính kèm tin tức) và
 *      "videos": ai cũng xem/tải được, như trước Module 0. Mọi tệp đang có đều
 *      nằm ở đây nên tiếp tục mở bình thường.
 *   2. Kho riêng tư "private-attachments": bắt buộc phiếu cán bộ y tế (trạm,
 *      bác sĩ, quản trị); cán bộ điểm trạm chỉ xem tệp của trạm mình hoặc tệp
 *      chính mình tải lên. Không cache ở trình duyệt hay CDN.
 *
 * Mã tệp phải đúng định dạng (chữ, số, _ . -): mã có "../" hay ký tự lạ được
 * trả 404 như mọi mã không tồn tại, không đụng tới kho lưu trữ. Tuyến này chỉ
 * đọc: không có lối nào xoá hay ghi tệp qua đây.
 */
export default async (req: Request) => {
  const headers = {
    "Access-Control-Allow-Methods": "GET, OPTIONS"
  };
  const jsonError = (error: string, status: number, extra: Record<string, string> = {}) =>
    new Response(JSON.stringify({ error }), {
      headers: { ...headers, "Content-Type": "application/json", "Cache-Control": "no-store", ...extra },
      status
    });

  if (req.method === "OPTIONS") {
    return new Response(null, { headers, status: 204 });
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    return jsonError("Method not allowed", 405);
  }

  try {
    const url = new URL(req.url);
    const rawId = url.searchParams.get("id");
    if (!rawId) return jsonError("Missing document/file id", 400);
    const id = safeId(rawId, 200);
    if (!id) return jsonError("File not found", 404);

    const publicFile = async (storeName: string, fallbackMime: string) => {
      const store = getStore(storeName);
      const meta = await store.getMetadata(id);
      if (!meta) return null;
      const blob = await store.get(id, { type: "blob" });
      if (!blob) return null;
      return new Response(blob, {
        headers: {
          ...headers,
          ...servedHeaders(asMime(meta.metadata?.contentType, fallbackMime), id),
          "Cache-Control": "public, max-age=31536000, immutable"
        },
        status: 200
      });
    };

    const fromPublic = (await publicFile("attachments", "application/octet-stream")) || (await publicFile("videos", "video/mp4"));
    if (fromPublic) return fromPublic;

    const privateStore = getStore(PRIVATE_ATTACHMENT_STORE);
    const privateMeta = await privateStore.getMetadata(id);
    if (!privateMeta) return jsonError("File not found", 404);

    const ctx = await optionalAuth(req);
    if (!ctx) return jsonError("Vui lòng đăng nhập để xem tệp này.", 401);
    const owner = String(privateMeta.metadata?.uploadedBy || "");
    const station = String(privateMeta.metadata?.stationCode || "").toUpperCase();
    const allowed =
      canHandleAppointments(ctx) &&
      (servesAllStations(ctx) || owner === ctx.user.id || (station !== "" && station === boundStationOf(ctx)));
    if (!allowed) return jsonError("Tài khoản không có quyền xem tệp này.", 403);

    const blob = await privateStore.get(id, { type: "blob" });
    if (!blob) return jsonError("File not found", 404);
    return new Response(blob, {
      headers: {
        ...headers,
        ...servedHeaders(asMime(privateMeta.metadata?.contentType, "application/octet-stream"), id),
        "Cache-Control": "private, no-store"
      },
      status: 200
    });
  } catch (err: any) {
    console.error("file error", err?.name || "Error");
    return jsonError("Không đọc được tệp.", 500);
  }
};

export const config = {
  path: "/api/attachment",
};
