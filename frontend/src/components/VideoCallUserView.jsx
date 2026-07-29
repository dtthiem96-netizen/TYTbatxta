import React, { useEffect, useState } from 'react';
import api from '../utils/api';

export default function VideoCallUserView({ callId, token }) {
  const [payload, setPayload] = useState(null);
  const [formValues, setFormValues] = useState({});

  useEffect(() => {
    async function load() {
      const res = await api.get(`/api/call/${callId}/user-view`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      setPayload(data);
    }
    load();
  }, [callId, token]);

  if (!payload) return <div>Đang tải...</div>;

  const { doctor } = payload;

  const handleChange = (id, value) => setFormValues(prev => ({ ...prev, [id]: value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    // Submit user inputs to server (e.g., attach to call/session)
    await api.post('/api/call/inputs', { callId, inputs: formValues }, { headers: { Authorization: `Bearer ${token}` } });
    alert('Gửi thành công');
  };

  return (
    <div className="video-call-user">
      <div className="video-window">{/* WebRTC video here */}</div>
      <div className="doctor-minimal">
        <h3>Bác sĩ: {doctor.name}</h3>
        <form onSubmit={handleSubmit}>
          {doctor.minimalFields.map(field => (
            <div key={field.id} className="field">
              <label>{field.label}{field.required ? '*' : ''}</label>
              <input
                name={field.id}
                type={field.type === 'text' ? 'text' : 'text'}
                required={field.required}
                onChange={(e) => handleChange(field.id, e.target.value)}
              />
            </div>
          ))}
          <button type="submit">Gửi</button>
        </form>
      </div>
    </div>
  );
}
