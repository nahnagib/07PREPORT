import type { NpsReach } from '../api';

// Presentation only: keep the warehouse's grouping, counts and additional categories intact.
const ERROR_LABELS: Record<string, { label: string; cause: string }> = {
  meta_temporary: { label: 'Unexpected error', cause: 'Temporary Meta server issue.' },
  phone_format: { label: 'Phone wrong', cause: 'No phone number on the customer contact, or an incorrect number.' },
  undeliverable_131026: { label: 'Message Undeliverable', cause: 'Recipient has no WhatsApp or has blocked us.' },
  ecosystem_131049: { label: 'Ecosystem Engagement', cause: 'Meta blocked delivery due to over-messaging or low template quality.' },
  template_quality: { label: 'Quality Low', cause: 'Template paused by Meta.' },
};

export const REASON_COLORS = [
  'var(--ps-nps-slate)', 'var(--ps-nps-teal)', 'var(--ps-nps-blue)',
  'var(--ps-nps-cyan)', 'var(--ps-nps-amber)', 'var(--ps-nps-lilac)', 'var(--ps-nps-rose)',
];
const ERROR_ORDER = ['meta_temporary', 'phone_format', 'undeliverable_131026', 'ecosystem_131049', 'template_quality', 'opted_out_131050', 'other'];

export function errorPieItems(errors: NpsReach['errors']) {
  return errors.map((error) => {
    const display = ERROR_LABELS[error.key];
    const colorIndex = ERROR_ORDER.indexOf(error.key);
    return {
      key: error.key,
      label: display?.label ?? error.label,
      count: error.count,
      color: REASON_COLORS[colorIndex < 0 ? REASON_COLORS.length - 1 : colorIndex],
      hint: [display?.cause, error.hint, error.fixable ? 'Fixable: can be corrected on our side.' : undefined].filter(Boolean).join('\n'),
    };
  });
}
