"""Anomaly detection over the monthly KPI panel: Z-score/IQR per metric, plus
IsolationForest across all metrics together for multivariate anomalies no
single metric would flag alone. With only a few dozen monthly points, this
is necessarily low-powered -- the caveat below is carried into the report
rather than overstating confidence.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest

METRIC_COLUMNS = ["value", "volume", "asp", "leads", "opportunities", "quotations", "sales_orders", "deliveries", "avg_sales_per_invoice"]

METHODOLOGY_CAVEAT = (
    "Anomaly detection runs on a monthly panel with a limited number of "
    "historical points; flags below a few standard deviations should be read "
    "as directional signals, not statistically certain outliers."
)


@dataclass
class SingleMetricAnomaly:
    year_month: str
    metric: str
    value: float
    zscore: float
    severity: str  # "high" | "moderate"


def single_metric_anomalies(panel: pd.DataFrame, zscore_threshold: float = 2.0) -> list[SingleMetricAnomaly]:
    if panel.empty:
        return []
    flags: list[SingleMetricAnomaly] = []
    for metric in METRIC_COLUMNS:
        if metric not in panel.columns:
            continue
        series = panel[metric].astype(float)
        if series.std(ddof=0) == 0 or series.dropna().empty:
            continue
        mean, std = series.mean(), series.std(ddof=0)
        q1, q3 = series.quantile(0.25), series.quantile(0.75)
        iqr = q3 - q1
        for i, row in panel.iterrows():
            v = row[metric]
            if pd.isna(v):
                continue
            z = (v - mean) / std if std else 0.0
            is_iqr_outlier = iqr > 0 and (v < q1 - 1.5 * iqr or v > q3 + 1.5 * iqr)
            if abs(z) >= zscore_threshold or is_iqr_outlier:
                severity = "high" if abs(z) >= 3 else "moderate"
                flags.append(SingleMetricAnomaly(row["year_month"], metric, float(v), float(z), severity))
    flags.sort(key=lambda f: -abs(f.zscore))
    return flags


@dataclass
class MultivariateAnomaly:
    year_month: str
    anomaly_score: float  # higher = more anomalous
    contributing_metrics: list[str]


def multivariate_anomalies(panel: pd.DataFrame, contamination: float = 0.1) -> list[MultivariateAnomaly]:
    if panel.empty or len(panel) < 8:
        return []
    cols = [c for c in METRIC_COLUMNS if c in panel.columns]
    data = panel[cols].fillna(panel[cols].mean())
    if data.isna().all().any():
        return []

    z = (data - data.mean()) / data.std(ddof=0).replace(0, 1)
    model = IsolationForest(contamination=contamination, random_state=0)
    model.fit(z)
    scores = -model.score_samples(z)  # higher = more anomalous
    preds = model.predict(z)  # -1 = anomaly

    results = []
    for i, row in panel.iterrows():
        if preds[i] != -1:
            continue
        row_z = z.iloc[i]
        contributing = row_z.abs().sort_values(ascending=False).head(3).index.tolist()
        results.append(MultivariateAnomaly(row["year_month"], float(scores[i]), contributing))
    results.sort(key=lambda a: -a.anomaly_score)
    return results
