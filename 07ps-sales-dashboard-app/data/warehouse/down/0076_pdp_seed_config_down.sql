-- Reverses 0076_pdp_seed_config.sql: removes the seeded configuration rows nothing references yet. Rows already used
-- by a project, score, checklist or member stay; run 0075's down script to remove everything.

SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;
SET @tika := (SELECT CompanyKey FROM dim_company WHERE LOWER(Company) = 'tika' OR UPPER(odoo_name) = 'TIKA' ORDER BY CompanyKey LIMIT 1);

DELETE FROM pdp_setting WHERE company_key = @tika AND setting_key IN ('max_concurrent_projects', 'mix_target_planned',
  'mix_target_unplanned', 'mix_target_innovation', 'min_score', 'fast_track_feasibility_hours', 'freeze_from_mmdd',
  'freeze_to_mmdd', 'pilot_kg_min', 'pilot_kg_max');
DELETE FROM pdp_kpi_target WHERE company_key = @tika AND kpi_code IN ('NEW_PRODUCTS', 'REFORMULATIONS',
  'FIELD_TRIAL_SUCCESS', 'FIRST_PASS_LAB', 'ON_TIME', 'CYCLE_TIME', 'CRITICAL_DOC_ERRORS');
DELETE FROM pdp_gate_rule WHERE company_key = @tika AND signoff_code IN ('KICKOFF', 'UNPLANNED_EXEC', 'TECH_EVAL',
  'TS_VALIDATION', 'PILOT', 'FINAL_LAUNCH');
DELETE t FROM pdp_checklist_template t
  LEFT JOIN pdp_project_checklist c ON c.template_id = t.template_id
 WHERE t.company_key = @tika AND c.item_id IS NULL;
DELETE s FROM pdp_scoring_criterion s
  LEFT JOIN pdp_project_score ps ON ps.criterion_id = s.criterion_id
 WHERE s.company_key = @tika AND ps.score_id IS NULL;
DELETE r FROM pdp_governance_role r
  LEFT JOIN pdp_governance_member m ON m.role_id = r.role_id
 WHERE r.company_key = @tika AND m.member_id IS NULL;
DELETE FROM pdp_roadmap_year WHERE company_key = @tika AND year BETWEEN 2023 AND 2028 AND notes IS NULL;
DELETE FROM pdp_gap_item WHERE company_key = @tika AND owner_user_id IS NULL AND due_date IS NULL AND notes IS NULL;
DELETE d FROM pdp_dropdown_value d
 WHERE d.company_key = @tika
   AND NOT EXISTS (SELECT 1 FROM pdp_project p WHERE p.project_type_id = d.value_id OR p.request_source_id = d.value_id)
   AND NOT EXISTS (SELECT 1 FROM pdp_lab_test l WHERE l.competitor_id = d.value_id OR l.property_id = d.value_id)
   AND NOT EXISTS (SELECT 1 FROM pdp_customer_feedback f WHERE f.channel_id = d.value_id OR f.category_id = d.value_id);
