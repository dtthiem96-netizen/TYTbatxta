exports.handler = async (event) => {
  const body = event.body ? JSON.parse(event.body) : {};
  const { stationCode, operatorName, role } = body;
  if (!stationCode || !operatorName) {
    return { statusCode: 400, body: JSON.stringify({ success: false, message: 'Vui lòng nhập Mã điểm trạm và Tên cán bộ trực.' }) };
  }
  const roomId = `room-${String(stationCode).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
  return {
    statusCode: 200,
    body: JSON.stringify({
      success: true,
      data: {
        stationCode,
        operatorName,
        role: role || 'station_operator',
        roomId,
        sessionToken: `token-${Date.now()}-${Math.random().toString(36).substr(2,6)}`
      }
    })
  };
};
