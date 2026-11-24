#!/usr/bin/env node
/**
 * Dựng bản Cloudflare Workers (chạy tự động trước `wrangler dev` / `wrangler
 * deploy` nhờ khoá build.command trong wrangler.jsonc).
 *
 *  1. .cf-dist/ : tệp tĩnh. Chép từ public/ (bản phân phối đã được main.js kiểm
 *     tra đồng bộ với thư mục gốc), BỎ public/admin (Decap + Netlify Identity
 *     không chạy được trên Cloudflare), thêm trang chép dữ liệu và hai tệp
 *     _redirects, _headers dịch từ netlify.toml.
 *  2. cloudflare/generated/migrations.ts : nội dung các tệp SQL trong
 *     netlify/database/migrations, để /api/migrate dựng bảng trên cơ sở dữ liệu
 *     mới theo đúng thứ tự đã chạy trên Netlify.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "public");
const OUT = path.join(ROOT, ".cf-dist");
const SKIP_TOP = new Set(["admin"]);

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

for (const entry of fs.readdirSync(SRC, { withFileTypes: true })) {
  if (SKIP_TOP.has(entry.name)) continue;
  fs.cpSync(path.join(SRC, entry.name), path.join(OUT, entry.name), { recursive: true });
}
for (const required of ["index.html", "app.js", "sw.js", "bacsi.html", "chamcong.html"]) {
  if (!fs.existsSync(path.join(OUT, required))) {
    console.error(`Thiếu ${required} trong public/ - bản Cloudflare sẽ hỏng.`);
    process.exit(1);
  }
}
fs.cpSync(path.join(ROOT, "cloudflare", "static"), OUT, { recursive: true });

/* Luật chuyển hướng. Các trang .html được Cloudflare tự phục vụ ở đường dẫn
   không đuôi (/bacsi -> bacsi.html), nên chỉ cần đưa đường dẫn con về đó. */
const redirects = `
/cham-cong /chamcong 301
/cham-cong/* /chamcong 301
/chamcong/* /chamcong 200
/bacsi/* /bacsi 200
/tram / 200
/tram/* / 200
/public/* /:splat 301
/admin / 302
/admin/* / 302
`.trimStart();
fs.writeFileSync(path.join(OUT, "_redirects"), redirects);

/* Header. Cloudflare mặc định trả "public, max-age=0, must-revalidate" kèm
   ETag cho mọi tệp tĩnh, đúng điều netlify.toml đặt cho HTML và các tệp .js
   không có vân tay. Ở đây chỉ thêm bộ đệm dài cho ảnh, âm thanh, assets/ và các
   header bảo mật. Mỗi header chỉ do MỘT luật đặt cho một đường dẫn: hai luật
   cùng khớp sẽ bị nối giá trị lại thành một header vô nghĩa. */
const immutable = "public, max-age=31536000, immutable";
const longCache = ["/assets/*", "/*.png", "/*.jpg", "/*.jpeg", "/*.gif", "/*.svg", "/*.webp", "/*.ico", "/*.woff2", "/*.mp3"];
let headers = "";
for (const p of longCache) headers += `${p}\n  Cache-Control: ${immutable}\n`;
headers += `/sw.js\n  Service-Worker-Allowed: /\n`;
headers += `/chuyen-du-lieu.html\n  X-Robots-Tag: noindex\n`;
headers += `/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: SAMEORIGIN
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(self), microphone=(self), geolocation=(self)
`;
fs.writeFileSync(path.join(OUT, "_headers"), headers);

/* Bộ di trú lược đồ. */
const MIG_DIR = path.join(ROOT, "netlify", "database", "migrations");
const migrations = fs.readdirSync(MIG_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && fs.existsSync(path.join(MIG_DIR, d.name, "migration.sql")))
  .map((d) => d.name)
  .sort()
  .map((name) => ({ name, sql: fs.readFileSync(path.join(MIG_DIR, name, "migration.sql"), "utf8") }));
const GEN_DIR = path.join(ROOT, "cloudflare", "generated");
fs.mkdirSync(GEN_DIR, { recursive: true });
fs.writeFileSync(
  path.join(GEN_DIR, "migrations.ts"),
  "// Tệp sinh tự động bởi tools/build-cloudflare.mjs - đừng sửa tay.\n"
    + `export const MIGRATIONS: { name: string; sql: string }[] = ${JSON.stringify(migrations, null, 1)};\n`
);

const count = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .reduce((n, e) => n + (e.isDirectory() ? count(path.join(dir, e.name)) : 1), 0);
console.log(`Bản Cloudflare: ${count(OUT)} tệp tĩnh trong .cf-dist, ${migrations.length} bản di trú lược đồ.`);
