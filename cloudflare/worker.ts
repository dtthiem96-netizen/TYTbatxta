/**
 * Điểm vào của trang Trạm Y tế Bát Xát trên Cloudflare Workers.
 *
 *   - /api/*  : chạy đúng các hàm trong netlify/functions (không sửa mã gốc),
 *               qua lớp đệm ở cloudflare/runtime.ts và cloudflare/shims.
 *   - còn lại : tệp tĩnh (thư mục .cf-dist do tools/build-cloudflare.mjs dựng
 *               từ public/), kèm _redirects và _headers. Yêu cầu tệp tĩnh
 *               không chạy Worker nên không tính vào hạn mức yêu cầu.
 *   - Hẹn giờ: attendance-maintenance chạy mỗi ngày (thay "@daily" của Netlify).
 */
import { databaseUrl, runInScope, type Env, type ExecutionContextLike } from "./runtime";

import adminUsers from "../netlify/functions/admin-users";
import aiCoordinator from "../netlify/functions/ai-coordinator";
import aiStatus from "../netlify/functions/ai-status";
import ai from "../netlify/functions/ai";
import attachment from "../netlify/functions/attachment";
import attendanceAdmin from "../netlify/functions/attendance-admin";
import attendanceMaintenance from "../netlify/functions/attendance-maintenance";
import attendanceReports from "../netlify/functions/attendance-reports";
import attendanceSecurity from "../netlify/functions/attendance-security";
import attendance from "../netlify/functions/attendance";
import authLogin from "../netlify/functions/auth-login";
import callLogs from "../netlify/functions/call-logs";
import clinicalAi from "../netlify/functions/clinical-ai";
import cmsDashboard from "../netlify/functions/cms-dashboard";
import cms from "../netlify/functions/cms";
import examinationReport from "../netlify/functions/examination-report";
import ice from "../netlify/functions/ice";
import notify from "../netlify/functions/notify";
import signal from "../netlify/functions/signal";
import stationAuth from "../netlify/functions/station-auth";
import stationRooms from "../netlify/functions/station-rooms";
import video from "../netlify/functions/video";
import vitals from "../netlify/functions/vitals";
import migrate from "./migrate";

type Handler = (req: Request) => Response | Promise<Response>;

/** Bảng đường dẫn, chép đúng `config.path` của từng hàm Netlify. */
const ROUTES = new Map<string, Handler>([
  ["/api/admin-users", adminUsers],
  ["/api/ai-coordinator", aiCoordinator],
  ["/api/ai-status", aiStatus],
  ["/api/ai", ai],
  ["/api/attachment", attachment],
  ["/api/attendance/admin", attendanceAdmin],
  ["/api/attendance/reports", attendanceReports],
  ["/api/attendance/security", attendanceSecurity],
  ["/api/attendance", attendance],
  ["/api/auth/login", authLogin],
  ["/api/call-logs", callLogs],
  ["/api/clinical-ai", clinicalAi],
  ["/api/cms/dashboard", cmsDashboard],
  ["/api/cms", cms],
  ["/api/examination-report", examinationReport],
  ["/api/ice", ice],
  ["/api/notify", notify],
  ["/api/signal", signal],
  ["/api/station-auth", stationAuth],
  ["/api/station-rooms", stationRooms],
  ["/api/video", video],
  ["/api/vitals", vitals],
  ["/api/migrate", migrate]
]);

function resolveHandler(pathname: string): Handler | null {
  const clean = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  const exact = ROUTES.get(clean);
  if (exact) return exact;
  if (clean.startsWith("/api/vitals/")) return vitals;
  return null;
}

/**
 * Mã gốc đọc IP và quốc gia của người gọi từ header riêng của Netlify. Trên
 * Cloudflare, chép giá trị tương ứng sang đúng tên header đó để chống spam theo
 * IP và kiểm tra chấm công theo quốc gia vẫn chạy như cũ.
 */
function asNetlifyRequest(req: Request): Request {
  const headers = new Headers(req.headers);
  const ip = req.headers.get("cf-connecting-ip");
  if (ip) {
    headers.set("x-nf-client-connection-ip", ip);
    if (!headers.has("x-forwarded-for")) headers.set("x-forwarded-for", ip);
  }
  const country = (req as unknown as { cf?: { country?: string } }).cf?.country;
  if (country) headers.set("x-nf-geo", btoa(JSON.stringify({ country: { code: country } })));
  return new Request(req, { headers });
}

/** db/index.ts đòi NETLIFY_DB_URL khác rỗng; kết nối thật do lớp đệm lấy từ Env. */
function primeProcessEnv(env: Env) {
  const proc = (globalThis as unknown as { process?: { env: Record<string, string | undefined> } }).process;
  if (!proc) return;
  if (!proc.env.NETLIFY_DB_URL && databaseUrl(env)) {
    proc.env.NETLIFY_DB_URL = "postgres://cloudflare-worker/database";
  }
}

/** Đường dẫn trả tệp (video, tệp đính kèm) cần hỗ trợ tải từng đoạn. */
const RANGE_PATHS = new Set(["/api/video", "/api/attachment"]);

/**
 * Trả từng đoạn tệp (HTTP Range, mã 206). Trên Netlify, CDN tự cắt đoạn từ
 * phản hồi đầy đủ của hàm; Cloudflare Workers thì không. Thiếu phần này, Safari
 * trên iPhone không phát hoặc không tua được video, vì nó luôn xin từng đoạn
 * (bắt đầu bằng "bytes=0-1"). Chỉ xử lý một đoạn; yêu cầu nhiều đoạn nhận cả tệp.
 */
async function withRange(request: Request, res: Response): Promise<Response> {
  if (res.status !== 200 || !res.body) return res;
  const headers = new Headers(res.headers);
  headers.set("Accept-Ranges", "bytes");
  const range = request.headers.get("range");
  const match = range && request.method === "GET" ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (!match || (!match[1] && !match[2])) {
    return new Response(res.body, { status: 200, headers });
  }

  const blob = await res.blob();
  const size = blob.size;
  let start: number;
  let end: number;
  if (match[1]) {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  } else {
    const suffix = Number(match[2]);
    start = Math.max(size - suffix, 0);
    end = size - 1;
  }
  if (start >= size || end < start) {
    headers.set("Content-Range", `bytes */${size}`);
    headers.delete("Content-Length");
    return new Response(null, { status: 416, headers });
  }
  headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
  headers.set("Content-Length", String(end - start + 1));
  return new Response(blob.slice(start, end + 1), { status: 206, headers });
}

function jsonError(message: string, status: number) {
  return new Response(JSON.stringify({ success: false, error: message }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContextLike): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    const handler = resolveHandler(url.pathname);
    if (!handler) return jsonError("Không tìm thấy API.", 404);

    primeProcessEnv(env);
    try {
      const res = await runInScope(env, ctx, async () => handler(asNetlifyRequest(request)));
      const clean = url.pathname.replace(/\/+$/, "");
      return RANGE_PATHS.has(clean) ? await withRange(request, res) : res;
    } catch (err) {
      console.error("Lỗi API", url.pathname, err);
      return jsonError("Lỗi máy chủ. Vui lòng thử lại sau.", 500);
    }
  },

  async scheduled(_controller: unknown, env: Env, ctx: ExecutionContextLike): Promise<void> {
    primeProcessEnv(env);
    await runInScope(env, ctx, async () => {
      const res = await (attendanceMaintenance as unknown as () => Promise<Response | void>)();
      if (res instanceof Response && !res.ok) console.error("Bảo trì chấm công lỗi", res.status, await res.text());
    });
  }
};
