'use client';
import React, { useRef, useState } from 'react';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Client-side pre-check -- a convenience only; the server (ZIP signature, size, structure) is the authority. */
export function precheckFile(file: { name: string; size: number }): string | null {
  if (!/\.xlsx$/i.test(file.name)) return 'Only .xlsx files are accepted (not .xlsm, .xls or .csv).';
  if (file.size === 0) return 'The file is empty.';
  if (file.size > MAX_UPLOAD_BYTES) return 'The file is larger than the 10 MB limit.';
  return null;
}

export interface UploadDropzoneProps {
  disabled?: boolean;
  /** Progress 0-100 while uploading/validating; undefined when idle. */
  progress?: number;
  busyLabel?: string;
  notice?: string;
  onFile: (file: File) => void;
  onReject: (message: string) => void;
}

export function UploadDropzone({ disabled, progress, busyLabel, notice, onFile, onReject }: UploadDropzoneProps) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  function take(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    const problem = precheckFile(file);
    if (problem) onReject(problem);
    else onFile(file);
  }

  return (
    <div>
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        aria-label="Upload MARCOM workbook. Drop an .xlsx file here or press Enter to choose one."
        onClick={() => !disabled && input.current?.click()}
        onKeyDown={(e) => {
          if (!disabled && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); input.current?.click(); }
        }}
        onDragOver={(e) => { e.preventDefault(); if (!disabled) setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); if (!disabled) take(e.dataTransfer.files); }}
        style={{
          border: `2px dashed ${over ? 'var(--ps-color-accent)' : 'var(--ps-color-border)'}`,
          borderRadius: 12,
          padding: '32px 16px',
          textAlign: 'center',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.7 : 1,
          background: over ? 'var(--ps-color-surface-alt, var(--ps-color-surface))' : 'var(--ps-color-surface)',
          color: 'var(--ps-color-text)',
        }}
      >
        <input
          ref={input}
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          hidden
          data-testid="marcom-file-input"
          onChange={(e) => { take(e.target.files); e.target.value = ''; }}
        />
        {progress !== undefined ? (
          <div aria-live="polite">
            <div style={{ fontWeight: 600, marginBottom: 8 }}>{busyLabel ?? 'Validating…'} {progress}%</div>
            <div style={{ height: 8, borderRadius: 4, background: 'var(--ps-color-border)', overflow: 'hidden', maxWidth: 360, margin: '0 auto' }}>
              <div style={{ width: `${progress}%`, height: '100%', background: 'var(--ps-color-accent)', transition: 'width 0.2s' }} />
            </div>
          </div>
        ) : (
          <>
            <div style={{ fontWeight: 600 }}>Drag and drop the filled MARCOM template here</div>
            <div style={{ fontSize: 13, color: 'var(--ps-color-muted-text)', marginTop: 4 }}>or click to choose a file · .xlsx only · up to 10 MB</div>
          </>
        )}
      </div>
      {notice && (
        <div role="alert" style={{ marginTop: 8, fontSize: 13, color: 'var(--ps-color-alert)' }}>✖ {notice}</div>
      )}
    </div>
  );
}
