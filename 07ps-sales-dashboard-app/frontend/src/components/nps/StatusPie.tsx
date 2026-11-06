import React from 'react';
import type { NpsFollowupStage, NpsFollowupStatus, NpsFollowupSummary } from '../../lib/api';
import { FOLLOWUP_STAGE_COLOR, FOLLOWUP_STAGE_LABEL, FOLLOWUP_STATUS_SLICES } from '../../lib/nps/view';
import { ReasonPie } from './ReasonPie';


/**
 * "Detractors by status": level 1 = the STATUS (Open, Close, Disputed; the generated column), a click drills into that
 * status's STAGES (Open -> New / Contacted / In progress, Close -> Resolved, Disputed -> Rejected; 0-case stages stay
 * in the legend as 0). The parent keeps the drilled status, so the panel title can name it. Historical has no status
 * and is not in it. Same total as the other follow-up charts (summary.charted).
 */
export function StatusPie({ summary, drill, onDrill }: {
  summary: NpsFollowupSummary;
  drill: NpsFollowupStatus | null;
  onDrill: (status: NpsFollowupStatus | null) => void;
}) {
  const drilled = drill ? summary.byStatus.find((s) => s.key === drill) : undefined;
  if (drilled) {
    return (
      <>
        <button type="button" className="ps-nps-back" data-testid="fu-status-back" onClick={() => onDrill(null)}>← All statuses</button>
        <ReasonPie ariaLabel={`${FOLLOWUP_STATUS_SLICES[drilled.key].label} by stage`} testId="fu-status-stage" totalLabel={FOLLOWUP_STATUS_SLICES[drilled.key].label}
          items={drilled.stages.map((st) => ({
            key: st.stage, label: FOLLOWUP_STAGE_LABEL[st.stage as NpsFollowupStage], count: st.count,
            color: FOLLOWUP_STAGE_COLOR[st.stage as NpsFollowupStage],
          }))} />
      </>
    );
  }
  return (
    <ReasonPie ariaLabel="Detractors by status" testId="fu-status" totalLabel="Detractors"
      onSelect={(key) => onDrill(key as NpsFollowupStatus)}
      canSelect={(key) => (summary.byStatus.find((s) => s.key === key)?.count ?? 0) > 0}
      items={summary.byStatus.map((s) => ({ key: s.key, label: FOLLOWUP_STATUS_SLICES[s.key].label, count: s.count, color: FOLLOWUP_STATUS_SLICES[s.key].color }))} />
  );
}
