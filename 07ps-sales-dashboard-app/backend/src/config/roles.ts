/**
 * Standards Section 5.2 - Role-Based Access manifest.
 * "Every dashboard/page declares its allowed roles in a manifest at build time, generated from
 * the same Role-Based Access table maintained by the platform owner." This is that table's
 * TypeScript mirror for compile-time checks; the source of truth at runtime is the
 * `role_dashboard_access` table in the warehouse (0006_rbac_manifest.sql), not this file.
 */
export type RoleTier =
  | 'BI00_EXECUTIVE'
  | 'BI01_DIRECTOR_B2B'
  | 'BI02_DIRECTOR_B2C'
  | 'BI03_COMPANY_EXEC'
  | 'DEPARTMENT_HEAD'
  | 'SALESPERSON';

/** Manifest declared per dashboard (Sales today) - Migration Plan Section 6.1 P0 exit criterion. */
export const SALES_DASHBOARD_ALLOWED_ROLES: RoleTier[] = [
  'BI00_EXECUTIVE',
  'BI01_DIRECTOR_B2B',
  'BI02_DIRECTOR_B2C',
  'BI03_COMPANY_EXEC',
  'DEPARTMENT_HEAD',
  'SALESPERSON',
];
