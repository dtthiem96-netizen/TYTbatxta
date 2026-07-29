# Station Dashboard & Minimal User View

This PR adds support for station dashboards (for station staff), doctor filters for video/sign permissions, persistence of patient PII (national id / BHYT) in prescriptions, and a minimal user-facing video call view that only shows fields the doctor requests from the user.

Files added:
- migrations/2026_add_station_doctor_prescription_audit.sql
- migrations/2026_backfill_doctor_flags.sql
- backend/routes/station.js
- backend/middleware/auth.js
- backend/utils/audit.js
- frontend/src/components/VideoCallUserView.jsx

How to apply migrations (Postgres):
- Run the SQL file in migrations/2026_add_station_doctor_prescription_audit.sql in your DB
- Optionally run migrations/2026_backfill_doctor_flags.sql to backfill doctor flags from user_roles

Notes:
- The server routes assume Sequelize models (User, Doctor, Call, Prescription, AuditLog) exist and may need mapping to your actual models.
- The VideoCallUserView component uses an api helper (frontend/src/utils/api) for requests; adapt as needed.
- Ensure to secure PII fields and apply encryption/audit policies as appropriate.
