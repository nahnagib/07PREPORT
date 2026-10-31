'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { APP_TIMEZONE, formatDateTime as formatDateTimeShared, formatDate, DISPLAY_LOCALE } from '../../../lib/format';
import { Button, Card, ConfirmDialog, DataTable, EmptyState, ErrorState, LoadingSkeleton, DateField as SharedDateField, type Column } from '@07ps/ui';
import { AdminLayout } from '../../../components/AdminLayout';
import { AdminOnlyGuard } from '../../../components/AuthGuard';
import { useFilterState } from '../../../components/FilterProvider';
import { EtlLogPanel } from '../../../components/EtlLogPanel';
import { EtlInputFilesCard } from '../../../components/EtlInputFilesCard';
import { useAuth } from '../../../lib/AuthProvider';
import {
  adminApi,
  ApiError,
  EtlJobRun,
  EtlMode,
  EtlStartMode,
  EtlPreflightResponse,
  EtlRunStatus,
  EtlRunStep,
  EtlSchedulerConfigResponse,
  EtlShadowCompareResponse,
  EtlStatusResponse,
} from '../../../lib/api';

const POLL_INTERVAL_MS = 5000;

/**
 * Admin-role-only, full stop -- not gated by the customizable pages/role_permissions system every
 * other admin page uses (see backend's requireAdminRole). Checked here directly against
 * user.role.name rather than canView(), so it stays hidden/blocked even if the vestigial
 * `admin_etl` permission is ever granted to a non-Admin role.
 */
export default function AdminEtlControlPage() {
  return (
    <AdminOnlyGuard>
      <AdminLayout>
        <EtlControlBody />
      </AdminLayout>
    </AdminOnlyGuard>
  );
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

type DisplayStatus = 'idle' | EtlRunStatus;

const STATUS_LABEL: Record<DisplayStatus, string> = {
  idle: 'Idle',
  queued: 'Queued',
  running: 'Running',
  success: 'Success',
  partial: 'Partial',
  failed: 'Failed',
  cancelled: 'Cancelled',
  skipped: 'Skipped',
};

const STATUS_COLOR_VAR: Record<DisplayStatus, string> = {
  idle: 'var(--ps-color-neutral-text)',
  queued: 'var(--ps-color-watch)',
  running: 'var(--ps-color-watch)',
  success: 'var(--ps-color-success)',
  partial: 'var(--ps-color-watch)',
  failed: 'var(--ps-color-alert)',
  cancelled: 'var(--ps-color-neutral-text)',
  skipped: 'var(--ps-color-neutral-text)',
}; // eslint-disable-line no-unused-vars

function StatusBadge({ status, large }: { status: DisplayStatus; large?: boolean }) {
  const color = STATUS_COLOR_VAR[status];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: large ? '6px 16px' : '2px 8px',
        borderRadius: 999,
        fontSize: large ? 15 : 12,
        fontWeight: 700,
        color,
        border: `1.5px solid ${color}`,
        background: `color-mix(in srgb, ${color} 10%, transparent)`,
        whiteSpace: 'nowrap',
      }}
    >
      <span
        aria-hidden
        style={{
          width: large ? 10 : 8,
          height: large ? 10 : 8,
          borderRadius: '50%',
          background: color,
          flexShrink: 0,
          animation: status === 'running' ? 'ps-pulse 1.4s ease-in-out infinite' : undefined,
        }}
      />
      {STATUS_LABEL[status]}
    </span>
  );
}

function formatDuration(seconds: number | null): string {
  if (seconds === null || seconds === undefined) return '—';
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins === 0) return `${secs}s`;
  return `${mins}m ${secs}s`;
}

function formatElapsed(ms: number | null): string {
  if (ms === null) return '—';
  return formatDuration(Math.floor(ms / 1000));
}

/** Pinned to Libya time (IANA identifier, not a hardcoded offset) -- these are ETL run times for a
 * Libya-based operation, so they must read the same regardless of the viewer's own browser/OS
 * timezone. See frontend/src/lib/format.ts's formatTimestamp for the same rule applied elsewhere. */
function formatDateTime(value: string | null): string {
  if (!value) return '—';
  return formatDateTimeShared(value, APP_TIMEZONE, { withSeconds: true });
}

function formatCount(value: number | null): string {
  return value === null || value === undefined ? '—' : value.toLocaleString(DISPLAY_LOCALE);
}

const MODE_LABEL: Record<EtlMode, string> = {
  incremental: 'Sales Refresh',
  full: 'Full Refresh',
  finance: 'Receivables Snapshot',
  nps: 'NPS Score',
  refresh: '30-minute Refresh',
  sales_build: 'Sales build (from the Odoo mirror)',
  sql: 'SQL Mode (before 2026-10)',
  excel: 'Excel Mode (before 2026-10)',
};

/** The ETL steps of one run, in the order main / full_all runs them. */
const STEP_LABEL: Record<string, string> = {
  core_dims: 'Reference data',
  finance_receivables: 'Receivables snapshot',
  process_nps: 'NPS Score',
  sales_incremental: 'Sales (incremental)',
  sales_full: 'Sales (full)',
  sales_mirror: 'Sales mirror (Odoo)',
  sales_build: 'Sales build',
  sales_shadow_compare: 'Live vs shadow comparison',
};

function stepStatus(status: string): DisplayStatus {
  return status in STATUS_LABEL ? (status as DisplayStatus) : 'idle';
}

/** etl_run_log times are UTC wall-clock strings ("YYYY-MM-DD HH:mm:ss"). */
function formatUtcWallClock(value: string | null): string {
  return value ? formatDateTime(`${value.replace(' ', 'T')}Z`) : '—';
}

function StepChips({ steps }: { steps: EtlRunStep[] | undefined }) {
  if (!steps?.length) return <>—</>;
  return (
    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
      {steps.map((s) => (
        <span key={s.runId} title={`${STEP_LABEL[s.job] ?? s.job}: ${STATUS_LABEL[stepStatus(s.status)]}`}>
          <StatusBadge status={stepStatus(s.status)} />
        </span>
      ))}
    </span>
  );
}

function RunStepsTable({ steps }: { steps: EtlRunStep[] }) {
  const cell: React.CSSProperties = { padding: '6px 8px', borderBottom: '1px solid var(--ps-color-border)', textAlign: 'left', verticalAlign: 'top' };
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, marginBottom: 10 }}>
      <thead>
        <tr style={{ color: 'var(--ps-color-muted-text)' }}>
          <th style={cell}>Step</th>
          <th style={cell}>Status</th>
          <th style={cell}>Started</th>
          <th style={cell}>Duration</th>
          <th style={cell}>Loaded</th>
          <th style={cell}>Error</th>
        </tr>
      </thead>
      <tbody>
        {steps.map((s) => (
          <tr key={s.runId}>
            <td style={cell}>
              {STEP_LABEL[s.job] ?? s.job} <code style={{ color: 'var(--ps-color-muted-text)' }}>{s.job}</code>
            </td>
            <td style={cell}><StatusBadge status={stepStatus(s.status)} /></td>
            <td style={cell}>{formatUtcWallClock(s.startedAtUtc)}</td>
            <td style={cell}>{formatDuration(s.durationSeconds === null ? null : Math.round(s.durationSeconds))}</td>
            <td style={cell}>{formatCount(s.rowsLoaded)}</td>
            <td style={{ ...cell, maxWidth: 420, overflowWrap: 'anywhere' }}>{s.errorMessage ? s.errorMessage.split('\n')[0] : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const TRIGGER_LABEL: Record<string, string> = {
  scheduled: 'Scheduled',
  manual: 'Manual',
  api: 'API',
  development: 'Development (CLI)',
};

// ---------------------------------------------------------------------------
// Manual refresh mode definitions -- the confirmation copy from the spec, and the one place a
// future job type/mode would be added (this table, not a UI redesign).
// ---------------------------------------------------------------------------

const MANUAL_MODES: {
  mode: EtlStartMode;
  label: string;
  description: string;
  confirmMessage: string;
  variant?: 'primary' | 'danger';
}[] = [
  {
    mode: 'incremental',
    label: 'Sales Refresh',
    description:
      'The 3-hourly run (job main): reference data, then the sales refresh. Does not refresh Receivables and Collections. Recommended for normal operations.',
    confirmMessage: 'This process may take about 20-25 minutes. Do you want to continue?',
  },
  {
    mode: 'full',
    label: 'Full Refresh',
    description: "The 02:00 run (job full_all): reference data (customers, products, people, teams), today's receivables snapshot, then every sales table rebuilt.",
    confirmMessage: 'This process refreshes the reference data, the receivables snapshot and every sales table and may take about 25-40 minutes. Do you want to continue?',
    variant: 'danger',
  },
  {
    mode: 'finance',
    label: 'Receivables Snapshot',
    description:
      "The 15:00 run (job finance_receivables): today's receivables snapshot for Receivables and Collections, with the reference data first when it is older than 3 hours. Also taken by the 02:00 Full Refresh; a re-run replaces today's snapshot.",
    confirmMessage: 'This process takes about 3-10 minutes and replaces today\'s receivables snapshot. Do you want to continue?',
  },
  {
    mode: 'nps',
    label: 'NPS Score',
    description:
      "Job process_nps: reads the NPS developer's ratings database (SSH tunnel) and rebuilds the NPS Score page from a full reload of the ratings and the WhatsApp messages, with the reference data first when it is older than 3 hours. Scheduled once a night as the last step of the 02:00 Full Refresh; this button runs it now. Needs NPS_ENABLED=true in the ETL.",
    confirmMessage: 'This process takes about a minute and rebuilds the NPS Score data. Do you want to continue?',
  },
];

function EtlControlBody() {
  const { token } = useAuth();
  const [status, setStatus] = useState<EtlStatusResponse | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [schedulerConfig, setSchedulerConfig] = useState<EtlSchedulerConfigResponse | null>(null);
  const [confirmMode, setConfirmMode] = useState<EtlStartMode | null>(null);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  const [confirmForceReset, setConfirmForceReset] = useState(false);
  const [forceResetting, setForceResetting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [preflight, setPreflight] = useState<EtlPreflightResponse | null>(null);
  const [failedLog, setFailedLog] = useState<{ runId: number; lines: string[] } | null>(null);
  const { bumpDataVersion } = useFilterState();
  // Last seen { id, status } of the run being tracked, to notice the moment it finishes.
  const seenRun = useRef<{ id: number; status: EtlRunStatus } | null>(null);

  const loadStatus = useCallback(() => {
    if (!token) return;
    adminApi
      .getEtlStatus(token)
      .then((res) => {
        setStatus(res);
        setStatusError(null);
      })
      .catch((err) => setStatusError(err instanceof ApiError ? err.message : 'Failed to load ETL status.'))
      .finally(() => setLoadingStatus(false));
  }, [token]);

  useEffect(() => {
    loadStatus();
    const interval = setInterval(loadStatus, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [loadStatus]);

  const loadPreflight = useCallback(() => {
    if (!token) return;
    adminApi.getEtlPreflight(token).then(setPreflight).catch(() => setPreflight({ available: false, error: 'Could not reach the backend.' }));
  }, [token]);

  useEffect(() => {
    loadPreflight();
    const interval = setInterval(loadPreflight, 15_000);
    return () => clearInterval(interval);
  }, [loadPreflight]);

  useEffect(() => {
    if (!token) return;
    adminApi.getEtlSchedulerConfig(token).then(setSchedulerConfig).catch(() => {});
  }, [token]);

  const run = status?.run ?? null;
  // "Last Run Information" always describes the last run that FINISHED, never the in-flight one.
  const lastRun = status?.lastRun ?? null;

  // When the run we were watching flips queued/running -> success, warehouse data just changed:
  // reload every dashboard hook and the filter options (FilterProvider's dataVersion), and the
  // run history table here.
  useEffect(() => {
    const prev = seenRun.current;
    if (run) {
      if (prev && prev.id === run.id && (prev.status === 'queued' || prev.status === 'running') && (run.status === 'success' || run.status === 'partial')) {
        bumpDataVersion();
        setHistoryRefreshKey((k) => k + 1);
      }
      seenRun.current = { id: run.id, status: run.status };
    }
  }, [run, bumpDataVersion]);
  const isActive = run?.status === 'queued' || run?.status === 'running';
  // Defaults true while the first status load is still in flight, so the panel doesn't flash a
  // false "queue unavailable" warning before it actually knows.
  const queueAvailable = status?.queueAvailable ?? true;
  // Same reasoning as queueAvailable's default -- and only meaningful once the queue itself is up,
  // so a queue outage shows its own banner instead of stacking a second, redundant one.
  const workerAvailable = status?.workerAvailable ?? true;
  const displayStatus: DisplayStatus = run ? run.status : 'idle';
  // Only a definite "checked and not ready" blocks Run; an unreachable check (available: false) doesn't.
  const inputsBlocked = preflight?.available === true && preflight.ok === false;

  async function loadFailedLog(runId: number) {
    if (!token) return;
    try {
      const { lines } = await adminApi.getEtlRunLogLines(token, runId);
      setFailedLog({ runId, lines: lines.slice(-60) });
    } catch {
      setFailedLog({ runId, lines: ['(could not load the log for this run)'] });
    }
  }

  async function handleConfirmStart() {
    if (!token || !confirmMode) return;
    setStarting(true);
    setActionError(null);
    try {
      await adminApi.startEtlRun(token, confirmMode);
      setConfirmMode(null);
      loadStatus();
      setHistoryRefreshKey((k) => k + 1);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Failed to start ETL run.');
    } finally {
      setStarting(false);
    }
  }

  async function handleRetry() {
    if (!token) return;
    setRetrying(true);
    setActionError(null);
    try {
      await adminApi.retryEtlRun(token, lastRun?.id);
      loadStatus();
      setHistoryRefreshKey((k) => k + 1);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Failed to retry the ETL run.');
    } finally {
      setRetrying(false);
    }
  }

  async function handleCancel() {
    if (!token) return;
    setCancelling(true);
    setActionError(null);
    try {
      await adminApi.cancelEtlRun(token);
      loadStatus();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Failed to cancel ETL run.');
    } finally {
      setCancelling(false);
    }
  }

  async function handleForceReset() {
    if (!token) return;
    setForceResetting(true);
    setActionError(null);
    try {
      await adminApi.forceResetEtlLock(token);
      setConfirmForceReset(false);
      loadStatus();
      setHistoryRefreshKey((k) => k + 1);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Failed to reset the ETL lock.');
    } finally {
      setForceResetting(false);
    }
  }

  const activeModeConfig = confirmMode ? MANUAL_MODES.find((m) => m.mode === confirmMode) : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ps-space-4, 24px)' }}>
      <style>{`@keyframes ps-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }`}</style>

      {(status?.scheduleWarning || schedulerConfig?.scheduleWarning) && (
        <div
          role="alert"
          data-testid="etl-schedule-warning"
          style={{
            padding: '12px 16px',
            borderRadius: 8,
            background: 'var(--ps-color-alert-bg, #fdecea)',
            border: '2px solid var(--ps-color-alert-border, #f0868b)',
            color: 'var(--ps-color-alert)',
            fontSize: 14,
            lineHeight: 1.5,
          }}
        >
          <strong style={{ display: 'block', fontSize: 15 }}>No ETL schedule is running on this server</strong>
          {status?.scheduleWarning ?? schedulerConfig?.scheduleWarning}
        </div>
      )}
      {status?.salesBuild?.active && (
        <div
          role="status"
          data-testid="etl-sales-build-active"
          style={{
            padding: '10px 16px',
            borderRadius: 8,
            background: 'var(--ps-color-info-bg, #e8f1fb)',
            border: '1px solid var(--ps-color-info-border, #9cc3ea)',
            fontSize: 14,
          }}
        >
          <strong>
            {status.salesBuild.active.status === 'queued' ? 'Sales rebuild queued' : 'Sales rebuild in progress'}
            {' — started '}
            {formatDateTime(status.salesBuild.active.startedAt ?? status.salesBuild.active.queuedAt)}
          </strong>
          . The 30-minute refresh of the shared lists, receivables, collections and NPS keeps running meanwhile.
        </div>
      )}
      {statusError && <ErrorState message={statusError} onRetry={loadStatus} />}
      {actionError && <ErrorState message={actionError} onRetry={() => setActionError(null)} />}

      {/* --- Current Status --- */}
      <Card>
        {!queueAvailable && (
          <div
            style={{
              padding: 10,
              marginBottom: 16,
              borderRadius: 8,
              background: 'var(--ps-color-alert-bg, #fdecea)',
              border: '1px solid var(--ps-color-alert-border, #f0868b)',
              color: 'var(--ps-color-alert)',
              fontSize: 13,
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              flexWrap: 'wrap',
            }}
          >
            <span>
              Queue unavailable &mdash; the ETL queue backend (Redis) can&apos;t be reached right now. New runs can&apos;t be
              started until connectivity is restored.
            </span>
          </div>
        )}
        {queueAvailable && !workerAvailable && (
          <div
            style={{
              padding: 10,
              marginBottom: 16,
              borderRadius: 8,
              background: 'var(--ps-color-alert-bg, #fdecea)',
              border: '1px solid var(--ps-color-alert-border, #f0868b)',
              color: 'var(--ps-color-alert)',
              fontSize: 13,
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              flexWrap: 'wrap',
            }}
          >
            <span>
              No ETL worker is currently connected &mdash; the queue is up, but nothing is consuming it. A new run would
              sit &quot;Queued&quot; indefinitely. Check that the etl:worker process is running before starting a run.
            </span>
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--ps-color-muted-text)', marginBottom: 6 }}>
              Current Status
            </div>
            {loadingStatus ? <LoadingSkeleton variant="kpi" /> : <StatusBadge status={displayStatus} large />}
          </div>
          {isActive && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <div style={{ fontSize: 13, color: 'var(--ps-color-muted-text)' }}>
                Elapsed: <strong style={{ color: 'var(--ps-color-text)' }}>{formatElapsed(status?.elapsedMs ?? null)}</strong>
                {status?.progress?.stage && (
                  <>
                    {' '}
                    · Stage: <strong style={{ color: 'var(--ps-color-text)' }}>{status.progress.stage}</strong>
                    {status.progress.stageStatus ? ` (${status.progress.stageStatus})` : ''}
                  </>
                )}
              </div>
              <Button variant="danger" onClick={handleCancel} disabled={cancelling}>
                {cancelling ? 'Cancelling...' : 'Cancel Run'}
              </Button>
              <Button variant="secondary" onClick={() => setConfirmForceReset(true)}>
                Force Reset ETL Lock
              </Button>
            </div>
          )}
        </div>
        <p style={{ fontSize: 11.5, color: 'var(--ps-color-muted-text)', margin: '6px 0 0' }}>
          Cancel Run stops an in-progress job; use Force Reset ETL Lock instead if a run is stuck (e.g. still
          &quot;Queued&quot; with no progress -- Cancel has no effect until a worker has actually picked it up).
        </p>

        {isActive && run && token && (
          <div style={{ marginTop: 16 }}>
            <EtlLogPanel token={token} runId={run.id} live />
          </div>
        )}
      </Card>

      <ConfirmDialog
        open={confirmForceReset}
        title="Force Reset ETL Lock?"
        message="This marks every currently queued/running ETL run as Failed, freeing up the lock so a new run can start. Only do this if you've confirmed the queue is genuinely stuck (e.g. unreachable), not just a run that's legitimately still in progress. This is logged with your name and the time."
        confirmLabel="Force Reset"
        confirmVariant="danger"
        busy={forceResetting}
        onConfirm={handleForceReset}
        onCancel={() => setConfirmForceReset(false)}
      />

      {/* --- Last Run Info + Next Scheduled Run --- */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 'var(--ps-space-4, 24px)' }}>
        <Card>
          <h3 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 12px' }}>Last Run Information</h3>
          {lastRun ? (
            <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 16px', fontSize: 13.5 }}>
              <InfoRow label="Execution mode" value={MODE_LABEL[lastRun.mode] ?? lastRun.mode} />
              <InfoRow label="Trigger source" value={TRIGGER_LABEL[lastRun.trigger_source] ?? lastRun.trigger_source} />
              <InfoRow label="Started by" value={lastRun.triggered_by_user_name ?? '—'} />
              <InfoRow label="Status" value={<StatusBadge status={lastRun.status} />} />
              <InfoRow label="Started" value={formatDateTime(lastRun.started_at)} />
              <InfoRow label="Finished" value={formatDateTime(lastRun.finished_at)} />
              <InfoRow label="Duration" value={formatDuration(lastRun.duration_seconds)} />
              <InfoRow label="Records extracted" value={formatCount(lastRun.odoo_extract_count)} />
              <InfoRow label="Records loaded" value={formatCount(lastRun.db_loaded_count)} />
              <InfoRow label="Records inserted" value="Not tracked by pipeline" />
              <InfoRow label="Records updated" value="Not tracked by pipeline" />
              <InfoRow label="Records skipped" value="Not tracked by pipeline" />
              <InfoRow label="Errors" value={lastRun.error_message ? summarizeError(lastRun.error_message) : 'None'} />
            </dl>
          ) : (
            <EmptyState message="No ETL runs recorded yet." />
          )}
          {lastRun && !isActive && lastRun.status === 'partial' && (
            <div
              style={{
                marginTop: 14,
                padding: 10,
                borderRadius: 8,
                background: 'color-mix(in srgb, var(--ps-color-watch) 10%, transparent)',
                border: '1px solid var(--ps-color-watch)',
                fontSize: 13,
              }}
            >
              <strong style={{ color: 'var(--ps-color-watch)' }}>The last run finished partially.</strong> The other steps
              loaded and kept their data; the failed step is tried again by the next scheduled run, or now with Receivables
              Snapshot.
              {lastRun.error_message && <div style={{ marginTop: 6 }}>{summarizeError(lastRun.error_message)}</div>}
            </div>
          )}
          {lastRun && !isActive && lastRun.status === 'skipped' && (
            <div style={{ marginTop: 14, fontSize: 13, color: 'var(--ps-color-muted-text)' }}>
              The last trigger was skipped: another ETL run was already running. Nothing was written.
            </div>
          )}
          {lastRun && !isActive && (lastRun.status === 'failed' || lastRun.status === 'cancelled') && (
            <div
              style={{
                marginTop: 14,
                padding: 10,
                borderRadius: 8,
                background: 'var(--ps-color-alert-bg, #fdecea)',
                border: '1px solid var(--ps-color-alert-border, #f0868b)',
                color: 'var(--ps-color-alert)',
                fontSize: 13,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                flexWrap: 'wrap',
              }}
            >
              <span>
                {lastRun.status === 'failed' ? 'The last run failed.' : 'The last run was cancelled.'} Re-running is safe: each
                table load replaces its own window, so nothing is duplicated.
              </span>
              <Button variant="secondary" onClick={handleRetry} disabled={retrying || !queueAvailable || !workerAvailable || inputsBlocked}>
                {retrying ? 'Retrying...' : 'Retry Run'}
              </Button>
            </div>
          )}
          {lastRun && !isActive && lastRun.status === 'failed' && lastRun.error_message && (
            <div style={{ marginTop: 10, fontSize: 13 }}>
              <strong style={{ color: 'var(--ps-color-alert)' }}>Why it failed:</strong> {summarizeError(lastRun.error_message)}
              <details style={{ marginTop: 6 }}>
                <summary style={{ cursor: 'pointer', color: 'var(--ps-color-muted-text)' }}>Full error output</summary>
                <pre style={PRE_STYLE}>{lastRun.error_message}</pre>
              </details>
              <div style={{ marginTop: 6 }}>
                <Button variant="secondary" onClick={() => loadFailedLog(lastRun.id)}>
                  {failedLog?.runId === lastRun.id ? 'Reload last log lines' : 'Show last log lines'}
                </Button>
                {failedLog?.runId === lastRun.id && <pre style={PRE_STYLE}>{failedLog.lines.join('\n') || '(no log lines were kept for this run)'}</pre>}
              </div>
            </div>
          )}
        </Card>

        <Card>
          <h3 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 12px' }}>Next Scheduled Run</h3>
          <dl style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 12, fontSize: 13.5 }}>
            {status?.schedulerEnabled === false && (
              <p style={{ margin: 0, color: 'var(--ps-color-muted-text)' }}>
                No schedule runs on this machine (ETL_SCHEDULER_ENABLED is off): only the production server refreshes the data.
              </p>
            )}
            <InfoRow label="Next 30-minute Refresh" value={formatDateTime(status?.nextRefreshRun ?? null)} stacked />
            <InfoRow label="Next Sales Refresh" value={formatDateTime(status?.nextIncrementalRun ?? null)} stacked />
            <InfoRow label="Next Full Refresh" value={formatDateTime(status?.nextFullRun ?? null)} stacked />
            <InfoRow label="Next Receivables Snapshot" value={formatDateTime(status?.nextFinanceRun ?? null)} stacked />
            <InfoRow label="Next NPS Score refresh" value={formatDateTime(status?.nextNpsRun ?? null)} stacked />
            <InfoRow
              label="Next sales build (from the Odoo mirror)"
              value={formatDateTime(schedulerConfig?.salesBuild?.nextRun ?? null)}
              stacked
            />
            {status?.salesBuild?.last && (
              <InfoRow
                label="Last sales build"
                value={`${STATUS_LABEL[stepStatus(status.salesBuild.last.status)] ?? status.salesBuild.last.status} · ${formatDateTime(
                  status.salesBuild.last.finishedAt,
                )}${status.salesBuild.last.durationSeconds !== null ? ` · ${status.salesBuild.last.durationSeconds} s` : ''}`}
                stacked
              />
            )}
          </dl>
        </Card>
      </div>

      {/* --- Phase B: live vs shadow comparison (ETL_SALES_MODE=shadow) --- */}
      <ShadowCompareCard token={token} />

      {/* --- Input files preflight --- */}
      <PreflightCard preflight={preflight} onRecheck={loadPreflight} />

      {/* --- Replace input files (does not start a run) --- */}
      <EtlInputFilesCard etlRunActive={isActive} nextFullRun={status?.nextFullRun ?? null} />

      {/* --- Manual Refresh --- */}
      <Card>
        <h3 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 4px' }}>Manual Refresh</h3>
        <p style={{ fontSize: 12.5, color: 'var(--ps-color-muted-text)', margin: '0 0 16px' }}>
          Job type: <strong>Odoo Sales &amp; CRM Sync</strong>
        </p>
        {!queueAvailable ? (
          <div
            style={{
              padding: 10,
              marginBottom: 16,
              borderRadius: 8,
              background: 'var(--ps-color-alert-bg, #fdecea)',
              border: '1px solid var(--ps-color-alert-border, #f0868b)',
              color: 'var(--ps-color-alert)',
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            Queue unavailable &mdash; cannot start a new run until the queue backend is reachable again.
          </div>
        ) : !workerAvailable ? (
          <div
            style={{
              padding: 10,
              marginBottom: 16,
              borderRadius: 8,
              background: 'var(--ps-color-alert-bg, #fdecea)',
              border: '1px solid var(--ps-color-alert-border, #f0868b)',
              color: 'var(--ps-color-alert)',
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            No ETL worker is connected &mdash; cannot start a new run until the etl:worker process is back up.
          </div>
        ) : (
          isActive && (
            <div
              style={{
                padding: 10,
                marginBottom: 16,
                borderRadius: 8,
                background: 'var(--ps-color-watch-bg)',
                border: '1px solid var(--ps-color-watch-border)',
                color: 'var(--ps-color-watch)',
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              An ETL process is already running.
            </div>
          )
        )}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
          {MANUAL_MODES.map((m) => (
            <div
              key={m.mode}
              style={{
                border: '1px solid var(--ps-color-border)',
                borderRadius: 10,
                padding: 14,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <strong style={{ fontSize: 14 }}>{m.label}</strong>
              <p style={{ fontSize: 12.5, color: 'var(--ps-color-muted-text)', margin: 0, flex: 1 }}>{m.description}</p>
              <Button
                variant={m.variant ?? 'secondary'}
                disabled={isActive || !queueAvailable || !workerAvailable || inputsBlocked}
                onClick={() => setConfirmMode(m.mode)}
              >
                Run
              </Button>
            </div>
          ))}
        </div>
      </Card>

      <ConfirmDialog
        open={confirmMode !== null}
        title={activeModeConfig ? `Start ${activeModeConfig.label}?` : ''}
        message={activeModeConfig?.confirmMessage ?? ''}
        confirmLabel="Run"
        confirmVariant={activeModeConfig?.variant}
        busy={starting}
        onConfirm={handleConfirmStart}
        onCancel={() => setConfirmMode(null)}
      />

      {/* --- Scheduler Settings --- */}
      <Card>
        <h3 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 12px' }}>Scheduler Settings</h3>
        {schedulerConfig ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16, fontSize: 13.5 }}>
            {schedulerConfig.refresh && (
              <div>
                <strong>30-minute Refresh</strong>
                <p style={{ margin: '4px 0 0', color: 'var(--ps-color-muted-text)' }}>
                  {schedulerConfig.refresh.enabled ? (
                    <>
                      Cron: <code>{schedulerConfig.refresh.cron}</code>
                      <br />
                      Next run: {formatDateTime(schedulerConfig.refresh.nextRun)}
                    </>
                  ) : (
                    'Disabled'
                  )}
                </p>
              </div>
            )}
            <div>
              <strong>Sales Refresh</strong>
              <p style={{ margin: '4px 0 0', color: 'var(--ps-color-muted-text)' }}>
                {schedulerConfig.incremental.enabled ? (
                  <>
                    Cron: <code>{schedulerConfig.incremental.cron}</code>
                    <br />
                    Next run: {formatDateTime(schedulerConfig.incremental.nextRun)}
                  </>
                ) : (
                  'Disabled'
                )}
              </p>
            </div>
            <div>
              <strong>Full Refresh</strong>
              <p style={{ margin: '4px 0 0', color: 'var(--ps-color-muted-text)' }}>
                {schedulerConfig.full.enabled ? (
                  <>
                    Cron: <code>{schedulerConfig.full.cron}</code>
                    <br />
                    Next run: {formatDateTime(schedulerConfig.full.nextRun)}
                  </>
                ) : (
                  'Disabled'
                )}
              </p>
            </div>
            {schedulerConfig.finance && (
              <div>
                <strong>Receivables Snapshot</strong>
                <p style={{ margin: '4px 0 0', color: 'var(--ps-color-muted-text)' }}>
                  {schedulerConfig.finance.enabled ? (
                    <>
                      Cron: <code>{schedulerConfig.finance.cron}</code>
                      <br />
                      Next run: {formatDateTime(schedulerConfig.finance.nextRun)}
                    </>
                  ) : (
                    'Disabled'
                  )}
                </p>
              </div>
            )}
            {schedulerConfig.nps && (
              <div>
                <strong>NPS Score</strong>
                <p style={{ margin: '4px 0 0', color: 'var(--ps-color-muted-text)' }}>
                  {schedulerConfig.nps.enabled ? (
                    <>
                      {schedulerConfig.nps.via === 'full_all' ? 'Last step of the nightly Full Refresh (full reload), once a night' : 'Once a night, full reload'}
                      <br />
                      Cron: <code>{schedulerConfig.nps.cron}</code>
                      <br />
                      Next run: {formatDateTime(schedulerConfig.nps.nextRun)}
                    </>
                  ) : (
                    'Disabled'
                  )}
                </p>
              </div>
            )}
          </div>
        ) : (
          <LoadingSkeleton variant="kpi" />
        )}
        <p style={{ fontSize: 12, color: 'var(--ps-color-muted-text)', margin: '16px 0 0' }}>
          {schedulerConfig?.schedulerEnabled === false && (
            <>
              <strong>No schedule runs on this machine</strong> (<code>ETL_SCHEDULER_ENABLED</code> is off): only the
              production server refreshes the data.{' '}
            </>
          )}
          Configured via <code>ETL_REFRESH_INTERVAL_MINUTES</code> / <code>ETL_SCHEDULE_INCREMENTAL_CRON</code> /{' '}
          <code>ETL_SCHEDULE_FULL_CRON</code> / <code>ETL_SCHEDULE_FINANCE_CRON</code> in <code>backend/.env</code>, read in{' '}
          {schedulerConfig?.timezone ?? 'Africa/Tripoli'} time. Change and recreate the backend to apply. 30-minute =
          reference data + receivables and collections + NPS; Sales = reference data + sales; Full = everything, sales
          rebuilt; Receivables Snapshot = receivables only (off: the 30-minute refresh covers it).
        </p>
      </Card>

      {/* --- Run History --- */}
      <RunHistorySection token={token} refreshKey={historyRefreshKey} />
    </div>
  );
}

function InfoRow({ label, value, stacked }: { label: string; value: React.ReactNode; stacked?: boolean }) {
  return (
    <div style={stacked ? {} : undefined}>
      <dt style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.3, color: 'var(--ps-color-muted-text)', marginBottom: 2 }}>
        {label}
      </dt>
      <dd style={{ margin: 0, color: 'var(--ps-color-text)' }}>{value}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Run History
// ---------------------------------------------------------------------------

function RunHistorySection({ token, refreshKey }: { token: string | null; refreshKey: number }) {
  const [rows, setRows] = useState<EtlJobRun[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<EtlRunStatus | ''>('');
  const [modeFilter, setModeFilter] = useState<EtlMode | ''>('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<EtlJobRun | null>(null);
  const pageSize = 25;

  const load = useCallback(() => {
    if (!token) return;
    setLoading(true);
    setError(null);
    adminApi
      .getEtlHistory(token, {
        status: statusFilter || undefined,
        mode: modeFilter || undefined,
        fromDate: fromDate || undefined,
        toDate: toDate || undefined,
        page,
        pageSize,
      })
      .then((res) => {
        setRows(res.rows);
        setTotal(res.total);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load run history.'))
      .finally(() => setLoading(false));
  }, [token, statusFilter, modeFilter, fromDate, toDate, page]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const columns: Column<EtlJobRun>[] = [
    { key: 'queued_at', header: 'Date', render: (r) => formatDateTime(r.queued_at) },
    { key: 'triggered_by_user_name', header: 'Started By', render: (r) => r.triggered_by_user_name ?? '—' },
    { key: 'mode', header: 'Mode', render: (r) => MODE_LABEL[r.mode] ?? r.mode },
    { key: 'trigger_source', header: 'Trigger', render: (r) => TRIGGER_LABEL[r.trigger_source] ?? r.trigger_source },
    { key: 'duration_seconds', header: 'Duration', render: (r) => formatDuration(r.duration_seconds) },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'steps', header: 'Steps', render: (r) => <StepChips steps={r.steps} /> },
    { key: 'odoo_extract_count', header: 'Extracted', render: (r) => formatCount(r.odoo_extract_count) },
    { key: 'db_loaded_count', header: 'Loaded', render: (r) => formatCount(r.db_loaded_count) },
    { key: 'error_message', header: 'Errors', render: (r) => (r.error_message ? r.error_message.split('\n')[0] : '—') },
  ];

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <Card>
      <h3 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 4px' }}>Run History</h3>
      <p style={{ fontSize: 12, color: 'var(--ps-color-muted-text)', margin: '0 0 16px' }}>
        Every scheduled and manually-triggered run (including from the CLI) appears here. Runs started with{' '}
        <code>--sync</code> from a terminal bypass the queue and are not tracked here. Steps shows the run&apos;s ETL steps
        (reference data, receivables snapshot, sales) in order. Click a row to see its steps and log.
      </p>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16, alignItems: 'flex-end' }}>
        <FilterSelect
          label="Status"
          value={statusFilter}
          onChange={(v) => {
            setStatusFilter(v as EtlRunStatus | '');
            setPage(1);
          }}
          options={[
            { value: '', label: 'All statuses' },
            { value: 'queued', label: 'Queued' },
            { value: 'running', label: 'Running' },
            { value: 'success', label: 'Success' },
            { value: 'partial', label: 'Partial' },
            { value: 'failed', label: 'Failed' },
            { value: 'cancelled', label: 'Cancelled' },
            { value: 'skipped', label: 'Skipped' },
          ]}
        />
        <FilterSelect
          label="Mode"
          value={modeFilter}
          onChange={(v) => {
            setModeFilter(v as EtlMode | '');
            setPage(1);
          }}
          options={[
            { value: '', label: 'All modes' },
            { value: 'incremental', label: 'Sales Refresh' },
            { value: 'full', label: 'Full Refresh' },
            { value: 'finance', label: 'Receivables Snapshot' },
            { value: 'nps', label: 'NPS Score' },
            { value: 'sql', label: 'SQL Mode (before 2026-10)' },
            { value: 'excel', label: 'Excel Mode (before 2026-10)' },
          ]}
        />
        <DateField label="From" value={fromDate} onChange={(v) => { setFromDate(v); setPage(1); }} />
        <DateField label="To" value={toDate} onChange={(v) => { setToDate(v); setPage(1); }} />
      </div>

      <div style={{ marginBottom: 8, fontSize: 13, color: 'var(--ps-color-muted-text)' }}>
        {total} run(s) · Page {page} of {totalPages}
      </div>

      {loading ? (
        <LoadingSkeleton variant="kpi" />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : rows.length === 0 ? (
        <EmptyState message="No ETL runs match these filters." />
      ) : (
        <>
          <DataTable columns={columns} rows={rows} getRowId={(r) => String(r.id)} onRowClick={setSelectedRun} />
          {selectedRun && token && (
            <div style={{ marginTop: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <span style={{ fontSize: 12.5, color: 'var(--ps-color-muted-text)' }}>
                  Log for run #{selectedRun.id} &middot; {MODE_LABEL[selectedRun.mode] ?? selectedRun.mode} &middot;{' '}
                  {formatDateTime(selectedRun.queued_at)}
                </span>
                <button
                  onClick={() => setSelectedRun(null)}
                  style={{ border: 'none', background: 'none', color: 'var(--ps-color-muted-text)', cursor: 'pointer', fontSize: 12.5 }}
                >
                  Close ✕
                </button>
              </div>
              {selectedRun.steps && selectedRun.steps.length > 0 && <RunStepsTable steps={selectedRun.steps} />}
              <EtlLogPanel token={token} runId={selectedRun.id} live={false} />
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid var(--ps-color-border)', background: 'var(--ps-color-surface)', cursor: page <= 1 ? 'not-allowed' : 'pointer' }}
            >
              Previous
            </button>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid var(--ps-color-border)', background: 'var(--ps-color-surface)', cursor: page >= totalPages ? 'not-allowed' : 'pointer' }}
            >
              Next
            </button>
          </div>
        </>
      )}
    </Card>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div style={{ minWidth: 180 }}>
      <label style={{ display: 'block', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--ps-color-muted-text)', marginBottom: 4 }}>
        {label}
      </label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--ps-color-border)', background: 'var(--ps-color-surface)', color: 'var(--ps-color-text)', fontSize: 14 }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function DateField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label style={{ display: 'block', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--ps-color-muted-text)', marginBottom: 4 }}>
        {label}
      </label>
      <SharedDateField
        value={value}
        onChange={onChange}
        aria-label={label}
        clearable
        style={{ padding: '7px 10px', minWidth: 150, borderRadius: 8, border: '1px solid var(--ps-color-border)', background: 'var(--ps-color-surface)', color: 'var(--ps-color-text)', fontSize: 14 }}
      />
    </div>
  );
}

const PRE_STYLE: React.CSSProperties = {
  margin: '6px 0 0',
  padding: 10,
  maxHeight: 260,
  overflow: 'auto',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  fontSize: 11.5,
  background: 'var(--ps-color-muted-bg)',
  border: '1px solid var(--ps-color-border)',
  borderRadius: 6,
};

/** The last error-looking line of a captured stderr tail (e.g. "FileNotFoundError: ..."), or its
 * last line -- the traceback above it is available under "Full error output". */
function summarizeError(message: string): string {
  const lines = message.split('\n').map((l) => l.trim()).filter(Boolean);
  const errorLine = [...lines].reverse().find((l) => /(Error|Exception)\b/.test(l));
  return errorLine ?? lines[lines.length - 1] ?? message;
}

function formatBytes(n: number | null): string {
  if (n === null) return '';
  return n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

const FILE_STATUS_TEXT: Record<string, string> = {
  ok: 'Found',
  missing: 'Missing',
  unreadable: 'Unreadable',
  invalid_xlsx: 'Not a valid .xlsx',
};

/** Shows what the ETL service sees in its input folder, before anyone clicks Run. */
/** The latest live-vs-shadow comparisons of the sales tables (sales_shadow_compare, after each 02:00 refresh in shadow
 * mode): MATCH means the 30-minute build from the Odoo mirror wrote exactly what the 02:00 rebuild from Odoo wrote. */
function ShadowCompareCard({ token }: { token: string | null }) {
  const [data, setData] = useState<EtlShadowCompareResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    const load = () =>
      adminApi
        .getEtlShadowCompare(token)
        .then((res) => {
          setData(res);
          setError(null);
        })
        .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load the shadow comparison.'));
    load();
    const interval = setInterval(load, 5 * 60_000);
    return () => clearInterval(interval);
  }, [token]);

  if (!data?.runs.length && !error) return null; // shadow mode never ran here: nothing to show
  const latest = data?.runs[0];
  const diffCells = (data?.cells ?? []).filter((c) => c.status === 'DIFF');
  const color = (ok: boolean) => (ok ? 'var(--ps-color-success, #1e7e34)' : 'var(--ps-color-alert, #c0392b)');
  return (
    <Card>
      <h3 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 4px' }}>Sales: live vs shadow (daily comparison)</h3>
      <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--ps-color-muted-text)' }}>
        After each 02:00 full refresh the live sales tables (rebuilt from Odoo) are compared row by row with the shadow copies the
        30-minute build wrote from the Odoo mirror.
      </p>
      {error && <ErrorState message={error} />}
      {latest && (
        <div data-testid="etl-shadow-compare" style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13.5 }}>
          <div>
            <strong style={{ color: color(latest.status === 'match') }}>{latest.status === 'match' ? 'MATCH' : latest.status.toUpperCase()}</strong>
            {' · '}
            {formatDate(latest.asOfDate)} · {latest.tablesCompared} tables · rows live {formatCount(latest.rowsLive)}, shadow{' '}
            {formatCount(latest.rowsShadow)}
          </div>
          <div>
            Only in live: <strong>{formatCount(latest.rowsOnlyLive)}</strong> · only in shadow: <strong>{formatCount(latest.rowsOnlyShadow)}</strong>{' '}
            · different: <strong>{formatCount(latest.rowsDifferent)}</strong> · company × currency × month × salesperson cells:{' '}
            <strong>
              {formatCount(latest.cellsCompared - latest.cellsDiff)} / {formatCount(latest.cellsCompared)}
            </strong>{' '}
            match
            {latest.excludedOrders > 0 && ` · ${latest.excludedOrders} order(s) changed in Odoo during the comparison left out`}
          </div>
          {diffCells.length > 0 && (
            <table style={{ borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead>
                <tr>
                  {['Table', 'Cell', 'Measure', 'Live', 'Shadow', 'Diff'].map((h) => (
                    <th key={h} style={{ textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid var(--ps-color-border)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {diffCells.slice(0, 50).map((c) => (
                  <tr key={`${c.tableName}|${c.cellKey}|${c.measure}`}>
                    <td style={{ padding: '4px 8px' }}>{c.tableName}</td>
                    <td style={{ padding: '4px 8px' }}>{c.cellKey === '*' ? 'whole table' : c.cellKey}</td>
                    <td style={{ padding: '4px 8px' }}>{c.measure}</td>
                    <td style={{ padding: '4px 8px' }}>{c.liveValue ?? '—'}</td>
                    <td style={{ padding: '4px 8px' }}>{c.shadowValue ?? '—'}</td>
                    <td style={{ padding: '4px 8px' }}>{c.diff ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {data && data.runs.length > 1 && (
            <div style={{ color: 'var(--ps-color-muted-text)' }}>
              Earlier days:{' '}
              {data.runs.slice(1).map((r) => (
                <span key={r.compareUid} style={{ marginRight: 10, color: color(r.status === 'match') }}>
                  {formatDate(r.asOfDate)} {r.status === 'match' ? 'MATCH' : r.status.toUpperCase()}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function PreflightCard({ preflight, onRecheck }: { preflight: EtlPreflightResponse | null; onRecheck: () => void }) {
  const failing = preflight?.available === true && preflight.ok === false;
  return (
    <Card>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>Input Files Check</h3>
        <Button variant="secondary" onClick={onRecheck}>
          Re-check
        </Button>
      </div>
      {!preflight ? (
        <LoadingSkeleton variant="kpi" />
      ) : !preflight.available ? (
        <p style={{ fontSize: 13, color: 'var(--ps-color-watch)', margin: '10px 0 0' }}>
          Could not check the input files (the ETL service did not answer: {preflight.error}). Runs are not blocked, but will
          fail in their first step if the files are unreachable.
        </p>
      ) : (
        <>
          <p style={{ fontSize: 13, margin: '10px 0 8px', color: failing ? 'var(--ps-color-alert)' : 'var(--ps-color-success)', fontWeight: 600 }}>
            {failing ? 'Not ready — Run is disabled until this is fixed.' : 'Ready — all required input files were found and are readable.'}
          </p>
          <div style={{ fontSize: 12.5, color: 'var(--ps-color-muted-text)', marginBottom: 8 }}>
            Looked in <code>{preflight.input_dir}</code> ({preflight.source_var}={preflight.configured_value}
            {preflight.dir_exists === false ? ', directory does not exist' : ''}) on {preflight.platform}
          </div>
          <table style={{ fontSize: 12.5, borderCollapse: 'collapse', width: '100%' }}>
            <tbody>
              {(preflight.files ?? []).map((f) => (
                <tr key={f.name} style={{ borderTop: '1px solid var(--ps-color-border)' }}>
                  <td style={{ padding: '4px 8px 4px 0', fontWeight: 600 }}>{f.name}</td>
                  <td
                    style={{
                      padding: '4px 8px',
                      color: f.status === 'ok' ? 'var(--ps-color-success)' : f.required ? 'var(--ps-color-alert)' : 'var(--ps-color-watch)',
                    }}
                  >
                    {FILE_STATUS_TEXT[f.status] ?? f.status}
                    {f.required ? '' : ' (optional)'}
                  </td>
                  <td style={{ padding: '4px 0', color: 'var(--ps-color-muted-text)' }}>
                    {f.status === 'ok'
                      ? `${formatBytes(f.size_bytes)} · modified ${f.modified ? formatDate(f.modified, APP_TIMEZONE) : '—'}`
                      : f.detail}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {preflight.output && !preflight.output.writable && (
            <p style={{ fontSize: 12.5, color: 'var(--ps-color-alert)', margin: '8px 0 0' }}>
              Output folder not writable: {preflight.output.detail}
            </p>
          )}
          {failing && (
            <>
              {preflight.hint && <p style={{ fontSize: 13, margin: '10px 0 0' }}>{preflight.hint}</p>}
              <p style={{ fontSize: 12, color: 'var(--ps-color-muted-text)', margin: '6px 0 0' }}>
                {(preflight.listing ?? []).length > 0
                  ? `The folder currently contains: ${(preflight.listing ?? []).join(', ')}${preflight.listing_truncated ? ' …' : ''}`
                  : 'The folder is empty or not mounted.'}
              </p>
            </>
          )}
        </>
      )}
    </Card>
  );
}
