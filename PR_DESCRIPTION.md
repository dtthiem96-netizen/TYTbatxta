## Summary

This PR adds migrations, backend routes, middleware, a frontend component, and helpers to support station dashboards, doctor permission filters, minimal user-facing video call fields, and storing patient PII fields in prescriptions.

### Changes
- migrations/2026_add_station_doctor_prescription_audit.sql
- migrations/2026_backfill_doctor_flags.sql
- backend/routes/station.js
- backend/middleware/auth.js
- backend/utils/audit.js
- frontend/src/components/VideoCallUserView.jsx
- README_station_feature.md

### Notes
- Run the migration SQL against your Postgres DB.
- Adjust Sequelize model names/associations to match your project.
- Secure PII fields in DB and transit.
