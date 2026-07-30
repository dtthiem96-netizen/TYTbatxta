// Simple signaling for Netlify Functions (demo, in-memory). Not reliable for production.
const PEER_TTL_MS = 45_000;
const SIGNAL_TTL_MS = 180_000;

const signalPeers = global.__TYT_signalPeers__ || (global.__TYT_signalPeers__ = new Map());
const signalRooms = global.__TYT_signalRooms__ || (global.__TYT_signalRooms__ = new Map());
let signalLog = global.__TYT_signalLog__ || (global.__TYT_signalLog__ = []);
let signalSeq = global.__TYT_signalSeq__ || (global.__TYT_signalSeq__ = 0);

function nowMs() { return Date.now(); }
function prune() {
  const now = nowMs();
  for (const [peerId, p] of signalPeers.entries()) if (p.lastSeen < now - PEER_TTL_MS) signalPeers.delete(peerId);
  signalLog = signalLog.filter(e => e.ts >= now - SIGNAL_TTL_MS);
}

function pushEntry({ roomId, fromPeer, toPeer=null, type, payload=null }){
  signalSeq += 1;
  const now = nowMs();
  const entry = { seq: signalSeq, roomId, fromPeer, toPeer, type, payload, ts: now };
  signalLog.push(entry);
}

function activeSignalPeers(roomId){
  const now = nowMs();
  const out = [];
  for (const [peerId, peer] of signalPeers.entries()){
    if (peer.roomId === roomId && peer.lastSeen > now - PEER_TTL_MS) out.push({ peerId, ...peer });
  }
  return out;
}

exports.handler = async (event) => {
  const method = event.httpMethod;
  if (method === 'POST'){
    const body = event.body ? JSON.parse(event.body) : {};
    const { action, roomId, peerId } = body;
    if (!action || !roomId || !peerId) return { statusCode: 400, body: JSON.stringify({ error: 'Thiếu action/roomId/peerId' }) };
    prune();
    const now = nowMs();
    if (action === 'join'){
      const role = body.role === 'doctor' ? 'doctor' : 'station';
      const name = String(body.name || 'Thành viên');
      signalPeers.set(peerId, { roomId, role, name, lastSeen: now });
      const cursor = signalSeq;
      pushEntry({ roomId, fromPeer: peerId, type: 'peer-joined', payload: { role, name } });
      const others = activeSignalPeers(roomId).filter(p=>p.peerId!==peerId);
      return { statusCode: 200, body: JSON.stringify({ ok:true, cursor, shouldOffer: others.length>0, peers: others.map(p=>({peerId:p.peerId, role:p.role, name:p.name})), room: signalRooms.get(roomId) || null }) };
    }
    if (action === 'standby'){
      signalPeers.set(peerId, { roomId: '__lobby__', role: 'doctor', name: String(body.name||'Cán bộ trực'), lastSeen: now });
      return { statusCode:200, body: JSON.stringify({ ok:true }) };
    }
    if (action === 'signal'){
      const type = String(body.type||''); if(!type) return { statusCode:400, body: JSON.stringify({ error:'Thiếu type' }) };
      pushEntry({ roomId, fromPeer: peerId, toPeer: body.to||null, type, payload: body.payload||null });
      return { statusCode:200, body: JSON.stringify({ ok:true }) };
    }
    if (action === 'vitals'){
      touchRoom(roomId, { vitals: body.vitals||null });
      pushEntry({ roomId, fromPeer: peerId, type: 'vitals', payload: body.vitals||null });
      return { statusCode:200, body: JSON.stringify({ ok:true }) };
    }
    if (action === 'notes'){
      touchRoom(roomId, { notes: String(body.notes||'') });
      pushEntry({ roomId, fromPeer: peerId, type: 'notes', payload: { notes: body.notes||'' } });
      return { statusCode:200, body: JSON.stringify({ ok:true }) };
    }
    if (action === 'leave'){
      signalPeers.delete(peerId);
      pushEntry({ roomId, fromPeer: peerId, type: 'peer-left' });
      return { statusCode:200, body: JSON.stringify({ ok:true }) };
    }

    return { statusCode:400, body: JSON.stringify({ error: 'Action không hợp lệ' }) };
  }

  if (method === 'GET'){
    const q = event.queryStringParameters || {};
    const action = q.action;
    prune();
    if (action === 'rooms'){
      return { statusCode:200, body: JSON.stringify({ ok:true }) };
    }
    const roomId = q.roomId; const peerId = q.peerId; if(!roomId||!peerId) return { statusCode:400, body: JSON.stringify({ error:'Thiếu roomId hoặc peerId' }) };
    const cursor = Number(q.cursor||0);
    // fetch messages
    const messages = signalLog.filter(e => e.roomId===roomId && e.seq>cursor && e.fromPeer!==peerId && (e.toPeer===null || e.toPeer===peerId)).map(e=>({seq:e.seq, from:e.fromPeer, type:e.type, payload:e.payload}));
    return { statusCode:200, body: JSON.stringify({ ok:true, cursor: messages.length ? messages[messages.length-1].seq : cursor, messages, room: signalRooms.get(roomId)||null, peers: activeSignalPeers(roomId) }) };
  }

  return { statusCode:405, body: JSON.stringify({ error: 'Method not allowed' }) };
};

function touchRoom(roomId, patch){
  const existing = signalRooms.get(roomId) || {};
  signalRooms.set(roomId, { ...existing, ...patch, updatedAt: nowMs() });
}
