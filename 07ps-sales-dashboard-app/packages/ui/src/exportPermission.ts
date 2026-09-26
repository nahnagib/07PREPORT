import { createContext, useContext } from 'react';

/**
 * Export permission for everything in this package that produces a file (chart PNGs, table PDFs,
 * CSV/Excel). Two halves, both supplied by the host app:
 *
 *   - ExportPermissionContext: whether the current page allows Export. Components read it with
 *     useCanExport() and don't render their export buttons when it's false. Defaults to true so the
 *     package still works on its own.
 *   - an authorizer (setExportAuthorizer): every export function awaits authorizeExport() before
 *     building the file, and produces nothing unless it resolves true. The frontend's authorizer asks
 *     the backend (POST /exports/authorize), which is the real, server-side Export check -- hiding a
 *     button is only the UI half.
 */

export type ExportFormat = 'image' | 'pdf' | 'xlsx' | 'csv';

export const ExportPermissionContext = createContext<boolean>(true);

export function useCanExport(): boolean {
  return useContext(ExportPermissionContext);
}

type ExportAuthorizer = (format: ExportFormat) => Promise<boolean>;

let authorizer: ExportAuthorizer | null = null;

export function setExportAuthorizer(fn: ExportAuthorizer | null): void {
  authorizer = fn;
}

/** True when the export may proceed. No registered authorizer means no host-level rule (allowed). */
export async function authorizeExport(format: ExportFormat): Promise<boolean> {
  if (!authorizer) return true;
  try {
    return await authorizer(format);
  } catch {
    return false;
  }
}
