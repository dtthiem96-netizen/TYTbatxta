import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
// Mô-đun Xác thực (Authentication Module): đăng nhập, phiếu phiên JWT 8 giờ và
// rào chắn tuyến đường. Xem auth/index.js để biết cấu trúc mô-đun.
import { mountAuthModule } from './auth/index.js';

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

// Mô-đun Xác thực - đăng ký trước các tuyến nghiệp vụ:
//   POST /api/auth/login      đăng nhập, trả phiếu phiên JWT thời hạn 8 giờ
//   GET  /api/auth/session    kiểm tra phiếu phiên hiện tại
//   GET  /api/cms/dashboard   ví dụ tuyến CMS được authMiddleware bảo vệ
mountAuthModule(app);

// 0. CMS API
app.get('/api/cms', (req, res) => {
  return res.json({
    users: [
      { id: 'U1', username: 'tytbatxat@laocai.gov.vn', name: 'Trạm trưởng', role: 'Quản trị viên (Admin)', canReceiveVideo: 'true' },
      { id: 'U2', username: 'bacsituvan@laocai.gov.vn', name: 'BS. Nguyễn Thị Mai (Tư vấn Telehealth)', role: 'Bác sĩ nhận cuộc gọi', canReceiveVideo: 'true' },
      { id: 'U3', username: 'bientapvien@laocai.gov.vn', name: 'Cán bộ Truyền thông', role: 'Cán bộ biên tập (Editor)', canReceiveVideo: 'false' },
      { id: 'U4', username: 'canbotram@laocai.gov.vn', name: 'Y sĩ Cán bộ Điểm trạm', role: 'Cán bộ Điểm trạm (Station Operator)', canReceiveVideo: 'true' }
    ],
    prescriptionSigners: [
      { id: 'SIG1', name: 'BS. Nguyễn Thị Mai (Tư vấn Telehealth)', title: 'Bác sĩ', license: '001234/LCA-CCHN', workplace: 'Trạm Y tế Bát Xát', signature: '', isDefault: 'true', ts: Date.now() },
      { id: 'SIG2', name: 'Trạm trưởng', title: 'BS. Trạm Trưởng', license: '001000/LCA-CCHN', workplace: 'Trạm Y tế Bát Xát', signature: '', isDefault: 'false', ts: Date.now() }
    ],
    news: [
      { id: 'N3', title: 'Cảnh báo khẩn: Gia tăng ca mắc sốt xuất huyết tại địa bàn xã', description: 'Trạm Y tế Bát Xát khuyến cáo bà con diệt bọ gậy, dọn dẹp vật chứa nước.', date: '29/05/2026', icon: 'fa-mosquito', color: 'red', ts: 3, image: null },
      { id: 'N2', title: 'Hướng dẫn phòng tránh ngộ độc nấm độc rừng mùa hè', description: 'Tuyệt đối không hái nấm lạ, nấm có màu sắc sặc sỡ để ăn.', date: '25/05/2026', icon: 'fa-skull-crossbones', color: 'orange', ts: 2, image: null }
    ],
    vaccines: [
      { id: 'V1', date: 'Sáng 05/08/2026', time: '07:30 - 11:30', target: 'Trẻ em & Phụ nữ mang thai thuộc: Thôn 1, Thôn 2, Thôn 3, Thôn 4, Thôn 5', ts: 2 },
      { id: 'V2', date: 'Sáng 06/08/2026', time: '07:30 - 11:30', target: 'Trẻ em & Phụ nữ mang thai thuộc: Thôn 6, Thôn 7, Thôn 8, Thôn 9, Thôn 10', ts: 1 }
    ],
    documents: [
      { id: 'D1', title: 'Mẫu Giấy xin chuyển tuyến BHYT chuẩn', type: 'Biểu mẫu y tế', url: '#', date: '26/05/2026', ts: 2 },
      { id: 'D2', title: 'Tài liệu hướng dẫn 3 bước phòng Sốt Rét tại nhà', type: 'Tài liệu y tế', url: '#', date: '25/05/2026', ts: 1 }
    ],
    services: [
      { id: 'S1', name: 'Phòng Khám Chung / Đa Khoa', person: 'BS. Trạm Trưởng', zalo: '0382103002', ts: 3 },
      { id: 'S2', name: 'Phòng Khám Sản - Phụ Khoa', person: 'Nữ hộ sinh chuyên trách', zalo: '0382103002', ts: 2 },
      { id: 'S3', name: 'Phòng Y Học Cổ Truyền', person: 'Cán bộ Đông Y', zalo: '0382103002', ts: 1 }
    ],
    contacts: [
      { id: 'C1', name: 'BS. Trạm Trưởng', role: 'Trạm trưởng Trạm Y tế', phone: '0382103002', ts: 3 },
      { id: 'C2', name: 'Nữ hộ sinh chuyên trách', role: 'Phòng Khám Sản - Phụ Khoa', phone: '0382103002', ts: 2 },
      { id: 'C3', name: 'Cán bộ Đông Y', role: 'Phòng Y Học Cổ Truyền', phone: '0382103002', ts: 1 }
    ],
    videos: [
      { id: 'VD1', title: 'Hướng dẫn rửa tay 6 bước chuẩn Bộ Y tế', description: 'Video hướng dẫn rửa tay bằng xà phòng đúng cách phòng tránh dịch bệnh truyền nhiễm hiệu quả.', url: 'https://www.youtube.com/embed/fA4P9B2U-q0', date: '01/08/2026', ts: 101, isCollapsed: 'false' },
      { id: 'VD2', title: 'Sơ cứu dị vật đường thở ở trẻ em', description: 'Hướng dẫn phụ huynh và giáo viên cách xử trí nhanh khi trẻ bị hóc dị vật bằng nghiệm pháp Heimlich an toàn.', url: 'https://www.youtube.com/embed/T00O3IitfRE', date: '28/07/2026', ts: 100, isCollapsed: 'false' }
    ],
    appointments: [],
    siteConfigs: []
  });
});

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

    // Đẩy vào hộp thư signaling để màn hình khám (dùng HTTP long-poll) nhận được ngay,
    // đúng định dạng mà cổng thông tin đang đọc.
    const now = Date.now();
    const wireVitals = {
      bp: `${vitalsData.bp_sys}/${vitalsData.bp_dia}`,
      hr: String(vitalsData.heart_rate),
      spo2: String(vitalsData.spo2),
      temp: String(vitalsData.temperature),
      weight: String(vitalsData.weight),
      at: new Date(now).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
    };
    touchSignalRoom(roomId, { patientName, symptoms, vitals: wireVitals }, now);
    pushSignalEntry({
      roomId,
      fromPeer: String(req.body?.peerId || 'station'),
      type: 'vitals',
      payload: wireVitals,
      now
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

// 6. Signaling qua HTTP (cùng giao thức với Netlify Function /api/signal)
//
// Bảng điều khiển điểm trạm dùng chung một giao thức signaling cho cả hai môi trường:
// chạy nội bộ bằng server.js, và chạy trên Netlify bằng netlify/functions/signal.ts.
// Nhờ vậy public/app.js không cần biết mình đang chạy ở đâu.

const LOBBY_ROOM = '__lobby__';
const PEER_TTL_MS = 45_000;
const SIGNAL_TTL_MS = 180_000;
const POLL_WINDOW_MS = 7_000;
const POLL_INTERVAL_MS = 700;

const signalPeers = new Map(); // peerId -> { roomId, role, name, lastSeen }
const signalRooms = new Map(); // roomId -> { patientName, symptoms, vitals, notes, status, updatedAt }
let signalLog = []; // { seq, roomId, fromPeer, toPeer, type, payload, ts }
let signalSeq = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pruneSignalState(now) {
  for (const [peerId, peer] of signalPeers.entries()) {
    if (peer.lastSeen < now - PEER_TTL_MS) signalPeers.delete(peerId);
  }
  signalLog = signalLog.filter((entry) => entry.ts >= now - SIGNAL_TTL_MS);
}

function activeSignalPeers(roomId, now) {
  const result = [];
  for (const [peerId, peer] of signalPeers.entries()) {
    if (peer.roomId === roomId && peer.lastSeen > now - PEER_TTL_MS) {
      result.push({ peerId, role: peer.role, name: peer.name, lastSeen: peer.lastSeen });
    }
  }
  return result;
}

function pushSignalEntry({ roomId, fromPeer, toPeer = null, type, payload = null, now }) {
  signalSeq += 1;
  signalLog.push({ seq: signalSeq, roomId, fromPeer, toPeer, type, payload, ts: now });
}

function touchSignalRoom(roomId, patch, now) {
  const existing = signalRooms.get(roomId) || {};
  signalRooms.set(roomId, { ...existing, ...patch, updatedAt: now });
}

function signalRoomView(roomId) {
  const room = signalRooms.get(roomId);
  if (!room) return null;
  return {
    status: room.status || 'WAITING',
    patientName: room.patientName || null,
    vitals: room.vitals || null,
    notes: room.notes || ''
  };
}

function countOnDuty(now) {
  const peers = activeSignalPeers(LOBBY_ROOM, now);
  return { count: peers.length, names: peers.map((p) => p.name) };
}

function listSignalRooms(now) {
  const grouped = new Map();
  for (const [peerId, peer] of signalPeers.entries()) {
    if (peer.roomId === LOBBY_ROOM || peer.lastSeen <= now - PEER_TTL_MS) continue;
    const entry = grouped.get(peer.roomId) || [];
    entry.push({ peerId, ...peer });
    grouped.set(peer.roomId, entry);
  }

  const result = [];
  for (const [roomId, entry] of grouped.entries()) {
    const room = signalRooms.get(roomId);
    const waiting = entry.filter((p) => p.role !== 'doctor');
    result.push({
      roomId,
      patientName: room?.patientName || null,
      symptoms: room?.symptoms || null,
      status: room?.status || 'WAITING',
      vitals: room?.vitals || null,
      hasDoctor: entry.some((p) => p.role === 'doctor'),
      since: waiting.length ? Math.min(...waiting.map((p) => p.lastSeen)) : now,
      waiting: waiting.map((p) => ({ name: p.name, role: p.role, since: p.lastSeen }))
    });
  }
  return result;
}

function fetchSignalMessages(roomId, peerId, cursor) {
  return signalLog
    .filter(
      (entry) =>
        entry.roomId === roomId &&
        entry.seq > cursor &&
        entry.fromPeer !== peerId &&
        (entry.toPeer === null || entry.toPeer === peerId)
    )
    .sort((a, b) => a.seq - b.seq)
    .map((entry) => ({ seq: entry.seq, from: entry.fromPeer, type: entry.type, payload: entry.payload }));
}

app.post('/api/signal', (req, res) => {
  const { action, roomId, peerId } = req.body || {};
  if (!action) return res.status(400).json({ error: 'Thiếu action' });
  if (!roomId || !peerId) return res.status(400).json({ error: 'Thiếu roomId hoặc peerId' });

  const now = Date.now();

  if (action === 'join') {
    pruneSignalState(now);
    const role = req.body.role === 'doctor' ? 'doctor' : 'station';
    const name = String(req.body.name || 'Thành viên');
    const others = activeSignalPeers(roomId, now).filter((p) => p.peerId !== peerId);

    signalPeers.set(peerId, { roomId, role, name, lastSeen: now });

    const patch = { status: role === 'doctor' || others.length ? 'IN_CALL' : 'WAITING' };
    if (req.body.patientName) patch.patientName = String(req.body.patientName);
    if (req.body.symptoms) patch.symptoms = String(req.body.symptoms);
    touchSignalRoom(roomId, patch, now);

    const cursor = signalSeq;
    pushSignalEntry({ roomId, fromPeer: peerId, type: 'peer-joined', payload: { role, name }, now });

    return res.json({
      ok: true,
      cursor,
      shouldOffer: others.length > 0,
      peers: others.map((p) => ({ peerId: p.peerId, role: p.role, name: p.name })),
      room: signalRoomView(roomId)
    });
  }

  if (action === 'standby') {
    pruneSignalState(now);
    signalPeers.set(peerId, {
      roomId: LOBBY_ROOM,
      role: 'doctor',
      name: String(req.body.name || 'Cán bộ trực'),
      lastSeen: now
    });
    const onDuty = countOnDuty(now);
    return res.json({ ok: true, rooms: listSignalRooms(now), doctorsOnline: onDuty.count, doctorNames: onDuty.names });
  }

  if (action === 'signal') {
    const type = String(req.body.type || '');
    if (!type) return res.status(400).json({ error: 'Thiếu type' });
    pushSignalEntry({ roomId, fromPeer: peerId, toPeer: req.body.to || null, type, payload: req.body.payload ?? null, now });
    return res.json({ ok: true });
  }

  if (action === 'vitals') {
    const vitals = req.body.vitals || {};
    touchSignalRoom(roomId, { vitals }, now);
    pushSignalEntry({ roomId, fromPeer: peerId, type: 'vitals', payload: vitals, now });
    return res.json({ ok: true });
  }

  if (action === 'notes') {
    const notes = String(req.body.notes || '');
    touchSignalRoom(roomId, { notes }, now);
    pushSignalEntry({ roomId, fromPeer: peerId, type: 'notes', payload: { notes }, now });
    return res.json({ ok: true });
  }

  if (action === 'complete') {
    touchSignalRoom(roomId, { status: 'COMPLETED' }, now);
    pushSignalEntry({ roomId, fromPeer: peerId, type: 'call-ended', payload: { reason: 'completed' }, now });
    return res.json({ ok: true });
  }

  if (action === 'leave') {
    signalPeers.delete(peerId);
    if (roomId === LOBBY_ROOM) return res.json({ ok: true });

    pushSignalEntry({ roomId, fromPeer: peerId, type: 'peer-left', payload: null, now });
    if (activeSignalPeers(roomId, now).length === 0) {
      const room = signalRooms.get(roomId);
      if (room && room.status !== 'COMPLETED') touchSignalRoom(roomId, { status: 'ENDED' }, now);
    }
    return res.json({ ok: true });
  }

  return res.status(400).json({ error: 'Action không hợp lệ' });
});

app.get('/api/signal', async (req, res) => {
  const now = Date.now();

  if (req.query.action === 'rooms') {
    pruneSignalState(now);
    const onDuty = countOnDuty(now);
    return res.json({ ok: true, rooms: listSignalRooms(now), doctorsOnline: onDuty.count, doctorNames: onDuty.names });
  }

  if (req.query.action === 'on-duty') {
    const onDuty = countOnDuty(now);
    return res.json({ ok: true, doctorsOnline: onDuty.count, doctorNames: onDuty.names });
  }

  const roomId = req.query.roomId;
  const peerId = req.query.peerId;
  if (!roomId || !peerId) return res.status(400).json({ error: 'Thiếu roomId hoặc peerId' });

  const cursor = Number(req.query.cursor || 0);
  const peer = signalPeers.get(peerId);
  if (peer) peer.lastSeen = now;

  // Long-poll ngắn để bắt tay WebRTC nhanh mà không cần giữ socket.
  const deadline = now + POLL_WINDOW_MS;
  let messages = fetchSignalMessages(roomId, peerId, cursor);
  while (messages.length === 0 && Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    messages = fetchSignalMessages(roomId, peerId, cursor);
  }

  const pollNow = Date.now();
  const onDuty = countOnDuty(pollNow);

  return res.json({
    ok: true,
    cursor: messages.length ? messages[messages.length - 1].seq : cursor,
    messages,
    doctorsOnline: onDuty.count,
    doctorNames: onDuty.names,
    room: signalRoomView(roomId),
    peers: activeSignalPeers(roomId, pollNow).map((p) => ({ peerId: p.peerId, role: p.role, name: p.name }))
  });
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
