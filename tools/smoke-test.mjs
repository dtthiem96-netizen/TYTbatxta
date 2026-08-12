/**
 * Nạp thử trang trong DOM thật (jsdom) để bắt lỗi lúc chạy.
 *
 *   node tools/smoke-test.mjs            # kiểm tra cả / và /tram
 *   node tools/smoke-test.mjs /tram      # chỉ một tuyến
 *
 * Kiểm tra tĩnh (main.js) chỉ đối chiếu văn bản; bộ này thực sự dựng trang, chạy
 * app.js rồi gọi từng luồng nghiệp vụ và ĐỐI CHIẾU TÁC DỤNG TRÊN DOM - vì một bộ
 * xử lý ghi vào ID không tồn tại vẫn "chạy không lỗi".
 *
 * Hai điều cần biết khi đọc tệp này:
 *   1. jsdom KHÔNG thực thi <script type="module">, nên khối module của trang được
 *      gói lại thành IIFE async và chạy như script cổ điển (đã kiểm chứng khối này
 *      không dùng import/export nên bọc lại là tương đương).
 *   2. fetch giả phải trả về sau một nhịp timer thật. Nếu nó giải quyết ngay lập
 *      tức thì các vòng long-poll biến thành chuỗi microtask vô hạn và treo cả
 *      tiến trình - không phải lỗi của trang, nhưng đủ làm bộ kiểm tra vô dụng.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

let JSDOM, VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = await import('jsdom'));
} catch {
  console.log('Bỏ qua nạp thử: chưa cài jsdom (npm install).');
  process.exit(0);
}

const ROOT = path.resolve(process.env.SMOKE_ROOT || path.join(import.meta.dirname, '..'));
const ROUTES = process.argv.slice(2).filter((a) => a.startsWith('/'));
const PAGES = ROUTES.length ? ROUTES : ['/', '/tram'];

/** Bộ xử lý window.* mà markup gọi bằng thuộc tính onclick/onchange. */
const REQUIRED_HANDLERS = [
  'openStationPanel', 'switchStation', 'printReportA5', 'downloadReportPDF',
  'renderSignerSelectors', 'renderActiveSignerPreview', 'finishAndExportReport',
  'sendVitalsToDoctor', 'requestAIConsultation', 'toggleSpeechToText',
  'toggleCameraDevice', 'toggleMic', 'toggleVideo', 'openModal', 'closeModal',
  'closeAlertBanner', 'closeReportModal',
  // Rào chắn đăng nhập & tên phòng khám biến động của Module Bảng điều khiển trạm.
  'submitLogin', 'logoutStationPanel', 'handleStationLoginKey',
  'applyStationClinicName', 'getStationSession', 'setStationSession',
  'handleSaveClinicName', 'hasStationAccess', 'toggleUserStationPermission',
  // Cấp quyền vào Module Bác sĩ tuyến trên (/bacsi) - cấp tách khỏi quyền điểm trạm.
  'hasDoctorAccess', 'toggleUserDoctorPermission'
];

/* Dữ liệu CMS giả lập: một tài khoản ĐƯỢC cấp quyền vào Bảng điều khiển trạm và
   một tài khoản KHÔNG được cấp, để kiểm tra cả hai nhánh của luồng phân quyền. */
const STATION_PASSWORD = 'mat-khau-nap-thu';
const CLINIC_NAME = 'Trạm Y tế Nạp Thử';
const GRANTED_USER = {
  id: 'SMOKE-U1', username: 'canbotram@smoke.test', name: 'Y sĩ Được Cấp Quyền',
  role: 'Cán bộ Điểm trạm', canReceiveVideo: 'true', stationAccess: 'true'
};
const DENIED_USER = {
  id: 'SMOKE-U2', username: 'bientap@smoke.test', name: 'Biên tập viên Không Quyền',
  role: 'Biên tập nội dung', canReceiveVideo: 'false', stationAccess: 'false'
};
const CMS_USERS = [GRANTED_USER, DENIED_USER];

function buildWindow(html, route, problems) {
  const note = (kind, msg) =>
    problems.push(`[${kind}] ${String(msg).split('\n').slice(0, 3).join(' | ').slice(0, 400)}`);

  const dom = new JSDOM(html, {
    url: `http://localhost${route}`,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: makeConsole(note),
    beforeParse: (win) => stubBrowser(win, note)
  });
  return { win: dom.window, note };
}

function makeConsole(note) {
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => {
    // jsdom không cài đặt navigation, media, layout... - đó là giới hạn của bộ
    // giả lập, không phải lỗi của trang.
    if (/Not implemented/i.test(e.message)) return;
    note('jsdomError', e.stack || e.message);
  });
  vc.on('error', (...a) => note('console.error', a.join(' ')));
  return vc;
}

function stubBrowser(win, note) {
  win.tailwind = { config: {} };

  // Trả lời sau một nhịp timer thật (xem ghi chú đầu tệp).
  const jsonRes = (status, payload) => new Promise((resolve) => setTimeout(() => resolve({
    ok: status >= 200 && status < 300, status,
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(JSON.stringify(payload)),
    blob: () => Promise.resolve(new win.Blob([]))
  }), 20));
  const okJson = (data) => jsonRes(200, { success: true, data });

  /* Bản sao rút gọn của quy tắc phân quyền phía máy chủ (netlify/functions/station-auth.ts):
     chỉ tài khoản được CMS Quản trị cấp quyền mới đăng nhập được Bảng điều khiển trạm. */
  const authRule = (u) => {
    if (!u) return false;
    const granted = String(u.stationAccess || '').trim().toLowerCase();
    if (granted === 'true') return true;
    if (granted === 'false') return false;
    return /Điểm trạm|Station|Admin|Quản trị/i.test(u.role || '');
  };

  /* Phạm vi quyền của phiếu phiên, tương ứng scopesFor() trong netlify/lib/auth.ts. */
  const scopesOf = (u) => {
    const list = [];
    if (authRule(u)) list.push('station');
    if (/admin|quản trị|quan tri/i.test(u.role || '')) list.push('admin');
    if (String(u.canReceiveVideo || 'true') !== 'false') list.push('video');
    return list;
  };

  win.fetch = (url, opts) => {
    const u = String(url);
    if (u.includes('/api/signal')) return okJson({ peers: [], messages: [], rooms: [], onDuty: [] });
    if (u.includes('/api/vitals')) return okJson({ evaluation: { status: 'NORMAL', alerts: [] } });
    if (u.includes('/api/clinical-ai')) return okJson({ diagnosisList: [], prescriptions: [], icd10Codes: [] });
    if (u.includes('/api/examination-report')) {
      return okJson({ reportCode: 'SMOKE-001', treatmentPlan: 'Theo dõi 48 giờ' });
    }
    if (u.includes('/api/station-auth')) {
      const method = String((opts && opts.method) || 'GET').toUpperCase();
      const authHeader = String(((opts && opts.headers) || {}).Authorization || '');

      /* GET = kiểm tra lại phiếu phiên. Rào chắn của module gọi tuyến này trước khi
         mở thân Bảng điều khiển, nên bản giả lập phải trả đủ scopes. */
      if (method === 'GET') {
        const username = authHeader.replace(/^Bearer\s+smoke-token:/, '');
        const holder = CMS_USERS.find((x) => x.username === username);
        if (!holder || !authRule(holder)) {
          return jsonRes(401, { success: false, error: 'Phiên đăng nhập không hợp lệ' });
        }
        return jsonRes(200, { success: true, user: holder, scopes: scopesOf(holder) });
      }

      let body = {};
      try { body = JSON.parse((opts && opts.body) || '{}'); } catch { body = {}; }
      const user = CMS_USERS.find((x) => x.username === body.username);
      if (!user || body.password !== STATION_PASSWORD) {
        return jsonRes(401, { success: false, error: 'Invalid credentials' });
      }
      if (!authRule(user)) {
        return jsonRes(403, {
          success: false,
          error: 'Tài khoản chưa được CMS Quản trị cấp quyền truy cập Bảng điều khiển trạm'
        });
      }
      return jsonRes(200, {
        success: true,
        user,
        token: 'smoke-token:' + user.username,
        expiresAt: 4102444800000,
        scopes: scopesOf(user),
        mustChangePassword: false
      });
    }
    if (u.includes('/api/cms')) {
      // /api/cms trả các bộ sưu tập ở cấp cao nhất (không bọc trong "data").
      return jsonRes(200, {
        success: true,
        users: CMS_USERS,
        siteConfigs: [{ id: 'station-clinic-name', value: CLINIC_NAME }]
      });
    }
    return okJson({});
  };

  const track = () => ({
    kind: 'video', stop() {}, enabled: true, applyConstraints: () => Promise.resolve()
  });
  const stream = {
    getTracks: () => [track()], getVideoTracks: () => [track()], getAudioTracks: () => [track()],
    addTrack() {}, removeTrack() {}
  };
  Object.defineProperty(win.navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: () => Promise.resolve(stream),
      enumerateDevices: () => Promise.resolve([
        { kind: 'videoinput', deviceId: 'cam-wide', label: 'Camera góc rộng' },
        { kind: 'videoinput', deviceId: 'cam-macro', label: 'Camera cận cảnh' },
        { kind: 'audioinput', deviceId: 'mic-1', label: 'Micro' }
      ])
    }
  });

  win.RTCPeerConnection = class {
    constructor() {
      this.localDescription = { type: 'offer', sdp: 'v=0' };
      this.remoteDescription = null;
      this.iceConnectionState = 'new';
    }
    addTrack() { return { replaceTrack: () => Promise.resolve() }; }
    getSenders() { return [{ track: track(), replaceTrack: () => Promise.resolve() }]; }
    addTransceiver() {}
    createOffer() { return Promise.resolve({ type: 'offer', sdp: 'v=0' }); }
    createAnswer() { return Promise.resolve({ type: 'answer', sdp: 'v=0' }); }
    setLocalDescription(d) { this.localDescription = d || this.localDescription; return Promise.resolve(); }
    setRemoteDescription(d) { this.remoteDescription = d; return Promise.resolve(); }
    addIceCandidate() { return Promise.resolve(); }
    close() {}
    addEventListener() {}
  };
  win.RTCSessionDescription = function (d) { return d; };
  win.RTCIceCandidate = function (c) { return c; };

  win.SpeechRecognition = win.webkitSpeechRecognition = class {
    constructor() { this.lang = ''; this.continuous = false; this.interimResults = false; }
    start() { this.onstart && this.onstart(); }
    stop() { this.onend && this.onend(); }
    abort() {}
    addEventListener() {}
  };

  win.AudioContext = win.webkitAudioContext = class {
    constructor() { this.currentTime = 0; this.destination = {}; }
    createOscillator() {
      return { type: '', frequency: { value: 0 }, connect() {}, start() {}, stop() {} };
    }
    createGain() { return { gain: { setValueAtTime() {} }, connect() {} }; }
  };

  win.open = () => {
    const child = new JSDOM('<!doctype html><html><body></body></html>').window;
    child.focus = () => {}; child.print = () => {}; child.close = () => {};
    return child;
  };
  win.print = () => {};
  win.scrollTo = () => {};
  win.HTMLMediaElement.prototype.play = () => Promise.resolve();
  win.HTMLMediaElement.prototype.pause = () => {};
  win.URL.createObjectURL = () => 'blob:test';
  win.URL.revokeObjectURL = () => {};

  win.addEventListener('error', (e) => note('window.onerror', e.error?.stack || e.message));
  win.addEventListener('unhandledrejection', (e) => note('unhandledRejection', e.reason?.stack || e.reason));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Nạp một trang, chạy các luồng, trả về danh sách vấn đề tìm được. */
async function runPage(pageFile, route) {
  const problems = [];
  const abs = path.join(ROOT, pageFile);
  if (!fs.existsSync(abs)) return [`[thiếu tệp] ${pageFile}`];

  let html = fs.readFileSync(abs, 'utf8');
  html = html.replace(
    /<script type="module">([\s\S]*?)<\/script>/,
    (_m, body) => `<script>(async () => {\n${body}\n})().catch(e => { window.__moduleError = e; });</script>`
  );

  const { win, note } = buildWindow(html, route, problems);

  await Promise.race([
    new Promise((r) => {
      if (win.document.readyState === 'complete') return r();
      win.addEventListener('load', r, { once: true });
    }),
    wait(8000)
  ]);
  if (win.__moduleError) note('khối module', win.__moduleError.stack || win.__moduleError.message);

  const appFile = pageFile.startsWith('public/') ? 'public/app.js' : 'app.js';
  try {
    win.eval(fs.readFileSync(path.join(ROOT, appFile), 'utf8'));
    win.document.dispatchEvent(new win.Event('DOMContentLoaded', { bubbles: true }));
  } catch (err) {
    note(appFile, err.stack || err.message);
  }
  await wait(400);

  for (const fn of REQUIRED_HANDLERS) {
    if (typeof win[fn] !== 'function') note('thiếu bộ xử lý', `window.${fn} không phải hàm`);
  }

  const $ = (id) => win.document.getElementById(id);
  const setVal = (id, v) => { const e = $(id); if (e) e.value = v; };

  // Điền biểu mẫu như cán bộ trạm thật, gồm cả tuổi và giới tính.
  setVal('patient-name', 'Nguyễn Thị Nạp Thử');
  setVal('patient-age', '67');
  setVal('patient-gender', 'Nữ');
  setVal('patient-symptoms', 'Khó thở, đau tức ngực 2 ngày');
  setVal('clinical-notes', 'Phổi thông khí giảm đáy phải.');

  // Sinh hiệu ở ngưỡng CẤP CỨU: phải bật được biểu ngữ cảnh báo.
  setVal('vitals-bp-sys', '175');
  setVal('vitals-bp-dia', '105');
  setVal('vitals-hr', '134');
  setVal('vitals-spo2', '88');
  setVal('vitals-temp', '39.8');
  setVal('vitals-weight', '52');

  // --- Vị trí mới của module & rào chắn đăng nhập --------------------------
  const txt = (id) => { const e = $(id); return e ? (e.value ?? e.textContent ?? '').trim() : null; };
  const isHidden = (id) => { const e = $(id); return !e || e.classList.contains('hidden'); };

  // Module phải nằm ở chân trang và thanh tiêu đề không còn lối vào nào nữa.
  const footerModule = $('footer-station-module');
  if (!footerModule) note('vị trí module', 'không thấy #footer-station-module ở chân trang');
  else if (!footerModule.closest('footer')) note('vị trí module', '#footer-station-module không nằm trong <footer>');
  const headerEl = win.document.querySelector('header');
  if (headerEl && /openStationPanel/.test(headerEl.innerHTML)) {
    note('vị trí module', 'thanh tiêu đề vẫn còn lối vào Bảng điều khiển trạm');
  }

  // Chưa đăng nhập: mở module chỉ được ra popup đăng nhập, không lộ thân module.
  try { win.openStationPanel(); } catch (err) { note('luồng: rào chắn đăng nhập', err.stack || err.message); }
  await wait(400);
  if (isHidden('login-modal')) note('rào chắn đăng nhập', 'chưa đăng nhập mà không hiện #login-modal');
  if (!isHidden('modal-station-panel')) note('rào chắn đăng nhập', '#modal-station-panel mở khi chưa đăng nhập');

  // Danh sách tài khoản chỉ gợi ý người đã được CMS Quản trị cấp quyền.
  const accountSelect = $('input-cms-account');
  if (!accountSelect) note('không có phần tử', '#input-cms-account');
  else {
    const values = Array.from(accountSelect.options).map((o) => o.value);
    if (!values.includes(GRANTED_USER.username)) {
      note('danh sách tài khoản', 'tài khoản đã được cấp quyền không có trong #input-cms-account');
    }
    if (values.includes(DENIED_USER.username)) {
      note('danh sách tài khoản', 'tài khoản chưa được cấp quyền vẫn hiện trong #input-cms-account');
    }
  }

  const tryLogin = async (username, password, label) => {
    if (accountSelect && !Array.from(accountSelect.options).some((o) => o.value === username)) {
      // Thêm tay để mô phỏng người dùng can thiệp danh sách phía trình duyệt:
      // máy chủ vẫn phải là nơi quyết định cuối cùng.
      const forged = win.document.createElement('option');
      forged.value = username;
      forged.textContent = username;
      accountSelect.appendChild(forged);
    }
    if (accountSelect) accountSelect.value = username;
    setVal('input-station-password', password);
    try {
      await Promise.race([win.submitLogin(), wait(3000)]);
    } catch (err) {
      note(`luồng: ${label}`, err.stack || err.message);
    }
    await wait(400);
  };

  // Tài khoản chưa được cấp quyền: bị từ chối, không tạo phiên, không mở module.
  await tryLogin(DENIED_USER.username, STATION_PASSWORD, 'đăng nhập tài khoản chưa được cấp quyền');
  if (!isHidden('modal-station-panel')) {
    note('phân quyền', 'tài khoản chưa được cấp quyền vẫn mở được #modal-station-panel');
  }
  if (typeof win.getStationSession === 'function' && win.getStationSession()) {
    note('phân quyền', 'đã tạo phiên làm việc cho tài khoản chưa được cấp quyền');
  }
  if (!/từ chối/i.test(txt('station-login-status') || '')) {
    note('phân quyền', `#station-login-status không báo từ chối: "${txt('station-login-status')}"`);
  }

  // Sai mật khẩu: cũng phải bị chặn dù tài khoản có quyền.
  await tryLogin(GRANTED_USER.username, 'sai-mat-khau', 'đăng nhập sai mật khẩu');
  if (!isHidden('modal-station-panel')) {
    note('phân quyền', 'sai mật khẩu vẫn mở được #modal-station-panel');
  }

  // Tài khoản được CMS Quản trị cấp quyền: đăng nhập thành công và vào module.
  await tryLogin(GRANTED_USER.username, STATION_PASSWORD, 'đăng nhập tài khoản được cấp quyền');
  if (isHidden('modal-station-panel')) {
    note('phân quyền', 'tài khoản được cấp quyền vẫn không mở được #modal-station-panel');
  }
  if (!isHidden('login-modal')) note('phân quyền', 'popup đăng nhập không đóng sau khi xác thực thành công');
  const session = typeof win.getStationSession === 'function' ? win.getStationSession() : null;
  if (!session || session.username !== GRANTED_USER.username) {
    note('phân quyền', 'không ghi nhận phiên làm việc sau khi đăng nhập thành công');
  }
  if (txt('station-auth-user-name') !== GRANTED_USER.name) {
    note('phân quyền', `#station-auth-user-name = "${txt('station-auth-user-name')}" (mong đợi tên cán bộ đăng nhập)`);
  }

  /* Giả mạo phiếu phiên trong sessionStorage (mô phỏng người dùng tự dựng phiên rồi
     mở module qua URL). Rào chắn phải hỏi lại máy chủ chứ không tin bộ nhớ trình duyệt. */
  if (typeof win.setStationSession === 'function' && typeof win.openStationPanel === 'function') {
    win.setStationSession({
      token: 'smoke-token:khong-ton-tai',
      username: 'khong-ton-tai@laocai.gov.vn',
      name: 'Phiên giả mạo',
      expiresAt: 4102444800000
    });
    try {
      await Promise.race([win.openStationPanel(), wait(3000)]);
    } catch (err) {
      note('phân quyền', err.stack || err.message);
    }
    await wait(300);
    if (!isHidden('modal-station-panel')) {
      note('phân quyền', 'phiếu phiên giả mạo trong sessionStorage vẫn mở được #modal-station-panel');
    }
    if (typeof win.getStationSession === 'function' && win.getStationSession()) {
      note('phân quyền', 'phiếu phiên giả mạo không bị xoá sau khi máy chủ từ chối');
    }
    // Đăng nhập lại bằng tài khoản hợp lệ để các kiểm tra phía sau chạy trong module.
    await tryLogin(GRANTED_USER.username, STATION_PASSWORD, 'đăng nhập lại sau kiểm tra giả mạo');
    if (isHidden('modal-station-panel')) {
      note('phân quyền', 'không mở lại được #modal-station-panel sau khi đăng nhập lại');
    }
  }

  // Tên phòng khám phải biến động theo CMS Quản trị, mọi vị trí hiển thị cùng đổi.
  const clinicNodes = () => Array.from(win.document.querySelectorAll('[data-station-clinic-name]'));
  if (clinicNodes().length < 2) note('tên phòng khám', 'thiếu vị trí [data-station-clinic-name] để đồng bộ');
  setVal('cfg-clinic-name', 'Trạm Y tế Xã Nạp Thử');
  try {
    await Promise.race([win.handleSaveClinicName({ preventDefault() {} }), wait(3000)]);
  } catch (err) {
    note('luồng: lưu tên phòng khám', err.stack || err.message);
  }
  await wait(300);
  const stale = clinicNodes().filter((el) => el.textContent.trim() !== 'Trạm Y tế Xã Nạp Thử');
  if (stale.length) {
    note('tên phòng khám', `${stale.length}/${clinicNodes().length} vị trí chưa nhận tên mới từ CMS Quản trị`);
  }

  const flows = [
    ['mở bảng điều khiển trạm', () => win.openStationPanel()],
    ['đổi điểm trạm', () => win.switchStation('TYT-YTY-03')],
    ['bật/tắt micro', () => win.toggleMic()],
    ['bật/tắt video', () => win.toggleVideo()],
    ['đổi camera', () => win.toggleCameraDevice()],
    ['bật giọng nói (STT)', () => win.toggleSpeechToText()],
    ['tắt giọng nói (STT)', () => win.toggleSpeechToText()],
    ['gửi sinh hiệu cấp cứu', () => win.sendVitalsToDoctor()],
    ['hỏi trợ lý AI', () => win.requestAIConsultation()],
    ['dựng danh sách người ký', () => win.renderSignerSelectors()],
    ['xem trước chữ ký', () => win.renderActiveSignerPreview()],
    ['xuất phiếu khám', () => win.finishAndExportReport()],
    ['in phiếu A5', () => win.printReportA5()],
    ['tải phiếu (.doc)', () => win.downloadReportPDF()]
  ];

  for (const [name, fn] of flows) {
    try {
      const out = fn();
      if (out && typeof out.then === 'function') await Promise.race([out, wait(3000)]);
    } catch (err) {
      note(`luồng: ${name}`, err.stack || err.message);
    }
  }
  await wait(300);

  // --- Đối chiếu tác dụng thực tế trên DOM ---------------------------------
  const text = (id) => {
    const e = $(id);
    return e ? (e.value ?? e.textContent ?? '').trim() : null;
  };
  const mustFill = (id, why) => {
    if (text(id) === null) return note('không có phần tử', `#${id}`);
    if (!text(id)) note('phần tử rỗng', `#${id} không được điền ${why}`);
  };

  if (text('display-station-code') !== null && text('display-station-code') !== 'TYT-YTY-03') {
    note('đổi trạm không có tác dụng', `#display-station-code = "${text('display-station-code')}"`);
  }

  // Sinh hiệu cấp cứu phải làm hiện biểu ngữ cảnh báo với nội dung cụ thể.
  const banner = $('alert-banner');
  if (!banner) note('không có phần tử', '#alert-banner');
  else if (banner.classList.contains('hidden')) {
    note('cảnh báo cấp cứu', '#alert-banner vẫn ẩn dù SpO2 88%, HA 175/105, nhịp 134, 39.8°C');
  } else {
    mustFill('alert-banner-msg', 'khi có sinh hiệu cấp cứu');
  }

  // Phiếu khám A5 phải điền đủ phần đầu và các ô sinh hiệu.
  for (const id of ['rpt-code', 'rpt-date', 'rpt-station', 'rpt-edit-patient-name',
    'rpt-val-bp', 'rpt-val-hr', 'rpt-val-spo2', 'rpt-val-temp']) {
    mustFill(id, 'sau khi xuất phiếu khám');
  }
  // Tuổi/giới tính là yêu cầu riêng của phiếu khám, phải hiện đúng nội dung.
  const ageGender = text('rpt-edit-age-gender');
  if (ageGender !== null && !/67/.test(ageGender)) {
    note('tuổi/giới tính', `#rpt-edit-age-gender = "${ageGender}" (không thấy tuổi 67 đã nhập)`);
  }

  // Đóng phiếu khám phải trả cán bộ về đúng Bảng điều khiển đang khám.
  try { win.closeReportModal(); } catch (err) { note('luồng: đóng phiếu khám', err.message); }
  const panel = $('modal-station-panel');
  if (!panel) note('không có phần tử', '#modal-station-panel');
  else if (panel.classList.contains('hidden')) {
    note('quay lại bảng điều khiển', '#modal-station-panel bị ẩn sau khi đóng phiếu khám');
  }

  // Tắt biểu ngữ cảnh báo phải thực sự ẩn nó đi.
  try { win.closeAlertBanner(); } catch (err) { note('luồng: đóng cảnh báo', err.message); }
  if (banner && !banner.classList.contains('hidden')) {
    note('đóng cảnh báo', '#alert-banner vẫn hiện sau closeAlertBanner()');
  }

  win.close();
  return [...new Set(problems)];
}

/** Nạp một trang tĩnh đơn giản (trang quản trị) chỉ để bắt lỗi script. */
async function runStaticPage(pageFile) {
  const problems = [];
  const abs = path.join(ROOT, pageFile);
  if (!fs.existsSync(abs)) return [`[thiếu tệp] ${pageFile}`];

  const html = fs.readFileSync(abs, 'utf8');
  const { win } = buildWindow(html, '/', problems);
  await Promise.race([
    new Promise((r) => {
      if (win.document.readyState === 'complete') return r();
      win.addEventListener('load', r, { once: true });
    }),
    wait(5000)
  ]);
  await wait(300);
  win.close();
  return [...new Set(problems)];
}

// --- Chạy -------------------------------------------------------------------
let total = 0;
const cases = [];
for (const route of PAGES) cases.push([`index.html ${route}`, () => runPage('index.html', route)]);
cases.push(['public/index.html /tram', () => runPage('public/index.html', '/tram')]);
// Cả 401.html và admin/decap.html đều chạy khi window.netlifyIdentity KHÔNG tồn
// tại (jsdom không nạp script ngoài, giống lúc người dùng bị phần mềm chặn quảng
// cáo hoặc mất mạng). Đó chính là trường hợp cần kiểm: trang phải hiển thị thông
// báo thay vì ném lỗi và để lại một màn hình trắng.
for (const p of ['admin/index.html', 'admin/cms.html', 'admin/decap.html', '401.html']) {
  cases.push([p, () => runStaticPage(p)]);
}

for (const [label, run] of cases) {
  const found = await run();
  total += found.length;
  if (!found.length) {
    console.log(`✓ ${label} - không phát hiện lỗi lúc chạy`);
  } else {
    console.log(`✗ ${label} - ${found.length} vấn đề:`);
    for (const p of found) console.log('    ' + p);
  }
}

console.log(total ? `\nTổng: ${total} vấn đề.` : '\nTất cả các trang nạp và chạy sạch.');
process.exit(total ? 1 : 0);
