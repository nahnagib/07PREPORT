/**
 * Data-quality validation for Fact_Opportunity, surfaced on the Pipeline Health page.
 *
 * Deliberately scoped WITHOUT pipelineHealth.ts's `b2bClause` (`SalesSegment = 'B2B'`) even though
 * this feeds the B2B-only Pipeline Health page: a row with a NULL/blank SalesSegment can never
 * match `SalesSegment = 'B2B'`, so applying that clause here would make `missingSalesSegment`
 * always read zero -- exactly the blind spot this module exists to surface. `buildCrmWhereClause`
 * (company/branch/salesperson/salesteam) is still applied, since those are legitimate scoping
 * dimensions the page's filter bar already exposes and don't hide any of the checks below.
 *
 * Thresholds for the frontend's status badge (tunable, not derived from anything in the data):
 *   green  < DATA_QUALITY_YELLOW_PCT
 *   yellow < DATA_QUALITY_RED_PCT
 *   red    >= DATA_QUALITY_RED_PCT
 */

import type { Pool } from 'mysql2/promise';
import { buildCrmWhereClause, type Filters } from './filters';
import { classifyRate, TargetStatus } from './classify';

export const DATA_QUALITY_YELLOW_PCT = 0.02;
export const DATA_QUALITY_RED_PCT = 0.05;

export interface DataQualityIssue {
  key: string;
  label: string;
  count: number;
}

export interface DataQualityOverview {
  totalRecords: number;
  dirtyRecords: number;
  dirtyPct: number | null;
  status: TargetStatus;
  issues: DataQualityIssue[];
}

const MISSING_STAGE = `(fo.Stage IS NULL OR TRIM(fo.Stage) = '')`;
const MISSING_SALES_SEGMENT = `(fo.SalesSegment IS NULL OR TRIM(fo.SalesSegment) = '')`;
const MISSING_CREATED_DATE = `fo.OpportunityCreatedDate IS NULL`;
const OPEN_MISSING_EXPECTED_CLOSE = `(fo.IsOpen = 1 AND fo.ExpectedCloseDate IS NULL)`;
// The ETL's own stated invariant (crm_status_classifier.py: is_open = not is_won and not is_lost)
// is not enforced by any DB constraint -- these three pairs should never both be true on one row.
const CONFLICTING_STATUS_FLAGS = `(
  (fo.IsOpen = 1 AND fo.IsLost = 1) OR
  (fo.IsOpen = 1 AND fo.IsWon = 1) OR
  (fo.IsWon = 1 AND fo.IsLost = 1)
)`;
const DIRTY = `(${MISSING_STAGE} OR ${MISSING_SALES_SEGMENT} OR ${MISSING_CREATED_DATE} OR ${OPEN_MISSING_EXPECTED_CLOSE} OR ${CONFLICTING_STATUS_FLAGS})`;

export async function computeOpportunityDataQuality(pool: Pool, filters: Filters): Promise<DataQualityOverview> {
  const { clause, params } = buildCrmWhereClause(filters, 'fo');
  const sql = `
    SELECT
      COUNT(*) AS totalRecords,
      SUM(CASE WHEN ${MISSING_STAGE} THEN 1 ELSE 0 END) AS missingStage,
      SUM(CASE WHEN ${MISSING_SALES_SEGMENT} THEN 1 ELSE 0 END) AS missingSalesSegment,
      SUM(CASE WHEN ${MISSING_CREATED_DATE} THEN 1 ELSE 0 END) AS missingCreatedDate,
      SUM(CASE WHEN ${OPEN_MISSING_EXPECTED_CLOSE} THEN 1 ELSE 0 END) AS openMissingExpectedClose,
      SUM(CASE WHEN ${CONFLICTING_STATUS_FLAGS} THEN 1 ELSE 0 END) AS conflictingStatusFlags,
      SUM(CASE WHEN ${DIRTY} THEN 1 ELSE 0 END) AS dirtyRecords
    FROM Fact_Opportunity fo
    WHERE ${clause}
  `;
  const [rows] = await pool.query(sql, params);
  const row = (rows as any[])[0];
  const totalRecords = Number(row.totalRecords ?? 0);
  const dirtyRecords = Number(row.dirtyRecords ?? 0);

  const issues: DataQualityIssue[] = [
    { key: 'missingStage', label: 'Missing Stage', count: Number(row.missingStage ?? 0) },
    { key: 'missingSalesSegment', label: 'Missing Sales Segment', count: Number(row.missingSalesSegment ?? 0) },
    { key: 'missingCreatedDate', label: 'Missing Created Date', count: Number(row.missingCreatedDate ?? 0) },
    { key: 'openMissingExpectedClose', label: 'Open, Missing Expected Close Date', count: Number(row.openMissingExpectedClose ?? 0) },
    { key: 'conflictingStatusFlags', label: 'Conflicting Status Flags (Open/Won/Lost)', count: Number(row.conflictingStatusFlags ?? 0) },
  ];

  const dirtyPct = totalRecords > 0 ? dirtyRecords / totalRecords : null;

  return {
    totalRecords,
    dirtyRecords,
    dirtyPct,
    status: classifyRate(dirtyPct, DATA_QUALITY_YELLOW_PCT, DATA_QUALITY_RED_PCT),
    issues,
  };
}
