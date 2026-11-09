-- Move Unresolved cases to another stage before reversing this migration.
-- The ALTER fails atomically if any Unresolved cases remain; no cases are deleted.
ALTER TABLE nps_followup_case
  DROP CHECK chk_nps_followup_stage,
  ADD CONSTRAINT chk_nps_followup_stage CHECK
    (stage IN ('HISTORICAL', 'NEW', 'CONTACTED', 'IN_PROGRESS', 'RESOLVED', 'REJECTED'));
