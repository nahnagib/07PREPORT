import type { Pool } from 'mysql2/promise';
import { PipelineStageOrder, type StageCatalogRow } from '../config/pipelineStages';

/** The CRM stages from the warehouse (dim_sales_crm_stage: Odoo crm.stage id, name, sequence), in pipeline order
 * (config/pipelineStages.ts). If the table cannot be read the fixed order still applies; other stages then go last. */
export async function fetchPipelineStageOrder(pool: Pool): Promise<PipelineStageOrder> {
  let catalog: StageCatalogRow[] = [];
  try {
    const [rows] = await pool.query('SELECT StageID AS stageId, Stage AS stage, Sequence AS sequence FROM dim_sales_crm_stage');
    catalog = (rows as any[])
      .filter((r) => r != null && Number.isFinite(Number(r.stageId)) && r.stageId !== null)
      .map((r) => ({ stageId: Number(r.stageId), stage: String(r.stage ?? ''), sequence: r.sequence != null ? Number(r.sequence) : null }));
  } catch (err) {
    console.warn('[pipelineStages] dim_sales_crm_stage not readable; using the fixed stage order only', err);
  }
  return new PipelineStageOrder(catalog);
}
