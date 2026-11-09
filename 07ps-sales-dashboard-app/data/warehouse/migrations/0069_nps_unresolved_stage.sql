-- Add Unresolved as a distinct workflow stage. The existing generated status
-- maps it to DISPUTED; Resolved remains CLOSE (displayed as Closed).
-- Re-runnable, preserves every existing case and its history.
ALTER TABLE nps_followup_case
  DROP CHECK chk_nps_followup_stage,
  ADD CONSTRAINT chk_nps_followup_stage CHECK
    (stage IN ('HISTORICAL', 'NEW', 'CONTACTED', 'IN_PROGRESS', 'RESOLVED', 'UNRESOLVED', 'REJECTED'));
