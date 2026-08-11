// Telehealth Station Application Logic - Vanilla JS

/**
 * Danh sách điểm phòng khám / điểm trạm y tế khu vực.
 *
 * Danh mục gốc nằm ở `window.TELEHEALTH_STATIONS` (khai báo trong index.html) để
 * ô chọn điểm phòng khám của người dân, ô chọn điểm trạm khi đăng nhập và bảng
 * điều khiển này luôn dùng chung một danh sách. Mảng dưới đây chỉ là bản dự
 * phòng khi app.js được nạp trước trang chính.
 */
const STATIONS = (typeof window !== 'undefined' && Array.isArray(window.TELEHEALTH_STATIONS) && window.TELEHEALTH_STATIONS.length)
  ? window.TELEHEALTH_STATIONS
  : [
      { code: 'TYT-BATXAT-01', name: 'Trạm Y tế Bát Xát (Trung tâm)' },
      { code: 'TYT-BATXAT-BQ-02', name: 'Điểm phòng khám Bản Qua' },
      { code: 'TYT-BATXAT-BV-03', name: 'Điểm phòng khám Bản Vược' },
      { code: 'TYT-BATXAT-QK-04', name: 'Điểm phòng khám Quang Kim' },
      { code: 'TYT-BATXAT-PN-05', name: 'Điểm phòng khám Phìn Ngan' }
    ];

/** Phòng trực mặc định của một điểm trạm, ví dụ TYT-YTY-03 -> room-tyt-yty-03. */
function defaultRoomForStation(code) {
  return 'room-' + stationSlug(code);
}

function stationSlug(code) {
  return String(code || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Suy ra điểm phòng khám đích từ mã phòng. Người dân gọi từ trang chính sẽ tạo
 * phòng dạng `room-<slug điểm khám>-<mã thời gian>`, nhờ vậy bảng điều khiển
 * biết cuộc gọi đang đổ chuông vào điểm nào mà không cần thêm cột trong CSDL.
 */
function stationFromRoomId(id) {
  const raw = String(id || '').toLowerCase();
  let best = null;
  for (const st of STATIONS) {
    const slug = stationSlug(st.code);
    if (raw === 'room-' + slug || raw.startsWith('room-' + slug + '-')) {
      if (!best || slug.length > stationSlug(best.code).length) best = st;
    }
  }
  return best;
}

function stationName(code) {
  const found = STATIONS.find(s => s.code === code);
  return found ? found.name : code;
}

let stationCode = 'TYT-BATXAT-01';
let operatorName = 'Y sĩ Nguyễn Văn A';
let role = 'station_operator';
let roomId = defaultRoomForStation(stationCode);

/**
 * Gọi API của Module Bảng điều khiển kèm phiếu phiên (JWT) do /api/station-auth cấp.
 *
 * Các tuyến /api/vitals và /api/examination-report chỉ nhận yêu cầu có quyền
 * "station"; nếu máy chủ trả 401/403 (phiếu hết hạn, tài khoản bị khoá, hoặc
 * Quản trị vừa thu hồi ô "Quyền truy cập Mod Bảng điều khiển điểm trạm") thì
 * đóng module và bắt đăng nhập lại thay vì để cán bộ thao tác vào khoảng không.
 */
async function stationApiFetch(url, options) {
  const opts = Object.assign({}, options);
  const token = (typeof window.getStationToken === 'function') ? window.getStationToken() : '';
  opts.headers = Object.assign({}, opts.headers || {});
  if (token) opts.headers['Authorization'] = 'Bearer ' + token;

  const res = await fetch(url, opts);
  if (res.status === 401 || res.status === 403) {
    const data = await res.clone().json().catch(() => null);
    const message = (data && data.error) || 'Phiên làm việc không còn hiệu lực. Vui lòng đăng nhập lại.';
    if (typeof window.handleStationAuthFailure === 'function') {
      window.handleStationAuthFailure(message);
    }
    throw new Error(message);
  }
  return res;
}

// Signaling chạy qua HTTP long-poll (/api/signal) thay cho WebSocket:
// nền tảng serverless không giữ kết nối socket lâu dài, và đây cũng chính là
// giao thức mà màn hình Y sĩ/ Bác sĩ trong trang chính đang dùng.
const SIGNAL_URL = '/api/signal';
// Sàn nghỉ tối thiểu giữa hai lượt long-poll, chống quay vòng không nghỉ.
const POLL_MIN_GAP_MS = 500;
let peerId = null;
let signalCursor = 0;
let polling = false;
let pollToken = 0;
let pendingCandidates = [];
let iceQueue = [];
let iceQueueTimer = null;
let remotePeerName = null;
let isConnected = false;
let rejoinTimer = null;
let rejoinAttempts = 0;

let peerConnection = null;
let localStream = null;
/**
 * Luồng THỰC SỰ gửi đi: tiếng đã qua chuỗi lọc chống vang/chống hú của
 * CallAudio, kèm nguyên các track hình. Tách khỏi `localStream` vì `localStream`
 * phải luôn là luồng gốc của thiết bị - chỉ stop() đúng luồng đó thì đèn báo
 * camera/micro của máy mới tắt khi kết thúc cuộc gọi.
 */
let outboundStream = null;
let videoDevices = [];
let currentCamIndex = 0;

/**
 * Phiên khám từ xa chỉ mở khi cán bộ trực bấm nút ("Bắt đầu cuộc gọi" trên thanh
 * điều khiển, hoặc "Tiếp nhận" một cuộc gọi đang chờ trong hàng đợi).
 *
 * Trước thời điểm đó bảng điều khiển KHÔNG vào phòng signaling và KHÔNG xin
 * quyền camera/micro: mở bảng điều khiển để nhập sinh hiệu hay in phiếu khám
 * không phải là lý do để đèn camera của máy trạm sáng lên, và cũng không nên
 * làm điểm trạm hiện ra trong hàng đợi của tuyến trên như đang chờ hội chẩn.
 */
let callActive = false;

let isMicMuted = false;
let isVideoMuted = false;
let isListeningSTT = false;
let speechRecognition = null;

let callTimerSeconds = 0;
let callTimerInterval = null;

let currentVitals = {
  bpSys: 135,
  bpDia: 85,
  heartRate: 82,
  spo2: 97,
  temperature: 37.2,
  weight: 62
};

let cmsUsers = [];
let cmsSigners = [];
let loggedInCmsUser = null;
let queuePollInterval = null;

/** Kết quả phân tích gần nhất của Trợ lý AI lâm sàng (dùng khi xuất phiếu khám). */
let currentAIAnalysis = null;

// Initialize Application
let stationPanelStarted = false;
function startStationPanel() {
  // Chỉ khởi tạo một lần: nếu chạy hai lần sẽ có hai vòng long-poll và hai bộ
  // đếm thời gian cùng hoạt động, làm lưu lượng gọi /api/signal tăng gấp đôi.
  if (stationPanelStarted) return;
  stationPanelStarted = true;

  console.log('🚀 Initializing Telehealth Station Panel...');

  // Đồng bộ tên điểm trạm / cán bộ trực lên tiêu đề bảng điều khiển
  renderStationIdentity();

  // Tải dữ liệu tài khoản và bác sĩ từ CMS
  loadCmsData();

  // Hàng đợi cuộc gọi CỐ Ý không được quét ở đây. Người dân mở trang chủ không
  // phải là cán bộ trực, nên trình duyệt của họ không được tự động gọi sang
  // kênh tiếp nhận của điểm trạm. Vòng quét chỉ chạy khi Bảng điều khiển được
  // mở sau khi đăng nhập (window.openStationPanel gọi startQueuePolling).

  // Camera, micro và phòng khám từ xa CỐ Ý không được khởi động ở đây: chúng chỉ
  // mở khi cán bộ trực bấm "Bắt đầu cuộc gọi" hoặc "Tiếp nhận" một cuộc gọi chờ.
  updateCallControlsUI();
  updateConnectionBadge(false, 'Chưa kết nối - bấm "Bắt đầu cuộc gọi"');

  // Initialize Speech-to-Text Engine
  initSpeechRecognition();

  // Đẩy ghi chép lâm sàng gõ tay sang tuyến trên theo nhịp
  const notesEl = document.getElementById('clinical-notes');
  if (notesEl) notesEl.addEventListener('input', scheduleNotesSync);
}

// app.js được nạp với thuộc tính defer nên thường chạy trước DOMContentLoaded,
// nhưng nếu tệp bị nạp muộn (bộ nhớ đệm, chèn động) thì sự kiện đã đi qua và
// bảng điều khiển sẽ không bao giờ khởi tạo - nên xét luôn cả readyState.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startStationPanel, { once: true });
} else {
  // Hoãn sang microtask kế tiếp để mọi khai báo let/const ở cuối tệp kịp khởi
  // tạo trước khi khởi động (nếu gọi ngay tại đây sẽ vướng vùng chết TDZ).
  Promise.resolve().then(startStationPanel);
}

/** Hiển thị mã điểm trạm, tên điểm trạm và cán bộ trực trên mọi vị trí liên quan. */
function renderStationIdentity() {
  const elCode = document.getElementById('display-station-code');
  if (elCode) {
    elCode.textContent = stationCode;
    elCode.title = stationName(stationCode);
  }

  const elOp = document.getElementById('display-operator-name');
  if (elOp) elOp.textContent = operatorName;

  ['input-station-code', 'station-switcher'].forEach(id => {
    const sel = document.getElementById(id);
    if (sel && sel.value !== stationCode) sel.value = stationCode;
  });
}

/**
 * Chuyển sang một điểm trạm khu vực khác: rời phòng trực cũ và vào phòng trực
 * của điểm trạm mới để tuyến trên nhìn thấy đúng nơi đang cần hỗ trợ.
 */
function switchStation(code) {
  if (!code || code === stationCode) return;

  const previousPeerId = peerId;
  const previousRoomId = roomId;

  stationCode = code;
  roomId = defaultRoomForStation(code);
  renderStationIdentity();

  if (previousPeerId && previousRoomId) {
    fetch(SIGNAL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'leave', roomId: previousRoomId, peerId: previousPeerId })
    }).catch(() => {});
  }

  appendChatMessage('Hệ thống', `Đã chuyển sang ${stationName(code)} [${code}].`);

  // Chỉ vào phòng của điểm trạm mới khi đang thực sự có cuộc gọi. Đổi điểm trạm
  // lúc chưa gọi chỉ là chọn nơi trực, không phải lệnh mở cuộc gọi.
  if (callActive) {
    joinRoom();
  } else {
    updateConnectionBadge(false, 'Chưa kết nối - bấm "Bắt đầu cuộc gọi"');
  }
}

/* ===========================================================================
   PHIÊN GỌI KHÁM TỪ XA - MỞ VÀ ĐÓNG BẰNG THAO TÁC CỦA CÁN BỘ TRỰC
   =========================================================================== */

/**
 * Mở phiên khám từ xa: xin quyền camera/micro rồi mới vào phòng signaling.
 * Đây là lối vào DUY NHẤT bật thiết bị thu hình/thu tiếng của điểm trạm.
 */
async function startTeleconsultation(targetRoomId) {
  if (callActive) {
    appendChatMessage('Hệ thống', 'Cuộc gọi đang diễn ra.');
    return;
  }

  if (targetRoomId) roomId = targetRoomId;
  if (!roomId) roomId = defaultRoomForStation(stationCode);

  callActive = true;
  updateCallControlsUI();
  updateConnectionBadge(false, 'Đang mở camera và micro...');
  appendChatMessage('Hệ thống', 'Đang xin quyền camera và micro của thiết bị...');

  await initLocalCamera();

  // Cán bộ trực có thể đã bấm "Kết thúc cuộc gọi" trong lúc trình duyệt còn đang
  // hỏi quyền truy cập - khi đó phải trả lại thiết bị chứ không vào phòng khám.
  if (!callActive) {
    releaseLocalMedia();
    return;
  }

  startCallTimer();
  await joinRoom();
}

/**
 * Đóng phiên khám: rời phòng signaling, đóng kết nối ngang hàng và TẮT HẲN
 * camera/micro (gọi track.stop() nên đèn báo camera của máy cũng tắt theo).
 */
function endTeleconsultation(options) {
  const silent = options && options.silent;
  const wasActive = callActive;
  callActive = false;

  stopPolling();
  if (rejoinTimer) {
    clearTimeout(rejoinTimer);
    rejoinTimer = null;
  }
  rejoinAttempts = 0;

  if (roomId && peerId) {
    fetch(SIGNAL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'leave', roomId, peerId }),
      keepalive: true
    }).catch(() => {});
  }
  peerId = null;

  if (peerConnection) {
    try {
      peerConnection.ontrack = null;
      peerConnection.onicecandidate = null;
      peerConnection.close();
    } catch (err) {}
    peerConnection = null;
  }

  releaseLocalMedia();
  stopCallTimer();
  stopSpeechToText();

  isConnected = false;
  remotePeerName = null;
  pendingCandidates = [];
  iceQueue = [];
  if (iceQueueTimer) { clearTimeout(iceQueueTimer); iceQueueTimer = null; }
  showRemotePlaceholder();
  updateCallControlsUI();
  updateConnectionBadge(false, 'Chưa kết nối - bấm "Bắt đầu cuộc gọi"');

  /* Kết thúc cuộc gọi là thoát hẳn khỏi chức năng gọi điện: bảng điều khiển
     không được nằm lại ở dạng khung nổi hay bị ẩn sau thẻ khôi phục, vì lúc đó
     không còn cuộc gọi nào để chạy nền nữa. */
  if (window.TeleWin) window.TeleWin.exit('modal-station-panel');

  if (wasActive && !silent) {
    appendChatMessage('Hệ thống', 'Đã kết thúc cuộc gọi. Camera và micro của điểm trạm đã tắt.');
  }
}

/** Trả camera/micro về cho hệ điều hành và xoá hình xem trước tại chỗ. */
function releaseLocalMedia() {
  try { CallAudio.release(); } catch (err) {}
  if (localStream) {
    localStream.getTracks().forEach(track => {
      try { track.stop(); } catch (err) {}
    });
    localStream = null;
  }
  outboundStream = null;
  videoDevices = [];
  currentCamIndex = 0;
  isMicMuted = false;
  isVideoMuted = false;

  const localVideo = document.getElementById('local-video');
  if (localVideo) localVideo.srcObject = null;
  const remoteVideo = document.getElementById('remote-video');
  if (remoteVideo) {
    try { CallAudio.detachRemote(remoteVideo); } catch (err) {}
  }
  renderAudioPanel();
}

/**
 * Đồng bộ thanh điều khiển với trạng thái phiên gọi: lúc chưa gọi thì hiện nút
 * "Bắt đầu cuộc gọi", khoá các nút camera/micro và bật tấm che khung hình tại
 * chỗ để không ai tưởng camera đang chạy.
 */
function updateCallControlsUI() {
  const startBtn = document.getElementById('btn-start-call');
  if (startBtn) startBtn.classList.toggle('hidden', callActive);

  const endBtn = document.getElementById('btn-end-call');
  if (endBtn) endBtn.classList.toggle('hidden', !callActive);

  /* Nút "Kết thúc cuộc gọi" trên thanh tiêu đề của module: luôn nhìn thấy dù cán
     bộ đã cuộn xuống phần sinh hiệu hay biên bản, không phải tìm lại thanh điều
     khiển dưới khung hình. Nút dùng display:flex nên phải gỡ cả lớp `hidden`. */
  const endBtnHeader = document.getElementById('btn-end-call-header');
  if (endBtnHeader) {
    endBtnHeader.classList.toggle('hidden', !callActive);
    endBtnHeader.classList.toggle('flex', callActive);
  }

  ['btn-toggle-camera', 'btn-toggle-mic', 'btn-toggle-video'].forEach(id => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.disabled = !callActive;
    btn.classList.toggle('opacity-40', !callActive);
    btn.classList.toggle('cursor-not-allowed', !callActive);
  });

  const idleCover = document.getElementById('local-media-idle');
  if (idleCover) idleCover.classList.toggle('hidden', callActive);

  const camStatus = document.getElementById('camera-status-text');
  if (camStatus && !callActive) {
    camStatus.textContent = 'Camera & micro đang TẮT - chỉ bật khi bắt đầu cuộc gọi khám từ xa.';
  }
}

// Load CMS Users & Prescription Signers
async function loadCmsData() {
  try {
    const res = await fetch('/api/cms');
    if (res.ok) {
      const data = await res.json();
      if (data.users && Array.isArray(data.users)) cmsUsers = data.users;
      if (data.prescriptionSigners && Array.isArray(data.prescriptionSigners)) cmsSigners = data.prescriptionSigners;
      
      populateCmsAccountsDropdown();
      syncConsultingDoctorsList();
    }
  } catch (err) {
    console.warn('Không tải được dữ liệu CMS:', err.message);
  }
}

// Populate CMS Accounts Dropdown in Login Modal
function populateCmsAccountsDropdown() {
  const selectEl = document.getElementById('input-cms-account');
  if (!selectEl) return;

  /* Chỉ liệt kê tài khoản đã được CMS Quản trị cấp quyền vào Bảng điều khiển trạm.
     Cột stationAccess mới thêm nên tài khoản cũ có thể còn trống - khi đó suy ra từ
     vai trò, đúng như quy tắc mà /api/station-auth áp dụng ở phía máy chủ. Máy chủ
     vẫn là nơi quyết định cuối cùng, danh sách này chỉ để tránh chọn nhầm. */
  const hasStationAccess = (u) => {
    if (!u) return false;
    if ((u.status || 'ACTIVE').toUpperCase() === 'DISABLED') return false;
    if (u.stationAccess === 'true') return true;
    if (u.stationAccess === 'false') return false;
    return /Điểm trạm|Station|Admin|Quản trị/i.test(u.role || '');
  };

  const stationAccounts = cmsUsers.filter(hasStationAccess);
  /* Nếu chưa tài khoản nào được tích quyền thì vẫn liệt kê hết để Quản trị đăng nhập
     lần đầu mà thiết lập; máy chủ vẫn từ chối tài khoản không có quyền. */
  const accountsToRender = stationAccounts.length > 0
    ? stationAccounts
    : cmsUsers.filter(u => (u.status || 'ACTIVE').toUpperCase() !== 'DISABLED');

  selectEl.innerHTML = '<option value="">-- Chọn tài khoản cán bộ trực trạm --</option>' +
    accountsToRender.map(u => `<option value="${u.username}">${u.name} (${u.role}) - ${u.username}</option>`).join('');

  // Tự động chọn tài khoản cán bộ trạm mặc định nếu có
  const defaultAcc = accountsToRender.find(u => u.username === 'canbotram@laocai.gov.vn') || accountsToRender[0];
  if (defaultAcc) {
    selectEl.value = defaultAcc.username;
    onCmsAccountSelect(defaultAcc.username);
  }
}

function onCmsAccountSelect(username) {
  if (!username) return;
  const found = cmsUsers.find(u => u.username === username);
  if (found) {
    loggedInCmsUser = found;
    operatorName = found.name;
    const nameInput = document.getElementById('input-operator-name');
    if (nameInput) nameInput.value = found.name;
  }
}

// Quét hàng đợi các cuộc gọi từ người dân (User Video Calls)
function startQueuePolling() {
  if (queuePollInterval) clearInterval(queuePollInterval);
  refreshIncomingCallsQueue();
  queuePollInterval = setInterval(refreshIncomingCallsQueue, 3500);
}

/** Dừng quét hàng đợi khi cán bộ đăng xuất khỏi Bảng điều khiển. */
function stopQueuePolling() {
  if (queuePollInterval) clearInterval(queuePollInterval);
  queuePollInterval = null;
}

/** Hàng đợi lần quét gần nhất - nút "Tiếp nhận nhanh" đọc lại từ đây. */
let pendingCallQueue = [];

/** Bọc chuỗi để nhúng an toàn vào thuộc tính onclick trong chuỗi HTML. */
function queueAttr(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, '\\&#39;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Bọc chuỗi để hiển thị trong nội dung HTML. */
function queueText(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Thời gian người dân đã chờ máy, hiển thị dạng "2 phút 05 giây". */
function queueWaitedLabel(since) {
  const started = Number(since);
  if (!started) return '';
  const secs = Math.max(0, Math.floor((Date.now() - started) / 1000));
  const mm = Math.floor(secs / 60);
  const ss = String(secs % 60).padStart(2, '0');
  return mm > 0 ? `${mm} phút ${ss} giây` : `${ss} giây`;
}

/**
 * Cập nhật nút "Tiếp nhận cuộc gọi" đặt ngay dưới khung hàng đợi.
 *
 * Nút bấm được là khi có ít nhất một cuộc gọi chưa ai tiếp nhận; ưu tiên cuộc
 * gọi đổ chuông đúng vào điểm trạm cán bộ đang trực, sau đó tới cuộc chờ lâu nhất.
 */
function updateQueueAcceptButton() {
  const btn = document.getElementById('station-queue-accept-btn');
  const label = document.getElementById('station-queue-accept-label');
  const next = nextPendingCall();

  if (btn) btn.disabled = !next;
  if (!label) return;

  if (!next) {
    label.textContent = 'Chưa có cuộc gọi chờ';
    return;
  }
  const pName = next.patientName || 'Bệnh nhân';
  label.textContent = next.roomId === roomId && callActive
    ? `Đang kết nối với ${pName}`
    : `Tiếp nhận cuộc gọi - ${pName}`;
}

/** Cuộc gọi sẽ được nhận khi bấm nút tiếp nhận nhanh. */
function nextPendingCall() {
  const waiting = pendingCallQueue.filter(r => !r.hasDoctor);
  if (!waiting.length) return null;
  const mine = waiting.filter(r => {
    const target = stationFromRoomId(r.roomId);
    return target && target.code === stationCode;
  });
  const pool = mine.length ? mine : waiting;
  return pool.slice().sort((a, b) => Number(a.since || 0) - Number(b.since || 0))[0];
}

/** Nút "Tiếp nhận cuộc gọi" của khung "Cuộc gọi chờ từ Người dân". */
function acceptNextPatientCall() {
  const next = nextPendingCall();
  if (!next) {
    showAlertBanner('Hiện chưa có cuộc gọi nào của người dân đang chờ tiếp nhận.');
    return;
  }
  acceptPatientCall(next.roomId, next.patientName || 'Bệnh nhân', next.symptoms || '');
}

async function refreshIncomingCallsQueue() {
  try {
    const res = await fetch('/api/signal?action=rooms');
    if (!res.ok) return;
    const data = await res.json();
    const rooms = (data.rooms || []).filter(r => r.roomId !== '__lobby__');
    pendingCallQueue = rooms;

    const countEl = document.getElementById('station-queue-count');
    const listEl = document.getElementById('station-queue-list');
    if (countEl) countEl.textContent = `${rooms.length} cuộc gọi`;

    updateQueueAcceptButton();

    if (!listEl) return;
    if (rooms.length === 0) {
      listEl.innerHTML = '<div class="text-[11px] text-slate-400 italic">Hiện không có người dân nào đang gọi. Đang chờ kết nối...</div>';
      return;
    }

    listEl.innerHTML = rooms.map(r => {
      const pName = r.patientName || 'Bệnh nhân';
      const isCurrent = r.roomId === roomId && callActive;
      // Người dân đã chọn điểm phòng khám nào thì hiện đúng tên điểm đó, và tô
      // đậm khi cuộc gọi đang đổ chuông vào chính điểm trạm cán bộ đang trực.
      const target = stationFromRoomId(r.roomId);
      const forMe = target && target.code === stationCode;
      const targetBadge = target
        ? `<span class="text-[9px] px-1.5 py-0.5 rounded font-bold ${forMe ? 'bg-emerald-700 text-emerald-100' : 'bg-slate-700 text-slate-300'}">
             <i class="fa-solid fa-location-dot"></i> ${queueText(target.name)}
           </span>`
        : '';
      const waited = queueWaitedLabel(r.since);
      // Thẻ xếp dọc: tên bệnh nhân, triệu chứng rồi tới nút tiếp nhận chiếm trọn
      // bề ngang. Cách xếp ngang trước đây làm nút bị đẩy khuất khỏi cột hẹp của
      // Bảng điều khiển khi tên bệnh nhân hoặc tên điểm trạm dài.
      return `
        <div class="bg-slate-900 border ${isCurrent ? 'border-emerald-500' : (forMe ? 'border-emerald-700' : 'border-slate-700')} p-2.5 rounded-xl text-xs shadow space-y-2">
          <div class="flex items-start gap-2">
            <i class="fa-solid fa-user text-blue-400 mt-0.5"></i>
            <div class="min-w-0 flex-1">
              <div class="font-bold text-white text-[12px] break-words">${queueText(pName)}</div>
              <div class="mt-0.5 flex flex-wrap items-center gap-1">
                ${targetBadge}
                ${waited ? `<span class="text-[9px] px-1.5 py-0.5 rounded font-bold bg-amber-900/70 text-amber-200"><i class="fa-regular fa-clock"></i> Chờ ${waited}</span>` : ''}
                ${r.hasDoctor ? '<span class="text-[9px] px-1.5 py-0.5 rounded font-bold bg-slate-700 text-slate-300">Đã có cán bộ</span>' : ''}
              </div>
              <div class="text-[10px] text-slate-400 mt-1 break-words">${queueText(r.symptoms || 'Khám sức khỏe tổng quát')}</div>
            </div>
          </div>
          <button type="button"
            onclick="acceptPatientCall('${queueAttr(r.roomId)}', '${queueAttr(pName)}', '${queueAttr(r.symptoms || '')}')"
            title="Tiếp nhận cuộc gọi của ${queueText(pName)} - lúc này mới mở camera và micro của điểm trạm"
            class="${isCurrent ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-blue-600 hover:bg-blue-500'} w-full text-white font-bold px-3 py-2 rounded-lg text-[11px] transition flex items-center justify-center gap-1.5">
            <i class="fa-solid fa-headset"></i> ${isCurrent ? 'Đang kết nối' : 'Tiếp nhận cuộc gọi'}
          </button>
        </div>
      `;
    }).join('');
  } catch (err) {
    console.warn('Lỗi quét hàng đợi cuộc gọi:', err.message);
  }
}

// Tiếp nhận cuộc gọi từ giao diện người dân gọi
function acceptPatientCall(targetRoomId, patientName, symptoms) {
  if (!targetRoomId) return;

  // Tiếp nhận cuộc gọi thì bảng điều khiển phải hiện lại đầy đủ, kể cả khi cán
  // bộ đang để nó ở dạng khung nổi hoặc đã ẩn để làm việc khác.
  if (window.TeleWin) window.TeleWin.set('modal-station-panel', 'normal');

  const previousPeerId = peerId;
  const previousRoomId = roomId;

  roomId = targetRoomId;

  // Cập nhật thông tin bệnh nhân trên giao diện điểm trạm
  const pNameInput = document.getElementById('patient-name');
  const pSymInput = document.getElementById('patient-symptoms');
  if (pNameInput) pNameInput.value = patientName || 'Bệnh nhân';
  if (pSymInput) pSymInput.value = symptoms || '';

  const hudName = document.getElementById('hud-patient-name');
  if (hudName) hudName.textContent = patientName || 'Bệnh nhân';

  // Rời phòng cũ nếu đang ở phòng khác
  if (previousPeerId && previousRoomId && previousRoomId !== targetRoomId) {
    fetch(SIGNAL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'leave', roomId: previousRoomId, peerId: previousPeerId })
    }).catch(() => {});
  }

  // Bấm "Tiếp nhận" chính là thao tác vào cuộc gọi: đến đây mới mở camera/micro.
  if (callActive) {
    joinRoom();
  } else {
    startTeleconsultation(targetRoomId);
  }
  showAlertBanner(`Đã tiếp nhận và kết nối với bệnh nhân: ${patientName}`);
  // Nhãn nút tiếp nhận phải đổi ngay, không đợi tới nhịp quét hàng đợi kế tiếp.
  updateQueueAcceptButton();
}

// Đồng bộ danh sách Bác sĩ tư vấn & được cấp quyền nhận cuộc gọi Video + Ký số
function syncConsultingDoctorsList() {
  const doctors = cmsUsers.filter(u => u.canReceiveVideo === 'true');
  console.log('🩺 Danh sách Bác sĩ tư vấn được phân quyền khám video & ký số:', doctors);
}

// 1. HTTP Signaling & WebRTC Logic
function newPeerId() {
  return `station-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

/** Vai trò gửi lên máy chủ chỉ có 'station' hoặc 'doctor'. */
function signalRole() {
  return role === 'superior_doctor' ? 'doctor' : 'station';
}

async function signalPost(body) {
  const res = await fetch(SIGNAL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ roomId, peerId }, body))
  });
  if (!res.ok) throw new Error('Signaling lỗi ' + res.status);
  return res.json();
}

function sendSignal(type, payload, to) {
  if (!roomId || !peerId) return Promise.resolve();
  return signalPost({ action: 'signal', type, payload: payload === undefined ? null : payload, to: to || null })
    .catch(err => console.warn(`Không gửi được bản tin "${type}":`, err.message));
}

async function joinRoom() {
  // Rào chắn cuối cùng: không bao giờ đăng ký điểm trạm vào phòng signaling khi
  // cán bộ trực chưa bấm nút gọi. Mọi lối gọi tới đây (đổi điểm trạm, đăng nhập,
  // thử kết nối lại, gọi tay từ console) đều bị chặn nếu chưa có phiên gọi.
  if (!callActive) {
    console.warn('Bỏ qua joinRoom(): chưa bắt đầu cuộc gọi khám từ xa.');
    updateConnectionBadge(false, 'Chưa kết nối - bấm "Bắt đầu cuộc gọi"');
    return;
  }

  stopPolling();
  if (rejoinTimer) {
    clearTimeout(rejoinTimer);
    rejoinTimer = null;
  }
  peerId = newPeerId();
  signalCursor = 0;
  pendingCandidates = [];
  isConnected = false;

  initPeerConnection();

  try {
    const joined = await signalPost({
      action: 'join',
      role: signalRole(),
      name: `${operatorName} (${stationCode})`,
      patientName: document.getElementById('patient-name')?.value || 'Bệnh nhân',
      symptoms: document.getElementById('patient-symptoms')?.value || ''
    });

    rejoinAttempts = 0;
    signalCursor = joined.cursor || 0;
    updateConnectionBadge(true, 'Đã vào phòng khám - chờ tiếp nhận');
    appendChatMessage('Hệ thống', `Đã vào phòng khám [${roomId}].`);

    if (joined.room && joined.room.vitals) updateVitalsUIFromRemote(joined.room.vitals);
    if (joined.room && joined.room.notes) {
      const notesEl = document.getElementById('clinical-notes');
      if (notesEl && !notesEl.value) notesEl.value = joined.room.notes;
    }

    // Bắt đầu nhận bản tin trước khi chào mời để không bỏ lỡ answer.
    polling = true;
    pollToken += 1;
    pollLoop(pollToken);

    // Bên vào phòng sau chịu trách nhiệm tạo offer -> chỉ có duy nhất một bên gọi.
    if (joined.peers && joined.peers.length) {
      remotePeerName = joined.peers[0].name;
      appendChatMessage('Hệ thống', `${remotePeerName} đang trong phòng - đang bắt tay kết nối...`);
      await createWebRTCOffer();
    } else {
      appendChatMessage('Hệ thống', 'Đang chờ Y sĩ/ Bác sĩ tiếp nhận cuộc gọi...');
    }
  } catch (err) {
    console.error('Không vào được phòng khám:', err);
    scheduleRejoin();
  }
}

/**
 * Thử vào lại phòng khám với thời gian chờ tăng dần (3s -> 6s -> 12s -> 24s,
 * tối đa 30s). Lịch cũ luôn bị huỷ trước khi đặt lịch mới để không có nhiều
 * vòng joinRoom cùng chạy song song, gây nhân đôi lưu lượng gọi /api/signal.
 */
function scheduleRejoin() {
  if (rejoinTimer) clearTimeout(rejoinTimer);
  // Không tự vào lại phòng khi cuộc gọi đã kết thúc - nếu không thì nút "Kết
  // thúc cuộc gọi" sẽ bị một hẹn giờ cũ kéo ngược vào phòng khám.
  if (!callActive) return;
  const delay = Math.min(3000 * Math.pow(2, rejoinAttempts), 30000);
  rejoinAttempts += 1;
  updateConnectionBadge(false, `Mất kết nối - thử lại sau ${Math.round(delay / 1000)}s...`);
  rejoinTimer = setTimeout(() => {
    rejoinTimer = null;
    joinRoom();
  }, delay);
}

function stopPolling() {
  polling = false;
  pollToken += 1;
}

async function pollLoop(token) {
  let backoff = 0;
  while (polling && pollToken === token) {
    try {
      const url = `${SIGNAL_URL}?roomId=${encodeURIComponent(roomId)}&peerId=${encodeURIComponent(peerId)}&cursor=${signalCursor}`;
      const startedAt = Date.now();
      const res = await fetch(url);
      if (!res.ok) throw new Error('poll ' + res.status);
      const data = await res.json();
      if (!polling || pollToken !== token) return;

      backoff = 0;
      if (typeof data.cursor === 'number') signalCursor = data.cursor;
      updateConnectionBadge(true, isConnected ? 'Đang kết nối với tuyến trên' : 'Đã vào phòng khám - chờ tiếp nhận');

      const messages = data.messages || [];
      for (const msg of messages) {
        await handleSignalMessage(msg);
      }

      // /api/signal giữ mỗi yêu cầu tới 7 giây trước khi trả về rỗng. Nếu nó
      // trả ngay mà không có bản tin nào (hàm bị cấu hình sai, phản hồi đổi
      // dạng...) thì vòng lặp này sẽ quay không nghỉ và gọi hàm hàng trăm lần
      // mỗi phút - nên đặt sàn nghỉ tối thiểu giữa hai lượt hỏi.
      if (!messages.length && Date.now() - startedAt < POLL_MIN_GAP_MS) {
        await new Promise(r => setTimeout(r, POLL_MIN_GAP_MS));
      }
    } catch (err) {
      if (!polling || pollToken !== token) return;
      console.warn('Mất tín hiệu signaling, đang thử lại...', err.message);
      updateConnectionBadge(false, 'Mất kết nối - đang thử lại...');
      // Giãn dần nhịp thử lại (2s -> 4s -> 8s, tối đa 15s) để một hàm
      // /api/signal đang lỗi không bị dội hàng trăm yêu cầu mỗi phút.
      backoff = backoff ? Math.min(backoff * 2, 15000) : 2000;
      await new Promise(r => setTimeout(r, backoff));
    }
  }
}

async function handleSignalMessage(msg) {
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case 'peer-joined': {
      remotePeerName = (msg.payload && msg.payload.name) || 'Y sĩ/ Bác sĩ';
      appendChatMessage('Hệ thống', `${remotePeerName} đã tham gia phòng khám.`);
      // Không tạo offer ở đây: bên vừa vào phòng mới là bên gọi.
      break;
    }

    case 'offer':
      await handleWebRTCOffer(msg.payload);
      break;

    case 'answer':
      await handleWebRTCAnswer(msg.payload);
      break;

    case 'ice':
      await handleWebRTCIceCandidate(msg.payload);
      break;

    case 'chat':
      appendChatMessage(
        (msg.payload && msg.payload.sender) || remotePeerName || 'Trạm Y tế Bát Xát',
        (msg.payload && msg.payload.text) || '',
        new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
      );
      break;

    case 'vitals':
      updateVitalsUIFromRemote(msg.payload);
      break;

    case 'notes': {
      const text = msg.payload && msg.payload.notes;
      const notesEl = document.getElementById('clinical-notes');
      if (text && notesEl) notesEl.value = text;
      break;
    }

    case 'advice': {
      const advice = msg.payload && msg.payload.advice;
      if (advice) appendChatMessage('Chỉ định', advice);
      break;
    }

    case 'peer-left':
      isConnected = false;
      remotePeerName = null;
      appendChatMessage('Hệ thống', 'Đầu bên kia đã rời phòng khám.');
      showRemotePlaceholder();
      updateConnectionBadge(false, 'Tuyến trên đã rời phòng khám');
      break;

    /* Tuyến trên đã chốt "Hoàn thành lượt khám": buổi khám khép lại hoàn toàn,
       nên điểm trạm cũng thoát hẳn khỏi chức năng gọi - trả camera/micro về cho
       máy và đưa bảng điều khiển ra khỏi trạng thái khung nổi/ẩn. */
    case 'call-ended':
      isConnected = false;
      remotePeerName = null;
      appendChatMessage('Hệ thống', 'Tuyến trên đã hoàn thành lượt khám. Đang thoát khỏi cuộc gọi...');
      showRemotePlaceholder();
      updateConnectionBadge(false, 'Tuyến trên đã kết thúc lượt khám');
      setTimeout(() => endTeleconsultation(), 1200);
      break;

    default:
      break;
  }
}

function showRemotePlaceholder() {
  const remoteVideo = document.getElementById('remote-video');
  const remotePlaceholder = document.getElementById('remote-placeholder');
  if (remoteVideo) {
    remoteVideo.srcObject = null;
    remoteVideo.classList.add('hidden');
  }
  if (remotePlaceholder) remotePlaceholder.classList.remove('hidden');
}

// Rời phòng gọn gàng khi đóng tab để tuyến trên không thấy trạm "treo" trong hàng đợi.
window.addEventListener('pagehide', () => {
  if (!roomId || !peerId) return;
  try {
    fetch(SIGNAL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'leave', roomId, peerId }),
      keepalive: true
    }).catch(() => {});
  } catch (err) {}
});

function updateConnectionBadge(connected, text) {
  const badge = document.getElementById('connection-badge');
  const badgeText = document.getElementById('connection-status-text');

  if (badge) {
    badge.className = connected
      ? 'inline-flex items-center space-x-1 bg-emerald-950/80 border border-emerald-800/80 text-emerald-400 text-[10px] px-2 py-0.5 rounded-full'
      : 'inline-flex items-center space-x-1 bg-red-950/80 border border-red-800/80 text-red-400 text-[10px] px-2 py-0.5 rounded-full';
  }
  if (badgeText) badgeText.textContent = text;
}

/**
 * WebRTC chỉ tồn tại trên origin an toàn (https hoặc localhost) và trên trình
 * duyệt đủ mới. Kiểm tra trước để phần còn lại của bảng điều khiển (sinh hiệu,
 * trợ lý AI, phiếu khám A5) vẫn chạy khi không gọi được video.
 */
function webRTCSupported() {
  return typeof RTCPeerConnection === 'function'
    && typeof RTCSessionDescription === 'function'
    && typeof RTCIceCandidate === 'function';
}

let webRTCWarningShown = false;
function warnWebRTCUnavailable() {
  updateConnectionBadge(false, 'Trình duyệt không hỗ trợ gọi video');
  if (webRTCWarningShown) return;
  webRTCWarningShown = true;
  console.warn('WebRTC không khả dụng: cần trang https (hoặc localhost) và trình duyệt hỗ trợ.');
  appendChatMessage(
    'Hệ thống',
    'Thiết bị/trình duyệt này chưa gọi được video (cần truy cập bằng https). '
    + 'Các chức năng nhập sinh hiệu, trợ lý AI và in phiếu khám A5 vẫn dùng bình thường.'
  );
}

/* ===========================================================================
   BỘ XỬ LÝ ÂM THANH CUỘC GỌI (window.CallAudio)
   ---------------------------------------------------------------------------
   Phòng khám của điểm trạm là môi trường tệ nhất cho âm thanh hội thoại: mic và
   loa ngoài đặt cạnh nhau (cán bộ và bệnh nhân cùng nghe chung một loa), tường
   gạch trần phẳng gây vang, cộng thêm tiếng quạt, tiếng máy nén khí, tiếng
   người chờ khám ngoài hành lang. Ba hiện tượng người dùng phản ánh:

     1. Độ vang  - tiếng loa dội lại vào mic rồi truyền ngược sang đầu kia, đầu
                   kia nghe thấy chính mình chậm vài trăm ms.
     2. Tiếng hú - vòng lặp loa -> mic -> loa đạt hệ số khuếch đại >= 1 ở một
                   tần số nào đó và tự dao động, thành tiếng rít chói.
     3. Tạp âm   - mic thu cả tiếng nền phòng khám lẫn hành lang, lời thoại bị
                   lẫn trong nền ồn.

   Bốn lớp xử lý dưới đây giải quyết lần lượt:

     Lớp 1 - Ràng buộc thu: xin trình duyệt bật khử vọng (AEC), khử ồn (NS),
             tự cân mức (AGC) và tách giọng nói (voiceIsolation) ngay tại tầng
             thu của hệ điều hành. Đây là lớp mạnh nhất nhưng không đủ.
     Lớp 2 - Chuỗi lọc Web Audio trên đường TIẾNG ĐI: cắt trầm (quạt, rung bàn),
             cắt cao (rít, xì), nén động (kéo lời bệnh nhân ngồi xa lên ngang
             lời cán bộ ngồi gần mic), rồi cổng tạp âm (noise gate) đóng lại khi
             chỉ còn tiếng nền.
     Lớp 3 - Chống hú chủ động: theo dõi phổ tần của mic; khi phát hiện một đỉnh
             hẹp bám lì ở một tần số (dấu hiệu kinh điển của vòng hú), lập tức
             cắm bộ lọc chuông (notch) đúng tần số đó và ghìm mic trong chốc lát
             để bẻ gãy vòng lặp trước khi tai người kịp nghe thấy tiếng rít.
     Lớp 4 - Né vọng (ducking): khi đầu bên kia đang nói, hạ nhẹ mic của mình.
             Vòng loa -> mic không bao giờ khép kín được nữa nên hết vang.

   Toàn bộ chạy trong try/catch: trình duyệt cũ hoặc môi trường không có Web
   Audio sẽ dùng thẳng luồng mic gốc, cuộc gọi vẫn hoạt động bình thường.
   =========================================================================== */

/** Ba mức lọc tạp âm. Số liệu chọn theo dải tiếng nói 300-3400 Hz của điện thoại. */
const CALL_AUDIO_PROFILES = {
  off: {
    label: 'Tắt (giữ nguyên tiếng thu)',
    highpass: 20, lowpass: 20000,
    gate: false, gateMargin: 0, gateFloorDb: -120, gateFloorGain: 1, gateHoldMs: 0,
    compress: false, makeup: 1
  },
  medium: {
    label: 'Vừa (khuyến nghị)',
    highpass: 100, lowpass: 9000,
    gate: true, gateMargin: 9, gateFloorDb: -58, gateFloorGain: 0.18, gateHoldMs: 280,
    compress: true, makeup: 1.25
  },
  strong: {
    label: 'Mạnh (phòng khám ồn)',
    highpass: 145, lowpass: 7200,
    gate: true, gateMargin: 6, gateFloorDb: -50, gateFloorGain: 0.05, gateHoldMs: 220,
    compress: true, makeup: 1.5
  }
};

const CallAudio = (function createCallAudioEngine() {
  const STORAGE_KEY = 'tyt_call_audio_v1';

  const settings = {
    profile: 'medium',
    antiHowl: true,
    duck: true,
    speakerVolume: 1,
    micDeviceId: '',
    speakerDeviceId: ''
  };

  const metrics = {
    micLevel: 0,        // 0..1, mức tiếng vào mic sau khi lọc
    remoteLevel: 0,     // 0..1, mức tiếng ra loa
    noiseFloorDb: -70,  // ước lượng nền ồn phòng khám
    gateOpen: false,
    ducking: false,
    howling: false,
    howlHz: 0,
    howlCount: 0,
    active: false,
    processing: false   // true khi tiếng đi thực sự chạy qua chuỗi lọc
  };

  let ctx = null;
  let chain = null;          // chuỗi xử lý tiếng đi
  let rawStream = null;      // luồng gốc từ thiết bị (giữ để stop() đúng nguồn)
  let monitor = null;        // bộ đo tiếng về từ đầu bên kia
  let ticker = null;
  let notifyTimer = null;
  let muted = false;
  const remoteElements = new Set();
  const listeners = new Set();

  /* ---------------------------------------------------------------- tiện ích */

  function profile() {
    return CALL_AUDIO_PROFILES[settings.profile] || CALL_AUDIO_PROFILES.medium;
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (saved && typeof saved === 'object') {
        if (CALL_AUDIO_PROFILES[saved.profile]) settings.profile = saved.profile;
        if (typeof saved.antiHowl === 'boolean') settings.antiHowl = saved.antiHowl;
        if (typeof saved.duck === 'boolean') settings.duck = saved.duck;
        if (typeof saved.speakerVolume === 'number') {
          settings.speakerVolume = Math.min(1, Math.max(0, saved.speakerVolume));
        }
        if (typeof saved.micDeviceId === 'string') settings.micDeviceId = saved.micDeviceId;
        if (typeof saved.speakerDeviceId === 'string') settings.speakerDeviceId = saved.speakerDeviceId;
      }
    } catch (err) {
      // localStorage bị chặn (chế độ riêng tư) - dùng giá trị mặc định.
    }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (err) {}
  }

  /** Báo cho giao diện biết trạng thái mới (tối đa ~7 lần/giây, đủ mượt cho mắt). */
  function notify(force) {
    if (!force && notifyTimer) return;
    if (!force) {
      notifyTimer = setTimeout(() => { notifyTimer = null; emit(); }, 140);
      return;
    }
    emit();
  }

  function emit() {
    listeners.forEach(fn => {
      try { fn(getState()); } catch (err) {}
    });
  }

  function getState() {
    return Object.assign({}, settings, metrics, { profileLabel: profile().label });
  }

  function ensureContext() {
    if (ctx) return ctx;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (typeof Ctor !== 'function') return null;
    try {
      // 48 kHz là tần số lấy mẫu gốc của Opus/WebRTC: khớp sẵn thì không phải
      // đổi tần số lấy mẫu giữa chừng, tránh méo tiếng và tốn CPU vô ích.
      ctx = new Ctor({ latencyHint: 'interactive', sampleRate: 48000 });
    } catch (err) {
      try { ctx = new Ctor(); } catch (err2) { ctx = null; }
    }
    return ctx;
  }

  function resumeContext() {
    if (ctx && ctx.state === 'suspended' && typeof ctx.resume === 'function') {
      ctx.resume().catch(() => {});
    }
  }

  /* ------------------------------------------------- Lớp 1: ràng buộc khi thu */

  /**
   * Ràng buộc micro gửi cho getUserMedia.
   *
   * Các khoá không phải chuẩn W3C (voiceIsolation, googX) được đặt trong
   * `advanced`: trình duyệt hỗ trợ thì áp dụng, không hỗ trợ thì bỏ qua trong im
   * lặng. Nếu đặt ở tầng ngoài, một trình duyệt không biết khoá đó sẽ ném
   * OverconstrainedError và cuộc gọi mất luôn tiếng - cái giá quá đắt cho một
   * tuỳ chọn chỉ mang tính tối ưu.
   */
  function constraints() {
    const base = {
      echoCancellation: true,
      noiseSuppression: settings.profile !== 'off',
      autoGainControl: true,
      // Mic một kênh: bộ khử vọng của trình duyệt so sánh tín hiệu thu với tín
      // hiệu phát ra loa, luồng stereo làm phép so sánh đó lệch pha và khử hụt.
      channelCount: 1,
      sampleRate: 48000,
      sampleSize: 16
    };
    if (settings.micDeviceId) base.deviceId = { exact: settings.micDeviceId };
    base.advanced = [
      { echoCancellation: { exact: true } },
      { voiceIsolation: true },
      { noiseSuppression: { exact: settings.profile !== 'off' } },
      { latency: { ideal: 0.01 } }
    ];
    return base;
  }

  /* ------------------------------------------- Lớp 2+3: chuỗi lọc tiếng đi ra */

  /**
   * Dựng chuỗi xử lý cho luồng mic và trả về luồng ĐÃ LỌC để đưa vào WebRTC.
   * Luồng gốc vẫn được giữ nguyên (không đụng tới track hình) để hàm kết thúc
   * cuộc gọi vẫn stop() đúng thiết bị và tắt được đèn báo camera.
   */
  function attachLocal(stream) {
    detachLocal();
    rawStream = stream || null;
    if (!stream) return stream;

    const audioTracks = typeof stream.getAudioTracks === 'function' ? stream.getAudioTracks() : [];
    if (!audioTracks.length) {
      metrics.active = true;
      startTicker();
      return stream;
    }

    const audioCtx = ensureContext();
    if (!audioCtx || typeof audioCtx.createMediaStreamSource !== 'function'
        || typeof audioCtx.createMediaStreamDestination !== 'function') {
      // Không có Web Audio: vẫn gọi được, chỉ là mất lớp lọc bổ sung.
      metrics.active = true;
      metrics.processing = false;
      startTicker();
      notify(true);
      return stream;
    }

    try {
      const p = profile();
      const micOnly = new MediaStream(audioTracks);
      const source = audioCtx.createMediaStreamSource(micOnly);

      // Cắt trầm: tiếng quạt, tiếng điều hoà, rung mặt bàn khi đặt máy đo.
      const highpass = audioCtx.createBiquadFilter();
      highpass.type = 'highpass';
      highpass.frequency.value = p.highpass;
      highpass.Q.value = 0.7;

      // Bộ lọc chuông dự phòng cho lớp chống hú: mặc định 0 dB (không đụng gì
      // vào tiếng), chỉ hạ sâu đúng tần số hú khi phát hiện vòng lặp.
      const notch = audioCtx.createBiquadFilter();
      notch.type = 'peaking';
      notch.frequency.value = 2000;
      notch.Q.value = 9;
      notch.gain.value = 0;

      // Cắt cao: tiếng xì nền và tiếng rít kim loại nằm trên dải lời nói.
      const lowpass = audioCtx.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.value = p.lowpass;
      lowpass.Q.value = 0.7;

      // Nén động: cán bộ ngồi sát mic, bệnh nhân ngồi xa hơn cả mét. Không nén
      // thì đầu kia nghe cán bộ rõ mồn một còn bệnh nhân thì lí nhí.
      const comp = audioCtx.createDynamicsCompressor();
      comp.threshold.value = p.compress ? -28 : 0;
      comp.knee.value = 12;
      comp.ratio.value = p.compress ? 3.5 : 1;
      comp.attack.value = 0.005;
      comp.release.value = 0.15;

      // Cổng tạp âm + né vọng: một núm khuếch đại duy nhất do vòng đo điều khiển.
      const gate = audioCtx.createGain();
      gate.gain.value = 1;

      const makeup = audioCtx.createGain();
      makeup.gain.value = p.makeup;

      // Bộ phân tích đặt SAU khi lọc: nền ồn đã được cắt bớt nên ngưỡng mở cổng
      // bám sát tiếng nói thật, không bị tiếng quạt kéo lên.
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.5;

      const dest = audioCtx.createMediaStreamDestination();

      source.connect(highpass);
      highpass.connect(notch);
      notch.connect(lowpass);
      lowpass.connect(analyser);
      lowpass.connect(comp);
      comp.connect(gate);
      gate.connect(makeup);
      makeup.connect(dest);

      chain = {
        source, highpass, notch, lowpass, comp, gate, makeup, analyser, dest,
        micOnly,
        freqData: new Float32Array(analyser.frequencyBinCount),
        timeData: new Float32Array(analyser.fftSize),
        binHz: audioCtx.sampleRate / analyser.fftSize,
        noiseFloorDb: -70,
        calibrateUntil: Date.now() + 1200,
        openUntil: 0,
        howlBin: -1,
        howlStableMs: 0,
        howlUntil: 0,
        notchUntil: 0,
        lastTick: 0
      };

      // Luồng gửi đi = tiếng đã lọc + nguyên các track hình của luồng gốc.
      const outbound = new MediaStream();
      dest.stream.getAudioTracks().forEach(t => {
        try { t.contentHint = 'speech'; } catch (e) {}
        outbound.addTrack(t);
      });
      if (typeof stream.getVideoTracks === 'function') {
        stream.getVideoTracks().forEach(t => outbound.addTrack(t));
      }

      metrics.active = true;
      metrics.processing = true;
      resumeContext();
      startTicker();
      notify(true);
      return outbound;
    } catch (err) {
      console.warn('Không dựng được chuỗi lọc âm thanh, dùng tiếng thu gốc:', err && err.message);
      chain = null;
      metrics.active = true;
      metrics.processing = false;
      startTicker();
      notify(true);
      return stream;
    }
  }

  function detachLocal() {
    stopTicker();
    if (chain) {
      try { chain.source.disconnect(); } catch (e) {}
      try { chain.dest.stream.getTracks().forEach(t => t.stop()); } catch (e) {}
      chain = null;
    }
    rawStream = null;
    muted = false;
    metrics.active = false;
    metrics.processing = false;
    metrics.micLevel = 0;
    metrics.remoteLevel = 0;
    metrics.gateOpen = false;
    metrics.ducking = false;
    metrics.howling = false;
    metrics.howlHz = 0;
    notify(true);
  }

  /* ------------------------------------ Lớp 4: đo tiếng về để né vọng/chống hú */

  /**
   * Gắn luồng tiếng về vào phần tử phát, đồng thời trích một nhánh chỉ để ĐO.
   * Nhánh đo đi qua một núm khuếch đại bằng 0 rồi mới ra loa: bắt buộc phải nối
   * tới destination thì đồ thị mới được chạy, nhưng gain 0 nên không phát ra
   * tiếng - nếu để gain 1 thì mỗi câu của bác sĩ sẽ nghe thành hai lần.
   */
  function attachRemote(element, stream) {
    if (element) {
      remoteElements.add(element);
      applySpeakerToElement(element);
    }
    if (!stream || typeof stream.getAudioTracks !== 'function') return;
    if (!stream.getAudioTracks().length) return;

    const audioCtx = ensureContext();
    if (!audioCtx || typeof audioCtx.createMediaStreamSource !== 'function') return;

    try {
      if (monitor) {
        try { monitor.source.disconnect(); } catch (e) {}
        try { monitor.mute.disconnect(); } catch (e) {}
      }
      const monoStream = new MediaStream(stream.getAudioTracks());
      const source = audioCtx.createMediaStreamSource(monoStream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.6;
      const mute = audioCtx.createGain();
      mute.gain.value = 0;

      source.connect(analyser);
      analyser.connect(mute);
      mute.connect(audioCtx.destination);

      monitor = { source, analyser, mute, data: new Float32Array(analyser.fftSize) };
      resumeContext();
    } catch (err) {
      monitor = null;
    }
  }

  function detachRemote(element) {
    if (element) remoteElements.delete(element);
    if (!remoteElements.size && monitor) {
      try { monitor.source.disconnect(); } catch (e) {}
      try { monitor.mute.disconnect(); } catch (e) {}
      monitor = null;
    }
  }

  /* --------------------------------------------------------- vòng đo & điều khiển */

  function startTicker() {
    stopTicker();
    // setInterval chứ không phải requestAnimationFrame: cán bộ trực hay chuyển
    // tab sang tra cứu thuốc, rAF sẽ đứng hình và cổng tạp âm kẹt ở trạng thái
    // cuối - đúng lúc cần nó làm việc nhất thì nó ngủ.
    ticker = setInterval(tick, 45);
  }

  function stopTicker() {
    if (ticker) { clearInterval(ticker); ticker = null; }
  }

  /** Mức hiệu dụng (RMS) của một khung mẫu, quy ra dBFS. */
  function rmsDb(analyser, buffer) {
    if (!analyser || typeof analyser.getFloatTimeDomainData !== 'function') return { db: -120, rms: 0 };
    analyser.getFloatTimeDomainData(buffer);
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
    const rms = Math.sqrt(sum / buffer.length);
    return { db: rms > 0 ? 20 * Math.log10(rms) : -120, rms };
  }

  function tick() {
    if (!chain) return;
    const now = Date.now();
    const dt = chain.lastTick ? now - chain.lastTick : 45;
    chain.lastTick = now;

    let mic;
    try {
      mic = rmsDb(chain.analyser, chain.timeData);
    } catch (err) {
      return;
    }
    metrics.micLevel = Math.min(1, mic.rms * 6);

    // Nền ồn: tụt nhanh theo chỗ lặng, dâng lên rất chậm. Nhờ vậy ngưỡng mở cổng
    // tự bám theo phòng khám lúc vắng lẫn lúc đông mà không cần chỉnh tay.
    // Riêng hơn một giây đầu là lúc "đo phòng": cho nền dâng nhanh để cổng biết
    // ngay tiếng quạt, tiếng hành lang ồn cỡ nào. Không có đoạn này thì nền phải
    // bò từ -70 dB lên cả hai chục giây, và suốt hai chục giây đó tạp âm phòng
    // khám vẫn đi thẳng sang đầu bên kia.
    const calibrating = now < (chain.calibrateUntil || 0);
    const riseRate = calibrating ? 0.08 : 0.0015;
    if (mic.db < chain.noiseFloorDb) chain.noiseFloorDb = chain.noiseFloorDb * 0.9 + mic.db * 0.1;
    else chain.noiseFloorDb = chain.noiseFloorDb * (1 - riseRate) + mic.db * riseRate;
    chain.noiseFloorDb = Math.max(-95, Math.min(-25, chain.noiseFloorDb));
    metrics.noiseFloorDb = chain.noiseFloorDb;

    let remote = { db: -120, rms: 0 };
    if (monitor) {
      try { remote = rmsDb(monitor.analyser, monitor.data); } catch (err) {}
    }
    metrics.remoteLevel = Math.min(1, remote.rms * 6);

    const p = profile();
    let target = 1;

    // --- Cổng tạp âm ---------------------------------------------------------
    if (p.gate) {
      const openAt = Math.max(chain.noiseFloorDb + p.gateMargin, p.gateFloorDb);
      if (mic.db > openAt) chain.openUntil = now + p.gateHoldMs;
      metrics.gateOpen = now < chain.openUntil;
      if (!metrics.gateOpen) target = p.gateFloorGain;
    } else {
      metrics.gateOpen = true;
    }

    // --- Né vọng khi đầu bên kia đang nói -----------------------------------
    // Đây là thứ cắt đứt tiếng vang: loa đang phát thì mic chỉ còn 40%, nên
    // tiếng loa dội lại không đủ sức quay ngược sang đầu kia.
    metrics.ducking = false;
    if (settings.duck && remote.db > -50) {
      metrics.ducking = true;
      target *= 0.4;
    }

    // --- Chống hú ------------------------------------------------------------
    if (settings.antiHowl) target = applyHowlGuard(now, dt, mic, target);
    else { metrics.howling = false; metrics.howlHz = 0; }

    if (muted) target = 0;

    try {
      const t = ctx.currentTime;
      // Mở nhanh (12ms) để không cụt chữ đầu, đóng chậm (140ms) để đuôi câu
      // không bị cắt ngang nghe như máy bộ đàm.
      chain.gate.gain.setTargetAtTime(target, t, target < 0.99 ? 0.14 : 0.012);
    } catch (err) {}

    notify(false);
  }

  /**
   * Nhận diện vòng hú: tiếng hú là một đỉnh phổ RẤT hẹp, rất cao so với phần
   * còn lại, và bám lì ở nguyên một tần số - khác hẳn giọng người vốn trượt
   * liên tục qua nhiều tần số. Bắt được đúng đặc điểm đó thì can thiệp được
   * trong khoảng 300 ms, tức là trước khi nó kịp rít lên thành tiếng.
   */
  function applyHowlGuard(now, dt, mic, target) {
    let peakBin = -1;
    let peakDb = -160;
    let sum = 0;
    let count = 0;

    try {
      if (typeof chain.analyser.getFloatFrequencyData !== 'function') return target;
      chain.analyser.getFloatFrequencyData(chain.freqData);
    } catch (err) {
      return target;
    }

    const minBin = Math.max(1, Math.floor(300 / chain.binHz));
    const maxBin = Math.min(chain.freqData.length - 1, Math.floor(6000 / chain.binHz));
    for (let i = minBin; i <= maxBin; i++) {
      const v = chain.freqData[i];
      if (!isFinite(v)) continue;
      sum += v; count++;
      if (v > peakDb) { peakDb = v; peakBin = i; }
    }
    if (!count || peakBin < 0) return target;

    const mean = sum / count;
    const prominence = peakDb - mean;
    const sameTone = chain.howlBin >= 0 && Math.abs(peakBin - chain.howlBin) <= 2;

    // Đỉnh phải vừa cao tuyệt đối, vừa nhô hẳn lên khỏi mặt bằng phổ.
    if (peakDb > -38 && prominence > 20) {
      chain.howlStableMs = sameTone ? chain.howlStableMs + dt : 0;
      chain.howlBin = peakBin;
    } else {
      chain.howlStableMs = 0;
      chain.howlBin = -1;
    }

    if (chain.howlStableMs > 320) {
      const hz = Math.round(peakBin * chain.binHz);
      if (!metrics.howling) {
        metrics.howlCount++;
        console.warn(`Phát hiện hú loa ở ~${hz} Hz - đã cắm bộ lọc chuông và ghìm mic.`);
      }
      metrics.howling = true;
      metrics.howlHz = hz;
      chain.howlUntil = now + 900;
      chain.notchUntil = now + 6000;
      chain.howlStableMs = 0;
      try {
        const t = ctx.currentTime;
        chain.notch.frequency.setTargetAtTime(hz, t, 0.01);
        chain.notch.gain.setTargetAtTime(-30, t, 0.02);
      } catch (err) {}
      // Hạ luôn loa một nấc: chỉ chặn ở mic thì hú sẽ quay lại ngay khi buông.
      setSpeakerVolume(Math.max(0.3, settings.speakerVolume * 0.85), true);
      notify(true);
    }

    if (now < chain.howlUntil) return Math.min(target, 0.05);

    if (metrics.howling && now >= chain.howlUntil) {
      metrics.howling = false;
      notify(true);
    }
    // Bộ lọc chuông được gỡ dần sau vài giây yên tĩnh, trả lại độ trong cho tiếng.
    if (chain.notchUntil && now > chain.notchUntil) {
      chain.notchUntil = 0;
      metrics.howlHz = 0;
      try { chain.notch.gain.setTargetAtTime(0, ctx.currentTime, 0.4); } catch (err) {}
    }
    return target;
  }

  /* --------------------------------------------------------------- điều khiển */

  function setMuted(value) {
    muted = !!value;
    if (rawStream && typeof rawStream.getAudioTracks === 'function') {
      rawStream.getAudioTracks().forEach(t => { t.enabled = !muted; });
    }
    if (chain) {
      try { chain.gate.gain.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, 0.01); } catch (err) {}
    }
    notify(true);
  }

  function setProfile(name) {
    if (!CALL_AUDIO_PROFILES[name]) return;
    settings.profile = name;
    save();
    if (chain) {
      const p = profile();
      try {
        const t = ctx.currentTime;
        chain.highpass.frequency.setTargetAtTime(p.highpass, t, 0.05);
        chain.lowpass.frequency.setTargetAtTime(p.lowpass, t, 0.05);
        chain.comp.threshold.setTargetAtTime(p.compress ? -28 : 0, t, 0.05);
        chain.comp.ratio.setTargetAtTime(p.compress ? 3.5 : 1, t, 0.05);
        chain.makeup.gain.setTargetAtTime(p.makeup, t, 0.05);
      } catch (err) {}
      chain.noiseFloorDb = -70;
      chain.calibrateUntil = Date.now() + 1200;
    }
    notify(true);
  }

  function setAntiHowl(value) {
    settings.antiHowl = !!value;
    save();
    if (!settings.antiHowl && chain) {
      chain.howlStableMs = 0;
      chain.howlUntil = 0;
      chain.notchUntil = 0;
      try { chain.notch.gain.setTargetAtTime(0, ctx.currentTime, 0.1); } catch (err) {}
    }
    notify(true);
  }

  function setDuck(value) {
    settings.duck = !!value;
    save();
    notify(true);
  }

  function applySpeakerToElement(el) {
    if (!el) return;
    try { el.volume = settings.speakerVolume; } catch (err) {}
    if (settings.speakerDeviceId && typeof el.setSinkId === 'function') {
      el.setSinkId(settings.speakerDeviceId).catch(() => {});
    }
  }

  function setSpeakerVolume(value, internal) {
    const v = Math.min(1, Math.max(0, Number(value)));
    if (!isFinite(v)) return;
    settings.speakerVolume = v;
    remoteElements.forEach(applySpeakerToElement);
    if (!internal) save();
    notify(true);
  }

  /** Đổi loa phát (chỉ Chrome/Edge có setSinkId; nơi khác giữ loa mặc định). */
  function setSpeakerDevice(deviceId) {
    settings.speakerDeviceId = deviceId || '';
    save();
    remoteElements.forEach(applySpeakerToElement);
    notify(true);
  }

  /**
   * Đổi micro giữa cuộc gọi. CỐ Ý chỉ xin thiết bị khi đang có phiên xử lý chạy:
   * ngoài cuộc gọi thì hàm này không bao giờ chạm tới getUserMedia, giữ đúng
   * nguyên tắc "chưa bấm gọi thì không mở thiết bị" của bảng điều khiển.
   */
  async function setMicDevice(deviceId) {
    settings.micDeviceId = deviceId || '';
    save();
    if (!metrics.active || !rawStream) { notify(true); return null; }

    try {
      const fresh = await navigator.mediaDevices.getUserMedia({ audio: constraints() });
      const newTrack = fresh.getAudioTracks()[0];
      if (!newTrack) return null;
      try { newTrack.contentHint = 'speech'; } catch (e) {}

      // Trả micro cũ về hệ điều hành rồi mới thay nguồn của chuỗi lọc.
      rawStream.getAudioTracks().forEach(t => {
        try { rawStream.removeTrack(t); } catch (e) {}
        try { t.stop(); } catch (e) {}
      });
      try { rawStream.addTrack(newTrack); } catch (e) {}
      newTrack.enabled = !muted;

      if (chain && ctx) {
        try { chain.source.disconnect(); } catch (e) {}
        chain.micOnly = new MediaStream([newTrack]);
        chain.source = ctx.createMediaStreamSource(chain.micOnly);
        chain.source.connect(chain.highpass);
        chain.noiseFloorDb = -70;
        chain.calibrateUntil = Date.now() + 1200;
      }
      notify(true);
      // Chuỗi lọc vẫn phát ra đúng track cũ nên WebRTC không cần thương lượng lại.
      return chain ? null : newTrack;
    } catch (err) {
      console.warn('Không đổi được micro:', err && err.message);
      notify(true);
      return null;
    }
  }

  /** Danh sách mic/loa để đổ vào ô chọn (nhãn chỉ hiện sau khi đã cấp quyền). */
  async function listDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return {
        mics: devices.filter(d => d.kind === 'audioinput'),
        speakers: devices.filter(d => d.kind === 'audiooutput')
      };
    } catch (err) {
      return { mics: [], speakers: [] };
    }
  }

  function release() {
    detachLocal();
    remoteElements.clear();
    if (monitor) {
      try { monitor.source.disconnect(); } catch (e) {}
      try { monitor.mute.disconnect(); } catch (e) {}
      monitor = null;
    }
    metrics.howlCount = 0;
  }

  function onUpdate(fn) {
    if (typeof fn === 'function') listeners.add(fn);
    return () => listeners.delete(fn);
  }

  load();

  return {
    profiles: CALL_AUDIO_PROFILES,
    constraints,
    attachLocal,
    detachLocal,
    attachRemote,
    detachRemote,
    setMuted,
    setProfile,
    setAntiHowl,
    setDuck,
    setSpeakerVolume,
    setSpeakerDevice,
    setMicDevice,
    listDevices,
    getState,
    onUpdate,
    release,
    supportsOutputSelection: () => typeof HTMLMediaElement !== 'undefined'
      && typeof HTMLMediaElement.prototype.setSinkId === 'function'
  };
})();

if (typeof window !== 'undefined') window.CallAudio = CallAudio;

/* ---------------------------------------------------------------------------
   Bảng "Âm thanh cuộc gọi" trên thanh điều khiển của điểm trạm.
   Cán bộ trực cần nhìn thấy máy đang làm gì với tiếng của mình - vạch mức mic
   cho biết cổng tạp âm có đang cắt nhầm lời nói không, dòng trạng thái cho biết
   vì sao mic vừa bị ghìm (né tiếng bác sĩ, hay vừa chặn một cú hú).
   --------------------------------------------------------------------------- */

let audioPanelOpen = false;

function toggleAudioSettings() {
  const panel = document.getElementById('audio-settings-panel');
  if (!panel) return;
  audioPanelOpen = panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !audioPanelOpen);
  const btn = document.getElementById('btn-audio-settings');
  if (btn) {
    btn.className = audioPanelOpen
      ? 'px-3 h-10 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold flex items-center gap-1.5 transition shadow border border-blue-500'
      : 'px-3 h-10 rounded-xl bg-slate-800 hover:bg-slate-700 text-blue-300 text-xs font-bold flex items-center gap-1.5 transition shadow border border-slate-700';
  }
  if (audioPanelOpen) {
    refreshAudioDeviceOptions();
    renderAudioPanel();
  }
}

/** Đổ danh sách mic/loa vào hai ô chọn. Nhãn thiết bị chỉ có sau khi được cấp quyền. */
async function refreshAudioDeviceOptions() {
  const micSel = document.getElementById('audio-mic-select');
  const spkSel = document.getElementById('audio-speaker-select');
  if (!micSel && !spkSel) return;

  const { mics, speakers } = await CallAudio.listDevices();
  const state = CallAudio.getState();

  const fill = (sel, list, current, emptyLabel) => {
    if (!sel) return;
    // Dựng bằng DOM chứ không nối chuỗi HTML: nhãn thiết bị là dữ liệu do hệ
    // điều hành/USB cung cấp, không phải nguồn đáng tin để nhét thẳng vào trang.
    sel.textContent = '';
    const first = document.createElement('option');
    first.value = '';
    first.textContent = 'Thiết bị mặc định của máy';
    sel.appendChild(first);
    list.forEach((d, i) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId || '';
      opt.textContent = d.label || `${emptyLabel} ${i + 1}`;
      sel.appendChild(opt);
    });
    sel.value = current || '';
  };

  fill(micSel, mics, state.micDeviceId, 'Micro');
  fill(spkSel, speakers, state.speakerDeviceId, 'Loa');

  const spkWrap = document.getElementById('audio-speaker-select-wrap');
  if (spkWrap) {
    // Firefox/Safari chưa cho trang tự chọn loa: ẩn ô đi còn hơn để một ô bấm
    // vào không có tác dụng gì.
    spkWrap.classList.toggle('hidden', !CallAudio.supportsOutputSelection() || !speakers.length);
  }
}

/** Vẽ lại toàn bộ bảng theo trạng thái hiện tại của bộ xử lý âm thanh. */
function renderAudioPanel(state) {
  const s = state || CallAudio.getState();

  const profileSel = document.getElementById('audio-profile-select');
  if (profileSel && profileSel.value !== s.profile) profileSel.value = s.profile;

  const howlBox = document.getElementById('audio-anti-howl');
  if (howlBox) howlBox.checked = !!s.antiHowl;

  const duckBox = document.getElementById('audio-duck');
  if (duckBox) duckBox.checked = !!s.duck;

  const range = document.getElementById('audio-speaker-range');
  const rangeVal = document.getElementById('audio-speaker-value');
  const pct = Math.round(s.speakerVolume * 100);
  if (range && document.activeElement !== range) range.value = String(pct);
  if (rangeVal) rangeVal.textContent = `${pct}%`;

  const meter = document.getElementById('audio-mic-meter');
  if (meter) {
    meter.style.width = `${Math.round(Math.min(1, s.micLevel) * 100)}%`;
    meter.className = s.howling
      ? 'h-full rounded-full bg-rose-500 transition-all duration-75'
      : (s.gateOpen
        ? 'h-full rounded-full bg-emerald-500 transition-all duration-75'
        : 'h-full rounded-full bg-slate-600 transition-all duration-75');
  }

  const status = document.getElementById('audio-status-text');
  if (status) {
    let text;
    if (!s.active) text = 'Chưa gọi - bộ lọc sẽ chạy khi bắt đầu cuộc gọi.';
    else if (s.howling) text = `Vừa chặn một cú hú ở ~${s.howlHz} Hz - đã hạ loa một nấc.`;
    else if (s.ducking) text = 'Bác sĩ đang nói - mic hạ tạm để không dội tiếng ngược lại.';
    else if (s.gateOpen) text = 'Đang truyền lời thoại.';
    else text = `Đang chặn tiếng nền phòng khám (nền ~${Math.round(s.noiseFloorDb)} dB).`;
    status.textContent = text;
  }

  const note = document.getElementById('audio-howl-note');
  if (note) {
    note.classList.toggle('hidden', !s.howlCount);
    if (s.howlCount) {
      note.textContent = `Đã tự chặn ${s.howlCount} lần hú trong phiên này. Nếu còn hú, hạ âm lượng loa hoặc kéo loa ra xa micro.`;
    }
  }

  const engine = document.getElementById('audio-engine-note');
  if (engine && s.active && !s.processing) {
    engine.classList.remove('hidden');
  } else if (engine) {
    engine.classList.add('hidden');
  }
}

function setCallNoiseProfile(value) {
  CallAudio.setProfile(value);
  const label = (CallAudio.profiles[value] || {}).label || value;
  appendChatMessage('Hệ thống', `Mức lọc tạp âm micro: ${label}.`);
}

function setCallAntiHowl(checked) {
  CallAudio.setAntiHowl(checked);
  appendChatMessage('Hệ thống', checked
    ? 'Đã bật chống hú/chống vang tự động.'
    : 'Đã tắt chống hú - chỉ nên tắt khi cán bộ và bệnh nhân đều dùng tai nghe.');
}

function setCallDuck(checked) {
  CallAudio.setDuck(checked);
}

function setCallSpeakerVolume(value) {
  CallAudio.setSpeakerVolume(Number(value) / 100);
}

function setCallMicDevice(deviceId) {
  CallAudio.setMicDevice(deviceId);
}

function setCallSpeakerDevice(deviceId) {
  CallAudio.setSpeakerDevice(deviceId);
}

// Bảng chỉ vẽ lại khi đang mở, để vòng đo 45ms không phải đụng vào DOM vô ích.
CallAudio.onUpdate((state) => {
  if (audioPanelOpen) renderAudioPanel(state);
});

// 2. WebRTC Audio/Video Connection Setup
/** @returns {boolean} true nếu đã tạo được kết nối ngang hàng. */
function initPeerConnection() {
  if (peerConnection) {
    try {
      peerConnection.ontrack = null;
      peerConnection.onicecandidate = null;
      peerConnection.close();
    } catch (err) {}
    peerConnection = null;
  }

  if (!webRTCSupported()) {
    warnWebRTCUnavailable();
    return false;
  }

  const configuration = {
    iceServers: [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
      { urls: 'stun:stun.cloudflare.com:3478' },
      { urls: 'stun:global.stun.twilio.com:3478' }
    ],
    // Thu sẵn nhiều ứng viên đường truyền hơn ngay khi mở kết nối, và dồn mọi
    // luồng vào một cổng: bắt tay xong sớm hơn nên hình lên nhanh hơn.
    iceCandidatePoolSize: 8,
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require'
  };

  try {
    peerConnection = new RTCPeerConnection(configuration);
  } catch (err) {
    peerConnection = null;
    console.error('Không khởi tạo được RTCPeerConnection:', err);
    warnWebRTCUnavailable();
    return false;
  }

  // Add local stream tracks to WebRTC connection
  const sendStream = outboundStream || localStream;
  if (sendStream) {
    sendStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, sendStream);
    });
    tuneVideoSender();
  }

  // Handle incoming remote media stream
  peerConnection.ontrack = (event) => {
    console.log('🎥 Remote video track received');
    const remoteVideo = document.getElementById('remote-video');
    const remotePlaceholder = document.getElementById('remote-placeholder');

    // Bỏ bộ đệm phát lại cho HÌNH: khung hình hiện gần thời gian thực.
    // CỐ Ý không đụng tới track tiếng: bộ đệm chống rung (jitter buffer) của
    // luồng tiếng mà bị ép về 0 thì mỗi gói tin về trễ sẽ thành một tiếng lụp
    // bụp/lạo xạo - đúng thứ tiếng kêu mà cán bộ trạm phản ánh.
    try {
      if (event.receiver && event.track && event.track.kind === 'video') {
        event.receiver.playoutDelayHint = 0;
      }
    } catch (e) {}

    if (remoteVideo) {
      remoteVideo.srcObject = event.streams[0];
      remoteVideo.playsInline = true;
      remoteVideo.classList.remove('hidden');
      remoteVideo.play().catch(() => {});
      // Gắn loa vào bộ đo: mic sẽ tự né khi bác sĩ đang nói, và lớp chống hú có
      // đủ dữ liệu để biết tiếng đang quay vòng qua loa ngoài của phòng khám.
      try { CallAudio.attachRemote(remoteVideo, event.streams[0]); } catch (e) {}
    }
    if (remotePlaceholder) {
      remotePlaceholder.classList.add('hidden');
    }
    isConnected = true;
    updateConnectionBadge(true, 'Đang kết nối với bác sĩ');
  };

  // Ứng viên ICE được gom lô rồi gửi một lượt (xem sendIceCandidate).
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) queueIceCandidate(event.candidate.toJSON ? event.candidate.toJSON() : event.candidate);
    else flushIceQueue();
  };

  return true;
}

/* =============================================================================
   GÓC THU HÌNH RỘNG - áp dụng cho mọi camera của bảng điều khiển điểm trạm
   -----------------------------------------------------------------------------
   Một buổi khám ở trạm thường có ít nhất ba người trong phòng: cán bộ trực,
   người bệnh và người nhà đi kèm. Nếu camera mở ở khuôn hẹp thì tuyến trên chỉ
   thấy được một người, phải liên tục nhắc "dịch máy sang trái/phải".

     - Khung 16:9 và bề ngang lớn: đa số webcam chỉ mở hết bề ngang cảm biến ở
       chế độ màn ảnh rộng; chế độ 4:3 hay 640x480 là khuôn đã bị cắt hai bên.
     - resizeMode 'none': không cho trình duyệt cắt-phóng để chiều theo kích
       thước yêu cầu.
     - Không tốn thêm băng thông: trần bitrate ở tuneVideoSender() giữ nguyên,
       bộ mã hoá tự thu nhỏ ảnh cho vừa đường truyền - thu rộng rồi nén lại,
       chứ không cắt bớt người ngồi ngoài rìa.
   ========================================================================== */
const WIDE_VIDEO_CONSTRAINTS = {
  width: { ideal: 1920, max: 1920 },
  height: { ideal: 1080, max: 1080 },
  aspectRatio: { ideal: 16 / 9 },
  frameRate: { ideal: 30, min: 15 },
  resizeMode: 'none'
};

/** Ràng buộc hình góc rộng, kèm phần chỉ định thiết bị nếu có. */
function wideVideoConstraints(extra) {
  return Object.assign({}, WIDE_VIDEO_CONSTRAINTS, extra || {});
}

/**
 * Nới góc nhìn ngay trên track vừa mở.
 *
 * Ràng buộc lúc getUserMedia mới chỉ chọn được chế độ khuôn hình. Nhiều camera
 * (camera soi cận cảnh, camera sau điện thoại, webcam hội nghị) vẫn giữ mức
 * phóng to của lần dùng trước. Kéo zoom về mức nhỏ nhất và ép lại bề ngang lớn
 * nhất mà thiết bị khai báo là cách duy nhất lấy lại phần khung đã bị cắt.
 */
async function widenTrackFieldOfView(track) {
  if (!track || typeof track.getCapabilities !== 'function' || typeof track.applyConstraints !== 'function') return;
  let caps = {};
  try { caps = track.getCapabilities() || {}; } catch (e) { return; }
  const advanced = [];
  if (caps.zoom && typeof caps.zoom.min === 'number') advanced.push({ zoom: caps.zoom.min });
  if (Array.isArray(caps.resizeMode) && caps.resizeMode.includes('none')) advanced.push({ resizeMode: 'none' });
  const wanted = {};
  const maxW = caps.width && caps.width.max;
  if (typeof maxW === 'number' && maxW > 0) {
    const w = Math.min(maxW, 1920);
    wanted.width = { ideal: w };
    wanted.height = { ideal: Math.round(w * 9 / 16) };
  }
  if (advanced.length) wanted.advanced = advanced;
  if (!Object.keys(wanted).length) return;
  try { await track.applyConstraints(wanted); } catch (e) { /* thiết bị không cho thì giữ nguyên */ }
}

/**
 * Ép bộ mã hoá ưu tiên giữ số khung hình khi băng thông tụt (mạng 3G/4G vùng cao),
 * thay vì mặc định hạ khung hình làm hình giật từng nấc.
 */
function tuneVideoSender() {
  if (!peerConnection) return;
  const sender = peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
  if (!sender || !sender.getParameters) return;
  try {
    const params = sender.getParameters();
    params.degradationPreference = 'maintain-framerate';
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = 1500000;
    params.encodings[0].maxFramerate = 30;
    sender.setParameters(params).catch(() => {});
  } catch (err) {
    console.warn('Không đặt được thông số luồng hình:', err);
  }
}

/* Gom ứng viên ICE trong 40ms rồi gửi một lô: mỗi bản tin signaling là một chặng
   HTTP, gom lại giúp rút ngắn thời gian bắt tay xuống rõ rệt. */
function queueIceCandidate(candidate) {
  iceQueue.push(candidate);
  if (iceQueueTimer) return;
  iceQueueTimer = setTimeout(flushIceQueue, 40);
}

function flushIceQueue() {
  if (iceQueueTimer) { clearTimeout(iceQueueTimer); iceQueueTimer = null; }
  if (!iceQueue.length) return;
  sendSignal('ice', iceQueue.splice(0));
}

async function createWebRTCOffer() {
  if (!peerConnection && !initPeerConnection()) return;
  try {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    await sendSignal('offer', offer);
  } catch (err) {
    console.error('Error creating WebRTC offer:', err);
  }
}

async function handleWebRTCOffer(offer) {
  if (!offer) return;
  if (!peerConnection && !initPeerConnection()) return;
  try {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    await drainPendingCandidates();

    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    await sendSignal('answer', answer);
  } catch (err) {
    console.error('Error handling WebRTC offer:', err);
  }
}

async function handleWebRTCAnswer(answer) {
  if (!answer || !peerConnection) return;
  try {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
    await drainPendingCandidates();
  } catch (err) {
    console.error('Error handling WebRTC answer:', err);
  }
}

async function handleWebRTCIceCandidate(candidate) {
  if (!candidate || !peerConnection) return;

  // Chấp nhận cả bản tin cũ (một ứng viên) lẫn bản tin gom lô (mảng ứng viên),
  // để máy đã mở sẵn trang cũ vẫn bắt tay được với máy đã nạp bản mới.
  const items = Array.isArray(candidate) ? candidate : [candidate];
  const ready = peerConnection.remoteDescription && peerConnection.remoteDescription.type;

  for (const item of items) {
    if (!item) continue;
    let ice;
    try {
      ice = new RTCIceCandidate(item);
    } catch (err) {
      continue;
    }

    // Ứng viên ICE đến trước khi có remote description thì phải xếp hàng, nếu không sẽ mất.
    if (!ready) {
      pendingCandidates.push(ice);
      continue;
    }

    try {
      await peerConnection.addIceCandidate(ice);
    } catch (err) {
      console.warn('Error adding ICE candidate:', err.message);
    }
  }
}

async function drainPendingCandidates() {
  const queued = pendingCandidates;
  pendingCandidates = [];
  for (const candidate of queued) {
    try {
      await peerConnection.addIceCandidate(candidate);
    } catch (err) {
      console.warn('Error adding queued ICE candidate:', err.message);
    }
  }
}

// 3. Local Camera & Dual-Camera Switcher Logic
async function initLocalCamera(deviceId = null) {
  // Chỉ mở thiết bị khi đang trong phiên gọi. Đây là nơi duy nhất gọi
  // getUserMedia trong bảng điều khiển, nên rào ở đây là rào được tất cả.
  if (!callActive) {
    console.warn('Bỏ qua initLocalCamera(): chưa bắt đầu cuộc gọi khám từ xa.');
    return;
  }

  // Đổi camera GIỮA cuộc gọi thì chỉ xin lại track hình, giữ nguyên track tiếng.
  //
  // Hai lý do, cả hai đều liên quan trực tiếp tới tiếng vang:
  //   - Bộ khử vọng của trình duyệt phải học đặc tính âm học của phòng (loa cách
  //     mic bao xa, tường dội thế nào). Mở lại micro là xoá sạch phần đã học đó,
  //     nên vài giây sau mỗi lần chuyển camera là đầu bên kia lại nghe vọng.
  //   - Bản cũ mở luồng mới mà không tắt luồng cũ, nên sau mỗi lần chuyển là có
  //     thêm một micro đang thu song song trong cùng căn phòng.
  const keepAudio = !!(deviceId && localStream && localStream.getAudioTracks().length);

  if (keepAudio) {
    try {
      const camOnly = await navigator.mediaDevices.getUserMedia({
        video: wideVideoConstraints({ deviceId: { exact: deviceId } })
      }).catch(() => navigator.mediaDevices.getUserMedia({
        // Camera không nhận nổi khuôn rộng thì vẫn phải mở được, đừng để việc
        // chuyển camera giữa buổi khám thất bại chỉ vì một ràng buộc phụ.
        video: { deviceId: { exact: deviceId }, frameRate: { ideal: 30, min: 15 } }
      }));
      const newVideo = camOnly.getVideoTracks()[0];
      localStream.getVideoTracks().forEach(t => {
        try { localStream.removeTrack(t); } catch (e) {}
        try { t.stop(); } catch (e) {}
      });
      if (newVideo) {
        try { newVideo.contentHint = 'motion'; } catch (e) {}
        widenTrackFieldOfView(newVideo);
        try { localStream.addTrack(newVideo); } catch (e) {}
        newVideo.enabled = !isVideoMuted;
        if (outboundStream && outboundStream !== localStream) {
          outboundStream.getVideoTracks().forEach(t => {
            try { outboundStream.removeTrack(t); } catch (e) {}
          });
          try { outboundStream.addTrack(newVideo); } catch (e) {}
        }
        const sender = peerConnection
          && peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender) sender.replaceTrack(newVideo);
      }
      const previewEl = document.getElementById('local-video');
      if (previewEl) {
        previewEl.srcObject = localStream;
        previewEl.play().catch(() => {});
      }
      tuneVideoSender();
      return;
    } catch (err) {
      console.warn('Không đổi được riêng camera, mở lại toàn bộ thiết bị:', err && err.message);
    }
  }

  // Mở lại toàn bộ thiết bị: trả luồng cũ về hệ điều hành trước đã.
  if (localStream) {
    localStream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
  }
  CallAudio.detachLocal();

  try {
    // Xin đúng một cấu hình ngay từ đầu (khuôn góc rộng + trần số khung hình)
    // để trình duyệt không phải khởi động camera lần hai - đây là khâu chiếm
    // nhiều thời gian nhất khi bắt đầu cuộc gọi.
    const constraints = {
      // Ràng buộc tiếng do CallAudio dựng: khử vọng, khử ồn, tự cân mức và tách
      // giọng nói ngay tại tầng thu, một kênh 48 kHz cho khớp bộ khử vọng.
      audio: CallAudio.constraints(),
      video: deviceId
        ? wideVideoConstraints({ deviceId: { exact: deviceId } })
        : wideVideoConstraints()
    };

    localStream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    console.warn('⚠️ Camera access warning, attempting audio-only fallback:', err.message);
    try {
      // Trước khi bỏ hẳn hình, thử lại với ràng buộc tối thiểu: có thể camera
      // chỉ không đáp ứng nổi khuôn rộng chứ không phải bị từ chối quyền.
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: CallAudio.constraints(),
        video: deviceId ? { deviceId: { exact: deviceId } } : true
      });
    } catch (errWide) {
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: CallAudio.constraints() });
      } catch (err2) {
        console.warn('⚠️ Audio/Video access unavailable:', err2.message);
        localStream = null;
      }
    }
  }

  if (localStream) {
    // Báo cho bộ mã hoá biết đây là hình chuyển động và tiếng nói, để nó chọn
    // đúng thuật toán nén thay vì đoán mò.
    localStream.getVideoTracks().forEach(t => {
      try { t.contentHint = 'motion'; } catch (e) {}
      widenTrackFieldOfView(t);
    });
    localStream.getAudioTracks().forEach(t => { try { t.contentHint = 'speech'; } catch (e) {} });

    // Tiếng đi vòng qua chuỗi lọc trước khi ra khỏi máy; hình giữ nguyên.
    outboundStream = CallAudio.attachLocal(localStream) || localStream;
    CallAudio.setMuted(isMicMuted);
    refreshAudioDeviceOptions();

    const localVideo = document.getElementById('local-video');
    if (localVideo) {
      // Ô xem trước tại chỗ BẮT BUỘC phải câm: phát tiếng mic của chính mình ra
      // loa là tự tạo ra một vòng loa -> mic, hú ngay trong ba giây đầu.
      localVideo.srcObject = localStream;
      localVideo.playsInline = true;
      localVideo.muted = true;
      localVideo.volume = 0;
      localVideo.play().catch(() => {});
    }

    try {
      // List available video devices for camera switching
      const devices = await navigator.mediaDevices.enumerateDevices();
      videoDevices = devices.filter(d => d.kind === 'videoinput');
      console.log(`📷 Detected ${videoDevices.length} camera inputs:`, videoDevices);
    } catch (e) {
      videoDevices = [];
    }

    // Replace video/audio tracks in peer connection if already active
    if (peerConnection) {
      const videoTrack = localStream.getVideoTracks()[0];
      // Track tiếng gửi đi phải lấy từ luồng ĐÃ LỌC, không phải mic thô - nếu
      // lấy nhầm mic thô thì mỗi lần đổi camera là mất sạch lớp chống vang.
      const audioTrack = (outboundStream && outboundStream.getAudioTracks()[0])
        || localStream.getAudioTracks()[0];
      const senders = peerConnection.getSenders();

      const videoSender = senders.find(s => s.track && s.track.kind === 'video');
      if (videoSender && videoTrack) {
        videoSender.replaceTrack(videoTrack);
      }
      const audioSender = senders.find(s => s.track && s.track.kind === 'audio');
      if (audioSender && audioTrack) {
        audioSender.replaceTrack(audioTrack);
      }
      tuneVideoSender();
    }
  }
}

// Switch between Wide Angle Camera and Close-Up Lesion/Dermatoscope Camera
async function toggleCameraDevice() {
  if (!callActive) {
    appendChatMessage('Hệ thống', 'Chưa có cuộc gọi nào đang diễn ra - bấm "Bắt đầu cuộc gọi" để bật camera.');
    return;
  }

  if (videoDevices.length <= 1) {
    // Simulated toggle if only 1 device is physically available on client hardware
    currentCamIndex = currentCamIndex === 0 ? 1 : 0;
  } else {
    currentCamIndex = (currentCamIndex + 1) % videoDevices.length;
  }

  const isCloseup = currentCamIndex === 1;
  const label = isCloseup ? 'Camera 2: Cận Cảnh Tổn Thương / Họng / Da' : 'Camera 1: Toàn Cảnh Phòng Khám';

  // Update UI Labels safely
  const camLabel = document.getElementById('cam-label');
  if (camLabel) camLabel.textContent = isCloseup ? 'Cận cảnh' : 'Góc rộng';

  const pipLabel = document.getElementById('pip-label');
  if (pipLabel) pipLabel.textContent = isCloseup ? 'Cam Cận Cảnh' : 'Cam Toàn Cảnh';

  const camStatus = document.getElementById('camera-status-text');
  if (camStatus) camStatus.textContent = `Camera: ${isCloseup ? 'Cận Cảnh Soi Tổn Thương' : 'Góc Rộng Phòng Khám'}`;
  
  const badge = document.getElementById('active-cam-mode-badge');
  if (badge) {
    badge.innerHTML = `<i class="fa-solid fa-video"></i> ${label}`;
    badge.className = isCloseup ? 'bg-amber-950 text-amber-400 border border-amber-800 px-2.5 py-0.5 rounded-full font-medium text-[11px]' : 'bg-emerald-950 text-emerald-400 border border-emerald-800 px-2.5 py-0.5 rounded-full font-medium text-[11px]';
  }

  // Play audio tone trigger
  playBeepTone(600, 100);

  // Re-acquire camera stream if multiple physical devices exist
  if (videoDevices[currentCamIndex]?.deviceId) {
    await initLocalCamera(videoDevices[currentCamIndex].deviceId);
  }

  // Báo cho tuyến trên biết điểm trạm vừa đổi góc quay để bác sĩ đọc đúng hình.
  sendSignal('chat', {
    sender: 'Điểm trạm',
    text: `Đã chuyển camera: ${label}`
  });

  appendChatMessage('Hệ thống', `Chuyển sang: ${label}`);
}

// Toggle Microphone
function toggleMic() {
  if (!callActive || !localStream) {
    appendChatMessage('Hệ thống', 'Micro chỉ hoạt động trong cuộc gọi - bấm "Bắt đầu cuộc gọi" trước.');
    return;
  }
  const audioTrack = localStream.getAudioTracks()[0];
  if (audioTrack) {
    isMicMuted = !isMicMuted;
    audioTrack.enabled = !isMicMuted;
    // Ngắt luôn ở đầu ra của chuỗi lọc: track thô tắt rồi nhưng đuôi vang còn
    // đọng trong bộ nén/bộ lọc vẫn kịp thoát ra ngoài thêm một nhịp nữa.
    try { CallAudio.setMuted(isMicMuted); } catch (e) {}

    const micBtn = document.getElementById('btn-toggle-mic') || document.getElementById('mic-btn');
    const micIcon = document.getElementById('icon-mic') || micBtn?.querySelector('i');

    if (micBtn) {
      if (isMicMuted) {
        micBtn.className = 'w-10 h-10 rounded-xl bg-red-900 hover:bg-red-800 text-white flex items-center justify-center text-sm transition shadow border border-red-700';
        if (micIcon) micIcon.className = 'fa-solid fa-microphone-slash text-red-300 text-sm';
      } else {
        micBtn.className = 'w-10 h-10 rounded-xl bg-slate-800 hover:bg-slate-700 text-emerald-400 flex items-center justify-center text-sm transition shadow border border-slate-700';
        if (micIcon) micIcon.className = 'fa-solid fa-microphone text-emerald-400 text-sm';
      }
    }
  }
}

// Toggle Video Stream
function toggleVideo() {
  if (!callActive || !localStream) {
    appendChatMessage('Hệ thống', 'Camera chỉ hoạt động trong cuộc gọi - bấm "Bắt đầu cuộc gọi" trước.');
    return;
  }
  const videoTrack = localStream.getVideoTracks()[0];
  if (videoTrack) {
    isVideoMuted = !isVideoMuted;
    videoTrack.enabled = !isVideoMuted;

    const videoBtn = document.getElementById('btn-toggle-video') || document.getElementById('video-btn');
    const videoIcon = document.getElementById('icon-video') || videoBtn?.querySelector('i');

    if (videoBtn) {
      if (isVideoMuted) {
        videoBtn.className = 'w-10 h-10 rounded-xl bg-red-900 hover:bg-red-800 text-white flex items-center justify-center text-sm transition shadow border border-red-700';
        if (videoIcon) videoIcon.className = 'fa-solid fa-video-slash text-red-300 text-sm';
      } else {
        videoBtn.className = 'w-10 h-10 rounded-xl bg-slate-800 hover:bg-slate-700 text-emerald-400 flex items-center justify-center text-sm transition shadow border border-slate-700';
        if (videoIcon) videoIcon.className = 'fa-solid fa-video text-blue-400 text-sm';
      }
    }
  }
}

// 4. Speech-to-Text (SpeechRecognition) Engine
let notesSyncTimer = null;

/** Đồng bộ ghi chép lâm sàng lên phòng khám (gộp nhịp để không spam khi đang đọc chính tả). */
function scheduleNotesSync() {
  if (notesSyncTimer) clearTimeout(notesSyncTimer);
  notesSyncTimer = setTimeout(() => {
    const notesInput = document.getElementById('clinical-notes');
    if (!notesInput || !roomId || !peerId) return;
    signalPost({ action: 'notes', notes: notesInput.value })
      .catch(err => console.warn('Không đồng bộ được ghi chép:', err.message));
  }, 1200);
}

function initSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (SpeechRecognition) {
    speechRecognition = new SpeechRecognition();
    speechRecognition.lang = 'vi-VN';
    speechRecognition.continuous = true;
    speechRecognition.interimResults = true;

    speechRecognition.onresult = (event) => {
      let transcript = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }

      const notesInput = document.getElementById('clinical-notes');
      if (notesInput) {
        notesInput.value = (notesInput.value + ' ' + transcript).trim();

        // Đẩy nội dung vừa đọc sang màn hình tuyến trên
        scheduleNotesSync();
      }
    };

    speechRecognition.onerror = (err) => {
      console.warn('SpeechRecognition error:', err.error);
      stopSpeechToText();
    };

    speechRecognition.onend = () => {
      if (isListeningSTT) {
        speechRecognition.start(); // Keep listening continuously
      }
    };
  } else {
    console.warn('SpeechRecognition API not natively supported in this browser.');
  }
}

function toggleSpeechToText() {
  if (!speechRecognition) {
    alert('Trình duyệt hiện tại chưa hỗ trợ API Speech-to-Text trực tiếp. Vui lòng sử dụng Chrome / Edge.');
    return;
  }

  if (isListeningSTT) {
    stopSpeechToText();
  } else {
    // Chuyển lời nói thành văn bản cũng là một đường mở micro, nên áp cùng một
    // quy tắc: chỉ thu âm khi cán bộ trực đã vào cuộc gọi khám từ xa.
    if (!callActive) {
      appendChatMessage('Hệ thống', 'Chức năng thu âm chỉ bật trong cuộc gọi - bấm "Bắt đầu cuộc gọi" trước.');
      return;
    }
    startSpeechToText();
  }
}

function startSpeechToText() {
  isListeningSTT = true;
  speechRecognition.start();

  const sttText = document.getElementById('stt-btn-text');
  if (sttText) sttText.textContent = 'Đang thu âm...';

  const sttBtn = document.getElementById('stt-btn');
  if (sttBtn) sttBtn.className = 'bg-red-900/90 hover:bg-red-800 text-red-200 border border-red-600 text-[10px] px-2 py-1 rounded flex items-center gap-1 transition animate-pulse';

  const sttStatus = document.getElementById('stt-status');
  if (sttStatus) sttStatus.classList.remove('hidden');

  playBeepTone(800, 150);
}

function stopSpeechToText() {
  isListeningSTT = false;
  if (speechRecognition) speechRecognition.stop();

  const sttText = document.getElementById('stt-btn-text');
  if (sttText) sttText.textContent = 'Giọng nói (STT)';

  const sttBtn = document.getElementById('stt-btn');
  if (sttBtn) sttBtn.className = 'bg-slate-700 hover:bg-slate-600 text-emerald-400 border border-emerald-500/40 text-[10px] px-2 py-1 rounded flex items-center gap-1 transition';

  const sttStatus = document.getElementById('stt-status');
  if (sttStatus) sttStatus.classList.add('hidden');
}

// 5. Patient Vitals Submission & Real-time Sync
async function sendVitalsToDoctor() {
  const patientName = document.getElementById('patient-name')?.value || 'Bệnh nhân';
  const patientAge = document.getElementById('patient-age')?.value || '45';
  const patientGender = document.getElementById('patient-gender')?.value || 'Nam';

  const bpSys = document.getElementById('vitals-bp-sys')?.value || 120;
  const bpDia = document.getElementById('vitals-bp-dia')?.value || 80;
  const heartRate = document.getElementById('vitals-hr')?.value || 75;
  const spo2 = document.getElementById('vitals-spo2')?.value || 98;
  const temperature = document.getElementById('vitals-temp')?.value || 36.8;
  const weight = document.getElementById('vitals-weight')?.value || 60;
  const symptoms = document.getElementById('patient-symptoms')?.value || '';

  currentVitals = { bpSys, bpDia, heartRate, spo2, temperature, weight };

  // Update UI local cards
  updateVitalsCards(currentVitals);

  // Bật biểu ngữ cảnh báo ngay tại trạm, không phải chờ máy chủ trả lời.
  const localEval = evaluateVitalsLocally(currentVitals);
  if (localEval.alerts.length) {
    showAlertBanner(localEval.alerts.map(a => a.msg).join(' '), localEval.status);
  } else {
    closeAlertBanner();
  }

  playBeepTone(1000, 150);

  try {
    const response = await stationApiFetch('/api/vitals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roomId,
        peerId,
        stationCode,
        operatorName,
        patientName,
        patientAge,
        patientGender,
        bpSys,
        bpDia,
        heartRate,
        spo2,
        temperature,
        weight,
        symptoms
      })
    });

    const result = await response.json();
    if (result.success) {
      appendChatMessage('Sinh hiệu', `Đã đồng bộ chỉ số: HA ${bpSys}/${bpDia} mmHg, SpO2 ${spo2}%, Tim ${heartRate} bpm.`);

      // Ưu tiên kết quả đánh giá của máy chủ nếu có.
      const evaluation = result.data?.evaluation;
      if (evaluation?.alerts?.length) {
        showAlertBanner(evaluation.alerts.map(a => a.msg).join(' '), evaluation.status);
      }

      // Automatically trigger AI Co-pilot analysis on new vitals submit
      requestAIConsultation();
    }
  } catch (err) {
    console.error('Error submitting vitals:', err);
    appendChatMessage('Hệ thống', 'Không gửi được sinh hiệu lên máy chủ, chỉ số vẫn được lưu tại màn hình trạm.');
  }
}

/**
 * Đánh giá sinh hiệu ngay tại trình duyệt, dùng đúng ngưỡng của /api/vitals.
 * Nhờ vậy biểu ngữ cảnh báo vẫn bật kịp khi đường truyền tới máy chủ bị chậm.
 */
function evaluateVitalsLocally(v) {
  const alerts = [];
  let status = 'NORMAL';

  const num = (x) => Number(String(x).replace(',', '.'));
  const critical = (msg) => { alerts.push({ level: 'CRITICAL', msg }); status = 'CRITICAL'; };
  const warn = (msg) => { alerts.push({ level: 'WARNING', msg }); if (status !== 'CRITICAL') status = 'WARNING'; };

  const spo2 = num(v.spo2);
  const sys = num(v.bpSys);
  const dia = num(v.bpDia);
  const hr = num(v.heartRate);
  const temp = num(v.temperature);

  if (Number.isFinite(spo2)) {
    if (spo2 < 92) critical(`CẢNH BÁO CẤP CỨU: SpO2 giảm nguy hiểm (${spo2}% < 92%). Cần thở Oxy hỗ trợ ngay!`);
    else if (spo2 < 95) warn(`SpO2 thấp (${spo2}%). Theo dõi sát đường hô hấp.`);
  }
  if (Number.isFinite(sys) && Number.isFinite(dia)) {
    if (sys >= 160 || dia >= 100) critical(`CẢNH BÁO CẤP CỨU: Cơn tăng huyết áp (${sys}/${dia} mmHg). Nguy cơ biến cố tim mạch/đột quỵ!`);
    else if (sys >= 140 || sys < 90 || dia >= 90 || dia < 60) warn(`Huyết áp bất thường: ${sys}/${dia} mmHg.`);
  }
  if (Number.isFinite(hr)) {
    if (hr >= 130 || hr <= 45) critical(`CẢNH BÁO CẤP CỨU: Nhịp tim ${hr} bpm ngoài ngưỡng an toàn.`);
    else if (hr > 100 || hr < 55) warn(`Nhịp tim bất thường: ${hr} bpm.`);
  }
  if (Number.isFinite(temp)) {
    if (temp >= 39.5 || temp <= 35) critical(`CẢNH BÁO CẤP CỨU: Nhiệt độ ${temp}°C. Nguy cơ sốt cao/hạ nhiệt độ.`);
    else if (temp >= 38.5) warn(`Sốt cao: ${temp}°C.`);
  }

  return { status, alerts };
}

/** Đổi màu thẻ sinh hiệu theo mức nguy hiểm: bình thường / cảnh báo / cấp cứu. */
function paintVitalCard(cardId, level) {
  const card = document.getElementById(cardId);
  if (!card) return;
  if (level === 'CRITICAL') {
    card.className = 'bg-red-950/90 p-2.5 rounded-xl border-2 border-red-600 text-center animate-pulse';
  } else if (level === 'WARNING') {
    card.className = 'bg-amber-950/90 p-2.5 rounded-xl border-2 border-amber-600 text-center';
  } else {
    card.className = 'bg-slate-900 p-2.5 rounded-xl border border-slate-800 text-center';
  }
}

function levelFor(value, warnFn, criticalFn) {
  const n = Number(String(value).replace(',', '.'));
  if (!Number.isFinite(n)) return 'NORMAL';
  if (criticalFn(n)) return 'CRITICAL';
  if (warnFn(n)) return 'WARNING';
  return 'NORMAL';
}

function updateVitalsCards(v) {
  const setText = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };

  // Thẻ sinh hiệu ở cột nhập liệu
  setText('display-bp', `${v.bpSys}/${v.bpDia}`);
  setText('display-hr', `${v.heartRate} bpm`);
  setText('display-spo2', `${v.spo2}%`);
  setText('display-temp', `${v.temperature}°C`);

  // Thẻ HUD chồng trên khung hình khám
  setText('hud-bp', `${v.bpSys}/${v.bpDia}`);
  setText('hud-hr', v.heartRate);
  setText('hud-spo2', `${v.spo2}%`);
  setText('hud-temp', `${v.temperature}°C`);

  const pName = document.getElementById('patient-name')?.value || 'Bệnh nhân';
  const pAge = document.getElementById('patient-age')?.value || '';
  const pGender = document.getElementById('patient-gender')?.value || '';
  const detail = [pAge ? `${pAge}T` : '', pGender].filter(Boolean).join(' · ');
  setText('hud-patient-name', detail ? `${pName} (${detail})` : pName);

  // Tô màu cảnh báo cho từng thẻ chỉ số
  paintVitalCard('card-spo2', levelFor(v.spo2, n => n < 95, n => n < 92));
  paintVitalCard('card-hr', levelFor(v.heartRate, n => n > 100 || n < 55, n => n >= 130 || n <= 45));
  paintVitalCard('card-temp', levelFor(v.temperature, n => n >= 38.5, n => n >= 39.5 || n <= 35));

  const sys = Number(v.bpSys);
  const dia = Number(v.bpDia);
  let bpLevel = 'NORMAL';
  if (sys >= 160 || dia >= 100) bpLevel = 'CRITICAL';
  else if (sys >= 140 || sys < 90 || dia >= 90 || dia < 60) bpLevel = 'WARNING';
  paintVitalCard('card-bp', bpLevel);
}

/**
 * Nhận sinh hiệu từ đầu bên kia. Bản tin dùng đúng định dạng của màn hình
 * Y sĩ/ Bác sĩ: { bp: "135/85", hr, spo2, temp, weight, at }.
 */
function updateVitalsUIFromRemote(v) {
  if (!v) return;

  const [bpSys, bpDia] = String(v.bp || '').split('/');
  const merged = {
    bpSys: bpSys || currentVitals.bpSys,
    bpDia: bpDia || currentVitals.bpDia,
    heartRate: v.hr || currentVitals.heartRate,
    spo2: v.spo2 || currentVitals.spo2,
    temperature: v.temp || currentVitals.temperature,
    weight: v.weight || currentVitals.weight
  };

  currentVitals = merged;

  const setValue = (id, value) => {
    const el = document.getElementById(id);
    if (el && value !== undefined && value !== null && value !== '') el.value = value;
  };

  setValue('vitals-bp-sys', merged.bpSys);
  setValue('vitals-bp-dia', merged.bpDia);
  setValue('vitals-hr', merged.heartRate);
  setValue('vitals-spo2', merged.spo2);
  setValue('vitals-temp', merged.temperature);
  setValue('vitals-weight', merged.weight);

  updateVitalsCards(merged);
}

// 6. Clinical AI Co-Pilot Assistant Integration
async function requestAIConsultation() {
  const patientName = document.getElementById('patient-name')?.value || 'Bệnh nhân';
  const patientAge = document.getElementById('patient-age')?.value || '45';
  const patientGender = document.getElementById('patient-gender')?.value || 'Nam';

  const notes = document.getElementById('clinical-notes')?.value || '';
  const symptoms = document.getElementById('patient-symptoms')?.value || '';

  try {
    const response = await fetch('/api/clinical-ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vitals: currentVitals,
        symptoms,
        notes,
        patientName,
        patientAge,
        patientGender
      })
    });

    const result = await response.json();
    if (result.success && result.data) {
      currentAIAnalysis = result.data;
      renderAIResults(result.data);
    }
  } catch (err) {
    console.error('AI Co-pilot fetch error:', err);
  }
}

function renderAIResults(data) {
  // Red Flag Alerts
  const redFlagsContainer = document.getElementById('ai-red-flags');
  if (redFlagsContainer) {
    if (data.redFlags && data.redFlags.length > 0) {
      redFlagsContainer.innerHTML = data.redFlags.map(f => `<div>${f}</div>`).join('');
      redFlagsContainer.classList.remove('hidden');
    } else {
      redFlagsContainer.classList.add('hidden');
    }
  }

  // Diagnostic List
  const diagList = document.getElementById('ai-diagnosis-list');
  if (diagList && data.diagnosisList) {
    diagList.innerHTML = data.diagnosisList.map(d => `<li>${d}</li>`).join('');
  }

  // Paraclinicals List
  const paraList = document.getElementById('ai-paraclinicals-list');
  if (paraList && data.paraclinicals) {
    paraList.innerHTML = data.paraclinicals.map(p => `<li>${p}</li>`).join('');
  }

  // Prescriptions List
  const rxList = document.getElementById('ai-prescription-list');
  if (rxList && data.prescriptions) {
    rxList.innerHTML = data.prescriptions.map(rx => `
      <div class="bg-slate-800/80 p-1.5 rounded border border-slate-700/60">
        <div class="font-semibold text-emerald-300">${rx.name}</div>
        <div class="text-[10px] text-slate-300">${rx.dosage} (${rx.note || ''})</div>
      </div>
    `).join('');
  }

  const confidenceEl = document.getElementById('ai-confidence');
  if (confidenceEl) confidenceEl.textContent = `Độ tin cậy AI: ${data.aiConfidence || '94%'}`;
}

// 7. Finish Consultation & Export Examination Sheet Report
async function finishAndExportReport() {
  const val = (id) => document.getElementById(id)?.value?.trim() || '';

  const patientName = val('patient-name') || 'Bệnh nhân';
  const patientAge = val('patient-age') || '';
  const patientGender = val('patient-gender') || 'Nam';
  const symptoms = val('patient-symptoms') || 'Chưa ghi nhận';
  const clinicalNotes = val('clinical-notes') || 'Bệnh nhân tỉnh táo, tim phổi ổn định.';

  // Kết luận do cán bộ trạm / bác sĩ tư vấn gõ trực tiếp được ưu tiên hơn gợi ý của AI.
  const manualDiagnosis = val('station-dx-diagnosis');
  const manualDrugs = val('station-dx-drugs');
  const manualAdvice = val('station-doctor-advice');

  const aiDiagnosis = currentAIAnalysis?.diagnosisList?.length
    ? currentAIAnalysis.diagnosisList.join('; ')
    : 'Viêm đường hô hấp trên cấp tính (J06.9)';
  const aiPrescription = currentAIAnalysis?.prescriptions?.length
    ? currentAIAnalysis.prescriptions.map((rx, idx) => `${idx + 1}. ${rx.name} - ${rx.dosage}`).join('\n')
    : '1. Paracetamol 500mg - Uống 1 viên x 3 lần/ngày khi sốt >= 38.5°C';

  const diagnosisText = manualDiagnosis || aiDiagnosis;
  const prescriptionText = manualDrugs || aiPrescription;
  const treatmentPlan = 'Điều trị nội khoa tại điểm trạm / Theo dõi 48 giờ';

  let reportData = null;
  try {
    const response = await stationApiFetch('/api/examination-report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roomId,
        stationCode,
        operatorName,
        patientName,
        patientAge,
        patientGender,
        vitals: currentVitals,
        clinicalNotes,
        diagnosis: diagnosisText,
        icd10: currentAIAnalysis?.icd10Codes?.join(', ') || 'J06.9',
        treatmentPlan,
        prescription: prescriptionText,
        doctorNotes: manualAdvice
      })
    });
    const result = await response.json();
    if (result.success) reportData = result.data;
  } catch (err) {
    console.error('Error exporting report:', err);
  }

  // Phiếu khám vẫn phải in được kể cả khi không lưu được lên máy chủ.
  renderReportModal({
    reportData,
    patientName,
    patientAge,
    patientGender,
    symptoms,
    clinicalNotes,
    diagnosisText,
    prescriptionText,
    treatmentPlan,
    advice: manualAdvice
  });

  if (!reportData) {
    appendChatMessage('Hệ thống', 'Chưa lưu được phiếu khám lên máy chủ - bản in A5 vẫn sẵn sàng để in.');
    return;
  }

  // Đánh dấu buổi khám đã hoàn tất (chỉ khi đang thực sự ở trong một phòng khám).
  if (callActive && peerId) {
    signalPost({ action: 'complete' })
      .catch(err => console.warn('Không cập nhật được trạng thái phòng khám:', err.message));
  }
}

/** Đổ toàn bộ dữ liệu buổi khám vào cửa sổ Phiếu khám & Đơn thuốc khổ A5. */
function renderReportModal(ctx) {
  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };
  const setVal = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.value = value;
  };

  const code = ctx.reportData?.reportCode || `PK-${Date.now().toString().slice(-6)}`;
  setText('rpt-code', String(code).startsWith('PK-') ? code : `PK-${code}`);
  setText('rpt-date', `Ngày: ${new Date().toLocaleDateString('vi-VN')}`);
  setText('rpt-station', `${stationCode} - ${stationName(stationCode)}`);

  // Thông tin bệnh nhân & cán bộ (các ô cho phép sửa trực tiếp trước khi in)
  setVal('rpt-edit-patient-name', ctx.patientName);
  // Mẫu số 01 - Thông tư 52/2017/TT-BYT tách riêng tuổi và giới tính, thêm ngày
  // sinh, cân nặng, địa chỉ; phần nào chưa có dữ liệu thì để cán bộ điền tay.
  setVal('rpt-edit-age-gender', ctx.patientAge ? `${ctx.patientAge} tuổi` : '');
  const genderEl = document.getElementById('rpt-edit-gender');
  if (genderEl && ctx.patientGender) genderEl.value = ctx.patientGender;
  if (ctx.patientDob) setVal('rpt-edit-dob', ctx.patientDob);
  if (ctx.patientAddress) setVal('rpt-edit-address', ctx.patientAddress);
  setVal('rpt-edit-operator', operatorName);
  setText('rpt-sig-operator-name', operatorName);

  setVal('rpt-edit-symptoms', ctx.symptoms);
  setVal('rpt-edit-clinical-notes', ctx.clinicalNotes);

  // Sinh hiệu
  const v = currentVitals;
  setText('rpt-val-bp', `${v.bpSys}/${v.bpDia}`);
  setText('rpt-val-hr', `${v.heartRate} bpm`);
  setText('rpt-val-spo2', `${v.spo2}%`);
  setText('rpt-val-temp', `${v.temperature}°C`);
  setText('rpt-val-weight', `${v.weight || 60} kg`);
  const rptWeight = document.getElementById('rpt-edit-weight');
  if (rptWeight && !rptWeight.value.trim()) rptWeight.value = String(v.weight || 60);

  // Chẩn đoán, hướng xử trí, đơn thuốc, lời dặn
  setVal('rpt-edit-diagnosis', ctx.diagnosisText);
  setVal('rpt-edit-treatment', ctx.reportData?.treatmentPlan || ctx.treatmentPlan);
  setVal('rpt-edit-prescription', ctx.prescriptionText);
  if (ctx.advice) setVal('rpt-edit-advice', ctx.advice);

  // Chữ ký số của Bác sĩ kê đơn (do engine liên thông trong trang chính quản lý)
  if (typeof window.renderSignerSelectors === 'function') window.renderSignerSelectors();
  if (typeof window.renderActiveSignerPreview === 'function') window.renderActiveSignerPreview();

  openReportModal();
}

/**
 * window.openModal() ẩn mọi .modal-content trước khi mở cửa sổ mới, nên phiếu
 * khám sẽ che mất Bảng điều khiển trạm. Ghi nhớ trạng thái để khi đóng phiếu
 * thì cán bộ được trả về đúng bảng điều khiển đang khám, không bị đẩy ra trang
 * chủ giữa lúc cuộc gọi vẫn đang diễn ra.
 *
 * Bảng điều khiển đang ở dạng khung nổi (thu nhỏ/ẩn) thì nó không bị phiếu khám
 * che, nên cũng không cần khôi phục - cứ để nguyên trạng thái người dùng chọn.
 */
let stationPanelWasOpen = false;

function stationPanelFloating() {
  const panel = document.getElementById('modal-station-panel');
  return !!(panel && window.TeleWin && window.TeleWin.isFloating(panel));
}

function openReportModal() {
  const panel = document.getElementById('modal-station-panel');
  stationPanelWasOpen = !!panel && !panel.classList.contains('hidden') && !stationPanelFloating();

  if (typeof window.openModal === 'function') {
    window.openModal('report-modal');
    return;
  }
  const overlay = document.getElementById('modal-overlay');
  const rptModal = document.getElementById('report-modal');
  if (overlay) overlay.classList.remove('hidden');
  if (rptModal) {
    if (window.TeleWin) window.TeleWin.hideModals('report-modal');
    rptModal.classList.remove('hidden');
  }
}

function closeReportModal() {
  const rptModal = document.getElementById('report-modal');
  if (rptModal) rptModal.classList.add('hidden');

  const panel = document.getElementById('modal-station-panel');
  if (stationPanelWasOpen && panel) {
    panel.classList.remove('hidden');
    stationPanelWasOpen = false;
    return;
  }

  if (window.TeleWin) {
    window.TeleWin.sync();
    return;
  }
  const overlay = document.getElementById('modal-overlay');
  if (overlay) overlay.classList.add('hidden');
  document.body.style.overflow = 'auto';
}

// 8. Station Login Modal Handlers
//    Rào chắn đăng nhập của Module Bảng điều khiển trạm: thông tin đăng nhập được
//    máy chủ /api/station-auth xác thực trước, chỉ khi máy chủ trả về hợp lệ thì
//    phiên làm việc mới được ghi nhận và thân module mới được mở.
const STATION_AUTH_URL = '/api/station-auth';

function openLoginModal() {
  const overlay = document.getElementById('modal-overlay');
  if (overlay) overlay.classList.remove('hidden');

  const modal = document.getElementById('login-modal');
  if (modal) modal.classList.remove('hidden');

  const pwd = document.getElementById('input-station-password');
  if (pwd) pwd.value = '';
}

function closeLoginModal() {
  document.getElementById('login-modal').classList.add('hidden');
}

/** Hiển thị trạng thái xác thực ngay trong popup đăng nhập. */
function setStationLoginStatus(message, tone) {
  const el = document.getElementById('station-login-status');
  if (!el) return;

  const tones = {
    info: 'text-[11px] font-bold text-slate-400',
    pending: 'text-[11px] font-bold text-blue-400',
    error: 'text-[11px] font-bold text-rose-400',
    success: 'text-[11px] font-bold text-emerald-400'
  };
  el.className = tones[tone] || tones.info;
  el.textContent = message;
}

async function submitLogin() {
  const code = document.getElementById('input-station-code').value.trim();
  const selectedCmsUsername = (document.getElementById('input-cms-account')?.value || '').trim();
  const typedName = document.getElementById('input-operator-name').value.trim();
  const password = document.getElementById('input-station-password')?.value || '';
  const submitBtn = document.getElementById('station-login-submit');

  if (!code) return setStationLoginStatus('Vui lòng chọn điểm trạm đang trực.', 'error');
  if (!selectedCmsUsername) return setStationLoginStatus('Vui lòng chọn tài khoản cán bộ đã được CMS Quản trị cấp quyền.', 'error');
  if (!password) return setStationLoginStatus('Vui lòng nhập mật khẩu truy cập.', 'error');

  if (submitBtn) submitBtn.disabled = true;
  setStationLoginStatus('Đang xác thực tài khoản với hệ thống CMS...', 'pending');

  let result = null;
  try {
    const res = await fetch(STATION_AUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: selectedCmsUsername, password, scope: 'station' })
    });
    result = await res.json().catch(() => null);

    if (!res.ok || !result || result.success !== true) {
      // Lỗi phía máy chủ (500) có thể kèm chi tiết kỹ thuật - không hiển thị ra giao diện.
      const reason = res.status >= 500
        ? 'Hệ thống xác thực đang gián đoạn, vui lòng liên hệ Quản trị CMS.'
        : ((result && result.error) || 'Tài khoản hoặc mật khẩu không hợp lệ.');
      setStationLoginStatus('⛔ Từ chối truy cập: ' + reason, 'error');
      return;
    }
  } catch (err) {
    setStationLoginStatus('Không kết nối được máy chủ xác thực. Vui lòng thử lại.', 'error');
    return;
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }

  const authUser = result.user || { username: selectedCmsUsername, name: typedName };
  loggedInCmsUser = authUser;

  const previousPeerId = peerId;
  const previousRoomId = roomId;
  const stationChanged = code !== stationCode;

  stationCode = code;
  operatorName = authUser.name || typedName || authUser.username;
  role = 'station_operator'; // Luôn cố định vai trò Cán bộ Y tế Điểm trạm
  if (stationChanged) roomId = defaultRoomForStation(stationCode);

  renderStationIdentity();

  // Ghi nhận phiên làm việc để rào chắn của module cho phép mở thân Bảng điều khiển.
  // Phiếu JWT (result.token) là thứ mọi lệnh gọi API của module gắn kèm; máy chủ đọc
  // lại quyền từ cơ sở dữ liệu theo từng yêu cầu nên thu hồi quyền có hiệu lực ngay.
  if (typeof window.setStationSession === 'function') {
    window.setStationSession({
      token: result.token || '',
      expiresAt: result.expiresAt || 0,
      scopes: Array.isArray(result.scopes) ? result.scopes : [],
      username: authUser.username,
      name: operatorName,
      role: authUser.role || '',
      stationCode: authUser.stationCode || stationCode,
      loginAt: Date.now()
    });
  }

  if (result.mustChangePassword) {
    // Mật khẩu tạm do Quản trị cấp - nhắc cán bộ đổi lại mật khẩu riêng.
    setStationLoginStatus('✅ Đăng nhập thành công. Lưu ý: tài khoản đang dùng mật khẩu tạm, hãy đề nghị Quản trị đổi mật khẩu riêng.', 'success');
  }

  setStationLoginStatus('✅ Xác thực thành công. Đang mở Bảng điều khiển...', 'success');

  const pwdInput = document.getElementById('input-station-password');
  if (pwdInput) pwdInput.value = '';

  closeLoginModal();
  if (typeof window.openStationPanel === 'function') window.openStationPanel();

  // Rời phòng cũ nếu có
  if (previousPeerId && previousRoomId) {
    fetch(SIGNAL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'leave', roomId: previousRoomId, peerId: previousPeerId })
    }).catch(() => {});
  }

  // Đăng nhập chỉ mở bảng điều khiển. Vào phòng khám và bật camera/micro là một
  // thao tác riêng, do cán bộ trực chủ động bấm khi thật sự bắt đầu khám.
  if (callActive && stationChanged) {
    joinRoom();
  } else {
    updateCallControlsUI();
    updateConnectionBadge(false, 'Chưa kết nối - bấm "Bắt đầu cuộc gọi"');
    appendChatMessage('Hệ thống', 'Đã mở Bảng điều khiển. Bấm "Bắt đầu cuộc gọi" khi cần hội chẩn với tuyến trên.');
  }
}

// 9. Chat Helpers
function handleChatKeyPress(event) {
  if (event.key === 'Enter') {
    sendChatMessage();
  }
}

function sendChatMessage() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;

  const time = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  appendChatMessage(operatorName, text, time);

  sendSignal('chat', { sender: operatorName, text });

  input.value = '';
}

function appendChatMessage(sender, text, time = '') {
  const chatBox = document.getElementById('chat-box');
  if (!chatBox) return;
  const msgEl = document.createElement('div');
  msgEl.className = 'text-slate-200 leading-normal bg-slate-900/80 p-1 rounded border border-slate-800';
  msgEl.innerHTML = `<span class="font-semibold text-blue-400">${sender}</span> <span class="text-[9px] text-slate-500">${time}</span>: <span>${text}</span>`;
  chatBox.appendChild(msgEl);
  chatBox.scrollTop = chatBox.scrollHeight;
}

// 10. Audio & Alert Helpers

/**
 * Biểu ngữ cảnh báo khẩn cấp cho chỉ số sinh tồn nguy hiểm.
 * level = 'CRITICAL' (đỏ, nháy) hoặc 'WARNING' (hổ phách).
 */
function showAlertBanner(msg, level = 'CRITICAL') {
  const banner = document.getElementById('alert-banner');
  const msgEl = document.getElementById('alert-banner-msg');
  if (msgEl) msgEl.textContent = msg;
  if (!banner) return;

  const isCritical = level !== 'WARNING';
  banner.className = isCritical
    ? 'bg-rose-950/90 border-b border-rose-700 px-6 py-2.5 text-xs text-rose-200 flex items-center justify-between font-bold animate-pulse'
    : 'bg-amber-950/90 border-b border-amber-700 px-6 py-2.5 text-xs text-amber-200 flex items-center justify-between font-bold';
  banner.classList.remove('hidden');

  if (isCritical) playBeepTone(1200, 320);
}

function closeAlertBanner() {
  const banner = document.getElementById('alert-banner');
  if (banner) banner.classList.add('hidden');
}

function startCallTimer() {
  // Đồng hồ chỉ chạy trong cuộc gọi, và không bao giờ có hai bộ đếm cùng chạy.
  stopCallTimer();
  callTimerSeconds = 0;
  callTimerInterval = setInterval(() => {
    callTimerSeconds++;
    const mins = String(Math.floor(callTimerSeconds / 60)).padStart(2, '0');
    const secs = String(callTimerSeconds % 60).padStart(2, '0');
    const timerEl = document.getElementById('call-timer');
    if (timerEl) timerEl.textContent = `${mins}:${secs}`;
  }, 1000);
}

function stopCallTimer() {
  if (callTimerInterval) {
    clearInterval(callTimerInterval);
    callTimerInterval = null;
  }
  callTimerSeconds = 0;
  const timerEl = document.getElementById('call-timer');
  if (timerEl) timerEl.textContent = '00:00';
}

function playBeepTone(freq = 800, duration = 100) {
  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + duration / 1000);
  } catch (e) {
    // Ignore audio context autoplay restrictions if present
  }
}

// Global Window Bindings for HTML Event Handlers
window.loadCmsData = loadCmsData;
window.populateCmsAccountsDropdown = populateCmsAccountsDropdown;
window.onCmsAccountSelect = onCmsAccountSelect;
window.startQueuePolling = startQueuePolling;
window.stopQueuePolling = stopQueuePolling;
window.refreshIncomingCallsQueue = refreshIncomingCallsQueue;
window.acceptPatientCall = acceptPatientCall;
window.acceptNextPatientCall = acceptNextPatientCall;
window.joinRoom = joinRoom;
window.startTeleconsultation = startTeleconsultation;
window.endTeleconsultation = endTeleconsultation;
/** Bảng điều khiển hỏi trạng thái cuộc gọi trước khi cho đóng hẳn module. */
window.isStationCallActive = function() { return callActive; };
window.switchStation = switchStation;
window.stationList = STATIONS;
window.toggleCameraDevice = toggleCameraDevice;
window.toggleMic = toggleMic;
window.toggleVideo = toggleVideo;
window.toggleAudioSettings = toggleAudioSettings;
window.setCallNoiseProfile = setCallNoiseProfile;
window.setCallAntiHowl = setCallAntiHowl;
window.setCallDuck = setCallDuck;
window.setCallSpeakerVolume = setCallSpeakerVolume;
window.setCallMicDevice = setCallMicDevice;
window.setCallSpeakerDevice = setCallSpeakerDevice;
window.refreshAudioDeviceOptions = refreshAudioDeviceOptions;
window.toggleSpeechToText = toggleSpeechToText;
window.sendVitalsToDoctor = sendVitalsToDoctor;
window.requestAIConsultation = requestAIConsultation;
window.finishAndExportReport = finishAndExportReport;
window.closeReportModal = closeReportModal;
window.openLoginModal = openLoginModal;
window.closeLoginModal = closeLoginModal;
window.submitLogin = submitLogin;
window.sendChatMessage = sendChatMessage;
window.handleChatKeyPress = handleChatKeyPress;
window.closeAlertBanner = closeAlertBanner;
