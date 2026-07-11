from __future__ import annotations

import logging
import hashlib
import pickle
from pathlib import Path
from typing import Any, Callable, TypeVar


T = TypeVar("T")


class ReferenceDataCache:
    """Disk cache for parsed, unchanged reference workbooks."""

    CACHE_VERSION = 2

    def __init__(self, cache_dir: Path) -> None:
        self.cache_dir = cache_dir
        self.logger = logging.getLogger(__name__)

    def load(self, name: str, source_path: Path, loader: Callable[[], T]) -> T:
        cache_path = self.cache_dir / f"{name}.pickle"
        signature = self._signature(source_path)
        try:
            with cache_path.open("rb") as handle:
                payload: dict[str, Any] = pickle.load(handle)  # noqa: S301 - trusted, pipeline-owned cache
            if payload.get("version") == self.CACHE_VERSION and payload.get("signature") == signature:
                self.logger.info("%s unchanged; skipping Excel reload", source_path.name)
                return payload["value"]
        except FileNotFoundError:
            pass
        except Exception as exc:  # noqa: BLE001
            self.logger.warning("Reference cache %s could not be read; rebuilding: %s", name, exc)

        value = loader()
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        temp_path = cache_path.with_suffix(".tmp")
        try:
            with temp_path.open("wb") as handle:
                pickle.dump(
                    {"version": self.CACHE_VERSION, "signature": signature, "value": value},
                    handle,
                    protocol=pickle.HIGHEST_PROTOCOL,
            )
            temp_path.replace(cache_path)
            self.logger.info("%s changed; current file will be loaded", source_path.name)
        except Exception as exc:  # noqa: BLE001
            self.logger.warning("Reference cache %s could not be written: %s", name, exc)
            temp_path.unlink(missing_ok=True)
        return value

    @staticmethod
    def _signature(path: Path) -> tuple[str, int, str]:
        stat = path.stat()
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return str(path.resolve()), int(stat.st_size), digest.hexdigest()
