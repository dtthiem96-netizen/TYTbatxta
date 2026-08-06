// Telehealth Station Application Logic - Vanilla JS

/**
 * Danh sách điểm trạm y tế khu vực. Mỗi điểm trạm có một phòng trực riêng để
 * Bác sĩ tuyến trên và Trợ lý AI biết cuộc gọi đến từ đâu.
 */
const STATIONS = [
  { code: 'TYT-BATXAT-01', name: 'Trạm Y tế Bát Xát (Trung tâm)' },
  { code: 'TYT-AMLUONG-02', name: 'Điểm trạm Ẩm Lương' },
  { code: 'TYT-YTY-03', name: 'Điểm trạm Y Tý' },
  { code: 'TYT-BANXEO-04', name: 'Điểm trạm Bản Xèo' },
  { code: 'TYT-LUNGFIN-05', name: 'Điểm trạm Lũng Pô Fin' }
];

/** Phòng trực mặc định của một điểm trạm, ví dụ TYT-YTY-03 -> room-tyt-yty-03. */
function defaultRoomForStation(code) {
  return 'room-' + String(code || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function stationName(code) {
  const found = STATIONS.find(s => s.code === code);
  return found ? found.name : code;
}

let stationCode = 'TYT-BATXAT-01';
let operatorName = 'Y sĩ Nguyễn Văn A';
let role = 'station_operator';
let roomId = defaultRoomForStation(stationCode);

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
let remotePeerName = null;
let isConnected = false;
let rejoinTimer = null;
let rejoinAttempts = 0;

let peerConnection = null;
let localStream = null;
let videoDevices = [];
let currentCamIndex = 0;

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

  // Bắt đầu quét danh sách cuộc gọi chờ từ người dân
  startQueuePolling();

  // Initialize Media Devices & Camera
  initLocalCamera();

  // Vào phòng khám qua kênh signaling HTTP
  joinRoom();

  // Initialize Speech-to-Text Engine
  initSpeechRecognition();

  // Đẩy ghi chép lâm sàng gõ tay sang tuyến trên theo nhịp
  const notesEl = document.getElementById('clinical-notes');
  if (notesEl) notesEl.addEventListener('input', scheduleNotesSync);

  // Start Call Timer
  startCallTimer();
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
  joinRoom();
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
    if (u.stationAccess === 'true') return true;
    if (u.stationAccess === 'false') return false;
    return /Điểm trạm|Station|Admin|Quản trị/i.test(u.role || '');
  };

  const stationAccounts = cmsUsers.filter(hasStationAccess);
  const accountsToRender = stationAccounts.length > 0 ? stationAccounts : cmsUsers;

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

async function refreshIncomingCallsQueue() {
  try {
    const res = await fetch('/api/signal?action=rooms');
    if (!res.ok) return;
    const data = await res.json();
    const rooms = (data.rooms || []).filter(r => r.roomId !== '__lobby__');

    const countEl = document.getElementById('station-queue-count');
    const listEl = document.getElementById('station-queue-list');
    if (countEl) countEl.textContent = `${rooms.length} cuộc gọi`;

    if (!listEl) return;
    if (rooms.length === 0) {
      listEl.innerHTML = '<div class="text-[11px] text-slate-400 italic">Hiện không có người dân nào đang gọi. Đang chờ kết nối...</div>';
      return;
    }

    listEl.innerHTML = rooms.map(r => {
      const pName = r.patientName || 'Bệnh nhân';
      const isCurrent = r.roomId === roomId;
      return `
        <div class="flex items-center justify-between gap-3 bg-slate-900 border ${isCurrent ? 'border-emerald-500' : 'border-slate-700'} p-2 rounded-xl text-xs whitespace-nowrap shadow">
          <div class="flex items-center space-x-2">
            <i class="fa-solid fa-user text-blue-400"></i>
            <div>
              <div class="font-bold text-white text-[12px]">${pName}</div>
              <div class="text-[10px] text-slate-400">${r.symptoms || 'Khám sức khỏe tổng quát'}</div>
            </div>
          </div>
          <button onclick="acceptPatientCall('${r.roomId}', '${pName.replace(/'/g, "\\'")}', '${(r.symptoms||'').replace(/'/g, "\\'")}')" 
            class="${isCurrent ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-blue-600 hover:bg-blue-500'} text-white font-bold px-3 py-1.5 rounded-lg text-[11px] transition flex items-center gap-1.5">
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

  joinRoom();
  showAlertBanner(`Đã tiếp nhận và kết nối với bệnh nhân: ${patientName}`);
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
    case 'call-ended':
      isConnected = false;
      remotePeerName = null;
      appendChatMessage('Hệ thống', 'Đầu bên kia đã rời phòng khám.');
      showRemotePlaceholder();
      updateConnectionBadge(false, 'Tuyến trên đã rời phòng khám');
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
      { urls: 'stun:stun.cloudflare.com:3478' }
    ],
    iceCandidatePoolSize: 4
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
  if (localStream) {
    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
    });
  }

  // Handle incoming remote media stream
  peerConnection.ontrack = (event) => {
    console.log('🎥 Remote video track received');
    const remoteVideo = document.getElementById('remote-video');
    const remotePlaceholder = document.getElementById('remote-placeholder');

    if (remoteVideo) {
      remoteVideo.srcObject = event.streams[0];
      remoteVideo.classList.remove('hidden');
    }
    if (remotePlaceholder) {
      remotePlaceholder.classList.add('hidden');
    }
    isConnected = true;
    updateConnectionBadge(true, 'Đang kết nối với bác sĩ');
  };

  // ICE Candidates
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      sendSignal('ice', event.candidate);
    }
  };

  return true;
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
  const ice = new RTCIceCandidate(candidate);

  // Ứng viên ICE đến trước khi có remote description thì phải xếp hàng, nếu không sẽ mất.
  if (!peerConnection.remoteDescription || !peerConnection.remoteDescription.type) {
    pendingCandidates.push(ice);
    return;
  }

  try {
    await peerConnection.addIceCandidate(ice);
  } catch (err) {
    console.warn('Error adding ICE candidate:', err.message);
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
  try {
    const constraints = {
      audio: true,
      video: deviceId ? { deviceId: { exact: deviceId } } : { width: { ideal: 1280 }, height: { ideal: 720 } }
    };

    localStream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    console.warn('⚠️ Camera access warning, attempting audio-only fallback:', err.message);
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err2) {
      console.warn('⚠️ Audio/Video access unavailable:', err2.message);
      localStream = null;
    }
  }

  if (localStream) {
    const localVideo = document.getElementById('local-video');
    if (localVideo) {
      localVideo.srcObject = localStream;
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
      const audioTrack = localStream.getAudioTracks()[0];
      const senders = peerConnection.getSenders();
      
      const videoSender = senders.find(s => s.track && s.track.kind === 'video');
      if (videoSender && videoTrack) {
        videoSender.replaceTrack(videoTrack);
      }
      const audioSender = senders.find(s => s.track && s.track.kind === 'audio');
      if (audioSender && audioTrack) {
        audioSender.replaceTrack(audioTrack);
      }
    }
  }
}

// Switch between Wide Angle Camera and Close-Up Lesion/Dermatoscope Camera
async function toggleCameraDevice() {
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
  if (!localStream) return;
  const audioTrack = localStream.getAudioTracks()[0];
  if (audioTrack) {
    isMicMuted = !isMicMuted;
    audioTrack.enabled = !isMicMuted;

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
  if (!localStream) return;
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
    const response = await fetch('/api/vitals', {
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
    const response = await fetch('/api/examination-report', {
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

  // Đánh dấu buổi khám đã hoàn tất.
  signalPost({ action: 'complete' })
    .catch(err => console.warn('Không cập nhật được trạng thái phòng khám:', err.message));
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
  const ageGender = [ctx.patientAge ? `${ctx.patientAge} tuổi` : '', ctx.patientGender].filter(Boolean).join(' - ');
  setVal('rpt-edit-age-gender', ageGender);
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
 */
let stationPanelWasOpen = false;

function openReportModal() {
  const panel = document.getElementById('modal-station-panel');
  stationPanelWasOpen = !!panel && !panel.classList.contains('hidden');

  if (typeof window.openModal === 'function') {
    window.openModal('report-modal');
    return;
  }
  const overlay = document.getElementById('modal-overlay');
  const rptModal = document.getElementById('report-modal');
  if (overlay) overlay.classList.remove('hidden');
  if (rptModal) {
    document.querySelectorAll('.modal-content').forEach(m => m.classList.add('hidden'));
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
      body: JSON.stringify({ username: selectedCmsUsername, password })
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
  if (typeof window.setStationSession === 'function') {
    window.setStationSession({
      username: authUser.username,
      name: operatorName,
      role: authUser.role || '',
      stationCode: stationCode,
      loginAt: Date.now()
    });
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

  joinRoom();
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
  callTimerInterval = setInterval(() => {
    callTimerSeconds++;
    const mins = String(Math.floor(callTimerSeconds / 60)).padStart(2, '0');
    const secs = String(callTimerSeconds % 60).padStart(2, '0');
    const timerEl = document.getElementById('call-timer');
    if (timerEl) timerEl.textContent = `${mins}:${secs}`;
  }, 1000);
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
window.joinRoom = joinRoom;
window.switchStation = switchStation;
window.stationList = STATIONS;
window.toggleCameraDevice = toggleCameraDevice;
window.toggleMic = toggleMic;
window.toggleVideo = toggleVideo;
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
