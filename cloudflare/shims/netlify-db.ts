/**
 * Thay cho "drizzle-orm/netlify-db" khi chạy trên Cloudflare Workers.
 *
 * db/index.ts gọi drizzle({ schema }) MỘT lần rồi giữ lại dùng mãi. Trên Workers
 * kết nối phải thuộc về từng lượt yêu cầu, nên ở đây trả về một Proxy: mỗi lần mã
 * gốc chạm vào db.select / db.insert / db.transaction..., Proxy tìm (hoặc dựng)
 * phiên drizzle của lượt yêu cầu đang chạy trên kết nối postgres.js của lượt đó.
 */
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { currentScope, requestSql } from "../runtime";

type Config = { schema?: Record<string, unknown> } & Record<string, unknown>;

export function drizzle(config: Config = {}) {
  const key = config;
  const resolve = (): Record<string | symbol, unknown> => {
    const scope = currentScope();
    let instance = scope.dbs.get(key) as Record<string | symbol, unknown> | undefined;
    if (!instance) {
      // Bản drizzle-orm 1.0 beta nhận { client, ...cấu hình } - giữ nguyên cấu hình
      // mà db/index.ts đã trao cho adapter Netlify (schema, ...).
      instance = drizzlePostgres({ ...(config as any), client: requestSql() }) as unknown as Record<string | symbol, unknown>;
      scope.dbs.set(key, instance);
    }
    return instance;
  };

  return new Proxy({}, {
    get(_target, prop) {
      const instance = resolve();
      const value = instance[prop];
      return typeof value === "function" ? (value as Function).bind(instance) : value;
    },
    has(_target, prop) {
      return prop in resolve();
    }
  }) as any;
}
