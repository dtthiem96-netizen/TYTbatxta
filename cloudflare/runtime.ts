/**
 * Ngữ cảnh chạy của bản Cloudflare Workers.
 *
 * Mã máy chủ gốc được viết cho Netlify Functions: mỗi tệp trong
 * netlify/functions là một hàm (req: Request) => Response, đọc cấu hình qua
 * process.env, đọc/ghi tệp qua @netlify/blobs và truy vấn cơ sở dữ liệu qua
 * db/index.ts (drizzle-orm/netlify-db). Bản Cloudflare giữ nguyên toàn bộ mã đó
 * và chỉ thay ba chỗ nối bằng lớp đệm (cloudflare/shims):
 *
 *   - @netlify/blobs          -> kho R2 (binding BLOBS)
 *   - drizzle-orm/netlify-db  -> drizzle + postgres.js, qua Hyperdrive (binding
 *                                HYPERDRIVE) hoặc chuỗi kết nối DATABASE_URL
 *   - process.env             -> biến và khoá bí mật của Worker (nodejs_compat)
 *
 * Workers không cho dùng lại một kết nối mạng (socket) giữa hai lượt yêu cầu,
 * nên kết nối cơ sở dữ liệu phải thuộc về TỪNG lượt yêu cầu. AsyncLocalStorage
 * giữ ngữ cảnh của lượt đang chạy để các lớp đệm tìm đúng kết nối của lượt đó,
 * trong khi mã gốc vẫn dùng chung một đối tượng `db` như trên Netlify.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import postgres from "postgres";

export interface Env {
  ASSETS: { fetch(input: Request | string): Promise<Response> };
  BLOBS?: R2BucketLike;
  HYPERDRIVE?: { connectionString: string };
  DATABASE_URL?: string;
  [key: string]: unknown;
}

/** Phần nhỏ của R2Bucket mà lớp đệm Blobs dùng tới. */
export interface R2ObjectLike {
  key: string;
  etag: string;
  size: number;
  customMetadata?: Record<string, string>;
  httpMetadata?: { contentType?: string };
}
export interface R2ObjectBodyLike extends R2ObjectLike {
  body: ReadableStream;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
}
export interface R2BucketLike {
  get(key: string): Promise<R2ObjectBodyLike | null>;
  head(key: string): Promise<R2ObjectLike | null>;
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | string | ReadableStream | Blob,
    options?: { customMetadata?: Record<string, string>; httpMetadata?: { contentType?: string } }
  ): Promise<R2ObjectLike | null>;
  delete(key: string | string[]): Promise<void>;
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{
    objects: R2ObjectLike[];
    truncated: boolean;
    cursor?: string;
  }>;
}

export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

interface RequestScope {
  env: Env;
  ctx: ExecutionContextLike;
  sql?: postgres.Sql;
  /** Phiên drizzle đã dựng trong lượt này, theo cấu hình gọi drizzle(). */
  dbs: Map<unknown, unknown>;
}

const scopes = new AsyncLocalStorage<RequestScope>();

export function currentScope(): RequestScope {
  const scope = scopes.getStore();
  if (!scope) {
    throw new Error("Không có ngữ cảnh yêu cầu Cloudflare: lớp đệm bị gọi ngoài runInScope().");
  }
  return scope;
}

/** Chạy fn trong ngữ cảnh của một lượt yêu cầu, đóng kết nối cơ sở dữ liệu sau khi xong. */
export async function runInScope<T>(env: Env, ctx: ExecutionContextLike, fn: () => Promise<T>): Promise<T> {
  const scope: RequestScope = { env, ctx, dbs: new Map() };
  try {
    return await scopes.run(scope, fn);
  } finally {
    const sql = scope.sql;
    scope.sql = undefined;
    if (sql) ctx.waitUntil(sql.end({ timeout: 5 }).catch(() => {}));
  }
}

/** Chuỗi kết nối Postgres: ưu tiên Hyperdrive (có gộp kết nối), rồi DATABASE_URL. */
export function databaseUrl(env: Env): string {
  return String(env.HYPERDRIVE?.connectionString || env.DATABASE_URL || "").trim();
}

/** Kết nối postgres.js của lượt yêu cầu hiện tại, tạo lần đầu khi có truy vấn. */
export function requestSql(): postgres.Sql {
  const scope = currentScope();
  if (scope.sql) return scope.sql;

  const url = databaseUrl(scope.env);
  if (!url) {
    throw new Error(
      "Chưa cấu hình cơ sở dữ liệu cho Worker: gắn Hyperdrive (binding HYPERDRIVE) "
        + "hoặc thêm khoá bí mật DATABASE_URL trong Cloudflare."
    );
  }
  const viaHyperdrive = Boolean(scope.env.HYPERDRIVE?.connectionString);
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  scope.sql = postgres(url, {
    max: 5,
    // Hyperdrive tự lo TLS tới máy chủ gốc; kết nối thẳng thì bắt buộc TLS.
    ssl: viaHyperdrive || local ? false : "require",
    // Bộ gộp kết nối kiểu PgBouncer (Supabase, Neon) không giữ được câu lệnh
    // chuẩn bị sẵn giữa các giao dịch; Hyperdrive thì hỗ trợ.
    prepare: viaHyperdrive,
    fetch_types: false,
    connect_timeout: 10,
    idle_timeout: 5
  });
  return scope.sql;
}
