import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { EtlInputFilesCard } from '../EtlInputFilesCard';
import type { EtlInputFileSlot, EtlInputFilesResponse } from '../../lib/api';

const api = vi.hoisted(() => ({ getEtlInputFiles: vi.fn(), replaceEtlInputFile: vi.fn() }));
vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock('../../lib/AuthProvider', () => ({ useAuth: () => ({ token: 't' }) }));
vi.mock('../../lib/api', async (orig) => ({ ...(await orig<typeof import('../../lib/api')>()), adminApi: api }));
afterEach(cleanup);

const NAMES = ['sales_targets.xlsx', 'SalesTeam.xlsx', 'OffDays.xlsx', 'BlockedCustomers.xlsx', 'ProductExclusions.xlsx'];

function slot(name: string, extra: Partial<EtlInputFileSlot> = {}): EtlInputFileSlot {
  return {
    name, required: true, feeds: 'x', exists: true, size_bytes: 1024, modified: '2026-11-22T09:00:00+00:00', replaceable: true,
    source: 'input_folder', sheets: [], recent_backups: [], lastUpload: null, ...extra,
  };
}

describe('EtlInputFilesCard', () => {
  it('every input file has Upload / Replace and Check file; Last uploaded by shows the version the ETL reads', async () => {
    const data: EtlInputFilesResponse = {
      input_dir: '/etl/input', backup_dir: '/etl/input_backups', max_bytes: 5242880, read_only: true, upload_dir: '/etl/input_admin',
      files: NAMES.map((n) =>
        n === 'OffDays.xlsx'
          ? slot(n, { source: 'admin_upload', lastUpload: { at: '2026-11-22T10:00:00Z', byUserId: 7, byName: 'Admin User' } })
          : slot(n),
      ),
    };
    api.getEtlInputFiles.mockResolvedValue(data);
    render(<EtlInputFilesCard etlRunActive={false} nextFullRun={null} />);

    const rows = await screen.findAllByRole('row');
    const body = rows.slice(1).filter((r) => NAMES.some((n) => within(r).queryByText(n)));
    expect(body).toHaveLength(5);
    for (const row of body) {
      expect(within(row).getByRole('button', { name: 'Upload / Replace' })).toBeTruthy();
      expect(within(row).getByRole('button', { name: 'Check file' })).toBeTruthy();
    }
    const offdays = body.find((r) => within(r).queryByText('OffDays.xlsx'))!;
    expect(within(offdays).getByText(/Admin User/)).toBeTruthy();
    const team = body.find((r) => within(r).queryByText('SalesTeam.xlsx'))!;
    expect(within(team).getByText('Server file')).toBeTruthy();
    expect(screen.getByRole('note').textContent).toMatch(/replace any input file here.*backup.*next Full refresh/s);
  });
});
