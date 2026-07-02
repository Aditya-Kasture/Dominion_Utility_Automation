ALTER TABLE public.bge_portal_audit_log ADD COLUMN IF NOT EXISTS run_id TEXT;
ALTER TABLE public.water_portal_audit_log ADD COLUMN IF NOT EXISTS run_id TEXT;
ALTER TABLE public.bge_portal_audit_log DROP CONSTRAINT IF EXISTS bge_portal_audit_log_run_action_key;
ALTER TABLE public.bge_portal_audit_log 
  ADD CONSTRAINT bge_portal_audit_log_run_action_key UNIQUE (run_id, bge_account_number, action);

ALTER TABLE public.water_portal_audit_log DROP CONSTRAINT IF EXISTS water_portal_audit_log_run_action_key;
ALTER TABLE public.water_portal_audit_log 
  ADD CONSTRAINT water_portal_audit_log_run_action_key UNIQUE (run_id, unit_id, action);
