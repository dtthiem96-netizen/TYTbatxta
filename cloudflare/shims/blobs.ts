/**
 * Thay cho "@netlify/blobs" khi chạy trên Cloudflare Workers: lưu vào R2.
 *
 * Mỗi kho (getStore("attachments"), "videos", ...) là một tiền tố trong cùng
 * một bucket R2: khoá "abc" của kho "attachments" nằm ở "attachments/abc".
 * Siêu dữ liệu của Netlify Blobs là JSON tuỳ ý, còn R2 chỉ nhận chuỗi, nên toàn
 * bộ siêu dữ liệu được gói thành JSON trong một trường "nf".
 *
 * Chỉ hiện thực những gì mã gốc dùng: get, getWithMetadata, getMetadata, set,
 * setJSON, delete, list.
 */
import { currentScope, type R2BucketLike } from "../runtime";

type GetType = "arrayBuffer" | "blob" | "json" | "text" | "stream";
type Metadata = Record<string, unknown>;

const META_FIELD = "nf";

function bucket(): R2BucketLike {
  const b = currentScope().env.BLOBS;
  if (!b) throw new Error("Chưa gắn kho tệp R2 cho Worker (binding BLOBS).");
  return b;
}

function readMeta(custom?: Record<string, string>): Metadata {
  const raw = custom?.[META_FIELD];
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function toBody(value: unknown): Promise<ArrayBuffer | ArrayBufferView | string | ReadableStream> {
  if (typeof value === "string") return value;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value as ArrayBuffer | ArrayBufferView;
  if (value instanceof Blob) return value.arrayBuffer();
  if (value instanceof ReadableStream) return value;
  throw new Error("Kiểu dữ liệu không hỗ trợ khi ghi vào kho tệp.");
}

class R2Store {
  constructor(private readonly name: string) {}

  private key(key: string) {
    return `${this.name}/${key}`;
  }

  async get(key: string, options?: { type?: GetType }) {
    const obj = await bucket().get(this.key(key));
    if (!obj) return null;
    switch (options?.type) {
      case "arrayBuffer":
        return obj.arrayBuffer();
      case "blob": {
        const type = String(readMeta(obj.customMetadata).contentType || obj.httpMetadata?.contentType || "");
        return new Blob([await obj.arrayBuffer()], type ? { type } : undefined);
      }
      case "json":
        return obj.json();
      case "stream":
        return obj.body;
      default:
        return obj.text();
    }
  }

  async getWithMetadata(key: string, options?: { type?: GetType }) {
    const head = await bucket().head(this.key(key));
    if (!head) return null;
    const data = await this.get(key, options);
    if (data === null) return null;
    return { data, etag: head.etag, metadata: readMeta(head.customMetadata) };
  }

  async getMetadata(key: string) {
    const head = await bucket().head(this.key(key));
    if (!head) return null;
    return { etag: head.etag, metadata: readMeta(head.customMetadata) };
  }

  async set(key: string, value: unknown, options?: { metadata?: Metadata }) {
    const metadata = options?.metadata || {};
    const contentType = typeof metadata.contentType === "string" ? metadata.contentType : undefined;
    const res = await bucket().put(this.key(key), await toBody(value), {
      customMetadata: { [META_FIELD]: JSON.stringify(metadata) },
      httpMetadata: contentType ? { contentType } : undefined
    });
    return { modified: true, etag: res?.etag };
  }

  async setJSON(key: string, value: unknown, options?: { metadata?: Metadata }) {
    return this.set(key, JSON.stringify(value), options);
  }

  async delete(key: string) {
    await bucket().delete(this.key(key));
  }

  async list(options?: { prefix?: string }) {
    const base = `${this.name}/`;
    const prefix = base + (options?.prefix || "");
    const blobs: { key: string; etag: string }[] = [];
    let cursor: string | undefined;
    do {
      const page = await bucket().list({ prefix, cursor });
      for (const o of page.objects) blobs.push({ key: o.key.slice(base.length), etag: o.etag });
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return { blobs, directories: [] as string[] };
  }
}

export function getStore(input: string | { name: string; [k: string]: unknown }) {
  const name = typeof input === "string" ? input : input?.name;
  if (!name) throw new Error("getStore cần tên kho.");
  return new R2Store(name);
}

export function getDeployStore(input?: string | { name?: string }) {
  const name = typeof input === "string" ? input : input?.name || "deploy";
  return new R2Store(`deploy-${name}`);
}
