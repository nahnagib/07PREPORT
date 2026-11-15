-- Reverses 0074_pdp_schema.sql: drops every Product Development Plan table, with its data (projects, decisions,
-- attachments). Roll the backend back first and take a backup: this cannot be undone.

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS pdp_feedback_history, pdp_customer_feedback, pdp_launch, pdp_documentation_error, pdp_pilot_batch,
  pdp_field_trial, pdp_lab_test, pdp_project_checklist, pdp_attachment, pdp_gate_decision, pdp_project_score,
  pdp_score_round, pdp_project_history, pdp_project_member, pdp_project, pdp_project_seq, pdp_dropdown_value,
  pdp_checklist_template, pdp_gate_rule, pdp_scoring_criterion, pdp_kpi_target, pdp_setting, pdp_governance_member,
  pdp_governance_role, pdp_policy_section, pdp_policy_version, pdp_gap_item, pdp_roadmap_year, pdp_product_history,
  pdp_product, pdp_product_subfamily, pdp_product_family, pdp_brand;
SET FOREIGN_KEY_CHECKS = 1;
