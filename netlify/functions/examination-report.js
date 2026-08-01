// Examination report (simple in-memory storage)
const REPORTS = global.__TYT_REPORTS__ || (global.__TYT_REPORTS__ = []);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  const body = event.body ? JSON.parse(event.body) : {};
  const reportCode = `PKTX-${Date.now().toString().slice(-6)}`;
  const entry = {
    id: Date.now(),
    reportCode,
    roomId: body.roomId || 'room-01',
    stationCode: body.stationCode || 'TYT-STATION',
    operatorName: body.operatorName || 'Cán bộ Y tế',
    patientName: body.patientName || 'Bệnh nhân',
    patientAge: body.patientAge || null,
    patientGender: body.patientGender || null,
    vitals: body.vitals || {},
    clinicalNotes: body.clinicalNotes || '',
    diagnosis: body.diagnosis || '',
    icd10: body.icd10 || '',
    treatmentPlan: body.treatmentPlan || '',
    prescription: body.prescription || '',
    doctorNotes: body.doctorNotes || '',
    createdAt: new Date().toISOString()
  };

  REPORTS.unshift(entry);
  if (REPORTS.length > 500) REPORTS.pop();

  return {
    statusCode: 200,
    body: JSON.stringify({ success: true, message: 'Đã lưu phiếu khám (demo)', data: { reportCode, createdAt: entry.createdAt } })
  };
};
