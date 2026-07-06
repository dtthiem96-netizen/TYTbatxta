import { getStore } from "@netlify/blobs";

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
      return new Response(JSON.stringify({ error: "Missing document/file id" }), {
        headers: { ...headers, "Content-Type": "application/json" },
        status: 400
      });
    }

    const store = getStore("attachments");
    const metadata = await store.getMetadata(id);
    if (!metadata) {
      // Fallback to videos store in case of video IDs being requested here
      const videoStore = getStore("videos");
      const videoMeta = await videoStore.getMetadata(id);
      if (videoMeta) {
        const videoBlob = await videoStore.get(id, { type: "blob" });
        if (videoBlob) {
          return new Response(videoBlob, {
            headers: {
              ...headers,
              "Content-Type": videoMeta.metadata?.contentType || "video/mp4",
              "Cache-Control": "public, max-age=31536000, immutable"
            },
            status: 200
          });
        }
      }
      return new Response(JSON.stringify({ error: "File not found" }), {
        headers: { ...headers, "Content-Type": "application/json" },
        status: 404
      });
    }

    const mimeType = metadata.metadata?.contentType || "application/octet-stream";
    const blob = await store.get(id, { type: "blob" });
    if (!blob) {
      return new Response(JSON.stringify({ error: "File empty" }), {
        headers: { ...headers, "Content-Type": "application/json" },
        status: 404
      });
    }

    const responseHeaders = {
      ...headers,
      "Content-Type": mimeType,
      "Content-Disposition": `inline; filename="${id}"`,
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
  path: "/api/attachment",
};
