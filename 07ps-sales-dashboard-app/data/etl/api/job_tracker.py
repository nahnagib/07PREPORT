"""In-memory ETL job tracker: spawns one ETL platform job (`python -m etl_platform.run <job>`, see
data/etl/src/etl_platform/run.py and docs/ETL.md) as a subprocess per run and tracks its status/log lines for
app.py's routes to poll. The legacy writer (`python -m sales_pipeline.main`) is no longer started from here: after
the 2026-10 rebuild its tables no longer exist (they are zz_legacy_* until migration 0035 (manual retire)).

No persistence - state is lost if this Flask process restarts. That's an accepted MVP limitation
(see data/etl/api/README or the deployment docs): the subprocess is a child of this process, so it
dies with it too - there's never an orphaned pipeline run left running with nothing tracking it.

Only one job may be active at a time (mirrors the Node-side `hasActiveEtlRun()` guard in
backend/src/etl/queue/etlQueue.ts - this is defense-in-depth, not the only place that's enforced).
"""
from __future__ import annotations

import os
import subprocess
import threading
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

# data/etl/ - the subprocess's cwd, matching pythonRunner.ts's previous `cwd: config.pythonDir`.
ETL_ROOT = Path(__file__).resolve().parent.parent

TERMINAL_STATUSES = {"completed", "failed", "cancelled"}


@dataclass
class LogLine:
    index: int
    stream: str  # "stdout" | "stderr"
    text: str


@dataclass
class Job:
    job_id: str
    load_mode: str
    output_mode: str
    fast: bool
    extra_args: List[str]
    label: Optional[str]
    # the platform job (main, full_all, finance_receivables, ...); empty = derived from load_mode
    job_name: str = ""
    status: str = "pending"  # pending -> running -> completed | failed | cancelled
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    exit_code: Optional[int] = None
    cancel_requested: bool = False
    process: Optional[subprocess.Popen] = None
    _logs: List[LogLine] = field(default_factory=list)
    _logs_lock: threading.Lock = field(default_factory=threading.Lock)

    def duration_ms(self) -> Optional[int]:
        if self.started_at and self.finished_at:
            return int((self.finished_at - self.started_at).total_seconds() * 1000)
        return None

    def append_line(self, stream: str, text: str) -> None:
        with self._logs_lock:
            self._logs.append(LogLine(index=len(self._logs), stream=stream, text=text))

    def lines_after(self, after: int) -> List[LogLine]:
        with self._logs_lock:
            return list(self._logs[after:])

    def line_count(self) -> int:
        with self._logs_lock:
            return len(self._logs)

    def to_status_dict(self, after: int = 0) -> dict:
        lines = self.lines_after(after)
        return {
            "jobId": self.job_id,
            "job": self.job_name or LOAD_MODE_JOBS.get(self.load_mode, "full_all"),
            "status": self.status,
            "loadMode": self.load_mode,
            "outputMode": self.output_mode,
            "label": self.label,
            "startedAt": self.started_at.isoformat() if self.started_at else None,
            "finishedAt": self.finished_at.isoformat() if self.finished_at else None,
            "exitCode": self.exit_code,
            "durationMs": self.duration_ms(),
            "logLineCount": self.line_count(),
            "lines": [{"index": l.index, "stream": l.stream, "text": l.text} for l in lines],
        }


def _pump(stream, job: Job, stream_name: str) -> None:
    for raw_line in iter(stream.readline, ""):
        job.append_line(stream_name, raw_line.rstrip("\n"))
    stream.close()


LOAD_MODE_JOBS = {"incremental": "main", "full": "full_all"}  # callers that send only loadMode


def platform_job_name(job: Job) -> str:
    return job.job_name or LOAD_MODE_JOBS.get(job.load_mode, "full_all")


def platform_command(job: Job, python_bin: str) -> List[str]:
    """The ETL platform CLI for one run. loadMode/outputMode/fast are kept on the Job for the status payload only."""
    args = [python_bin, "-m", "etl_platform.run", platform_job_name(job), "--trigger-source", job.label or "api"]
    if job.extra_args:
        args.extend(job.extra_args)
    return args


def _run_job(job: Job, python_bin: str) -> None:
    args = platform_command(job, python_bin)

    job.status = "running"
    job.started_at = datetime.now(timezone.utc)

    try:
        proc = subprocess.Popen(
            args,
            cwd=str(ETL_ROOT),
            # The job label ("scheduled-incremental", "manual", ...) becomes etl_run_log.trigger_source.
            env={**os.environ, "ETL_TRIGGER_SOURCE": job.label or "api"},
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
    except Exception as exc:  # noqa: BLE001 - report, don't silently fix: surface it on the job
        job.append_line("stderr", f"Failed to start pipeline subprocess: {exc}")
        job.exit_code = -1
        job.finished_at = datetime.now(timezone.utc)
        job.status = "failed"
        return

    job.process = proc
    if job.cancel_requested:
        # Cancel arrived between job creation and the subprocess actually starting - close that
        # race by checking once immediately after Popen succeeds.
        proc.terminate()

    stdout_thread = threading.Thread(target=_pump, args=(proc.stdout, job, "stdout"), daemon=True)
    stderr_thread = threading.Thread(target=_pump, args=(proc.stderr, job, "stderr"), daemon=True)
    stdout_thread.start()
    stderr_thread.start()

    exit_code = proc.wait()
    stdout_thread.join()
    stderr_thread.join()

    job.exit_code = exit_code
    job.finished_at = datetime.now(timezone.utc)
    job.status = "cancelled" if job.cancel_requested else ("completed" if exit_code == 0 else "failed")


# Platform jobs that run in the "long" lane: the sales build from the Odoo mirror (minutes) runs next to the jobs of the
# main lane (the 30-minute refresh, the sales / full runs) -- the backend's second queue (etl-long) sends it. Two jobs of
# the same lane never run together; what each job may write is guarded by the platform's per-module MySQL locks.
LONG_LANE_JOBS = frozenset({"sales_build"})


def lane_for(job_name: Optional[str]) -> str:
    return "long" if job_name in LONG_LANE_JOBS else "main"


class JobTracker:
    def __init__(self) -> None:
        self._jobs: Dict[str, Job] = {}
        self._active_job_ids: Dict[str, Optional[str]] = {"main": None, "long": None}
        self._lock = threading.Lock()

    def active_job(self, lane: Optional[str] = None) -> Optional[Job]:
        """The active job of ``lane``, or of any lane when None (input uploads wait for every run)."""
        with self._lock:
            return self._active_job_locked(lane)

    def _active_job_locked(self, lane: Optional[str] = None) -> Optional[Job]:
        """Same as active_job(), but assumes self._lock is already held -- self._lock is a plain
        (non-reentrant) Lock, so callers already inside a `with self._lock:` block (e.g. start())
        must call this instead of active_job() to avoid deadlocking on themselves."""
        for name in ([lane] if lane else list(self._active_job_ids)):
            job_id = self._active_job_ids.get(name)
            job = self._jobs.get(job_id) if job_id else None
            if job is not None and job.status not in TERMINAL_STATUSES:
                return job
        return None

    def get(self, job_id: str) -> Optional[Job]:
        with self._lock:
            return self._jobs.get(job_id)

    def start(
        self,
        load_mode: str,
        output_mode: str,
        fast: bool,
        extra_args: List[str],
        label: Optional[str],
        python_bin: str,
        job_name: Optional[str] = None,
    ) -> Job:
        lane = lane_for(job_name)
        with self._lock:
            if self._active_job_locked(lane) is not None:
                raise RuntimeError("A run is already active")
            job_id = str(uuid.uuid4())
            job = Job(
                job_id=job_id,
                job_name=job_name or "",
                load_mode=load_mode,
                output_mode=output_mode,
                fast=fast,
                extra_args=list(extra_args or []),
                label=label,
            )
            self._jobs[job_id] = job
            self._active_job_ids[lane] = job_id

        thread = threading.Thread(target=_run_job, args=(job, python_bin), daemon=True)
        thread.start()
        return job

    def cancel(self, job_id: str) -> Job:
        job = self.get(job_id)
        if job is None:
            raise KeyError(job_id)
        if job.status in TERMINAL_STATUSES:
            raise ValueError(job.status)
        job.cancel_requested = True
        if job.process is not None:
            job.process.terminate()
        return job

    def force_reset(self) -> Optional[Job]:
        """Admin override for a stuck "active job" slot -- the Python-side mirror of Node's
        forceResetActiveEtlRuns (backend/src/etl/services/etlRunTracker.ts). Node's own reset only
        ever cleared its own etl_job_runs rows and BullMQ job; it had no way to reach this process's
        in-memory tracker, so if THIS was what was actually stuck (e.g. a subprocess wedged on
        something that never returns, or a request that died between starting the thread and this
        process being told about it), the Node-side reset alone freed nothing here and the very
        next enqueued run would immediately 409 against this tracker again. Terminates the tracked
        subprocess if it's still alive and immediately frees the "only one job active" slot -- does
        not wait for _run_job's background thread to notice the process exited on its own, since an
        admin invoking this wants the block gone now, not after that thread's next poll.
        """
        with self._lock:
            first: Optional[Job] = None
            for lane in list(self._active_job_ids):  # every lane: the admin wants every block gone
                job = self._active_job_locked(lane)
                self._active_job_ids[lane] = None
                if job is None:
                    continue
                job.cancel_requested = True
                if job.process is not None and job.process.poll() is None:
                    try:
                        job.process.terminate()
                    except Exception:  # noqa: BLE001 - best effort; tracker state is cleared below regardless
                        pass
                if job.status not in TERMINAL_STATUSES:
                    job.status = "cancelled"
                    job.finished_at = datetime.now(timezone.utc)
                first = first or job
            return first


# Module-level singleton - one Flask process, one tracker: one run at a time per lane, matching the two BullMQ queues
# (etl and etl-long, each concurrency 1).
tracker = JobTracker()
