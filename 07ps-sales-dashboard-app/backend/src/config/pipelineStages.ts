/**
 * The pipeline order of the CRM stages (2026-11-03) -- the ONE place it is defined. Every stage-based visual lists stages
 * in this order (Pipeline Health's Opportunity by Stage legend, slices and table; the Stage column of the opportunity
 * tables on Pipeline Health, Pipeline Trend and Activity Momentum), and each stage keeps the same colour on every chart.
 *
 * Matched by Odoo crm.stage id (dim_sales_crm_stage.StageID), never by name, so renaming a stage in Odoo changes nothing.
 * Any other stage -- "Lost" (which still holds open deals until the salesperson clicks the real Lost button), "Won", or
 * a stage the admin adds later -- goes after these, by Odoo's own stage sequence.
 */

export interface PipelineStageConfig {
  stageId: number;
  /** For reading this file only; the name shown on screen comes from Odoo. */
  name: string;
  /** Colour token the page maps to its theme (frontend tokens.css --ps-stage-<colorKey>). */
  colorKey: string;
}

export const PIPELINE_STAGE_ORDER: readonly PipelineStageConfig[] = [
  { stageId: 1, name: 'New', colorKey: 'new' },
  { stageId: 9, name: 'Design Stage', colorKey: 'design' },
  { stageId: 2, name: 'Qualified', colorKey: 'qualified' },
  { stageId: 8, name: 'Cross Selling', colorKey: 'cross-selling' },
  { stageId: 7, name: 'Proposition', colorKey: 'proposition' },
  { stageId: 10, name: 'Negotiations', colorKey: 'negotiations' },
  { stageId: 11, name: 'Waiting For LOA', colorKey: 'waiting-loa' },
  { stageId: 6, name: 'On Hold -Resolution Issue', colorKey: 'on-hold' },
];

/** Colours for the stages after the fixed list, in their order (cycled if there are more). */
export const OTHER_STAGE_COLOR_KEYS = ['other-1', 'other-2', 'other-3'] as const;
/** A row with no stage at all. */
export const UNSPECIFIED_STAGE_COLOR_KEY = 'unspecified';

export interface PipelineStage {
  stageId: number | null;
  stage: string;
  /** 1-based place in the pipeline order; the same number on every page. */
  position: number;
  colorKey: string;
}

export interface StageCatalogRow {
  stageId: number;
  stage: string;
  /** Odoo crm.stage sequence; orders the stages that are not in PIPELINE_STAGE_ORDER. */
  sequence: number | null;
}

/** Every stage in pipeline order: the fixed list first, then the rest by Odoo sequence (then id). */
export function orderPipelineStages(catalog: StageCatalogRow[]): PipelineStage[] {
  const byId = new Map(catalog.map((c) => [c.stageId, c]));
  const fixedIds = new Set(PIPELINE_STAGE_ORDER.map((s) => s.stageId));
  const fixed = PIPELINE_STAGE_ORDER.map((s) => ({ stageId: s.stageId, stage: byId.get(s.stageId)?.stage ?? s.name, colorKey: s.colorKey }));
  const others = catalog
    .filter((c) => !fixedIds.has(c.stageId))
    .sort((a, b) => (a.sequence ?? Number.MAX_SAFE_INTEGER) - (b.sequence ?? Number.MAX_SAFE_INTEGER) || a.stageId - b.stageId)
    .map((c, i) => ({ stageId: c.stageId, stage: c.stage, colorKey: OTHER_STAGE_COLOR_KEYS[i % OTHER_STAGE_COLOR_KEYS.length] }));
  return [...fixed, ...others].map((s, i) => ({ ...s, position: i + 1 }));
}

/** Lookup by stage id; an unknown id or a row with no stage goes last. */
export class PipelineStageOrder {
  readonly stages: PipelineStage[];
  private readonly byId: Map<number, PipelineStage>;

  constructor(catalog: StageCatalogRow[]) {
    this.stages = orderPipelineStages(catalog);
    this.byId = new Map(this.stages.map((s) => [s.stageId as number, s]));
  }

  of(stageId: number | null | undefined, stageName?: string | null): PipelineStage {
    const known = stageId != null ? this.byId.get(Number(stageId)) : undefined;
    if (known) return known;
    return {
      stageId: stageId != null ? Number(stageId) : null,
      stage: stageName ?? 'Unspecified',
      position: this.stages.length + 1,
      colorKey: UNSPECIFIED_STAGE_COLOR_KEY,
    };
  }
}
