import { getStore } from "@netlify/blobs";

/**
 * Metadata của Netlify Blobs có kiểu Record<string, unknown>, nên contentType
 * phải được kiểm tra là chuỗi trước khi đưa vào header của Response.
 */
const asMime = (value: unknown, fallback: string) =>
  typeof value === "string" && value.trim() ? value : fallback;

export default async (req: Request) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS"
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { headers, status: 204 });
  }

  try {
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
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
      "Content-Type": mimeType,
      "Cache-Control": "public, max-age=31536000, immutable",
    };

    return new Response(blob, { headers: responseHeaders, status: 200 });
  } catch (err: any) {
    console.error(err);
    return new Response(JSON.stringify({ error: err.message }), {
      headers: { ...headers, "Content-Type": "application/json" },
      status: 500
    });
  }
};

export const config = {
  path: "/api/video",
};
