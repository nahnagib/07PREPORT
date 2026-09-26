'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { APP_TIMEZONE } from '../../../lib/format';
import { Button, Card, ConfirmDialog, DataTable, EmptyState, ErrorState, LoadingSkeleton, type Column } from '@07ps/ui';
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
  EtlPreflightResponse,
  EtlRunStatus,
  EtlSchedulerConfigResponse,
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
      <AdminLayout title="ETL Control Center">
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
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const STATUS_COLOR_VAR: Record<DisplayStatus, string> = {
  idle: 'var(--ps-color-neutral-text)',
  queued: 'var(--ps-color-watch)',
  running: 'var(--ps-color-watch)',
  success: 'var(--ps-color-success)',
  failed: 'var(--ps-color-alert)',
  cancelled: 'var(--ps-color-neutral-text)',
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
  return new Date(value).toLocaleString(undefined, { timeZone: APP_TIMEZONE });
}

function formatCount(value: number | null): string {
  return value === null || value === undefined ? '—' : value.toLocaleString();
}

const MODE_LABEL: Record<EtlMode, string> = {
  incremental: 'Incremental Refresh',
  full: 'Full Refresh',
  sql: 'SQL Mode',
  excel: 'Excel Mode',
};

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
  mode: EtlMode;
  label: string;
  description: string;
  confirmMessage: string;
  variant?: 'primary' | 'danger';
}[] = [
  {
    mode: 'incremental',
    label: 'Incremental Refresh',
    description: 'Fast synchronization. Updates only changed records. Recommended for normal operations.',
    confirmMessage: 'This process may take between 20 and 40 minutes. Do you want to continue?',
  },
  {
    mode: 'full',
    label: 'Full Refresh',
    description: 'Rebuilds the reporting database. Longer execution time. Use only when necessary.',
    confirmMessage: 'This process rebuilds the entire reporting database and may take 55-60 minutes. Do you want to continue?',
    variant: 'danger',
  },
  {
    mode: 'sql',
    label: 'SQL Mode',
    description: 'Performs a complete SQL synchronization with full validation.',
    confirmMessage: 'This process may take 30-60 minutes. Do you want to continue?',
  },
  {
    mode: 'excel',
    label: 'Excel Mode',
    description: 'Generates Excel outputs only. Does not update the reporting database.',
    confirmMessage: 'This generates an Excel export and does not update the reporting database. It may take 20-40 minutes. Do you want to continue?',
  },
];

function EtlControlBody() {
  const { token } = useAuth();
  const [status, setStatus] = useState<EtlStatusResponse | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [schedulerConfig, setSchedulerConfig] = useState<EtlSchedulerConfigResponse | null>(null);
  const [confirmMode, setConfirmMode] = useState<EtlMode | null>(null);
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
      if (prev && prev.id === run.id && (prev.status === 'queued' || prev.status === 'running') && run.status === 'success') {
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
            <InfoRow label="Next Incremental Refresh" value={formatDateTime(status?.nextIncrementalRun ?? null)} stacked />
            <InfoRow label="Next Full Refresh" value={formatDateTime(status?.nextFullRun ?? null)} stacked />
          </dl>
        </Card>
      </div>

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
            <div>
              <strong>Incremental Refresh</strong>
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
          </div>
        ) : (
          <LoadingSkeleton variant="kpi" />
        )}
        <p style={{ fontSize: 12, color: 'var(--ps-color-muted-text)', margin: '16px 0 0' }}>
          Configured via <code>ETL_SCHEDULE_INCREMENTAL_CRON</code> / <code>ETL_SCHEDULE_FULL_CRON</code> in{' '}
          <code>backend/.env</code>. Change and restart the backend to apply.
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
        <code>--sync</code> from a terminal bypass the queue and are not tracked here. Click a row to view its log.
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
            { value: 'failed', label: 'Failed' },
            { value: 'cancelled', label: 'Cancelled' },
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
            { value: 'incremental', label: 'Incremental Refresh' },
            { value: 'full', label: 'Full Refresh' },
            { value: 'sql', label: 'SQL Mode' },
            { value: 'excel', label: 'Excel Mode' },
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
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid var(--ps-color-border)', background: 'var(--ps-color-surface)', color: 'var(--ps-color-text)', fontSize: 14 }}
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
                      ? `${formatBytes(f.size_bytes)} · modified ${f.modified ? new Date(f.modified).toLocaleDateString(undefined, { timeZone: APP_TIMEZONE }) : '—'}`
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
