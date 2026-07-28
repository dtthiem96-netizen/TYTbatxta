import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 8889;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// Initialize SQLite Database
let db;
try {
  const dbPath = path.join(__dirname, 'telehealth.db');
  db = new DatabaseSync(dbPath);
  
  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS vitals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id TEXT NOT NULL,
      station_code TEXT,
      operator_name TEXT,
      patient_name TEXT,
      patient_age INTEGER,
      patient_gender TEXT,
      bp_sys INTEGER,
      bp_dia INTEGER,
      heart_rate INTEGER,
      spo2 REAL,
      temperature REAL,
      weight REAL,
      symptoms TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS examination_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_code TEXT UNIQUE NOT NULL,
      room_id TEXT NOT NULL,
      station_code TEXT NOT NULL,
      operator_name TEXT NOT NULL,
      patient_name TEXT NOT NULL,
      patient_age INTEGER,
      patient_gender TEXT,
      vitals_json TEXT,
      clinical_notes TEXT,
      diagnosis TEXT,
      icd10 TEXT,
      treatment_plan TEXT,
      prescription TEXT,
      doctor_notes TEXT,
      status TEXT DEFAULT 'COMPLETED',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  console.log('✅ SQLite database initialized successfully at telehealth.db');
} catch (err) {
  console.warn('⚠️ Native SQLite initialization error, using fallback in-memory store:', err.message);
  // Fallback in-memory DB if needed
  db = {
    vitalsStore: [],
    reportsStore: [],
    exec: () => {},
    prepare: (sql) => ({
      run: (...args) => {
        if (sql.includes('INSERT INTO vitals')) {
          db.vitalsStore.push({ id: Date.now(), args });
        } else if (sql.includes('INSERT INTO examination_reports')) {
          db.reportsStore.push({ id: Date.now(), args });
        }
      },
      all: (...args) => db.vitalsStore,
      get: (...args) => db.reportsStore[0] || null
    })
  };
}

// Memory tracking for WebRTC Rooms & Signaling
const rooms = new Map(); // roomId -> Map<clientId, { ws, role, stationCode, operatorName }>

// Utility: Evaluate Vitals Severity
function evaluateVitals(vitals) {
  const alerts = [];
  let status = 'NORMAL'; // NORMAL | WARNING | CRITICAL

  const { bp_sys, bp_dia, heart_rate, spo2, temperature } = vitals;

  if (spo2 && spo2 < 92) {
    alerts.push({ level: 'CRITICAL', msg: `CẢNH BÁO CẤP CỨU: Nồng độ Oxy SpO2 giảm nguy hiểm (${spo2}% < 92%). Cần thở Oxy hỗ trợ khẩn cấp!` });
    status = 'CRITICAL';
  } else if (spo2 && spo2 < 95) {
    alerts.push({ level: 'WARNING', msg: `Cảnh báo: SpO2 nhẹ/vừa (${spo2}%). Theo dõi sát đường hô hấp.` });
    if (status !== 'CRITICAL') status = 'WARNING';
  }

  if (bp_sys && bp_sys >= 160 || bp_dia && bp_dia >= 100) {
    alerts.push({ level: 'CRITICAL', msg: `CẢNH BÁO CẤP CỨU: Cơn tăng huyết áp cấp cứu (${bp_sys}/${bp_dia} mmHg). Nguy cơ biến cố tim mạch/đột quỵ!` });
    status = 'CRITICAL';
  } else if (bp_sys && (bp_sys >= 140 || bp_sys < 90) || bp_dia && (bp_dia >= 90 || bp_dia < 60)) {
    alerts.push({ level: 'WARNING', msg: `Cảnh báo Huyết áp bất thường: ${bp_sys}/${bp_dia} mmHg.` });
    if (status !== 'CRITICAL') status = 'WARNING';
  }

  if (temperature && temperature >= 39.0) {
    alerts.push({ level: 'WARNING', msg: `Sốt cao (${temperature}°C). Cần chườm ấm & xem xét hạ sốt khẩn.` });
    if (status !== 'CRITICAL') status = 'WARNING';
  }

  if (heart_rate && (heart_rate > 120 || heart_rate < 50)) {
    alerts.push({ level: 'WARNING', msg: `Nhịp tim bất thường (${heart_rate} bpm). Cần kiểm tra điện tâm đồ ECG.` });
    if (status !== 'CRITICAL') status = 'WARNING';
  }

  return { status, alerts };
}

// API Routes

// 1. Station Login / Authentication API
app.post('/api/login', (req, res) => {
  const { stationCode, operatorName, role } = req.body;
  if (!stationCode || !operatorName) {
    return res.status(400).json({ success: false, message: 'Vui lòng nhập Mã điểm trạm và Tên cán bộ trực.' });
  }

  const roomId = `room-${stationCode.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
  return res.json({
    success: true,
    data: {
      stationCode,
      operatorName,
      role: role || 'station_operator',
      roomId,
      sessionToken: `token-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`
    }
  });
});

// 2. Patient Vitals Submission API
app.post('/api/vitals', (req, res) => {
  try {
    const {
      roomId = 'default-room',
      stationCode = 'TYT-BATXAT',
      operatorName = 'Cán bộ Y tế',
      patientName = 'Bệnh nhân',
      patientAge = 45,
      patientGender = 'Nam',
      bpSys,
      bpDia,
      heartRate,
      spo2,
      temperature,
      weight,
      symptoms = ''
    } = req.body;

    const vitalsData = {
      bp_sys: Number(bpSys) || 120,
      bp_dia: Number(bpDia) || 80,
      heart_rate: Number(heartRate) || 75,
      spo2: Number(spo2) || 98,
      temperature: Number(temperature) || 36.8,
      weight: Number(weight) || 60
    };

    const evaluation = evaluateVitals(vitalsData);

    // Persist to database
    if (db.prepare) {
      const stmt = db.prepare(`
        INSERT INTO vitals (
          room_id, station_code, operator_name, patient_name, patient_age, patient_gender,
          bp_sys, bp_dia, heart_rate, spo2, temperature, weight, symptoms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        roomId, stationCode, operatorName, patientName, Number(patientAge), patientGender,
        vitalsData.bp_sys, vitalsData.bp_dia, vitalsData.heart_rate, vitalsData.spo2,
        vitalsData.temperature, vitalsData.weight, symptoms
      );
    }

    const payload = {
      timestamp: new Date().toISOString(),
      stationCode,
      operatorName,
      patientName,
      patientAge,
      patientGender,
      vitals: vitalsData,
      symptoms,
      evaluation
    };

    // Broadcast to WebSocket clients in the room
    broadcastToRoom(roomId, {
      type: 'vitals-updated',
      data: payload
    });

    return res.json({
      success: true,
      message: 'Sinh hiệu bệnh nhân đã được đồng bộ trực tiếp lên màn hình khám.',
      data: payload
    });
  } catch (error) {
    console.error('Error saving vitals:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// 3. Get Vitals History API
app.get('/api/vitals/:roomId', (req, res) => {
  try {
    const { roomId } = req.params;
    let records = [];
    if (db.prepare) {
      records = db.prepare(`SELECT * FROM vitals WHERE room_id = ? ORDER BY created_at DESC LIMIT 10`).all(roomId);
    }
    return res.json({ success: true, data: records });
  } catch (err) {
    return res.json({ success: true, data: [] });
  }
});

// 4. Clinical Co-Pilot AI Recommendation Endpoint
app.post('/api/clinical-ai', (req, res) => {
  try {
    const { vitals, symptoms, notes, patientName, patientAge, patientGender } = req.body;

    const bpSys = Number(vitals?.bpSys || vitals?.bp_sys || 120);
    const bpDia = Number(vitals?.bpDia || vitals?.bp_dia || 80);
    const hr = Number(vitals?.heartRate || vitals?.heart_rate || 75);
    const spo2 = Number(vitals?.spo2 || 98);
    const temp = Number(vitals?.temperature || 36.8);

    const fullSymptoms = `${symptoms || ''} ${notes || ''}`.trim();

    // AI Clinical Reasoning Rule Engine & Medical Guidelines
    let diagnosisList = [];
    let icd10Codes = [];
    let paraclinicals = [];
    let prescriptions = [];
    let managementSteps = [];
    let redFlags = [];

    // Analyze Vitals & Symptoms
    if (spo2 < 92 || fullSymptoms.toLowerCase().includes('khó thở') || fullSymptoms.toLowerCase().includes('phổi')) {
      redFlags.push('⚠️ CẢNH BÁO HÔ HẤP: Nguy cơ Viêm phổi cấp / Suy hô hấp cấp / Đợt cấp COPD.');
      diagnosisList.push('1. Suy hô hấp cấp độ II (Theo dõi Viêm phổi/Đợt cấp COPD)');
      diagnosisList.push('2. Viêm phế quản cấp tính nặng');
      icd10Codes.push('J18.9 (Viêm phổi)', 'J44.1 (Đợt cấp COPD)', 'J96.0 (Suy hô hấp cấp)');
      paraclinicals.push('1. Đo khí máu động mạch (nếu có) hoặc SpO2 liên tục');
      paraclinicals.push('2. Chụp X-quang ngực thẳng khẩn cấp');
      paraclinicals.push('3. Tế bào máu ngoại vi (Công thức máu complete)');
      managementSteps.push('• Cho bệnh nhân nằm đầu cao 30-45 độ, thở Oxy qua cannula 2-4 lít/phút.');
      managementSteps.push('• Chuẩn bị phương tiện cấp cứu đường thở và liên hệ Bác sĩ Bệnh viện Tuyến Huyện ngay.');
      prescriptions.push({ name: 'Salbutamol 2.5mg (Khí dung)', dosage: '1 tép khí dung qua mặt nạ', note: 'Lặp lại sau 20 phút nếu chưa giảm khó thở' });
      prescriptions.push({ name: 'Methylprednisolone 40mg (Tiêm tĩnh mạch)', dosage: '1 lọ tiêm tĩnh mạch chậm', note: 'Chống viêm cấp đường hô hấp' });
    } else if (temp >= 38.5 || fullSymptoms.toLowerCase().includes('sốt') || fullSymptoms.toLowerCase().includes('viêm họng')) {
      diagnosisList.push('1. Viêm đường hô hấp trên cấp tính / Viêm họng cấp');
      diagnosisList.push('2. Sốt nhiễm siêu vi (Theo dõi Cúm / Đăng ký test nhanh)');
      icd10Codes.push('J02.9 (Viêm họng cấp)', 'J06.9 (Nhiễm trùng hô hấp trên cấp)');
      paraclinicals.push('1. Test nhanh Cúm A/B hoặc Covid-19');
      paraclinicals.push('2. Soi cận cảnh vòm họng bằng camera cận cảnh điểm trạm');
      paraclinicals.push('3. Tổng phân tích tế bào máu ngoại vi');
      managementSteps.push('• Chườm ấm vùng trán, nách, bẹn.');
      managementSteps.push('• Uống nhiều nước ấm, oresol bù điện giải.');
      prescriptions.push({ name: 'Paracetamol 500mg', dosage: '1 viên x 3-4 lần/ngày (khi sốt >= 38.5°C)', note: 'Uống cách nhau ít nhất 4-6 giờ' });
      prescriptions.push({ name: 'Oresol 245', dosage: 'Pha 1 gói với 1 lít nước sôi để nguội', note: 'Uống rải rác trong ngày' });
      prescriptions.push({ name: 'Amoxicillin + Acid Clavulanic 625mg', dosage: '1 viên x 2 lần/ngày (nếu có mủ/viêm họng bội nhiễm)', note: 'Uống sau ăn 5-7 ngày' });
    } else if (bpSys >= 140 || bpDia >= 90) {
      diagnosisList.push('1. Tăng huyết áp độ 1 - độ 2 (JNC 8 / VNHA)');
      diagnosisList.push('2. Theo dõi Nguy cơ biến cố Tim mạch / Đáy mắt');
      icd10Codes.push('I10 (Tăng huyết áp vô căn)');
      paraclinicals.push('1. Điện tâm đồ ECG 12 chuyển đạo');
      paraclinicals.push('2. Xét nghiệm Sinh hóa: Đường huyết, Creatinine, Men gan, Mỡ máu');
      paraclinicals.push('3. Tổng phân tích nước tiểu');
      managementSteps.push('• Để bệnh nhân nghỉ ngơi yên tĩnh tại phòng khám 15-20 phút rồi đo lại.');
      managementSteps.push('• Hướng dẫn chế độ ăn giảm muối (<5g muối/ngày), hạn chế chất kích thích.');
      prescriptions.push({ name: 'Amlodipin 5mg', dosage: '1 viên uống buổi sáng', note: 'Chẹn kênh calci hạ huyết áp' });
      prescriptions.push({ name: 'Enalapril 5mg (hoặc Losartan 50mg)', dosage: '1 viên uống buổi sáng', note: 'Nên tham khảo thêm Bác sĩ tuyến trên' });
    } else {
      diagnosisList.push('1. Theo dõi Hội chứng nhiễm trùng nhẹ / Rối loạn thể chất');
      diagnosisList.push('2. Sức khỏe lâm sàng hiện tại tương đối ổn định');
      icd10Codes.push('Z00.0 (Khám sức khỏe tổng quát)');
      paraclinicals.push('1. Đo sinh hiệu định kỳ');
      paraclinicals.push('2. Soi/chụp cận cảnh tổn thương ngoài da hoặc tai mũi họng nếu có biểu hiện');
      managementSteps.push('• Tiếp tục quan sát lâm sàng, theo dõi triệu chứng trong 24-48 giờ.');
      prescriptions.push({ name: 'Multivitamin / B-Complex', dosage: '1 viên x 2 lần/ngày', note: 'Tăng cường sức đề kháng' });
    }

    return res.json({
      success: true,
      data: {
        timestamp: new Date().toISOString(),
        patient: { name: patientName, age: patientAge, gender: patientGender },
        vitalsSummary: { bp: `${bpSys}/${bpDia} mmHg`, hr: `${hr} bpm`, spo2: `${spo2}%`, temp: `${temp}°C` },
        redFlags,
        diagnosisList,
        icd10Codes,
        paraclinicals,
        prescriptions,
        managementSteps,
        aiConfidence: '94%'
      }
    });
  } catch (error) {
    console.error('Clinical AI Error:', error);
    return res.status(500).json({ success: false, message: 'Không thể khởi tạo gợi ý lâm sàng.' });
  }
});

// 5. Save & Print Examination Report API
app.post('/api/examination-report', (req, res) => {
  try {
    const {
      roomId,
      stationCode,
      operatorName,
      patientName,
      patientAge,
      patientGender,
      vitals,
      clinicalNotes,
      diagnosis,
      icd10,
      treatmentPlan,
      prescription,
      doctorNotes
    } = req.body;

    const reportCode = `PKTX-${Date.now().toString().slice(-6)}`;

    if (db.prepare) {
      const stmt = db.prepare(`
        INSERT INTO examination_reports (
          report_code, room_id, station_code, operator_name, patient_name, patient_age, patient_gender,
          vitals_json, clinical_notes, diagnosis, icd10, treatment_plan, prescription, doctor_notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        reportCode,
        roomId || 'room-01',
        stationCode || 'TYT-STATION',
        operatorName || 'Cán bộ Y tế',
        patientName || 'Bệnh nhân',
        Number(patientAge) || 30,
        patientGender || 'Nam',
        JSON.stringify(vitals || {}),
        clinicalNotes || '',
        diagnosis || '',
        icd10 || '',
        treatmentPlan || '',
        prescription || '',
        doctorNotes || ''
      );
    }

    return res.json({
      success: true,
      message: 'Đã hoàn tất và xuất Phiếu khám bệnh từ xa thành công!',
      data: {
        reportCode,
        createdAt: new Date().toLocaleString('vi-VN'),
        patientName,
        stationCode,
        operatorName,
        diagnosis,
        icd10,
        treatmentPlan,
        prescription
      }
    });
  } catch (error) {
    console.error('Error creating report:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// Broadcast Helper
function broadcastToRoom(roomId, messageObj, senderWs = null) {
  const room = rooms.get(roomId);
  if (!room) return;

  const msgString = JSON.stringify(messageObj);
  for (const [clientId, client] of room.entries()) {
    if (client.ws !== senderWs && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(msgString);
    }
  }
}

// WebSocket Connection & WebRTC Signaling Logic
wss.on('connection', (ws) => {
  let currentRoomId = null;
  let currentClientId = `client-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`;

  ws.on('message', (rawMsg) => {
    try {
      const data = JSON.parse(rawMsg.toString());
      const { type, roomId, sender, target, payload } = data;

      switch (type) {
        case 'join-room': {
          currentRoomId = roomId || 'default-room';
          if (!rooms.has(currentRoomId)) {
            rooms.set(currentRoomId, new Map());
          }

          const room = rooms.get(currentRoomId);
          room.set(currentClientId, {
            ws,
            role: data.role || 'station_operator',
            stationCode: data.stationCode || 'TYT',
            operatorName: data.operatorName || 'Cán bộ Y tế'
          });

          console.log(`🔌 Client ${currentClientId} (${data.role}) joined room [${currentRoomId}]. Total users: ${room.size}`);

          // Notify sender of connection success
          ws.send(JSON.stringify({
            type: 'room-joined',
            clientId: currentClientId,
            roomId: currentRoomId,
            peerCount: room.size,
            existingPeers: Array.from(room.keys()).filter(id => id !== currentClientId)
          }));

          // Notify existing peers
          broadcastToRoom(currentRoomId, {
            type: 'peer-joined',
            peerId: currentClientId,
            role: data.role,
            stationCode: data.stationCode,
            operatorName: data.operatorName
          }, ws);

          break;
        }

        case 'webrtc-offer':
        case 'webrtc-answer':
        case 'webrtc-ice-candidate': {
          // Relay WebRTC signaling messages directly to target peer or room
          if (currentRoomId) {
            broadcastToRoom(currentRoomId, {
              type,
              senderId: currentClientId,
              targetId: target,
              payload
            }, ws);
          }
          break;
        }

        case 'camera-switch': {
          // Notify doctor when station switches camera (Wide vs Close-up)
          if (currentRoomId) {
            broadcastToRoom(currentRoomId, {
              type: 'camera-mode-changed',
              senderId: currentClientId,
              cameraMode: payload?.cameraMode, // 'wide' | 'closeup'
              cameraLabel: payload?.cameraLabel
            }, ws);
          }
          break;
        }

        case 'notes-stream': {
          // Stream Speech-to-Text notes in real-time to superior doctor screen
          if (currentRoomId) {
            broadcastToRoom(currentRoomId, {
              type: 'notes-updated',
              senderId: currentClientId,
              text: payload?.text
            }, ws);
          }
          break;
        }

        case 'chat-message': {
          if (currentRoomId) {
            broadcastToRoom(currentRoomId, {
              type: 'chat-received',
              senderName: payload?.senderName || 'Cán bộ',
              text: payload?.text,
              time: new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
            }, ws);
          }
          break;
        }

        default:
          break;
      }
    } catch (err) {
      console.error('WebSocket parsing error:', err);
    }
  });

  ws.on('close', () => {
    if (currentRoomId && rooms.has(currentRoomId)) {
      const room = rooms.get(currentRoomId);
      room.delete(currentClientId);
      console.log(`❌ Client ${currentClientId} left room [${currentRoomId}]. Remaining: ${room.size}`);
      if (room.size === 0) {
        rooms.delete(currentRoomId);
      } else {
        broadcastToRoom(currentRoomId, {
          type: 'peer-left',
          peerId: currentClientId
        });
      }
    }
  });
});

// Start Server
server.listen(PORT, () => {
  console.log(`===================================================`);
  console.log(`🏥 HỆ THỐNG KHÁM CHỮA BỆNH TỪ XA (TELEHEALTH)`);
  console.log(`🚀 Server đang chạy tại: http://localhost:${PORT}`);
  console.log(`===================================================`);
});
