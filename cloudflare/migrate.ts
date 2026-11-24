/**
 * /api/migrate - chép dữ liệu từ Netlify sang Cloudflare, chạy một lần.
 *
 * Chỉ bật khi Worker có khoá bí mật MIGRATE_KEY (người quản trị tự đặt trong
 * Cloudflare); thiếu khoá thì trả 404 như một đường dẫn không tồn tại. Không
 * dùng tài khoản CMS để xác thực vì lúc chép, cơ sở dữ liệu mới còn trống.
 *
 * Trang /chuyen-du-lieu.html gọi lần lượt các bước, mỗi lượt gọi làm một phần
 * nhỏ để vừa giới hạn thời gian xử lý của Workers:
 *
 *   status        đếm số dòng từng bảng ở nguồn và đích, cho biết thiếu cấu hình gì
 *   schema        dựng bảng trên cơ sở dữ liệu mới theo netlify/database/migrations
 *   plan          danh sách bảng theo thứ tự khoá ngoại (bảng cha trước)
 *   reset         xoá dữ liệu gieo sẵn do bản di trú tạo ở đích (ví dụ tài khoản
 *                 quản trị mặc định), để bản chép từ nguồn là bản duy nhất
 *   copy          chép một trang (tối đa PAGE dòng) của một bảng
 *   sequences     đặt lại bộ đếm tự tăng theo giá trị lớn nhất đã chép
 *   blob-stores   các kho tệp trên Netlify Blobs
 *   blob-list     một trang khoá trong một kho
 *   blob-copy     chép vài tệp từ Netlify Blobs sang R2
 *
 * Nguồn: khoá bí mật SOURCE_DATABASE_URL (chuỗi kết nối Netlify Database),
 * NETLIFY_TOKEN + NETLIFY_SITE_ID (đọc Netlify Blobs). Đích: cơ sở dữ liệu và
 * kho R2 của Worker.
 */
import postgres from "postgres";
import { currentScope, requestSql } from "./runtime";
import { MIGRATIONS } from "./generated/migrations";

const PAGE = 300;
const TRACKING_TABLE = "cf_schema_migrations";
/** Đổi được qua NETLIFY_API_URL chỉ để thử với máy chủ giả lập. */
const netlifyBlobsApi = () => `${env("NETLIFY_API_URL") || "https://api.netlify.com"}/api/v1/blobs`;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });

function env(name: string): string {
  return String(currentScope().env[name] ?? "").trim();
}

/** So sánh chuỗi không lộ thời gian (tránh dò khoá theo độ trễ). */
function sameSecret(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

const ident = (name: string) => `"${String(name).replace(/"/g, '""')}"`;

/**
 * Chuỗi kết nối Netlify Database. Giao diện Netlify không phải lúc nào cũng hiện
 * nút sao chép (ví dụ khi trang đang bị tạm dừng), nên nếu không có khoá
 * SOURCE_DATABASE_URL thì tự hỏi Netlify API bằng NETLIFY_TOKEN: người quản trị
 * chỉ cần một mã truy cập Netlify, không phải tự chép chuỗi chứa mật khẩu.
 */
async function sourceUrl(): Promise<string> {
  const direct = env("SOURCE_DATABASE_URL");
  if (direct) return direct;
  const token = env("NETLIFY_TOKEN");
  const site = env("NETLIFY_SITE_ID");
  if (!token || !site) {
    throw new Error("Chưa có NETLIFY_TOKEN và NETLIFY_SITE_ID (hoặc SOURCE_DATABASE_URL) để đọc Netlify Database.");
  }
  const base = env("NETLIFY_API_URL") || "https://api.netlify.com";
  const res = await fetch(`${base}/api/v1/sites/${site}/database`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403
      ? "mã truy cập Netlify sai hoặc không đủ quyền"
      : res.status === 404 ? "không tìm thấy cơ sở dữ liệu của site (kiểm tra NETLIFY_SITE_ID)" : "Netlify chưa trả lời được";
    throw new Error(`Netlify API trả ${res.status}: ${hint}.`);
  }
  const data = await res.json() as Record<string, unknown>;
  const url = String(data.connection_string || data.connectionString || "");
  if (!url) throw new Error("Netlify API không trả chuỗi kết nối (cơ sở dữ liệu có thể đang bị tắt).");
  return url;
}

async function sourceSql(): Promise<postgres.Sql> {
  const url = await sourceUrl();
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  return postgres(url, { max: 1, ssl: local ? false : "require", prepare: false, fetch_types: false, connect_timeout: 15 });
}

async function withSource<T>(fn: (src: postgres.Sql) => Promise<T>): Promise<T> {
  const src = await sourceSql();
  try {
    return await fn(src);
  } finally {
    currentScope().ctx.waitUntil(src.end({ timeout: 5 }).catch(() => {}));
  }
}

/** Bảng trong schema public của một cơ sở dữ liệu, xếp bảng cha trước bảng con. */
async function orderedTables(sql: postgres.Sql): Promise<string[]> {
  const tables = (await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> ${TRACKING_TABLE}
    ORDER BY table_name`).map((r) => String(r.table_name));
  const edges = await sql`
    SELECT tc.table_name AS child, ccu.table_name AS parent
    FROM information_schema.table_constraints tc
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'`;
  const parents = new Map<string, Set<string>>(tables.map((t) => [t, new Set<string>()]));
  for (const e of edges) {
    const child = String(e.child);
    const parent = String(e.parent);
    if (child !== parent && parents.has(child) && parents.has(parent)) parents.get(child)!.add(parent);
  }
  const ordered: string[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();
  const visit = (t: string) => {
    if (done.has(t) || visiting.has(t)) return;
    visiting.add(t);
    for (const p of parents.get(t) || []) visit(p);
    visiting.delete(t);
    done.add(t);
    ordered.push(t);
  };
  tables.forEach(visit);
  return ordered;
}

async function primaryKey(sql: postgres.Sql, table: string): Promise<string[]> {
  const rows = await sql`
    SELECT kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    WHERE tc.table_schema = 'public' AND tc.table_name = ${table} AND tc.constraint_type = 'PRIMARY KEY'
    ORDER BY kcu.ordinal_position`;
  return rows.map((r) => String(r.column_name));
}

async function countRows(sql: postgres.Sql, table: string): Promise<number | null> {
  try {
    const [row] = await sql.unsafe(`SELECT count(*)::int AS n FROM ${ident(table)}`);
    return Number(row.n);
  } catch {
    return null;
  }
}

async function status() {
  const scope = currentScope();
  const config = {
    target: Boolean(scope.env.HYPERDRIVE || env("DATABASE_URL")),
    source: Boolean(env("SOURCE_DATABASE_URL") || (env("NETLIFY_TOKEN") && env("NETLIFY_SITE_ID"))),
    blobsSource: Boolean(env("NETLIFY_TOKEN") && env("NETLIFY_SITE_ID")),
    blobsTarget: Boolean(scope.env.BLOBS)
  };
  const out: Record<string, unknown> = { config, migrations: MIGRATIONS.length };
  if (config.target) {
    const sql = requestSql();
    const [t] = await sql`SELECT to_regclass(${"public." + TRACKING_TABLE}) IS NOT NULL AS ok`;
    out.appliedMigrations = t.ok ? Number((await sql.unsafe(`SELECT count(*)::int AS n FROM ${ident(TRACKING_TABLE)}`))[0].n) : 0;
    const tables = await orderedTables(sql);
    const counts: Record<string, { target: number | null; source?: number | null }> = {};
    for (const table of tables) counts[table] = { target: await countRows(sql, table) };
    if (config.source) {
      await withSource(async (src) => {
        for (const table of tables) counts[table].source = await countRows(src, table);
      });
    }
    out.tables = counts;
  }
  return out;
}

async function applySchema() {
  const sql = requestSql();
  await sql.unsafe(`CREATE TABLE IF NOT EXISTS ${ident(TRACKING_TABLE)} (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await sql.unsafe(`SELECT name FROM ${ident(TRACKING_TABLE)}`)).map((r) => String(r.name)));
  const applied: string[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.name)) continue;
    await sql.begin(async (tx) => {
      await tx.unsafe(m.sql);
      await tx.unsafe(`INSERT INTO ${ident(TRACKING_TABLE)} (name) VALUES ($1)`, [m.name]);
    });
    applied.push(m.name);
  }
  return { applied, total: MIGRATIONS.length };
}

async function resetTarget() {
  const sql = requestSql();
  const tables = (await orderedTables(sql)).reverse();
  const skipped: string[] = [];
  for (const table of tables) {
    try {
      await sql.unsafe(`DELETE FROM ${ident(table)}`);
    } catch (err) {
      // Bảng nhật ký chấm công chặn xoá bằng trigger; lúc này chúng vẫn trống.
      skipped.push(`${table}: ${(err as Error).message.slice(0, 120)}`);
    }
  }
  return { cleared: tables.length - skipped.length, skipped };
}

async function copyPage(table: string, offset: number) {
  const sql = requestSql();
  const tables = await orderedTables(sql);
  if (!tables.includes(table)) throw new Error(`Bảng ${table} không có ở cơ sở dữ liệu mới. Chạy bước dựng bảng trước.`);
  const pk = await primaryKey(sql, table);
  const order = pk.length ? pk.map(ident).join(", ") : "ctid";
  return withSource(async (src) => {
    // Dữ liệu đi qua dạng JSON văn bản: Postgres tự đổi kiểu ở cả hai đầu, Worker
    // không phải phân tích từng dòng (đỡ thời gian xử lý).
    const [page] = await src.unsafe(
      `SELECT count(*)::int AS n, coalesce(json_agg(t), '[]'::json)::text AS rows
       FROM (SELECT * FROM ${ident(table)} ORDER BY ${order} LIMIT ${PAGE} OFFSET ${Math.max(0, Math.floor(offset))}) t`
    );
    const n = Number(page.n);
    if (n > 0) {
      await sql.unsafe(
        `INSERT INTO ${ident(table)} OVERRIDING SYSTEM VALUE
         SELECT * FROM json_populate_recordset(NULL::${ident(table)}, $1::text::json)
         ON CONFLICT DO NOTHING`,
        [String(page.rows)]
      );
    }
    return { table, copied: n, nextOffset: offset + n, done: n < PAGE };
  });
}

async function fixSequences() {
  const sql = requestSql();
  const cols = await sql`
    SELECT table_name, column_name, pg_get_serial_sequence(quote_ident(table_name), column_name) AS seq
    FROM information_schema.columns
    WHERE table_schema = 'public' AND pg_get_serial_sequence(quote_ident(table_name), column_name) IS NOT NULL`;
  const fixed: string[] = [];
  for (const c of cols) {
    await sql.unsafe(
      `SELECT setval($1, coalesce((SELECT max(${ident(String(c.column_name))}) FROM ${ident(String(c.table_name))}), 0) + 1, false)`,
      [String(c.seq)]
    );
    fixed.push(`${c.table_name}.${c.column_name}`);
  }
  return { fixed };
}

/* ---------------- Netlify Blobs -> R2 ---------------- */

function netlifyAuth() {
  const token = env("NETLIFY_TOKEN");
  const site = env("NETLIFY_SITE_ID");
  if (!token || !site) throw new Error("Chưa có khoá bí mật NETLIFY_TOKEN và NETLIFY_SITE_ID để đọc tệp trên Netlify.");
  return { token, site };
}

async function netlifyGet(path: string, accept?: string) {
  const { token, site } = netlifyAuth();
  const res = await fetch(`${netlifyBlobsApi()}/${site}${path}`, {
    headers: { authorization: `Bearer ${token}`, ...(accept ? { accept } : {}) }
  });
  return res;
}

async function blobStores() {
  const stores: string[] = [];
  let cursor = "";
  for (let i = 0; i < 20; i++) {
    const res = await netlifyGet(`?prefix=site:${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    if (res.status === 404) break;
    if (!res.ok) throw new Error(`Netlify Blobs trả ${res.status} khi liệt kê kho.`);
    const page = await res.json() as { stores?: string[]; next_cursor?: string };
    for (const s of page.stores || []) stores.push(s.startsWith("site:") ? s.slice(5) : s);
    if (!page.next_cursor) break;
    cursor = page.next_cursor;
  }
  // Kho *-chunks chỉ chứa mảnh tải lên dở dang: không cần chép.
  return { stores: stores.filter((s) => !s.endsWith("-chunks")) };
}

async function blobList(store: string, cursor: string) {
  const res = await netlifyGet(`/site:${store}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
  if (res.status === 404) return { keys: [], cursor: "" };
  if (!res.ok) throw new Error(`Netlify Blobs trả ${res.status} khi liệt kê kho ${store}.`);
  const page = await res.json() as { blobs?: { key: string }[]; next_cursor?: string };
  return { keys: (page.blobs || []).map((b) => b.key), cursor: page.next_cursor || "" };
}

function decodeNetlifyMeta(header: string | null): Record<string, unknown> {
  if (!header || !header.startsWith("b64;")) return {};
  try {
    const bytes = Uint8Array.from(atob(header.slice(4)), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return {};
  }
}

async function blobCopy(store: string, keys: string[]) {
  const bucket = currentScope().env.BLOBS;
  if (!bucket) throw new Error("Worker chưa gắn kho R2 (binding BLOBS).");
  const results: { key: string; ok: boolean; bytes?: number; error?: string }[] = [];
  for (const key of keys.slice(0, 5)) {
    try {
      const signed = await netlifyGet(`/site:${store}/${key}`, "application/json;type=signed-url");
      if (!signed.ok) throw new Error(`lấy đường tải trả ${signed.status}`);
      const { url } = await signed.json() as { url: string };
      const file = await fetch(url);
      if (!file.ok) throw new Error(`tải tệp trả ${file.status}`);
      const metadata = decodeNetlifyMeta(file.headers.get("x-amz-meta-user") || file.headers.get("netlify-blobs-metadata"));
      const body = await file.arrayBuffer();
      const contentType = typeof metadata.contentType === "string" ? metadata.contentType : undefined;
      await bucket.put(`${store}/${key}`, body, {
        customMetadata: { nf: JSON.stringify(metadata) },
        httpMetadata: contentType ? { contentType } : undefined
      });
      results.push({ key, ok: true, bytes: body.byteLength });
    } catch (err) {
      results.push({ key, ok: false, error: (err as Error).message.slice(0, 200) });
    }
  }
  return { store, results };
}

export default async (req: Request): Promise<Response> => {
  const expected = env("MIGRATE_KEY");
  if (!expected) return json({ success: false, error: "Không tìm thấy API." }, 404);
  if (req.method !== "POST") return json({ success: false, error: "Chỉ nhận POST." }, 405);

  let body: Record<string, any>;
  try {
    body = await req.json();
  } catch {
    return json({ success: false, error: "Thân yêu cầu không phải JSON." }, 400);
  }
  if (typeof body.key !== "string" || !sameSecret(body.key, expected)) {
    return json({ success: false, error: "Sai khoá chép dữ liệu." }, 403);
  }

  try {
    switch (body.action) {
      case "status": return json({ success: true, ...(await status()) });
      case "schema": return json({ success: true, ...(await applySchema()) });
      case "plan": return json({ success: true, tables: await orderedTables(requestSql()) });
      case "reset": return json({ success: true, ...(await resetTarget()) });
      case "copy": return json({ success: true, ...(await copyPage(String(body.table || ""), Number(body.offset || 0))) });
      case "sequences": return json({ success: true, ...(await fixSequences()) });
      case "blob-stores": return json({ success: true, ...(await blobStores()) });
      case "blob-list": return json({ success: true, ...(await blobList(String(body.store || ""), String(body.cursor || ""))) });
      case "blob-copy": return json({ success: true, ...(await blobCopy(String(body.store || ""), Array.isArray(body.keys) ? body.keys.map(String) : [])) });
      default: return json({ success: false, error: "Bước không hợp lệ." }, 400);
    }
  } catch (err) {
    return json({ success: false, error: (err as Error).message }, 500);
  }
};
