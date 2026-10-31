import React from 'react';
import { VisualInfoIcons } from '@07ps/ui';
export function InfoHint({ label, detail }: { label: string; detail: string }) {
  return <VisualInfoIcons title={label} help={{ definition: detail }} />;
}
