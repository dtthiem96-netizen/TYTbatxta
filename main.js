/**
 * Điểm vào của GitHub Action "Kiểm tra tính toàn vẹn bản dựng Trạm Y tế".
 *
 * Chạy bằng runtime node24 của GitHub Actions, không dùng thư viện ngoài.
 * Sáu nhóm kiểm tra:
 *   1. Cú pháp mọi khối <script> nội tuyến trong index.html + toàn bộ app.js.
 *   2. Đối chiếu bản gốc (index.html, app.js) với bản phân phối trong public/.
 *   3. Soát các ID phần tử DOM được JavaScript gọi nhưng không có trong HTML.
 *   4. Soát các hàm window.* được markup gọi nhưng không được định nghĩa.
 *   5. Chính sách Cache-Control trong netlify.toml (bẫy cache tệp không vân tay).
 *   6. Trạng thái cấp phát Netlify Database (ghi chú, không chặn).
 *
 * Nhóm 1 là lỗi nghiêm trọng (một dấu </script> lọt vào chuỗi JS đủ làm chết
 * toàn bộ trang). Nhóm 2-5 là cảnh báo, chỉ chặn workflow khi strict=true.
 * Nhóm 6 chỉ ghi chú, không bao giờ đổi mã thoát.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(process.env.INPUT_ROOT || '.');
const STRICT = String(process.env.INPUT_STRICT || 'false').toLowerCase() === 'true';

const errors = [];
const warnings = [];
const notes = [];

const fail = (msg, file) => errors.push({ msg, file });
const warn = (msg, file) => warnings.push({ msg, file });
// Ghi chú: chỉ để hiển thị trong log, KHÔNG đổi mã thoát ở bất kỳ chế độ nào.
// Dùng cho những trạng thái bất thường nhưng cố ý, cần nhìn thấy chứ không cần
// chặn - nếu dùng warn() thì strict=true sẽ làm CI đỏ mãi mãi.
const note = (msg, file) => notes.push({ msg, file });

const read = (rel) => {
  const abs = path.join(ROOT, rel);
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
};

/** Tách các khối <script> nội tuyến (bỏ qua script có src). */
function inlineScripts(html) {
  const blocks = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] || '';
    if (/\ssrc\s*=/i.test(attrs)) continue;
    if (/type\s*=\s*["'](?!module|text\/javascript|application\/javascript)/i.test(attrs)) continue;
    const line = html.slice(0, m.index).split('\n').length;
    blocks.push({ line, code: m[2], isModule: /type\s*=\s*["']module["']/i.test(attrs) });
  }
  return blocks;
}

/** Kiểm tra cú pháp mà không thực thi mã (node --check đọc từ stdin). */
function checkSyntax(code, isModule) {
  const args = isModule ? ['--input-type=module', '--check'] : ['--check'];
  const res = spawnSync(process.execPath, args, { input: code, encoding: 'utf8' });
  if (res.status === 0) return null;
  const out = String(res.stderr || res.stdout || 'không rõ nguyên nhân');
  return out.split('\n').filter((l) => /Error/.test(l)).join(' ') || out.slice(0, 300);
}

// --- 1. Cú pháp -------------------------------------------------------------
// Trang chính bắt buộc phải có mã nội tuyến; các trang quản trị thì không.
const MAIN_PAGES = ['index.html', 'public/index.html'];
const ADMIN_PAGES = ['admin/index.html', 'admin/cms.html', 'admin/decap.html', '401.html', 'public/admin/index.html', 'public/admin/cms.html', 'public/admin/decap.html'];

for (const file of [...MAIN_PAGES, ...ADMIN_PAGES]) {
  const required = MAIN_PAGES.includes(file);
  const html = read(file);
  if (html === null) {
    // Tệp thiếu ở thư mục public/ đã được nhóm kiểm tra đồng bộ báo riêng.
    if (required) warn('Không tìm thấy tệp.', file);
    continue;
  }
  const blocks = inlineScripts(html);
  if (required && !blocks.length) {
    warn('Không thấy khối <script> nội tuyến nào - kiểm tra lại cấu trúc trang.', file);
  }
  for (const block of blocks) {
    const problem = checkSyntax(block.code, block.isModule);
    if (problem) fail(`Khối <script> mở tại dòng ${block.line} bị lỗi cú pháp: ${problem}`, file);
  }
  // Dấu </script> chưa được thoát nằm trong chuỗi JS sẽ cắt ngang khối script.
  const stray = html.match(/<\/script\s*>/gi) || [];
  const opened = html.match(/<script\b/gi) || [];
  if (stray.length !== opened.length) {
    fail(`Số thẻ mở (${opened.length}) và thẻ đóng (${stray.length}) của <script> không khớp.`, file);
  }
}

for (const file of ['app.js', 'public/app.js']) {
  const code = read(file);
  if (code === null) {
    warn('Không tìm thấy tệp.', file);
    continue;
  }
  const problem = checkSyntax(code, false);
  if (problem) fail(`Lỗi cú pháp: ${problem}`, file);
}

// --- 2. Đồng bộ bản gốc và bản phân phối ------------------------------------
// Không chỉ index.html/app.js: mọi tài sản tĩnh dùng chung phải khớp nhau, vì
// một tệp thiếu trong public/ sẽ bị luật bắt-tất-cả trả về trang chủ với status
// 200 - trông như tải được nhưng thực ra là sai nội dung, khó phát hiện hơn 404.
const SYNC_TARGETS = ['index.html', 'app.js', 'logo.png', 'admin', 'assets'];

/** Liệt kê đường dẫn tương đối của mọi tệp trong một thư mục. */
function walk(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(abs, base));
    else if (entry.isFile()) out.push(path.relative(base, abs));
  }
  return out;
}

for (const target of SYNC_TARGETS) {
  const srcAbs = path.join(ROOT, target);
  if (!fs.existsSync(srcAbs)) continue;

  const rels = fs.statSync(srcAbs).isDirectory()
    ? walk(srcAbs).map((r) => path.posix.join(target, r.split(path.sep).join('/')))
    : [target];

  for (const rel of rels) {
    const a = path.join(ROOT, rel);
    const b = path.join(ROOT, 'public', rel);
    if (!fs.existsSync(b)) {
      warn(`Thiếu bản phân phối cho ${rel} - cần đồng bộ sang public/.`, `public/${rel}`);
      continue;
    }
    if (!fs.readFileSync(a).equals(fs.readFileSync(b))) {
      warn(`Nội dung lệch với ${rel} - cần đồng bộ lại trước khi triển khai.`, `public/${rel}`);
    }
  }

  // Tệp chỉ có trong public/ mà không còn ở bản gốc cũng là dấu hiệu lệch nhau.
  const distAbs = path.join(ROOT, 'public', target);
  if (fs.existsSync(distAbs) && fs.statSync(distAbs).isDirectory()) {
    for (const r of walk(distAbs)) {
      const rel = path.posix.join(target, r.split(path.sep).join('/'));
      if (!fs.existsSync(path.join(ROOT, rel))) {
        warn(`Chỉ tồn tại trong public/, không có ở bản gốc: ${rel}`, `public/${rel}`);
      }
    }
  }
}

// --- 3. ID phần tử DOM ------------------------------------------------------
const markup = (read('index.html') || '') + (read('public/index.html') || '');
if (markup) {
  const ids = new Set([...markup.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  // Một số phần tử được JavaScript tạo động rồi gán id, không có trong HTML tĩnh.
  for (const m of markup.matchAll(/\.id\s*=\s*['"]([^'"]+)['"]/g)) ids.add(m[1]);
  for (const file of ['app.js', 'index.html']) {
    const code = read(file);
    if (!code) continue;
    for (const m of code.matchAll(/\.id\s*=\s*['"]([^'"]+)['"]/g)) ids.add(m[1]);
    const refs = new Set([...code.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]));
    // Bỏ qua ID chỉ dùng làm phương án dự phòng phía sau toán tử ||.
    const fallbacks = new Set(
      [...code.matchAll(/\|\|\s*document\.getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])
    );
    const missing = [...refs].filter((id) => !ids.has(id) && !fallbacks.has(id));
    if (missing.length) warn(`Gọi tới ID không tồn tại trong HTML: ${missing.join(', ')}`, file);
  }
}

// --- 4. Bộ xử lý window.* gọi từ markup nhưng chưa được định nghĩa ----------
// Mọi thuộc tính onclick/onchange trong trang đều gọi qua window.*, nên đây là
// cách bắt các nút "bấm không phản hồi" do hàm bị đổi tên hoặc chưa xuất ra.
const WINDOW_BUILTINS = new Set([
  'scrollTo', 'scrollBy', 'open', 'close', 'print', 'focus', 'blur', 'alert', 'confirm', 'prompt',
  'addEventListener', 'removeEventListener', 'postMessage', 'matchMedia', 'getComputedStyle',
  'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'fetch', 'btoa', 'atob'
]);

{
  const html = read('index.html');
  const app = read('app.js');
  if (html && app) {
    const both = html + app;
    const defined = new Set();
    for (const m of both.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=/g)) defined.add(m[1]);
    for (const m of both.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)) defined.add(m[1]);
    const called = new Set([...html.matchAll(/window\.([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]));
    const missing = [...called].filter((fn) => !defined.has(fn) && !WINDOW_BUILTINS.has(fn));
    if (missing.length) {
      warn(`Markup gọi window.* chưa được định nghĩa: ${missing.map((f) => `${f}()`).join(', ')}`, 'index.html');
    }
  }
}

// --- 5. Chính sách cache trong netlify.toml ---------------------------------
// Một tệp JS/CSS không có vân tay nội dung trong tên mà bị gắn "immutable" với
// max-age một năm là lỗi rất khó phát hiện: bản triển khai mới trông như thành
// công, nhưng người đã từng mở trang vẫn chạy mã cũ hàng tháng trời và không có
// cách nào tự thoát ra. Kiểm tra ở đây để không ai vô tình đặt lại luật đó.
//
// Ngoài ra, tài liệu Netlify nói các header cùng tên sẽ được NỐI giá trị lại
// với nhau, nên hai luật cùng khớp một đường dẫn mà đặt Cache-Control khác nhau
// sẽ sinh ra header vô nghĩa. Vì vậy cũng kiểm tra luôn việc chồng luật.
{
  const toml = read('netlify.toml');
  if (toml) {
    // netlify.toml do chính dự án này quản lý và có cấu trúc rất đều, nên tách
    // bằng biểu thức chính quy là đủ - không cần thêm thư viện phân tích TOML.
    const rules = [];
    for (const block of toml.split(/^\[\[headers\]\]/m).slice(1)) {
      const head = block.split(/^\[\[/m)[0];
      const forM = head.match(/^\s*for\s*=\s*"([^"]+)"/m);
      const ccM = head.match(/^\s*Cache-Control\s*=\s*"([^"]+)"/m);
      if (forM) rules.push({ for: forM[1], cc: ccM ? ccM[1] : null });
    }

    // '*' của Netlify có thể vượt hoặc không vượt dấu '/' tuỳ ngữ cảnh; kiểm
    // theo cách rộng nhất để kết luận đúng với cả hai cách hiểu.
    const matches = (pattern, url, crossSlash) => {
      const star = crossSlash ? '[\\s\\S]*' : '[^/]*';
      const src = '^' + pattern.replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === '*' ? star : '\\' + c)) + '$';
      return new RegExp(src).test(url);
    };

    const JS_CSS = /\.(js|mjs|css)$/i;
    const FINGERPRINTED = /[.-][0-9a-f]{6,}\.(js|mjs|css)$/i;

    // Các tệp JS/CSS thực sự được publish ở thư mục gốc.
    const served = [];
    for (const rel of ['app.js', 'public/app.js']) {
      if (read(rel) !== null) served.push('/' + rel);
    }

    for (const url of served) {
      if (FINGERPRINTED.test(url)) continue;
      for (const crossSlash of [false, true]) {
        for (const r of rules) {
          if (!r.cc || !matches(r.for, url, crossSlash)) continue;
          if (/immutable/i.test(r.cc) || /max-age\s*=\s*([1-9]\d{5,})/.test(r.cc)) {
            warn(
              `Luật headers "${r.for}" gắn cache dài cho ${url} ("${r.cc}"). Tên tệp không có `
              + 'vân tay nội dung nên bản sửa lỗi sẽ không tới được người đang dùng. Dùng '
              + 'must-revalidate cho tệp này, hoặc đặt tệp có vân tay trong assets/.',
              'netlify.toml'
            );
          }
        }
      }
    }

    // Hai luật cùng khớp một đường dẫn nhưng đặt Cache-Control khác nhau.
    const probes = [...served, '/', '/index.html', '/logo.png', '/assets/tram_music.mp3'];
    for (const url of probes) {
      for (const crossSlash of [false, true]) {
        const vals = new Set(
          rules.filter((r) => r.cc && matches(r.for, url, crossSlash)).map((r) => r.cc)
        );
        if (vals.size > 1) {
          warn(
            `${url} khớp nhiều luật headers đặt Cache-Control khác nhau (${[...vals].join(' | ')}). `
            + 'Netlify nối các header cùng tên lại nên kết quả sẽ vô nghĩa - viết lại cho không chồng nhau.',
            'netlify.toml'
          );
        }
      }
    }
  }
}

// --- 6. Trạng thái cấp phát Netlify Database -------------------------------
// Bước lõi "Netlify Database setup" của @netlify/build chỉ chạy khi package.json
// có "@netlify/database" trong dependencies hoặc devDependencies. Bước đó cấp
// chuỗi kết nối NETLIFY_DB_URL và áp dụng các bản di trú trong
// netlify/database/migrations lên nhánh cơ sở dữ liệu đang triển khai.
//
// Có một giai đoạn cơ sở dữ liệu của site bị tắt, khi đó gói này bị gỡ khỏi
// package.json vì bước cấp phát không bắt lỗi: API trả 423 "database is
// disabled" và làm hỏng cả bản dựng, kể cả phần web tĩnh. Cơ sở dữ liệu nay đã
// bật trở lại và gói đã được khai báo lại - thiếu nó thì trình đóng gói không
// giải quyết được "@neondatabase/serverless" mà driver drizzle-orm/netlify-db
// cần, và MỌI hàm dùng cơ sở dữ liệu (đăng nhập CMS, Bảng điều khiển điểm trạm)
// đều hỏng lúc chạy.
//
// Nhóm kiểm tra này ghi lại trạng thái vào log để không ai phải đoán vì sao mã
// truy vấn vẫn còn nguyên mà chuỗi kết nối lại không được cấp.
{
  const pkgRaw = read('package.json');
  if (pkgRaw) {
    let pkg = null;
    try {
      pkg = JSON.parse(pkgRaw);
    } catch (err) {
      fail(`Không đọc được package.json: ${err.message}`, 'package.json');
    }
    if (pkg) {
      const declared = '@netlify/database' in { ...pkg.dependencies, ...pkg.devDependencies };
      const migrationsDir = path.join(ROOT, 'netlify/database/migrations');
      const hasMigrations = fs.existsSync(migrationsDir)
        && fs.readdirSync(migrationsDir).length > 0;
      const hasDbCode = read('db/index.ts') !== null;

      if (!declared && (hasMigrations || hasDbCode)) {
        note(
          'Mã truy vấn cơ sở dữ liệu và các tệp migration vẫn còn, nhưng '
          + '"@netlify/database" cố ý KHÔNG được khai báo trong package.json: cơ sở '
          + 'dữ liệu của site đang tắt và bước cấp phát của bản dựng sẽ làm cả bản '
          + 'dựng thất bại (API trả 423 "database is disabled"). Các endpoint dùng cơ '
          + 'sở dữ liệu trả lỗi có nội dung rõ ràng cho tới khi bật lại. Để bật lại: '
          + 'mở cơ sở dữ liệu cho site rồi thêm "@netlify/database" trở lại '
          + 'dependencies - db/index.ts đọc NETLIFY_DB_URL lúc chạy nên không cần sửa mã.',
          'package.json'
        );
      }
      if (declared && !hasMigrations) {
        warn(
          '"@netlify/database" được khai báo nhưng không có tệp migration nào trong '
          + 'netlify/database/migrations - kiểm tra lại out trong drizzle.config.ts.',
          'package.json'
        );
      }
    }
  }
}

// --- Báo cáo ----------------------------------------------------------------
for (const e of errors) console.log(`::error file=${e.file}::${e.msg}`);
for (const w of warnings) console.log(`::warning file=${w.file}::${w.msg}`);
for (const n of notes) console.log(`::notice file=${n.file}::${n.msg}`);

const summary = [
  '## Kiểm tra tính toàn vẹn bản dựng',
  '',
  `- Lỗi nghiêm trọng: **${errors.length}**`,
  `- Cảnh báo: **${warnings.length}**`,
  `- Ghi chú: **${notes.length}**`,
  `- Chế độ strict: \`${STRICT}\``,
  ''
].join('\n');

console.log(summary);

const append = (envVar, text) => {
  const target = process.env[envVar];
  if (target) {
    try {
      fs.appendFileSync(target, text);
    } catch (err) {
      console.log(`::warning::Không ghi được vào ${envVar}: ${err.message}`);
    }
  }
};

append('GITHUB_STEP_SUMMARY', summary + '\n');
append('GITHUB_OUTPUT', `errors=${errors.length}\nwarnings=${warnings.length}\n`);

if (errors.length || (STRICT && warnings.length)) {
  process.exitCode = 1;
}
