'use client';
import React, { useEffect, useRef, useState } from 'react';
import { API_BASE } from '../lib/api';

interface LogLine {
  ts: string | null;
  text: string;
}

type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'finished' | 'closed';

const RECONNECT_DELAY_MS = 3000;

/**
 * Terminal-style panel for the ETL Control Center: live output while a run is in progress, or the
 * static persisted log of a past run when opened from a Run History row (see EtlControlBody /
 * runId prop). `live` chooses which of those two modes this instance is in.
 *
 * Live mode deliberately does NOT use the native EventSource API for the SSE connection --
 * EventSource cannot send a custom Authorization header, and this app has no cookie-based session
 * to fall back on (every other endpoint uses a Bearer token, see lib/api.ts). `fetch` + a stream
 * reader gets the same one-directional server-push behavior while keeping the same auth as every
 * other admin call, at the cost of reconnection not being automatic -- handled here instead with a
 * simple retry loop, since the alternative (a query-string token) would leak the token into server
 * access logs.
 */
export function EtlLogPanel({
  token,
  runId,
  live,
}: {
  token: string;
  runId: number | null;
  live: boolean;
}) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  const [loadError, setLoadError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stoppedRef = useRef(false);

  useEffect(() => {
    containerRef.current?.scrollTo({ top: containerRef.current.scrollHeight });
  }, [lines]);

  useEffect(() => {
    setLines([]);
    setLoadError(null);
    stoppedRef.current = false;

    if (runId === null) {
      setConnectionState('closed');
      return () => {};
    }

    if (!live) {
      // Past-run mode: one plain fetch of whatever BullMQ still has persisted for that job.
      setConnectionState('connected');
      fetch(`${API_BASE}/admin/etl/runs/${runId}/log`, { headers: { Authorization: `Bearer ${token}` } })
        .then((res) => res.json())
        .then((data: { lines: string[] }) => {
          setLines(data.lines.map((text) => ({ ts: null, text })));
          setConnectionState('finished');
        })
        .catch((err) => setLoadError(err instanceof Error ? err.message : 'Failed to load run log.'));
      return () => {};
    }

    async function connect() {
      if (stoppedRef.current) return;
      setConnectionState((prev) => (prev === 'connected' ? prev : 'connecting'));
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const res = await fetch(`${API_BASE}/admin/etl/stream/${runId}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          throw new Error(`Stream request failed (${res.status})`);
        }
        setConnectionState('connected');

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let boundary = buffer.indexOf('\n\n');
          while (boundary !== -1) {
            const raw = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            boundary = buffer.indexOf('\n\n');

            if (!raw || raw.startsWith(':')) continue; // heartbeat comment, ignore
            let eventType = 'message';
            let dataStr = '';
            for (const line of raw.split('\n')) {
              if (line.startsWith('event:')) eventType = line.slice(6).trim();
              else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
            }
            if (!dataStr) continue;
            let data: unknown;
            try {
              data = JSON.parse(dataStr);
            } catch {
              continue;
            }

            if (eventType === 'log') {
              const entry = data as { line: string; ts: string };
              setLines((prev) => [...prev, { ts: entry.ts, text: entry.line }]);
            } else if (eventType === 'done') {
              stoppedRef.current = true;
              setConnectionState('finished');
            }
            // 'progress'/'status'/'queue-warning'/'error' events are informational for this panel
            // (the status badge elsewhere on the page already reflects run.status) -- only 'log'
            // and 'done' change what the terminal itself renders.
          }
        }

        if (!stoppedRef.current) {
          // Server ended the response without a 'done' event (queue hiccup, proxy timeout) --
          // reconnect rather than leaving the panel looking frozen with no explanation.
          scheduleReconnect();
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        scheduleReconnect();
      }
    }

    function scheduleReconnect() {
      if (stoppedRef.current) return;
      setConnectionState('reconnecting');
      reconnectTimerRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
    }

    void connect();

    return () => {
      stoppedRef.current = true;
      abortRef.current?.abort();
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    };
  }, [runId, live, token]);

  const statusLabel: Record<ConnectionState, string> = {
    connecting: 'Connecting…',
    connected: 'Live',
    reconnecting: 'Reconnecting…',
    finished: 'Run finished',
    closed: 'No run selected',
  };
  const statusColor: Record<ConnectionState, string> = {
    connecting: 'var(--ps-color-muted-text)',
    connected: 'var(--ps-color-success)',
    reconnecting: 'var(--ps-color-watch)',
    finished: 'var(--ps-color-muted-text)',
    closed: 'var(--ps-color-muted-text)',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {live && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: statusColor[connectionState] }}>
          <span
            aria-hidden
            style={{
              width: 7, height: 7, borderRadius: '50%', background: statusColor[connectionState], flexShrink: 0,
              animation: connectionState === 'connected' ? 'ps-pulse 1.4s ease-in-out infinite' : undefined,
            }}
          />
          {statusLabel[connectionState]}
        </div>
      )}
      <div
        ref={containerRef}
        style={{
          background: '#0b0f14',
          color: '#d6e2ea',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontSize: 12.5,
          lineHeight: 1.6,
          borderRadius: 8,
          border: '1px solid var(--ps-color-border)',
          padding: '10px 12px',
          // Was 320px -- with runPipelineJob.ts now persisting every line (not just a curated
          // significant-line subset), a full run's log can run well over a thousand lines; a taller
          // panel makes "the complete pipeline log output" actually reviewable without excessive
          // scrolling, while still being a fixed height + overflow (no virtualization needed at
          // this line count).
          height: 600,
          maxHeight: '70vh',
          overflowY: 'auto',
          whiteSpace: 'pre-wrap',
        }}
      >
        {loadError ? (
          <div style={{ color: '#f0868b' }}>{loadError}</div>
        ) : lines.length === 0 ? (
          <div style={{ color: '#5b6b78' }}>
            {runId === null ? 'No run selected.' : connectionState === 'connecting' ? 'Waiting for output…' : 'No log lines yet.'}
          </div>
        ) : (
          lines.map((l, i) => (
            <div key={i}>
              {l.ts && <span style={{ color: '#5b6b78' }}>[{new Date(l.ts).toLocaleTimeString('en-GB', { timeZone: 'Africa/Tripoli' })}] </span>}
              {l.text}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
