// middleware/auth.js

async function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

async function requireStationStaff(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  if (!req.user.is_station_staff) return res.status(403).json({ error: 'Forbidden' });
  next();
}

module.exports = { requireAuth, requireStationStaff };
