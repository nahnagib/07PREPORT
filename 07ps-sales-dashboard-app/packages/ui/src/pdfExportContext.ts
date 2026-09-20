/**
 * Single source of truth for the "Filters applied" + "Exported by" metadata block every
 * client-side table PDF in this package carries (exportRowsAsPdf, exportPerformanceTablePdf,
 * DataGrid's Export as PDF). The host app registers a provider once (frontend's
 * PdfExportContextBridge, mounted in the root layout) that resolves the *current* filter state to
 * human-readable names and the signed-in user's email from the authenticated session -- so no page
 * builds this itself, and no export path can drift from another.
 *
 * (The whole-page "Export Report" PDF is generated server-side in backend/src/services/reportPdf.ts
 * and reads the email from the authenticated request there.)
 */

export interface PdfExportContext {
  /** One entry per active filter, already resolved to names, e.g. "Company: Majaal". */
  filterParts: string[];
  exportedByEmail?: string | null;
}

let contextProvider: (() => PdfExportContext) | null = null;

export function setPdfExportContextProvider(provider: (() => PdfExportContext) | null): void {
  contextProvider = provider;
}

export function getPdfExportContext(): PdfExportContext {
  return contextProvider ? contextProvider() : { filterParts: [], exportedByEmail: null };
}

export interface PdfMetaOverrides {
  /** Replaces the registered context's filter parts (rarely needed). */
  filterParts?: string[];
  /** Page-local filters the global context can't know about (e.g. a page-only Customer slicer),
   * appended after the global ones. */
  extraFilterParts?: string[];
  exportedByEmail?: string | null;
}

/** Appends the shared "Filters applied" list + "Exported by ... on <date/time>" line to a page
 * container. Callers place it on the first page of a multi-page export. */
export function appendPdfMetaBlock(container: HTMLElement, overrides: PdfMetaOverrides = {}): void {
  const ctx = getPdfExportContext();
  const filterParts = [...(overrides.filterParts ?? ctx.filterParts), ...(overrides.extraFilterParts ?? [])];
  const email = overrides.exportedByEmail ?? ctx.exportedByEmail;

  const heading = document.createElement('p');
  heading.textContent = 'Filters applied:';
  heading.style.fontSize = '11px';
  heading.style.fontWeight = 'bold';
  heading.style.color = '#374151';
  heading.style.margin = '0 0 4px 0';
  container.appendChild(heading);

  if (filterParts.length === 0) {
    const none = document.createElement('p');
    none.textContent = 'No filters applied.';
    none.style.fontSize = '11px';
    none.style.color = '#6b7280';
    none.style.margin = '0 0 8px 0';
    container.appendChild(none);
  } else {
    const list = document.createElement('ul');
    list.style.margin = '0 0 8px 0';
    list.style.paddingLeft = '18px';
    filterParts.forEach((part) => {
      const li = document.createElement('li');
      li.textContent = part;
      li.style.fontSize = '11px';
      li.style.color = '#6b7280';
      list.appendChild(li);
    });
    container.appendChild(list);
  }

  const exportedBy = document.createElement('p');
  exportedBy.textContent = `Exported by: ${email ?? 'Unknown user'} on ${new Date().toLocaleString()}`;
  exportedBy.style.fontSize = '11px';
  exportedBy.style.color = '#6b7280';
  exportedBy.style.margin = '0 0 20px 0';
  exportedBy.style.borderBottom = '1px solid #e5e7eb';
  exportedBy.style.paddingBottom = '10px';
  container.appendChild(exportedBy);
}
