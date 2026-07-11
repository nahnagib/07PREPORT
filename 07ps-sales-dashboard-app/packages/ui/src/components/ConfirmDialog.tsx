'use client';
import React, { useEffect } from 'react';
import { Button } from './Button';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmVariant?: 'primary' | 'danger';
  onConfirm: () => void;
  onCancel: () => void;
  /** Disables both buttons and shows a busy confirm label -- for the moment between clicking
   * Confirm and the request actually resolving. */
  busy?: boolean;
}

/**
 * Shared confirmation modal -- the first real overlay dialog in @07ps/ui. Every
 * confirm-before-action need (ETL Control Center's "Start Incremental Refresh?", and any future
 * destructive-action confirmation) reuses this instead of a one-off implementation.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  confirmVariant = 'primary',
  onConfirm,
  onCancel,
  busy = false,
}: ConfirmDialogProps) {
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && !busy) onCancel();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, busy, onCancel]);

  if (!open) return null;

  return (
    <div
      role="presentation"
      onClick={() => !busy && onCancel()}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(0, 0, 0, 0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'var(--ps-space-3, 16px)',
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="ps-confirm-dialog-title"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 420,
          background: 'var(--ps-color-surface)',
          border: '1px solid var(--ps-color-border)',
          borderRadius: 'var(--ps-card-radius, 14px)',
          boxShadow: 'var(--ps-card-shadow)',
          padding: 'var(--ps-space-4, 24px)',
        }}
      >
        <h2
          id="ps-confirm-dialog-title"
          style={{ fontSize: 17, fontWeight: 700, margin: '0 0 8px', color: 'var(--ps-color-text)' }}
        >
          {title}
        </h2>
        <p style={{ fontSize: 14, color: 'var(--ps-color-muted-text)', margin: '0 0 24px', lineHeight: 1.5 }}>
          {message}
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button variant={confirmVariant} onClick={onConfirm} disabled={busy}>
            {busy ? 'Starting...' : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
