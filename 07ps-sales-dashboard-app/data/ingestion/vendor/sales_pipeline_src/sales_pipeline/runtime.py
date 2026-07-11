from __future__ import annotations

import time
import logging
import cProfile
import pstats
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Iterator


@dataclass
class StepTiming:
    step_name: str
    start_time: datetime
    end_time: datetime
    duration_seconds: float
    status: str
    error_message: str = ""


@dataclass
class PipelineRunContext:
    scheduled_refresh_time: str | None = None
    start_time: datetime = field(default_factory=datetime.now)
    end_time: datetime | None = None
    status: str = "RUNNING"
    error_message: str = ""
    step_timings: list[StepTiming] = field(default_factory=list)

    @contextmanager
    def step(self, name: str) -> Iterator[None]:
        logger = logging.getLogger(__name__)
        step_start = datetime.now()
        perf_start = time.perf_counter()
        logger.info("Pipeline step %s started", name)
        try:
            yield
        except Exception as exc:
            step_end = datetime.now()
            duration = time.perf_counter() - perf_start
            self.step_timings.append(
                StepTiming(
                    step_name=name,
                    start_time=step_start,
                    end_time=step_end,
                    duration_seconds=duration,
                    status="FAILED",
                    error_message=str(exc),
                )
            )
            logger.info("Pipeline step %s failed duration_seconds=%.2f", name, duration)
            raise
        else:
            step_end = datetime.now()
            duration = time.perf_counter() - perf_start
            self.step_timings.append(
                StepTiming(
                    step_name=name,
                    start_time=step_start,
                    end_time=step_end,
                    duration_seconds=duration,
                    status="SUCCESS",
                )
            )
            logger.info("Pipeline step %s completed duration_seconds=%.2f", name, duration)

    def finish(self, status: str, error_message: str = "") -> None:
        self.end_time = datetime.now()
        self.status = status
        self.error_message = error_message

    @property
    def total_duration_seconds(self) -> float:
        end = self.end_time or datetime.now()
        return (end - self.start_time).total_seconds()

    @property
    def total_duration_minutes(self) -> float:
        return self.total_duration_seconds / 60


@contextmanager
def optional_profiler(enabled: bool, output_path: Path) -> Iterator[None]:
    if not enabled:
        yield
        return
    output_path.parent.mkdir(parents=True, exist_ok=True)
    profiler = cProfile.Profile()
    profiler.enable()
    try:
        yield
    finally:
        profiler.disable()
        profiler.dump_stats(output_path)
        text_path = output_path.with_suffix(".txt")
        with text_path.open("w", encoding="utf-8") as handle:
            stats = pstats.Stats(profiler, stream=handle).sort_stats("cumulative")
            stats.print_stats(100)
