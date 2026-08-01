-- Migration: add station fields, doctor flags, prescription PII fields, and audit_logs

ALTER TABLE "users"
ADD COLUMN IF NOT EXISTS station_id UUID NULL,
ADD COLUMN IF NOT EXISTS is_station_staff BOOLEAN DEFAULT FALSE;

ALTER TABLE "doctors"
ADD COLUMN IF NOT EXISTS can_video_consult BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS can_sign_digitally BOOLEAN DEFAULT FALSE;

ALTER TABLE "prescriptions"
ADD COLUMN IF NOT EXISTS patient_national_id VARCHAR(32) NULL,
ADD COLUMN IF NOT EXISTS patient_bhyt_number VARCHAR(32) NULL;

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID NOT NULL,
  action VARCHAR(200) NOT NULL,
  target_type VARCHAR(50),
  target_id UUID,
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);
