"""notify(level, message): the single place alerts go through.

Today an alert is (1) a log line at that level -- the Node worker streams every line into the ETL Control
Center's run log -- and (2) whatever channels are registered. The runner registers a channel that keeps
WARNING/ERROR messages for the run's ``etl_run_log.error_message``. Email or Teams can be added later with
``register_channel`` without touching any caller. No SMTP is configured on purpose.

Never pass secrets in ``message`` or ``context``.
"""

from __future__ import annotations

import logging
from typing import Any, Callable

logger = logging.getLogger("etl_platform.notify")

Channel = Callable[[str, str, dict[str, Any]], None]

_LEVELS = {"DEBUG": logging.DEBUG, "INFO": logging.INFO, "WARNING": logging.WARNING, "ERROR": logging.ERROR, "CRITICAL": logging.CRITICAL}
_channels: list[Channel] = []


def register_channel(channel: Channel) -> Callable[[], None]:
    """Adds a channel; returns a function that removes it again."""
    _channels.append(channel)

    def _remove() -> None:
        if channel in _channels:
            _channels.remove(channel)

    return _remove


def notify(level: str, message: str, **context: Any) -> None:
    lvl = (level or "INFO").upper()
    if lvl == "WARN":
        lvl = "WARNING"
    if lvl not in _LEVELS:
        lvl = "INFO"
    suffix = " ".join(f"{k}={v}" for k, v in sorted(context.items()))
    logger.log(_LEVELS[lvl], "%s%s", message, f" [{suffix}]" if suffix else "")
    for channel in list(_channels):
        try:
            channel(lvl, message, dict(context))
        except Exception:  # noqa: BLE001 - an alert channel must never break the run it reports on
            logger.exception("Notification channel %r failed", channel)
