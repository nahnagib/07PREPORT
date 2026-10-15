import type { CreditPolicyZone } from '../../api';

/** Representative API response, including BLOCK's internal action ranges. */
export const ZONES: CreditPolicyZone[] = [
  { key: 'GREEN', label: 'GREEN', minDays: 0, maxDays: 15, tone: 'green', owner: 'Sales Manager', action: 'Payment Reminder', edgeLabel: '15 Days' },
  { key: 'YELLOW', label: 'YELLOW', minDays: 16, maxDays: 30, tone: 'amber', owner: 'Sales Director', action: 'Follow-up / Customer Visit', edgeLabel: '30 Days' },
  { key: 'RED', label: 'RED', minDays: 31, maxDays: 44, tone: 'red', owner: 'CEO', action: 'CEO Intervention', edgeLabel: '45 Days' },
  { key: 'BLOCK', label: 'BLOCK', minDays: 45, maxDays: null, tone: 'block', owner: 'GCEO + CFO', action: 'Management Escalation', edgeLabel: null,
    actionAreas: [
      { minDays: 45, maxDays: 60, action: 'Management Escalation', edgeLabel: '60 Days' },
      { minDays: 61, maxDays: 65, action: 'Final Warning + Stop Supply', edgeLabel: '65 Days', details: 'Send final payment warning by registered mail and suspend further supply/deliveries.' },
      { minDays: 66, maxDays: null, action: 'Legal Action', edgeLabel: null, details: 'CFO decides the appropriate legal action in consultation with GCEO.' },
    ],
  },
];
