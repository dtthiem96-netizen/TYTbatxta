// Telehealth Station Application Logic - Vanilla JS

let stationCode = 'TYT-BATXAT-01';
let operatorName = 'Y sĩ Nguyễn Văn A';
let role = 'station_operator';
let roomId = 'room-tytbatxat01';

let ws = null;
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

let currentAIAnalysis = null;

// Initialize Application
document.addEventListener('DOMContentLoaded', () => {
  console.log('🚀 Initializing Telehealth Station Panel...');
  
  // Set default values in UI
  document.getElementById('display-station-code').textContent = stationCode;
  document.getElementById('display-operator-name').textContent = operatorName;

  // Initialize Media Devices & Camera
  initLocalCamera();

  // Initialize WebSocket Signaling
  initWebSocket();

  // Initialize Speech-to-Text Engine
  initSpeechRecognition();

  // Start Call Timer
  startCallTimer();
});

// 1. WebSocket & WebRTC Signaling Logic
function initWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log('✅ WebSocket Connected to Server');
    updateConnectionBadge(true, 'Đã kết nối Máy chủ WebRTC');

    // Join Telehealth Room
    ws.send(JSON.stringify({
      type: 'join-room',
      roomId,
      role,
      stationCode,
      operatorName
    }));
  };

  ws.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);
      console.log('📩 WS Message:', msg.type);

      switch (msg.type) {
        case 'room-joined':
          appendChatMessage('Hệ thống', `Đã vào phòng khám [${msg.roomId}]. Số thiết bị trực tuyến: ${msg.peerCount}`);
          initPeerConnection();
          break;

        case 'peer-joined':
          appendChatMessage('Hệ thống', `Bác sĩ / Cán bộ [${msg.operatorName || msg.peerId}] đã tham gia phòng khám.`);
          createWebRTCOffer();
          break;

        case 'peer-left':
          appendChatMessage('Hệ thống', 'Một thành viên đã rời phòng khám.');
          break;

        case 'webrtc-offer':
          handleWebRTCOffer(msg.payload);
          break;

        case 'webrtc-answer':
          handleWebRTCAnswer(msg.payload);
          break;

        case 'webrtc-ice-candidate':
          handleWebRTCIceCandidate(msg.payload);
          break;

        case 'vitals-updated':
          updateVitalsUIFromRemote(msg.data);
          appendChatMessage('Sinh hiệu', `Đã đồng bộ sinh hiệu bệnh nhân [${msg.data.patientName}] lên màn hình Bác sĩ.`);
          break;

        case 'camera-mode-changed':
          appendChatMessage('Hệ thống', `Điểm trạm đã chuyển camera: ${msg.cameraLabel || 'Cận cảnh'}`);
          break;

        case 'notes-updated':
          if (msg.text) {
            document.getElementById('clinical-notes').value = msg.text;
          }
          break;

        case 'chat-received':
          appendChatMessage(msg.senderName, msg.text, msg.time);
          break;

        default:
          break;
      }
    } catch (err) {
      console.error('Error handling WebSocket message:', err);
    }
  };

  ws.onclose = () => {
    console.warn('⚠️ WebSocket Disconnected. Retrying in 3s...');
    updateConnectionBadge(false, 'Mất kết nối - Đang thử lại...');
    setTimeout(initWebSocket, 3000);
  };

  ws.onerror = (err) => {
    console.error('WebSocket Error:', err);
  };
}

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
  const configuration = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
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
  };

  // ICE Candidates
  peerConnection.onicecandidate = (event) => {
    if (event.candidate && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'webrtc-ice-candidate',
        roomId,
        payload: event.candidate
      }));
    }
  };
}

async function createWebRTCOffer() {
  if (!peerConnection) initPeerConnection();
  try {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    ws.send(JSON.stringify({
      type: 'webrtc-offer',
      roomId,
      payload: offer
    }));
  } catch (err) {
    console.error('Error creating WebRTC offer:', err);
  }
}

async function handleWebRTCOffer(offer) {
  if (!peerConnection) initPeerConnection();
  try {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    ws.send(JSON.stringify({
      type: 'webrtc-answer',
      roomId,
      payload: answer
    }));
  } catch (err) {
    console.error('Error handling WebRTC offer:', err);
  }
}

async function handleWebRTCAnswer(answer) {
  try {
    if (peerConnection) {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
    }
  } catch (err) {
    console.error('Error handling WebRTC answer:', err);
  }
}

async function handleWebRTCIceCandidate(candidate) {
  try {
    if (peerConnection) {
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    }
  } catch (err) {
    console.error('Error adding ICE candidate:', err);
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

    const localVideo = document.getElementById('local-video');
    if (localVideo) {
      localVideo.srcObject = localStream;
    }

    // List available video devices for camera switching
    const devices = await navigator.mediaDevices.enumerateDevices();
    videoDevices = devices.filter(d => d.kind === 'videoinput');
    console.log(`📷 Detected ${videoDevices.length} camera inputs:`, videoDevices);

    // Replace video track in peer connection if already active
    if (peerConnection) {
      const videoTrack = localStream.getVideoTracks()[0];
      const senders = peerConnection.getSenders();
      const videoSender = senders.find(s => s.track && s.track.kind === 'video');
      if (videoSender && videoTrack) {
        videoSender.replaceTrack(videoTrack);
      }
    }
  } catch (err) {
    console.warn('⚠️ Camera access warning (using canvas/video fallback):', err.message);
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

  // Notify remote doctor over WebSocket
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'camera-switch',
      roomId,
      payload: {
        cameraMode: isCloseup ? 'closeup' : 'wide',
        cameraLabel: label
      }
    }));
  }

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

        // Broadcast speech text to doctor via WS
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'notes-stream',
            roomId,
            payload: { text: notesInput.value }
          }));
        }
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

function updateVitalsUIFromRemote(data) {
  if (data && data.vitals) {
    const v = data.vitals;
    document.getElementById('vitals-bp-sys').value = v.bp_sys || 120;
    document.getElementById('vitals-bp-dia').value = v.bp_dia || 80;
    document.getElementById('vitals-hr').value = v.heart_rate || 75;
    document.getElementById('vitals-spo2').value = v.spo2 || 98;
    document.getElementById('vitals-temp').value = v.temperature || 36.8;

    updateVitalsCards({
      bpSys: v.bp_sys,
      bpDia: v.bp_dia,
      heartRate: v.heart_rate,
      spo2: v.spo2,
      temperature: v.temperature
    });
  }
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
        doctorNotes: 'Bác sĩ tuyến trên nhất trí với hướng xử trí của điểm trạm.'
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
  const name = document.getElementById('input-operator-name').value.trim();
  const selectedRole = document.getElementById('input-role').value;

  if (code && name) {
    stationCode = code;
    operatorName = name;
    role = selectedRole;
    roomId = `room-${code.toLowerCase().replace(/[^a-z0-9]/g, '')}`;

    document.getElementById('display-station-code').textContent = stationCode;
    document.getElementById('display-operator-name').textContent = operatorName;

    closeLoginModal();

    // Rejoin WebSocket room
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'join-room',
        roomId,
        role,
        stationCode,
        operatorName
      }));
    }
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

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'chat-message',
      roomId,
      payload: { senderName: operatorName, text }
    }));
  }

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
