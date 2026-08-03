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

  if (!payload) return <div role="status" aria-live="polite">Đang tải thông tin cuộc gọi...</div>;

  const { doctor } = payload;

  const handleChange = (id, value) => setFormValues(prev => ({ ...prev, [id]: value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    // Submit user inputs to server (e.g., attach to call/session)
    await api.post('/api/call/inputs', { callId, inputs: formValues }, { headers: { Authorization: `Bearer ${token}` } });
    alert('Đã gửi thông tin thành công.');
  };

  return (
    <main className="video-call-user">
      <div className="video-window" role="region" aria-label="Khung video cuộc gọi">{/* WebRTC video here */}</div>
      <section className="doctor-minimal" aria-labelledby="doctor-info-heading">
        <h2 id="doctor-info-heading">Bác sĩ: {doctor.name}</h2>
        <form onSubmit={handleSubmit}>
          {doctor.minimalFields.map(field => (
            <div key={field.id} className="field">
              <label htmlFor={`input-${field.id}`}>{field.label}{field.required ? ' *' : ''}</label>
              <input
                id={`input-${field.id}`}
                name={field.id}
                type={field.type === 'text' ? 'text' : 'text'}
                required={field.required}
                aria-required={field.required}
                onChange={(e) => handleChange(field.id, e.target.value)}
              />
            </div>
          ))}
          <button type="submit">Gửi thông tin</button>
        </form>
      </section>
    </main>
  );
}
