// Clinical AI function (port of server logic, simplified)
exports.handler = async (event) => {
  try {
    const body = event.body ? JSON.parse(event.body) : {};
    const vitals = body.vitals || {};
    const symptoms = body.symptoms || '';
    const notes = body.notes || '';
    const patientName = body.patientName || 'Bệnh nhân';
    const patientAge = body.patientAge || null;
    const patientGender = body.patientGender || null;

    const bpSys = Number(vitals.bpSys || vitals.bp_sys || 120);
    const bpDia = Number(vitals.bpDia || vitals.bp_dia || 80);
    const hr = Number(vitals.heartRate || vitals.heart_rate || 75);
    const spo2 = Number(vitals.spo2 || 98);
    const temp = Number(vitals.temperature || 36.8);

    const fullSymptoms = `${symptoms || ''} ${notes || ''}`.trim().toLowerCase();

    const diagnosisList = [];
    const icd10Codes = [];
    const paraclinicals = [];
    const prescriptions = [];
    const managementSteps = [];
    const redFlags = [];

    if (spo2 < 92 || fullSymptoms.includes('khó thở') || fullSymptoms.includes('phổi')) {
      redFlags.push('⚠️ Nguy cơ hô hấp nặng');
      diagnosisList.push('Suy hô hấp / Viêm phổi');
      icd10Codes.push('J18.9');
      paraclinicals.push('SpO2 liên tục, Xquang ngực');
      managementSteps.push('Thở oxy, liên hệ tuyến trên.');
      prescriptions.push({ name: 'Salbutamol (khí dung)' });
    } else if (temp >= 38.5 || fullSymptoms.includes('sốt')) {
      diagnosisList.push('Nhiễm trùng hô hấp trên');
      icd10Codes.push('J06.9');
      paraclinicals.push('Test nhanh cúm/COVID');
      prescriptions.push({ name: 'Paracetamol' });
    } else if (bpSys >= 140 || bpDia >= 90) {
      diagnosisList.push('Tăng huyết áp');
      icd10Codes.push('I10');
      paraclinicals.push('ECG, xét nghiệm sinh hóa');
      prescriptions.push({ name: 'Amlodipin' });
    } else {
      diagnosisList.push('Theo dõi lâm sàng');
      icd10Codes.push('Z00.0');
      paraclinicals.push('Đo sinh hiệu định kỳ');
      prescriptions.push({ name: 'Bổ sung dinh dưỡng' });
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
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
          aiConfidence: 'demo'
        }
      })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ success: false, message: err.message }) };
  }
};
