// Lightweight in-memory vitals handler for Netlify Functions (demo)
const VITALS_STORE = global.__TYT_VITALS_STORE__ || (global.__TYT_VITALS_STORE__ = []);

function evaluateVitals(vitals) {
  const alerts = [];
  let status = 'NORMAL';
  const { bp_sys, bp_dia, heart_rate, spo2, temperature } = vitals;

  if (spo2 && spo2 < 92) {
    alerts.push({ level: 'CRITICAL', msg: `CẢNH BÁO CẤP CỨU: SpO2 ${spo2}% < 92%` });
    status = 'CRITICAL';
  } else if (spo2 && spo2 < 95) {
    alerts.push({ level: 'WARNING', msg: `SpO2 thấp ${spo2}%` });
    if (status !== 'CRITICAL') status = 'WARNING';
  }

  if ((bp_sys && bp_sys >= 160) || (bp_dia && bp_dia >= 100)) {
    alerts.push({ level: 'CRITICAL', msg: `Tăng huyết áp nặng ${bp_sys}/${bp_dia}` });
    status = 'CRITICAL';
  } else if ((bp_sys && (bp_sys >= 140 || bp_sys < 90)) || (bp_dia && (bp_dia >= 90 || bp_dia < 60))) {
    alerts.push({ level: 'WARNING', msg: `Huyết áp bất thường ${bp_sys}/${bp_dia}` });
    if (status !== 'CRITICAL') status = 'WARNING';
  }

  if (temperature && temperature >= 39.0) {
    alerts.push({ level: 'WARNING', msg: `Sốt cao ${temperature}°C` });
    if (status !== 'CRITICAL') status = 'WARNING';
  }

  if (heart_rate && (heart_rate > 120 || heart_rate < 50)) {
    alerts.push({ level: 'WARNING', msg: `Nhịp tim bất thường ${heart_rate}` });
    if (status !== 'CRITICAL') status = 'WARNING';
  }

  return { status, alerts };
}

exports.handler = async (event) => {
  const method = event.httpMethod;
  if (method === 'POST') {
    const body = event.body ? JSON.parse(event.body) : {};
    const roomId = body.roomId || 'default-room';
    const vitalsData = {
      bp_sys: Number(body.bpSys || body.bp_sys) || 120,
      bp_dia: Number(body.bpDia || body.bp_dia) || 80,
      heart_rate: Number(body.heartRate || body.heart_rate) || 75,
      spo2: Number(body.spo2) || 98,
      temperature: Number(body.temperature) || 36.8,
      weight: Number(body.weight) || 60
    };

    const evaluation = evaluateVitals(vitalsData);
    const entry = {
      id: Date.now(),
      roomId,
      stationCode: body.stationCode || 'TYT-BATXAT',
      operatorName: body.operatorName || 'Cán bộ Y tế',
      patientName: body.patientName || 'Bệnh nhân',
      patientAge: body.patientAge || null,
      patientGender: body.patientGender || null,
      vitals: vitalsData,
      symptoms: body.symptoms || '',
      evaluation,
      created_at: new Date().toISOString()
    };

    VITALS_STORE.unshift(entry);
    if (VITALS_STORE.length > 500) VITALS_STORE.pop();

    return { statusCode: 200, body: JSON.stringify({ success: true, data: entry }) };
  }

  if (method === 'GET') {
    const q = event.queryStringParameters || {};
    const roomId = q.roomId || null;
    let records = VITALS_STORE;
    if (roomId) records = VITALS_STORE.filter(r => r.roomId === roomId);
    records = records.slice(0, 10);
    return { statusCode: 200, body: JSON.stringify({ success: true, data: records }) };
  }

  return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
};
