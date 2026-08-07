/**
 * Bộ kiểm tra "im lặng khi chưa gọi" cho Bảng điều khiển điểm trạm.
 *
 *   node tools/media-consent-check.mjs
 *
 * Nạp trang trong DOM thật (jsdom) rồi ĐẾM số lần trang chạm vào thiết bị và
 * kênh signaling. Ba điều bắt buộc phải đúng:
 *
 *   1. Nạp trang xong: 0 lần getUserMedia, 0 lần vào phòng khám (action=join).
 *      Mở trang chủ hay mở bảng điều khiển không phải là lệnh bật camera.
 *   2. Bấm các nút mic/camera lúc chưa gọi: vẫn 0 lần chạm thiết bị.
 *   3. Bấm "Bắt đầu cuộc gọi": mới mở thiết bị và vào phòng; bấm "Kết thúc":
 *      rời phòng, dừng track (đèn camera tắt) và không tự vào lại.
 *
 * Đây là bộ kiểm tra hành vi, không phải đối chiếu văn bản: chỉ cần một lệnh
 * initLocalCamera()/joinRoom() lọt lại vào đường khởi động là nó bắt được ngay.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

let JSDOM, VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = await import('jsdom'));
} catch {
  console.log('Bỏ qua kiểm tra quyền thiết bị: chưa cài jsdom (npm install).');
  process.exit(0);
}

const ROOT = path.resolve(process.env.SMOKE_ROOT || path.join(import.meta.dirname, '..'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGES = [
  { file: 'index.html', app: 'app.js', route: '/' },
  { file: 'public/index.html', app: 'public/app.js', route: '/tram' }
];

/** Dựng một cửa sổ jsdom có đếm mọi lần chạm camera/micro và kênh signaling. */
function buildWindow(html, route, calls) {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {});

  const track = () => ({
    kind: 'video',
    enabled: true,
    stop() { calls.trackStop++; },
    applyConstraints: () => Promise.resolve()
  });
  const stream = {
    getTracks: () => [track()], getVideoTracks: () => [track()], getAudioTracks: () => [track()],
    addTrack() {}, removeTrack() {}
  };

  return new JSDOM(html, {
    url: `http://localhost${route}`,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(win) {
      // Phản hồi phải trả về sau một nhịp timer thật, nếu không vòng long-poll
      // biến thành chuỗi microtask vô hạn và treo cả tiến trình.
      const okJson = (data) => new Promise((r) => setTimeout(() => r({
        ok: true, status: 200, json: () => Promise.resolve(data), clone() { return this; }
      }), 5));

      win.fetch = (url, opts) => {
        const u = String(url);
        if (u.includes('/api/signal')) {
          const method = String((opts && opts.method) || 'GET').toUpperCase();
          if (method === 'POST') {
            let body = {};
            try { body = JSON.parse((opts && opts.body) || '{}'); } catch { body = {}; }
            if (body.action === 'join') calls.join++;
            if (body.action === 'leave') calls.leave++;
          } else if (u.includes('peerId=')) {
            calls.poll++;
          }
          return okJson({ peers: [], messages: [], rooms: [], onDuty: [], cursor: 0 });
        }
        return okJson({ success: true, users: [], prescriptionSigners: [], siteConfigs: [] });
      };

      Object.defineProperty(win.navigator, 'mediaDevices', {
        configurable: true,
        value: {
          getUserMedia: () => { calls.getUserMedia++; return Promise.resolve(stream); },
          enumerateDevices: () => {
            calls.enumerateDevices++;
            return Promise.resolve([{ kind: 'videoinput', deviceId: 'cam-wide', label: 'Camera góc rộng' }]);
          }
        }
      });

      win.RTCPeerConnection = class {
        constructor() { this.localDescription = { type: 'offer', sdp: 'v=0' }; this.remoteDescription = null; }
        addTrack() { return { replaceTrack: () => Promise.resolve() }; }
        getSenders() { return []; }
        addTransceiver() {}
        createOffer() { return Promise.resolve({ type: 'offer', sdp: 'v=0' }); }
        createAnswer() { return Promise.resolve({ type: 'answer', sdp: 'v=0' }); }
        setLocalDescription() { return Promise.resolve(); }
        setRemoteDescription() { return Promise.resolve(); }
        addIceCandidate() { return Promise.resolve(); }
        close() {}
        addEventListener() {}
      };
      win.RTCSessionDescription = (d) => d;
      win.RTCIceCandidate = (c) => c;

      win.AudioContext = win.webkitAudioContext = class {
        constructor() { this.currentTime = 0; this.destination = {}; }
        createOscillator() { return { type: '', frequency: { value: 0 }, connect() {}, start() {}, stop() {} }; }
        createGain() { return { gain: { setValueAtTime() {} }, connect() {} }; }
      };

      win.HTMLMediaElement.prototype.play = () => Promise.resolve();
      win.HTMLMediaElement.prototype.pause = () => {};
      win.scrollTo = () => {};
      win.print = () => {};
    }
  });
}

async function checkPage(page) {
  const problems = [];
  const abs = path.join(ROOT, page.file);
  if (!fs.existsSync(abs)) return [`[thiếu tệp] ${page.file}`];

  // jsdom không thực thi <script type="module">, nên gói lại thành IIFE async.
  let html = fs.readFileSync(abs, 'utf8').replace(
    /<script type="module">([\s\S]*?)<\/script>/,
    (_m, body) => `<script>(async () => {\n${body}\n})().catch(e => { window.__moduleError = e; });</script>`
  );

  const calls = { getUserMedia: 0, enumerateDevices: 0, join: 0, poll: 0, leave: 0, trackStop: 0 };
  const win = buildWindow(html, page.route, calls).window;

  await Promise.race([
    new Promise((r) => {
      if (win.document.readyState === 'complete') return r();
      win.addEventListener('load', r, { once: true });
    }),
    wait(8000)
  ]);

  try {
    win.eval(fs.readFileSync(path.join(ROOT, page.app), 'utf8'));
    win.document.dispatchEvent(new win.Event('DOMContentLoaded', { bubbles: true }));
  } catch (err) {
    return [`[${page.app}] ${err.message}`];
  }
  await wait(1000);

  // --- 1. Nạp trang xong thì phải im lặng tuyệt đối --------------------------
  if (calls.getUserMedia) problems.push(`Trang tự xin quyền camera/micro khi vừa nạp (${calls.getUserMedia} lần).`);
  if (calls.enumerateDevices) problems.push('Trang tự liệt kê thiết bị thu hình khi vừa nạp.');
  if (calls.join) problems.push(`Trang tự vào phòng khám từ xa khi vừa nạp (${calls.join} lần).`);
  if (calls.poll) problems.push('Trang tự mở vòng long-poll signaling khi chưa gọi.');

  const $ = (id) => win.document.getElementById(id);
  if ($('local-media-idle') && $('local-media-idle').classList.contains('hidden')) {
    problems.push('Tấm che khung hình tại chỗ không hiện lúc chưa gọi.');
  }
  if ($('btn-end-call') && !$('btn-end-call').classList.contains('hidden')) {
    problems.push('Nút "Kết thúc cuộc gọi" hiện ra khi chưa có cuộc gọi nào.');
  }
  if ($('btn-toggle-mic') && !$('btn-toggle-mic').disabled) {
    problems.push('Nút micro chưa bị khoá lúc chưa gọi.');
  }

  // --- 2. Bấm nút thiết bị lúc chưa gọi cũng không được mở cam/mic ----------
  try {
    win.toggleMic();
    win.toggleVideo();
    await win.toggleCameraDevice();
  } catch (err) {
    problems.push(`Nút thiết bị ném lỗi lúc chưa gọi: ${err.message}`);
  }
  if (calls.getUserMedia) problems.push('Bấm nút mic/camera lúc chưa gọi vẫn mở được thiết bị.');

  // --- 3. Bấm nút gọi mới mở thiết bị, bấm kết thúc phải trả lại thiết bị ---
  if (typeof win.startTeleconsultation !== 'function' || typeof win.endTeleconsultation !== 'function') {
    problems.push('Thiếu window.startTeleconsultation / window.endTeleconsultation.');
    return problems;
  }

  await win.startTeleconsultation();
  await wait(500);
  if (!calls.getUserMedia) problems.push('Bấm "Bắt đầu cuộc gọi" nhưng không mở camera/micro.');
  if (!calls.join) problems.push('Bấm "Bắt đầu cuộc gọi" nhưng không vào phòng khám.');

  win.endTeleconsultation();
  await wait(300);
  if (!calls.leave) problems.push('Kết thúc cuộc gọi nhưng không rời phòng khám.');
  if (!calls.trackStop) problems.push('Kết thúc cuộc gọi nhưng không dừng track - đèn camera vẫn sáng.');

  const joinsBefore = calls.join;
  await wait(1500);
  if (calls.join > joinsBefore) problems.push('Sau khi kết thúc, trang vẫn tự vào lại phòng khám.');

  return problems;
}

let failed = 0;
for (const page of PAGES) {
  const problems = await checkPage(page);
  if (problems.length) {
    failed += problems.length;
    console.log(`✗ ${page.file} ${page.route}`);
    for (const p of problems) console.log(`   - ${p}`);
  } else {
    console.log(`✓ ${page.file} ${page.route} - không chạm camera/micro/phòng khám khi chưa bấm nút gọi`);
  }
}

console.log(failed
  ? `\nCó ${failed} vấn đề về quyền truy cập thiết bị.`
  : '\nBảng điều khiển im lặng cho tới khi cán bộ trực bấm nút gọi.');
process.exit(failed ? 1 : 0);
