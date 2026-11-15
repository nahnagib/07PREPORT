-- 0075: Product Development Plan -- configuration seed for TIKA (from the CEO's R&D Policy, scoring matrix and roadmap
-- deck, see docs/product-development-plan.md). Everything here stays editable in the app (Product Development Plan ->
-- Admin); INSERT IGNORE on the natural keys never overwrites an edit, so re-running this file is safe.
--
-- TIKA is looked up in the core dim_company by name (Odoo name "TIKA"), never by a hard-coded key. On a database whose
-- dim_company has no TIKA row yet (fresh install before the first ETL run) nothing is inserted; the admin import seeds
-- the same rows later (backend/src/services/pdp/seedConfig.ts holds the same values; a test keeps them in step).
--
-- NOT seeded on purpose: governance members (assigned on the admin screen), the product tree and policy v1.0 (the
-- admin import), the peak-season freeze months (empty = no freeze).
-- Reverse: data/warehouse/down/0075_pdp_seed_config_down.sql.

SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;

SET @tika := (SELECT CompanyKey FROM dim_company WHERE LOWER(Company) = 'tika' OR UPPER(odoo_name) = 'TIKA' ORDER BY CompanyKey LIMIT 1);

-- Settings (pdp_setting). freeze_*_mmdd: "MM-DD", both empty = no freeze.
INSERT IGNORE INTO pdp_setting (company_key, setting_key, setting_value)
SELECT @tika, v.k, v.val FROM (VALUES
    ROW('max_concurrent_projects', '6'),
    ROW('mix_target_planned', '50'),
    ROW('mix_target_unplanned', '30'),
    ROW('mix_target_innovation', '20'),
    ROW('min_score', '60'),
    ROW('fast_track_feasibility_hours', '72'),
    ROW('freeze_from_mmdd', ''),
    ROW('freeze_to_mmdd', ''),
    ROW('pilot_kg_min', '500'),
    ROW('pilot_kg_max', '1500')
) AS v(k, val) WHERE @tika IS NOT NULL;

-- Governance roles (policy section 4 + the deck's approval structure). No members.
INSERT IGNORE INTO pdp_governance_role (company_key, code, label, responsibility, sort_order)
SELECT @tika, v.code, v.label, v.resp, v.so FROM (VALUES
    ROW('CHAIRMAN',     'Chairman',          'Kick-off approval (with the CEO).', 1),
    ROW('CEO',          'CEO',               'Product portfolio leadership; kick-off approval; unplanned-project and capacity overrides.', 2),
    ROW('EXCO',         'EXCO',              'Strategic oversight, final approval.', 3),
    ROW('TECH_MANAGER', 'Technical Manager', 'Full ownership of the development pipeline.', 4),
    ROW('RND',          'R&D',               'Formulation, benchmarking, documentation.', 5),
    ROW('TS',           'Technical Support', 'Field trials, performance validation.', 6),
    ROW('COMMERCIAL',   'Commercial',        'Market demand, competitor insights, pricing.', 7),
    ROW('MARKETING',    'Marketing',         'Packaging, naming, branding.', 8),
    ROW('QC_QA',        'QC/QA',             'Standards compliance.', 9),
    ROW('PRODUCTION',   'Production',        'Scale-up and manufacturability.', 10)
) AS v(code, label, resp, so) WHERE @tika IS NOT NULL;

-- Priority scoring matrix (RD_Scoring_Matrix.xlsx): score 0-5, weighted = score x weight / 5, total out of 100.
INSERT IGNORE INTO pdp_scoring_criterion (company_key, code, name, weight, meaning_0, meaning_1, meaning_2, meaning_3, meaning_4, meaning_5, sort_order)
SELECT @tika, v.code, v.name, v.w, v.m0, v.m1, v.m2, v.m3, v.m4, v.m5, v.so FROM (VALUES
    ROW('STRATEGIC_ALIGNMENT', 'Strategic Alignment', 20, 'No alignment with strategy', 'Very weak alignment', 'Limited or partial alignment',
        'Good alignment with one pillar', 'Strong alignment with key pillars', 'Critical strategic priority', 1),
    ROW('REVENUE_POTENTIAL', 'Revenue Potential', 20, 'No commercial value', 'Very small potential', 'Moderate potential',
        'Good commercial return expected', 'High revenue potential', 'Major revenue generator', 2),
    ROW('TECHNICAL_RISK', 'Technical Risk', 20, 'Very high risk – likely to fail', 'High risk – sensitive to conditions',
        'Medium-high risk – requires controls', 'Moderate risk – manageable', 'Low risk', 'Very low risk – highly stable', 3),
    ROW('DEVELOPMENT_DIFFICULTY', 'Development Difficulty', 20, 'Very difficult – advanced chemistry', 'High difficulty – many iterations',
        'Medium-high difficulty', 'Moderate difficulty', 'Low difficulty', 'Very easy – straightforward formula', 4),
    ROW('URGENCY', 'Urgency', 10, 'Not urgent', 'Low urgency', 'Moderate urgency', 'Needed this quarter', 'High urgency',
        'Immediate need for active project', 5),
    ROW('PRODUCTION_IMPACT', 'Production Impact', 10, 'Major changes or new machinery needed', 'High impact on production',
        'Medium-high impact', 'Moderate impact', 'Low impact', 'No impact on production', 6)
) AS v(code, name, w, m0, m1, m2, m3, m4, m5, so) WHERE @tika IS NOT NULL;

-- Gate sign-offs (policy gates + the deck's approval structure).
INSERT IGNORE INTO pdp_gate_rule (company_key, gate, signoff_code, label, roles_json, mode, applies_to, sort_order)
SELECT @tika, v.gate, v.code, v.label, CAST(v.roles AS JSON), v.mode, v.applies, v.so FROM (VALUES
    ROW('G1', 'KICKOFF',        'Kick-off approval (Chairman / CEO)',                    '["CHAIRMAN","CEO"]',               'ANY', 'ALL',       1),
    ROW('G1', 'UNPLANNED_EXEC', 'Unplanned project approval (CEO / EXCO)',               '["CEO","EXCO"]',                   'ANY', 'UNPLANNED', 2),
    ROW('G2', 'TECH_EVAL',      'Technical evaluation (R&D + QC/QA + Production)',       '["RND","QC_QA","PRODUCTION"]',     'ALL', 'ALL',       3),
    ROW('G3', 'TS_VALIDATION',  'Pre-launch validation (Technical Support)',             '["TS"]',                           'ANY', 'ALL',       4),
    ROW('G4', 'PILOT',          'Pilot sign-off (Technical Manager)',                    '["TECH_MANAGER"]',                 'ANY', 'ALL',       5),
    ROW('G5', 'FINAL_LAUNCH',   'Final launch approval (EXCO)',                          '["EXCO"]',                         'ANY', 'ALL',       6)
) AS v(gate, code, label, roles, mode, applies, so) WHERE @tika IS NOT NULL;

-- Gate checklists. required = part of the gate rule; needs_evidence = an attachment or a link is required when done.
INSERT IGNORE INTO pdp_checklist_template (company_key, list_code, item_code, label, hint, gate, required, needs_evidence, owner_role_code, sort_order)
SELECT @tika, v.list, v.code, v.label, v.hint, v.gate, v.req, v.ev, v.owner, v.so FROM (VALUES
    ROW('FEASIBILITY',   'FEAS_RAW_MATERIAL',  'Raw material qualification',   NULL, 'G1', 1, 0, 'RND', 1),
    ROW('FEASIBILITY',   'FEAS_EQUIPMENT',     'Equipment capability',         NULL, 'G1', 1, 0, 'PRODUCTION', 2),
    ROW('FEASIBILITY',   'FEAS_COST',          'Cost structure analysis',      NULL, 'G1', 1, 0, 'COMMERCIAL', 3),
    ROW('FEASIBILITY',   'FEAS_STANDARDS',     'Standards mapping (EN/ASTM)',  NULL, 'G1', 1, 0, 'QC_QA', 4),
    ROW('FEASIBILITY',   'FEAS_MARKET',        'Market availability',          NULL, 'G1', 1, 0, 'COMMERCIAL', 5),
    ROW('FEASIBILITY',   'FEAS_RISKS',         'Risks & mitigation',           NULL, 'G1', 1, 0, 'TECH_MANAGER', 6),
    ROW('RAW_MATERIAL',  'RM_PURITY',          'Purity',                       'Joint QC & R&D evaluation', 'G4', 1, 0, 'QC_QA', 11),
    ROW('RAW_MATERIAL',  'RM_MOISTURE',        'Moisture',                     'Joint QC & R&D evaluation', 'G4', 1, 0, 'QC_QA', 12),
    ROW('RAW_MATERIAL',  'RM_PARTICLE_SIZE',   'Particle size',                'Joint QC & R&D evaluation', 'G4', 1, 0, 'QC_QA', 13),
    ROW('RAW_MATERIAL',  'RM_COMPATIBILITY',   'Compatibility',                'Joint QC & R&D evaluation', 'G4', 1, 0, 'RND', 14),
    ROW('RAW_MATERIAL',  'RM_STABILITY',       'Stability',                    'Joint QC & R&D evaluation', 'G4', 1, 0, 'RND', 15),
    ROW('RAW_MATERIAL',  'RM_COST_EFFICIENCY', 'Cost efficiency',              'Joint QC & R&D evaluation', 'G4', 1, 0, 'RND', 16),
    ROW('DOCUMENTATION', 'DOC_TDS',            'TDS (Technical Data Sheet)',   NULL, 'G5', 1, 1, 'RND', 21),
    ROW('DOCUMENTATION', 'DOC_MSDS',           'MSDS (Material Safety Data Sheet)', NULL, 'G5', 1, 1, 'RND', 22),
    ROW('DOCUMENTATION', 'DOC_FORMULA',        'Final formula',                NULL, 'G5', 1, 1, 'RND', 23),
    ROW('DOCUMENTATION', 'DOC_QC_SPECS',       'QC specifications',            NULL, 'G5', 1, 1, 'QC_QA', 24),
    ROW('DOCUMENTATION', 'DOC_SOP',            'Production SOP',               NULL, 'G5', 1, 1, 'PRODUCTION', 25),
    ROW('DOCUMENTATION', 'DOC_MOS',            'Method of Statement',          NULL, 'G5', 1, 1, 'TS', 26),
    ROW('DOCUMENTATION', 'DOC_CERTS',          'Compliance certificates',      NULL, 'G5', 1, 1, 'QC_QA', 27),
    ROW('DOCUMENTATION', 'DOC_PACKAGING',      'Packaging development',
        'Artwork, regulatory compliance, brand consistency, TDS/MSDS match (policy section 13)', 'G5', 0, 1, 'MARKETING', 28)
) AS v(list, code, label, hint, gate, req, ev, owner, so) WHERE @tika IS NOT NULL;

-- KPI targets (policy section 20), per quarter.
INSERT IGNORE INTO pdp_kpi_target (company_key, kpi_code, label, target, comparator, unit, sort_order)
SELECT @tika, v.code, v.label, v.t, v.cmp, v.unit, v.so FROM (VALUES
    ROW('NEW_PRODUCTS',        'New products this quarter',     3,  'gte', 'count', 1),
    ROW('REFORMULATIONS',      'Reformulations this quarter',   2,  'gte', 'count', 2),
    ROW('FIELD_TRIAL_SUCCESS', 'Field-trial success',           80, 'gte', 'pct',   3),
    ROW('FIRST_PASS_LAB',      'First-pass lab success',        85, 'gte', 'pct',   4),
    ROW('ON_TIME',             'On-time delivery',              90, 'gte', 'pct',   5),
    ROW('CYCLE_TIME',          'Average cycle time',            60, 'lte', 'days',  6),
    ROW('CRITICAL_DOC_ERRORS', 'Critical documentation errors', 0,  'lte', 'count', 7)
) AS v(code, label, t, cmp, unit, so) WHERE @tika IS NOT NULL;

-- Roadmap years (Xtreme_Roadmap.pptx slide 5, boxes in order 2023-2028).
INSERT IGNORE INTO pdp_roadmap_year (company_key, year, theme)
SELECT @tika, v.y, v.theme FROM (VALUES
    ROW(2023, 'Foundation Year'),
    ROW(2024, 'Expansion Year'),
    ROW(2025, 'Transformation Year'),
    ROW(2026, 'Portfolio Year'),
    ROW(2027, 'Optimization Year'),
    ROW(2028, 'Innovation & Advanced Systems Year')
) AS v(y, theme) WHERE @tika IS NOT NULL;

-- Gap analysis (slide 9; category = the 5M box each arrow points at). "Mentoring" on the slide means monitoring.
INSERT IGNORE INTO pdp_gap_item (company_key, category, item, status, sort_order)
SELECT @tika, v.cat, v.item, v.st, v.so FROM (VALUES
    ROW('MANPOWER',     'Technical Support Dept.', 'open', 1),
    ROW('MANPOWER',     'R&D technicians', 'open', 2),
    ROW('MANPOWER',     'Sales team upskilling', 'open', 3),
    ROW('MANPOWER',     'R&D committee', 'open', 4),
    ROW('MANPOWER',     'Production team', 'open', 5),
    ROW('MACHINE',      'Production lines ready for 2026 plan', 'open', 6),
    ROW('MACHINE',      'Lab equipment', 'open', 7),
    ROW('MACHINE',      'Extension for residential buildings', 'open', 8),
    ROW('MATERIALS',    'Suppliers: Libya, Spain, China, Turkey and Egypt', 'open', 9),
    ROW('MATERIALS',    'Trading items suppliers', 'open', 10),
    ROW('METHODS',      'R&D policy, forms and SOP', 'open', 11),
    ROW('MEASUREMENTS', 'R&D KPIs', 'open', 12),
    ROW('MEASUREMENTS', 'Monitoring tools (product launch tracking, dashboard & customer feedback)', 'in_progress', 13)
) AS v(cat, item, st, so) WHERE @tika IS NOT NULL;

-- Drop-down values (admin-managed).
INSERT IGNORE INTO pdp_dropdown_value (company_key, list_key, label, sort_order)
SELECT @tika, v.list, v.label, v.so FROM (VALUES
    ROW('project_type',      'New Product Development (NPD)', 1),
    ROW('project_type',      'Product Improvement / Optimization', 2),
    ROW('project_type',      'Localization & Cost Optimization', 3),
    ROW('project_type',      'Technical Support–initiated Improvement', 4),
    ROW('project_type',      'Sales/Market Demand Request', 5),
    ROW('request_source',    'Sales', 1),
    ROW('request_source',    'Technical Support', 2),
    ROW('request_source',    'R&D', 3),
    ROW('request_source',    'QC', 4),
    ROW('request_source',    'Commercial', 5),
    ROW('request_source',    'Employee idea', 6),
    ROW('competitor',        'Sika', 1),
    ROW('competitor',        'Mapei', 2),
    ROW('competitor',        'Weber', 3),
    ROW('competitor',        'Other', 4),
    ROW('lab_property',      'Adhesion', 1),
    ROW('lab_property',      'Strength', 2),
    ROW('lab_property',      'Flexibility', 3),
    ROW('lab_property',      'Curing', 4),
    ROW('lab_property',      'Workability', 5),
    ROW('lab_property',      'Climatic performance', 6),
    ROW('feedback_channel',  'Site visit', 1),
    ROW('feedback_channel',  'Phone', 2),
    ROW('feedback_channel',  'WhatsApp', 3),
    ROW('feedback_channel',  'Email', 4),
    ROW('feedback_channel',  'Sales visit', 5),
    ROW('feedback_category', 'Performance', 1),
    ROW('feedback_category', 'Application', 2),
    ROW('feedback_category', 'Packaging', 3),
    ROW('feedback_category', 'Price', 4),
    ROW('feedback_category', 'Other', 5)
) AS v(list, label, so) WHERE @tika IS NOT NULL;
