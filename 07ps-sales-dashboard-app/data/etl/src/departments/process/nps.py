"""The NPS Score rating rule: the ONLY place the rating levels and the classification rule are defined.

The source (MySQL ``nps_rating_full_data``, filled by the NPS developer's script from Odoo's delivery ratings) has no
0-10 score: the customer answers with stars. A message ``body`` is a RATING only when its whole ``<p>...</p>`` text,
whitespace trimmed, is exactly one of three Arabic answers (decision of 2026-10-18). Anything else is a comment (free
text) or blank -- never a rating, never counted as 0. The levels are shown on the standard NPS scale (step 2, 0047):

  level 3  ***  فاقت التوقعات       Promoters   المروجون    (standard NPS score 9-10)
  level 2  **   في مستوى التوقعات   Passives    المحايدون   (7-8)
  level 1  *    أقل من المتوقع      Detractors  المنتقدون   (0-6; a low rating)

NPS = %promoters - %detractors and CSAT = (passives + promoters) / responders are defined in the backend
(measures/npsScore.ts), always from summed counts. ``nps_style`` below is the same NPS, rounded, for the ETL's run log.
"""

from __future__ import annotations

import html
import re
from dataclasses import dataclass

import pandas as pd


@dataclass(frozen=True)
class NpsLevel:
    level: int
    key: str
    source_text: str  # the developer's exact answer text
    label_en: str
    label_ar: str
    sort_order: int


LEVELS: tuple[NpsLevel, ...] = (
    # labels on the standard NPS scale (migration 0047): Promoters / Passives / Detractors
    NpsLevel(3, "exceeded", "فاقت التوقعات", "Promoters", "المروجون", 1),
    NpsLevel(2, "met", "في مستوى التوقعات", "Passives", "المحايدون", 2),
    NpsLevel(1, "below", "أقل من المتوقع", "Detractors", "المنتقدون", 3),
)
LOW_RATING_LEVEL = 1
BY_TEXT = {lv.source_text: lv.level for lv in LEVELS}

KIND_RATING, KIND_COMMENT, KIND_BLANK = "rating", "comment", "blank"

_OUTER_P = re.compile(r"^\s*<p>(.*)</p>\s*$", re.S | re.I)
_BREAK = re.compile(r"<br\s*/?>", re.I)
_TAG = re.compile(r"<[^>]+>")
_EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
_PHONE = re.compile(r"(?<![\d])\+?\d(?:[\d\s\-]{6,})\d(?![\d])")
ARABIC_DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹", "01234567890123456789")


def validate_levels(levels: tuple[NpsLevel, ...] = LEVELS) -> None:
    keys = [lv.level for lv in levels]
    texts = [lv.source_text for lv in levels]
    if sorted(keys) != [1, 2, 3] or len(set(texts)) != len(texts) or LOW_RATING_LEVEL not in keys:
        raise ValueError("NPS levels must be exactly 1, 2, 3 with distinct answer texts")


def _inner_text(body: object) -> str:
    if body is None or (isinstance(body, float) and pd.isna(body)):
        return ""
    s = str(body)
    m = _OUTER_P.match(s)
    return (m.group(1) if m else s).strip()


def classify(body: object) -> int | None:
    """The developer's rule: the whole <p>...</p> text, whitespace trimmed, equals one of the three answers -> its level
    (3 / 2 / 1); anything else -> None (a comment or blank, never a rating)."""
    return BY_TEXT.get(_inner_text(body))


def body_kind(body: object) -> str:
    if classify(body) is not None:
        return KIND_RATING
    return KIND_COMMENT if comment_text(body) else KIND_BLANK


def comment_text(body: object) -> str:
    """Plain text of a comment: tags removed (<br> = new line), entities decoded, phone numbers and e-mail addresses
    masked (personal data stays in the raw layer only, decision D6)."""
    s = _BREAK.sub("\n", _inner_text(body))
    s = html.unescape(_TAG.sub("", s))
    s = _EMAIL.sub("[email]", s.translate(ARABIC_DIGITS))
    s = _PHONE.sub(lambda m: "[phone]" if sum(c.isdigit() for c in m.group(0)) >= 7 else m.group(0), s)
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in s.splitlines()]
    return "\n".join(line for line in lines if line)


def nps_style(exceeded: int, met: int, below: int) -> float | None:
    """%exceeded - %below over the rated responses (-100..+100, one decimal); None when there is no response."""
    total = int(exceeded) + int(met) + int(below)
    if total <= 0:
        return None
    return round(100.0 * (int(exceeded) - int(below)) / total, 1)


def level_frame() -> pd.DataFrame:
    """Rows of dim_process_nps_level."""
    validate_levels()
    return pd.DataFrame([{"nps_level": lv.level, "level_key": lv.key, "source_text": lv.source_text, "label_en": lv.label_en,
                          "label_ar": lv.label_ar, "is_low_rating": int(lv.level == LOW_RATING_LEVEL), "sort_order": lv.sort_order}
                         for lv in LEVELS])


validate_levels()
