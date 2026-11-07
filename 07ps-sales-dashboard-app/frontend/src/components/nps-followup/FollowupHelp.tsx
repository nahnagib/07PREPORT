'use client';
import React from 'react';
import { CircleHelp } from 'lucide-react';
import { HintPopover } from '@07ps/ui';
import {
  STAGES,
  STAGE_LABEL,
  STATUSES,
  STATUS_LABEL,
  type FollowupStage,
  type FollowupStatus,
} from '../../lib/nps/followup';

export const STAGE_DEFINITION: Record<FollowupStage, string> = {
  HISTORICAL: 'Rated before follow-up began. Kept for reference and excluded from SLA tracking.',
  NEW: 'A new detractor case waiting to be picked up for follow-up.',
  CONTACTED: 'Customer service has contacted the customer; the case is still open.',
  IN_PROGRESS: 'The issue is being investigated or action is underway; it is not yet resolved.',
  RESOLVED: "The customer's issue has been resolved and the case is closed.",
  REJECTED: 'The case was rejected rather than resolved. The reason is recorded in its notes.',
};

export const STATUS_DEFINITION: Record<FollowupStatus, string> = {
  OPEN: 'Cases still being followed up: New, Contacted or In progress.',
  CLOSE: 'Resolved cases. This status follows the Resolved stage automatically.',
  DISPUTED: 'Rejected cases. This status follows the Rejected stage automatically.',
};

type Props = { kind: 'stage'; value?: FollowupStage } | { kind: 'status'; value?: FollowupStatus };

/** Shared hover, keyboard-focus and tap help for the board headings and filter/list guides. */
export function FollowupHelp(props: Props) {
  const entries =
    props.kind === 'stage'
      ? (props.value ? [props.value] : STAGES).map((s) => ({
          label: STAGE_LABEL[s],
          definition: STAGE_DEFINITION[s],
        }))
      : (props.value ? [props.value] : STATUSES).map((s) => ({
          label: STATUS_LABEL[s],
          definition: STATUS_DEFINITION[s],
        }));
  const title = props.value
    ? `${entries[0].label} ${props.kind}`
    : props.kind === 'stage'
      ? 'Stages'
      : 'Statuses';
  return (
    <HintPopover
      label={`About ${title}`}
      testId={`fu-help-${props.kind}-${props.value ?? 'all'}`}
      icon={<CircleHelp size={14} aria-hidden="true" />}
    >
      <div style={{ fontWeight: 700, marginBottom: 4 }}>{title}</div>
      {!props.value && (
        <p style={{ margin: '0 0 8px' }}>
          {props.kind === 'stage'
            ? 'Stage is the current step in the follow-up workflow.'
            : 'Status is the outcome group, set automatically from the stage.'}
        </p>
      )}
      {entries.map((entry) => (
        <div key={entry.label} style={{ marginTop: 6 }}>
          {!props.value && <strong>{entry.label}: </strong>}
          {entry.definition}
        </div>
      ))}
    </HintPopover>
  );
}
