import { getStore } from "@netlify/blobs";
import { safeId } from "../lib/guard.js";

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

export default async (req: Request) => {
  const headers = {
    "Access-Control-Allow-Methods": "GET, OPTIONS"
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { headers, status: 204 });
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      headers: { ...headers, "Content-Type": "application/json" },
      status: 405
    });
  }

  try {
    const url = new URL(req.url);
    const rawId = url.searchParams.get("id");
    // Mã video sai định dạng (có "../", ký tự lạ) được coi như không tồn tại.
    const id = rawId ? safeId(rawId, 200) : "";
    if (rawId && !id) {
      return new Response(JSON.stringify({ error: "Video not found" }), {
        headers: { ...headers, "Content-Type": "application/json" },
        status: 404
      });
    }
    if (!id) {
      return new Response(JSON.stringify({ error: "Missing video id" }), {
        headers: { ...headers, "Content-Type": "application/json" },
        status: 400
      });
    }

    const store = getStore("videos");
    const metadata = await store.getMetadata(id);
    if (!metadata) {
      return new Response(JSON.stringify({ error: "Video not found" }), {
        headers: { ...headers, "Content-Type": "application/json" },
        status: 404
      });
    }

    const mimeType = asMime(metadata.metadata?.contentType, "video/mp4");
    const blob = await store.get(id, { type: "blob" });
    if (!blob) {
      return new Response(JSON.stringify({ error: "Video file empty" }), {
        headers: { ...headers, "Content-Type": "application/json" },
        status: 404
      });
    }

    const responseHeaders = {
      ...headers,
      ...servedHeaders(mimeType, id),
      "Cache-Control": "public, max-age=31536000, immutable",
    };

    return new Response(blob, { headers: responseHeaders, status: 200 });
  } catch (err: any) {
    console.error("file error", err?.name || "Error");
    return new Response(JSON.stringify({ error: "Không đọc được tệp." }), {
      headers: { ...headers, "Content-Type": "application/json" },
      status: 500
    });
  }
};

export const config = {
  path: "/api/video",
};
