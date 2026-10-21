import React from 'react';
import { safeOdooUrl } from '../../lib/debt/view';

/**
 * A document code (WH/OUT/…, S00123) linked to its Odoo form in a new tab. The URL comes from the API (built from the
 * ODOO_URL setting with the record id and its company); without one the code is shown as plain text.
 */
export function OdooLink({ href, children }: { href: string | null | undefined; children: React.ReactNode }) {
  const url = href ? safeOdooUrl(href) : null;
  if (!url) return <span dir="auto">{children}</span>;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" dir="auto" title="Open in Odoo (new tab)" onClick={(e) => e.stopPropagation()}
      style={{ color: 'var(--ps-color-accent)', textDecoration: 'underline' }}>
      {children}
    </a>
  );
}
