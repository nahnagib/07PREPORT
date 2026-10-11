import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RemoveBatchDialog, removeConfirmed, type RemoveBatchDialogProps } from '../RemoveBatchDialog';
import type { BatchItem, RemovePreview } from '../../../lib/marcomApi';

afterEach(cleanup);

const batch: BatchItem = {
  batchId: 7, filename: 'MARCOM_Contribution_Data_Template.xlsx', fileHash: 'h', templateVersion: '1.0',
  uploadedBy: { id: 2, name: 'tester' }, uploadedAt: '2026-09-24T12:16:00.000Z', status: 'SUCCESS',
  period: { from: '2025-01', to: '2026-09', label: 'Jan 2025 to Sep 2026' },
  totals: { inserted: 142, updated: 0, unchanged: 0, examplesSkipped: 7 },
  canRollback: false, rolledBackAt: null, rolledBackBy: null, rollbackReason: null,
  canRemove: true, removedAt: null, removedBy: null, removeReason: null, errorMessage: null,
};
const preview: RemovePreview = {
  batch, canRemove: true, blockedReason: null,
  tables: [
    { id: 'spend', label: 'P1 MARCOM Spending', deleted: 27, deletedCurrent: 24,
      deletedSuperseded: [{ key: '2026|1|majaal', label: '2026-01 · Majaal', supersededBy: 8 }], handedOver: [], rearmed: [], relinked: [] },
    { id: 'web', label: 'P3 Website', deleted: 0, deletedCurrent: 0, deletedSuperseded: [], handedOver: [], rearmed: [], relinked: [] },
  ],
  totals: { deleted: 27, otherBatchRowsAffected: 0 },
  brands: { deleted: ['Brand A', 'Brand B', 'Core Brand'], kept: [{ name: 'Majaal', usedBy: [8] }] },
};

function setup(over: Partial<RemoveBatchDialogProps> = {}) {
  const onConfirm = vi.fn();
  render(<RemoveBatchDialog batch={batch} preview={preview} previewLoading={false} previewError={null} onRetryPreview={vi.fn()}
    busy={false} error={null} onConfirm={onConfirm} onCancel={vi.fn()} {...over} />);
  return { onConfirm, button: () => screen.getByRole('button', { name: 'Remove batch' }) };
}

describe('RemoveBatchDialog', () => {
  it('shows the batch and the impact: rows per sheet, replaced rows, brands deleted and kept', () => {
    setup();
    expect(screen.getByText(/Remove batch #7\?/)).toBeTruthy();
    expect(screen.getByText(/tester/)).toBeTruthy();
    expect(screen.getByText('P1 MARCOM Spending')).toBeTruthy();
    expect(screen.queryByText('P3 Website')).toBeNull(); // sheets with no change are not listed
    expect(screen.getByText(/1 row a later batch already replaced/)).toBeTruthy();
    expect(screen.getByText(/Brand A, Brand B, Core Brand/)).toBeTruthy();
    expect(screen.getByText(/Majaal \(still used by batch #8\)/)).toBeTruthy();
  });

  it('the red button stays disabled until a reason AND the typed confirmation are given', () => {
    const { onConfirm, button } = setup();
    expect((button() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Reason (required)'), { target: { value: 'test data uploaded by mistake' } });
    expect((button() as HTMLButtonElement).disabled).toBe(true); // no confirmation yet
    fireEvent.change(screen.getByLabelText(/Type the file name or REMOVE/), { target: { value: 'remove' } });
    expect((button() as HTMLButtonElement).disabled).toBe(true); // wrong case
    fireEvent.change(screen.getByLabelText(/Type the file name or REMOVE/), { target: { value: 'MARCOM_Contribution_Data_Template.xlsx' } });
    expect((button() as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(screen.getByLabelText('Reason (required)'), { target: { value: ' a ' } });
    expect((button() as HTMLButtonElement).disabled).toBe(true); // reason too short
    fireEvent.change(screen.getByLabelText('Reason (required)'), { target: { value: 'test data' } });
    fireEvent.click(button());
    expect(onConfirm).toHaveBeenCalledWith('test data');
  });

  it('cannot confirm while the preview loads, or when the batch cannot be removed', () => {
    setup({ preview: null, previewLoading: true });
    fireEvent.change(screen.getByLabelText(/Type the file name or REMOVE/), { target: { value: 'REMOVE' } });
    expect((screen.getByRole('button', { name: 'Remove batch' }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    setup({ preview: { ...preview, canRemove: false, blockedReason: 'Only successful batches can be removed (this one is removed).' } });
    expect(screen.getByRole('alert').textContent).toContain('Only successful batches');
    expect((screen.getByRole('button', { name: 'Remove batch' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('renders nothing without a target', () => {
    const { container } = render(<RemoveBatchDialog batch={null} preview={null} previewLoading={false} previewError={null} onRetryPreview={vi.fn()}
      busy={false} error={null} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('removeConfirmed', () => {
  it('accepts the exact file name or REMOVE, nothing else', () => {
    expect(removeConfirmed('REMOVE', 'a.xlsx')).toBe(true);
    expect(removeConfirmed(' a.xlsx ', 'a.xlsx')).toBe(true);
    expect(removeConfirmed('remove', 'a.xlsx')).toBe(false);
    expect(removeConfirmed('', '')).toBe(false);
    expect(removeConfirmed('A.xlsx', 'a.xlsx')).toBe(false);
  });
});
