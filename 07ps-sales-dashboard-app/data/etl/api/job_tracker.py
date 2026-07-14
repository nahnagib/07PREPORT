"""In-memory ETL job tracker: spawns the real production pipeline
(data/etl/src/sales_pipeline/main.py, via `python -m sales_pipeline.main`) as a subprocess per run
and tracks its status/log lines for app.py's routes to poll.

No persistence - state is lost if this Flask process restarts. That's an accepted MVP limitation
(see data/etl/api/README or the deployment docs): the subprocess is a child of this process, so it
dies with it too - there's never an orphaned pipeline run left running with nothing tracking it.

Only one job may be active at a time (mirrors the Node-side `hasActiveEtlRun()` guard in
backend/src/etl/queue/etlQueue.ts - this is defense-in-depth, not the only place that's enforced).
"""
from __future__ import annotations

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


def _run_job(job: Job, python_bin: str) -> None:
    args = [python_bin, "-m", "sales_pipeline.main", "--output", job.output_mode, "--load-mode", job.load_mode]
    if job.fast:
        args.append("--fast")
    if job.extra_args:
        args.extend(job.extra_args)

    job.status = "running"
    job.started_at = datetime.now(timezone.utc)

    try:
        proc = subprocess.Popen(
            args,
            cwd=str(ETL_ROOT),
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


class JobTracker:
    def __init__(self) -> None:
        self._jobs: Dict[str, Job] = {}
        self._active_job_id: Optional[str] = None
        self._lock = threading.Lock()

    def active_job(self) -> Optional[Job]:
        with self._lock:
            return self._active_job_locked()

    def _active_job_locked(self) -> Optional[Job]:
        """Same as active_job(), but assumes self._lock is already held -- self._lock is a plain
        (non-reentrant) Lock, so callers already inside a `with self._lock:` block (e.g. start())
        must call this instead of active_job() to avoid deadlocking on themselves."""
        if self._active_job_id is None:
            return None
        job = self._jobs.get(self._active_job_id)
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
    ) -> Job:
        with self._lock:
            if self._active_job_locked() is not None:
                raise RuntimeError("A run is already active")
            job_id = str(uuid.uuid4())
            job = Job(
                job_id=job_id,
                load_mode=load_mode,
                output_mode=output_mode,
                fast=fast,
                extra_args=list(extra_args or []),
                label=label,
            )
            self._jobs[job_id] = job
            self._active_job_id = job_id

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


# Module-level singleton - one Flask process, one tracker, matching the "only one run at a time"
# invariant the whole system (BullMQ concurrency:1, this tracker) enforces at every layer.
tracker = JobTracker()
