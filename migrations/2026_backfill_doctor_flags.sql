-- Backfill doctor flags from user_roles

UPDATE doctors d
SET can_video_consult = true
FROM user_roles ur
WHERE ur.user_id = d.user_id AND ur.role = 'doctor_video';

UPDATE doctors d
SET can_sign_digitally = true
FROM user_roles ur
WHERE ur.user_id = d.user_id AND ur.role = 'doctor_sign';
