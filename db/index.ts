/**
 * Máy khách cơ sở dữ liệu (Netlify Database + Drizzle ORM).
 *
 * Khởi tạo kiểu TRỄ (lazy) là điều cố ý. drizzle({ schema }) NÉM LỖI ngay tại
 * lời gọi nếu biến môi trường NETLIFY_DB_URL trống. Gọi nó ở cấp mô-đun nghĩa là
 * cả tệp function không nạp được, và MỌI tuyến đường trong tệp đó trả về 500 kèm
 * vết ngăn xếp - kể cả những tuyến không hề chạm tới cơ sở dữ liệu (ví dụ các
 * tuyến đọc/ghi Netlify Blobs trong cms.ts).
 *
 * Với proxy bên dưới, kết nối chỉ được tạo ở lần truy vấn đầu tiên:
 *   - Tuyến không dùng cơ sở dữ liệu vẫn chạy bình thường.
 *   - Tuyến có dùng thì nhận một lỗi ghi rõ nguyên nhân, bắt được bằng try/catch.
 *   - Khi cơ sở dữ liệu của site được bật lại và NETLIFY_DB_URL xuất hiện, mã tự
 *     hoạt động đúng trở lại: biến môi trường được đọc lúc chạy, không phải lúc
 *     đóng gói, nên không cần sửa hay triển khai lại gì thêm.
 */
import { drizzle } from "drizzle-orm/netlify-db";
import * as schema from "./schema.js";

const createClient = () => drizzle({ schema });
type Client = ReturnType<typeof createClient>;

/** Chuẩn hoá chuỗi kết nối trước khi trao cho driver. */
function normalizeConnectionString(): void {
  const raw = process.env.NETLIFY_DB_URL;
  if (!raw) return;

  try {
    const url = new URL(raw);

    // Cơ sở dữ liệu chạy tại máy: dùng driver postgres thường, không WebSocket.
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      process.env.NETLIFY_DB_DRIVER = "server";
      if (!url.username) {
        url.username = "postgres";
      }
      process.env.NETLIFY_DB_URL = url.toString();
    } else {
      url.searchParams.delete("channel_binding");
      url.searchParams.delete("sslmode");
      process.env.NETLIFY_DB_URL = url.toString();
    }
  } catch (e) {
    console.error("Failed to parse NETLIFY_DB_URL:", e);
  }
}

let client: Client | null = null;

function getClient(): Client {
  if (client) return client;

  normalizeConnectionString();
  if (!process.env.NETLIFY_DB_URL) {
    throw new Error(
      "Netlify Database chưa sẵn dùng: biến môi trường NETLIFY_DB_URL trống. "
        + 'Bật lại cơ sở dữ liệu cho site, rồi thêm "@netlify/database" vào '
        + "dependencies trong package.json để bước cấp phát của bản dựng cung "
        + "cấp chuỗi kết nối.",
    );
  }

  client = createClient();
  return client;
}

export const db: Client = new Proxy({} as Client, {
  get(_target, prop) {
    const instance = getClient() as unknown as Record<string | symbol, unknown>;
    const value = instance[prop];
    return typeof value === "function" ? value.bind(instance) : value;
  },
});

export * as schema from "./schema.js";
