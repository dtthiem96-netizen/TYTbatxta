const express = require('express');
const router = express.Router();
const db = require('../models'); // Sequelize models
const { requireAuth, requireStationStaff } = require('../middleware/auth');

// GET /api/doctors?video=true&sign=true
router.get('/api/doctors', requireAuth, async (req, res) => {
  try {
    const { video, sign } = req.query;
    const where = {};
    if (video === 'true') where.can_video_consult = true;
    if (sign === 'true') where.can_sign_digitally = true;
    const doctors = await db.Doctor.findAll({ where });
    res.json(doctors);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/station/dashboard
router.get('/api/station/dashboard', requireAuth, requireStationStaff, async (req, res) => {
  try {
    const stationId = req.user.station_id;
    const calls = await db.Call.findAll({ where: { station_id: stationId, status: 'waiting' } });
    res.json({ stationId, calls });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/prescriptions
router.post('/api/prescriptions', requireAuth, async (req, res) => {
  try {
    const { callId, doctorId, items, patient_national_id, patient_bhyt_number } = req.body;
    // Basic validation
    if (!doctorId || !items) return res.status(400).json({ error: 'Missing doctorId or items' });
    const prescription = await db.Prescription.create({
      call_id: callId,
      doctor_id: doctorId,
      items,
      patient_national_id,
      patient_bhyt_number,
      created_by: req.user.id
    });
    res.status(201).json(prescription);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/call/:callId/user-view
router.get('/api/call/:callId/user-view', requireAuth, async (req, res) => {
  try {
    const callId = req.params.callId;
    const call = await db.Call.findByPk(callId, { include: [{ model: db.Doctor, as: 'doctor' }] });
    if (!call) return res.status(404).json({ error: 'Call not found' });

    // Example: doctor.templateFields stored in JSON column with visibility flags
    const templateFields = (call.doctor.template_fields || []).filter(f => f.visibleToUser).map(f => ({
      id: f.id,
      label: f.label,
      type: f.type,
      required: f.required
    }));

    res.json({
      callId,
      doctor: {
        id: call.doctor.id,
        name: call.doctor.name,
        minimalFields: templateFields
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
