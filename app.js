// Telehealth Station Application Logic - Vanilla JS

let stationCode = 'TYT-BATXAT-01';
let operatorName = 'Y sĩ Nguyễn Văn A';
let role = 'station_operator';
let roomId = 'room-tytbatxat01';

// Signaling chạy qua HTTP long-poll (/api/signal) thay cho WebSocket:
// nền tảng serverless không giữ kết nối socket lâu dài, và đây cũng chính là
// giao thức mà màn hình Y sĩ/ Bác sĩ trong trang chính đang dùng.
const SIGNAL_URL = '/api/signal';
let peerId = null;
let signalCursor = 0;
let polling = false;
let pollToken = 0;
let pendingCandidates = [];
let remotePeerName = null;
let isConnected = false;

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

// Initialize Application
document.addEventListener('DOMContentLoaded', () => {
  console.log('🚀 Initializing Telehealth Station Panel...');
  
  // Set default values in UI safely
  const elCode = document.getElementById('display-station-code');
  if (elCode) elCode.textContent = stationCode;
  const elOp = document.getElementById('display-operator-name');
  if (elOp) elOp.textContent = operatorName;

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

  // Start Call Timer
  startCallTimer();
});

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

  // Lọc danh sách tài khoản thuộc Cán bộ điểm trạm / Quản trị viên
  const stationAccounts = cmsUsers.filter(u => u.role.includes('Trạm') || u.role.includes('Cán bộ') || u.role.includes('Admin') || u.canReceiveVideo === 'true');
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
    updateConnectionBadge(false, 'Mất kết nối - đang thử lại...');
    setTimeout(joinRoom, 3000);
  }
}

function stopPolling() {
  polling = false;
  pollToken += 1;
}

async function pollLoop(token) {
  while (polling && pollToken === token) {
    try {
      const url = `${SIGNAL_URL}?roomId=${encodeURIComponent(roomId)}&peerId=${encodeURIComponent(peerId)}&cursor=${signalCursor}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error('poll ' + res.status);
      const data = await res.json();
      if (!polling || pollToken !== token) return;

      if (typeof data.cursor === 'number') signalCursor = data.cursor;
      updateConnectionBadge(true, isConnected ? 'Đang kết nối với tuyến trên' : 'Đã vào phòng khám - chờ tiếp nhận');

      for (const msg of (data.messages || [])) {
        await handleSignalMessage(msg);
      }
    } catch (err) {
      if (!polling || pollToken !== token) return;
      console.warn('Mất tín hiệu signaling, đang thử lại...', err.message);
      updateConnectionBadge(false, 'Mất kết nối - đang thử lại...');
      await new Promise(r => setTimeout(r, 2000));
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

  if (connected) {
    badge.className = 'flex items-center space-x-2 bg-emerald-950/80 border border-emerald-800/80 text-emerald-400 text-xs px-3 py-1.5 rounded-full';
    badgeText.textContent = text;
  } else {
    badge.className = 'flex items-center space-x-2 bg-red-950/80 border border-red-800/80 text-red-400 text-xs px-3 py-1.5 rounded-full';
    badgeText.textContent = text;
  }
}

// 2. WebRTC Audio/Video Connection Setup
function initPeerConnection() {
  if (peerConnection) {
    try {
      peerConnection.ontrack = null;
      peerConnection.onicecandidate = null;
      peerConnection.close();
    } catch (err) {}
  }

  const configuration = {
    iceServers: [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
      { urls: 'stun:stun.cloudflare.com:3478' }
    ],
    iceCandidatePoolSize: 4
  };

  peerConnection = new RTCPeerConnection(configuration);

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
}

async function createWebRTCOffer() {
  if (!peerConnection) initPeerConnection();
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
  if (!peerConnection) initPeerConnection();
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

  // Update UI Labels
  document.getElementById('pip-label').textContent = isCloseup ? 'Cam Cận Cảnh' : 'Cam Toàn Cảnh';
  document.getElementById('camera-status-text').textContent = `Camera: ${isCloseup ? 'Cận Cảnh Soi Tổn Thương' : 'Góc Rộng Phòng Khám'}`;
  
  const badge = document.getElementById('active-cam-mode-badge');
  badge.innerHTML = `<i class="fa-solid fa-video"></i> ${label}`;
  badge.className = isCloseup ? 'bg-amber-950 text-amber-400 border border-amber-800 px-2.5 py-0.5 rounded-full font-medium text-[11px]' : 'bg-emerald-950 text-emerald-400 border border-emerald-800 px-2.5 py-0.5 rounded-full font-medium text-[11px]';

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

    const micBtn = document.getElementById('btn-toggle-mic');
    const micIcon = document.getElementById('icon-mic');

    if (isMicMuted) {
      micBtn.className = 'bg-red-900 hover:bg-red-800 text-white p-2.5 rounded-xl text-xs font-medium border border-red-700 transition flex items-center justify-center w-10 h-10 shadow';
      micIcon.className = 'fa-solid fa-microphone-slash text-red-300 text-sm';
    } else {
      micBtn.className = 'bg-slate-800 hover:bg-slate-700 text-slate-200 p-2.5 rounded-xl text-xs font-medium border border-slate-700 transition flex items-center justify-center w-10 h-10 shadow';
      micIcon.className = 'fa-solid fa-microphone text-emerald-400 text-sm';
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

    const videoBtn = document.getElementById('btn-toggle-video');
    const videoIcon = document.getElementById('icon-video');

    if (isVideoMuted) {
      videoBtn.className = 'bg-red-900 hover:bg-red-800 text-white p-2.5 rounded-xl text-xs font-medium border border-red-700 transition flex items-center justify-center w-10 h-10 shadow';
      videoIcon.className = 'fa-solid fa-video-slash text-red-300 text-sm';
    } else {
      videoBtn.className = 'bg-slate-800 hover:bg-slate-700 text-slate-200 p-2.5 rounded-xl text-xs font-medium border border-slate-700 transition flex items-center justify-center w-10 h-10 shadow';
      videoIcon.className = 'fa-solid fa-video text-blue-400 text-sm';
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

  document.getElementById('stt-btn-text').textContent = 'Đang thu âm...';
  document.getElementById('stt-btn').className = 'bg-red-900/90 hover:bg-red-800 text-red-200 border border-red-600 text-[10px] px-2 py-1 rounded flex items-center gap-1 transition animate-pulse';
  document.getElementById('stt-status').classList.remove('hidden');
  playBeepTone(800, 150);
}

function stopSpeechToText() {
  isListeningSTT = false;
  if (speechRecognition) speechRecognition.stop();

  document.getElementById('stt-btn-text').textContent = 'Giọng nói (STT)';
  document.getElementById('stt-btn').className = 'bg-slate-700 hover:bg-slate-600 text-emerald-400 border border-emerald-500/40 text-[10px] px-2 py-1 rounded flex items-center gap-1 transition';
  document.getElementById('stt-status').classList.add('hidden');
}

// 5. Patient Vitals Submission & Real-time Sync
async function sendVitalsToDoctor() {
  const patientName = document.getElementById('patient-name').value || 'Bệnh nhân';
  const patientAge = document.getElementById('patient-age').value || '45';
  const patientGender = document.getElementById('patient-gender').value || 'Nam';

  const bpSys = document.getElementById('vitals-bp-sys').value || 120;
  const bpDia = document.getElementById('vitals-bp-dia').value || 80;
  const heartRate = document.getElementById('vitals-hr').value || 75;
  const spo2 = document.getElementById('vitals-spo2').value || 98;
  const temperature = document.getElementById('vitals-temp').value || 36.8;
  const weight = document.getElementById('vitals-weight').value || 60;
  const symptoms = document.getElementById('patient-symptoms').value || '';

  currentVitals = { bpSys, bpDia, heartRate, spo2, temperature, weight };

  // Update UI local cards
  updateVitalsCards(currentVitals);

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
      
      // Check emergency alerts
      if (result.data?.evaluation?.alerts?.length > 0) {
        const criticalMsg = result.data.evaluation.alerts.map(a => a.msg).join(' ');
        showAlertBanner(criticalMsg);
      } else {
        closeAlertBanner();
      }

      // Automatically trigger AI Co-pilot analysis on new vitals submit
      requestAIConsultation();
    }
  } catch (err) {
    console.error('Error submitting vitals:', err);
  }
}

function updateVitalsCards(v) {
  document.getElementById('display-bp').textContent = `${v.bpSys}/${v.bpDia}`;
  document.getElementById('display-hr').textContent = v.heartRate;
  document.getElementById('display-spo2').textContent = `${v.spo2}%`;
  document.getElementById('display-temp').textContent = `${v.temperature}°C`;

  // Update In-Video HUD Overlay
  document.getElementById('hud-bp').textContent = `${v.bpSys}/${v.bpDia}`;
  document.getElementById('hud-hr').textContent = v.heartRate;
  document.getElementById('hud-spo2').textContent = `${v.spo2}%`;

  const pName = document.getElementById('patient-name').value;
  const pAge = document.getElementById('patient-age').value;
  document.getElementById('hud-patient-name').textContent = `${pName} (${pAge}T)`;

  // Color Coding Card Alert logic
  const cardSpO2 = document.getElementById('card-spo2');
  if (Number(v.spo2) < 92) {
    cardSpO2.className = 'bg-red-950/90 p-2 rounded-lg border-2 border-red-600 text-center animate-pulse';
  } else if (Number(v.spo2) < 95) {
    cardSpO2.className = 'bg-amber-950/90 p-2 rounded-lg border-2 border-amber-600 text-center';
  } else {
    cardSpO2.className = 'bg-slate-900 p-2 rounded-lg border border-slate-800 text-center';
  }
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
  const patientName = document.getElementById('patient-name').value || 'Bệnh nhân';
  const patientAge = document.getElementById('patient-age').value || '45';
  const patientGender = document.getElementById('patient-gender').value || 'Nam';

  const notes = document.getElementById('clinical-notes').value || '';
  const symptoms = document.getElementById('patient-symptoms').value || '';

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
  if (data.redFlags && data.redFlags.length > 0) {
    redFlagsContainer.innerHTML = data.redFlags.map(f => `<div>${f}</div>`).join('');
    redFlagsContainer.classList.remove('hidden');
  } else {
    redFlagsContainer.classList.add('hidden');
  }

  // Diagnostic List
  const diagList = document.getElementById('ai-diagnosis-list');
  diagList.innerHTML = data.diagnosisList.map(d => `<li>${d}</li>`).join('');

  // Paraclinicals List
  const paraList = document.getElementById('ai-paraclinicals-list');
  paraList.innerHTML = data.paraclinicals.map(p => `<li>${p}</li>`).join('');

  // Prescriptions List
  const rxList = document.getElementById('ai-prescription-list');
  rxList.innerHTML = data.prescriptions.map(rx => `
    <div class="bg-slate-800/80 p-1.5 rounded border border-slate-700/60">
      <div class="font-semibold text-emerald-300">${rx.name}</div>
      <div class="text-[10px] text-slate-300">${rx.dosage} (${rx.note || ''})</div>
    </div>
  `).join('');

  document.getElementById('ai-confidence').textContent = `Độ tin cậy AI: ${data.aiConfidence || '94%'}`;
}

// 7. Finish Consultation & Export Examination Sheet Report
async function finishAndExportReport() {
  const patientName = document.getElementById('patient-name').value || 'Trần Văn Nam';
  const patientAge = document.getElementById('patient-age').value || '58';
  const patientGender = document.getElementById('patient-gender').value || 'Nam';
  const symptoms = document.getElementById('patient-symptoms').value || 'Chưa ghi nhận';
  const clinicalNotes = document.getElementById('clinical-notes').value || 'Bệnh nhân tỉnh táo, tim phổi ổn định.';

  const diagnosisText = currentAIAnalysis?.diagnosisList ? currentAIAnalysis.diagnosisList.join('; ') : 'Viêm đường hô hấp trên cấp tính (J06.9)';
  const prescriptionText = currentAIAnalysis?.prescriptions ? currentAIAnalysis.prescriptions.map((rx, idx) => `${idx + 1}. ${rx.name} - ${rx.dosage}`).join('\n') : '1. Paracetamol 500mg - Uống 1 viên x 3 lần/ngày khi sốt >= 38.5°C';

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
        treatmentPlan: 'Điều trị nội khoa tại điểm trạm / Theo dõi 48 giờ',
        prescription: prescriptionText,
        doctorNotes: ''
      })
    });

    const result = await response.json();
    if (result.success && result.data) {
      // Populate Printable Report Modal
      document.getElementById('rpt-code').textContent = `MÃ PHIẾU: ${result.data.reportCode}`;
      document.getElementById('rpt-date').textContent = `Ngày: ${new Date().toLocaleDateString('vi-VN')}`;
      document.getElementById('rpt-patient-name').textContent = patientName;
      document.getElementById('rpt-patient-age-gender').textContent = `${patientAge} tuổi - ${patientGender}`;
      document.getElementById('rpt-symptoms').textContent = symptoms;
      document.getElementById('rpt-station').textContent = stationCode;
      document.getElementById('rpt-operator').textContent = operatorName;

      document.getElementById('rpt-vitals-row').innerHTML = `
        <td class="p-1.5 border border-slate-300">${currentVitals.bpSys}/${currentVitals.bpDia}</td>
        <td class="p-1.5 border border-slate-300">${currentVitals.heartRate}</td>
        <td class="p-1.5 border border-slate-300">${currentVitals.spo2}%</td>
        <td class="p-1.5 border border-slate-300">${currentVitals.temperature}°C</td>
        <td class="p-1.5 border border-slate-300">${currentVitals.weight || 60}</td>
      `;

      document.getElementById('rpt-clinical-notes').textContent = clinicalNotes;
      document.getElementById('rpt-diagnosis').textContent = diagnosisText;
      document.getElementById('rpt-treatment-plan').textContent = result.data.treatmentPlan || 'Điều trị nội khoa tại điểm trạm / Theo dõi 48 giờ';
      document.getElementById('rpt-prescriptions').innerHTML = prescriptionText.split('\n').map(p => `<p>${p}</p>`).join('');

      document.getElementById('rpt-sig-operator').textContent = operatorName;

      // Open Modal
      document.getElementById('report-modal').classList.remove('hidden');

      // Đánh dấu buổi khám đã hoàn tất.
      signalPost({ action: 'complete' })
        .catch(err => console.warn('Không cập nhật được trạng thái phòng khám:', err.message));
    }
  } catch (err) {
    console.error('Error exporting report:', err);
  }
}

function closeReportModal() {
  document.getElementById('report-modal').classList.add('hidden');
}

// 8. Station Login Modal Handlers
function openLoginModal() {
  document.getElementById('login-modal').classList.remove('hidden');
}

function closeLoginModal() {
  document.getElementById('login-modal').classList.add('hidden');
}

function submitLogin() {
  const code = document.getElementById('input-station-code').value.trim();
  const selectedCmsUsername = document.getElementById('input-cms-account')?.value;
  const typedName = document.getElementById('input-operator-name').value.trim();

  let finalOperatorName = typedName;
  if (selectedCmsUsername) {
    const foundUser = cmsUsers.find(u => u.username === selectedCmsUsername);
    if (foundUser) {
      loggedInCmsUser = foundUser;
      finalOperatorName = foundUser.name;
    }
  }

  if (code && finalOperatorName) {
    const previousPeerId = peerId;
    const previousRoomId = roomId;

    stationCode = code;
    operatorName = finalOperatorName;
    role = 'station_operator'; // Luôn cố định vai trò Cán bộ Y tế Điểm trạm

    document.getElementById('display-station-code').textContent = stationCode;
    document.getElementById('display-operator-name').textContent = operatorName;

    closeLoginModal();

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
  const msgEl = document.createElement('div');
  msgEl.className = 'text-slate-200 leading-normal bg-slate-900/80 p-1 rounded border border-slate-800';
  msgEl.innerHTML = `<span class="font-semibold text-blue-400">${sender}</span> <span class="text-[9px] text-slate-500">${time}</span>: <span>${text}</span>`;
  chatBox.appendChild(msgEl);
  chatBox.scrollTop = chatBox.scrollHeight;
}

// 10. Audio & Alert Helpers
function showAlertBanner(msg) {
  document.getElementById('alert-banner-msg').textContent = msg;
  document.getElementById('alert-banner').classList.remove('hidden');
}

function closeAlertBanner() {
  document.getElementById('alert-banner').classList.add('hidden');
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
window.refreshIncomingCallsQueue = refreshIncomingCallsQueue;
window.acceptPatientCall = acceptPatientCall;
window.joinRoom = joinRoom;
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
