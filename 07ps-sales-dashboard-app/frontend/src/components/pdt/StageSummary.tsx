import type { StageCode } from '../../lib/pdt/api';

/** ?stage=development <-> DEVELOPMENT (the dashboard keeps its single selected stage in the URL). */
export const stageToParam = (s: StageCode | null): string | null => (s ? s.toLowerCase().replace(/_/g, '-') : null);
export function stageFromParam(v: string | null | undefined): StageCode | null {
  const code = (v ?? '').toUpperCase().replace(/-/g, '_');
  return (['IDEA', 'RESEARCH', 'DEVELOPMENT', 'TESTING', 'LAUNCH_READY', 'LAUNCHED'] as const).find((c) => c === code) ?? null;
}
