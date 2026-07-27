"""Predictive forecasting: backtests SARIMAX vs. Prophet on held-out history
and keeps whichever wins, per measure. Daily revenue gets a true 30/60/90-day
forecast; pipeline trend (naturally monthly-grain) gets a 1/2/3-month
forecast; Pipeline Health / Customer Growth get a directional regression
projection rather than a calendar forecast, since they aren't clean time series.
"""
from __future__ import annotations

import warnings
from dataclasses import dataclass, field

import numpy as np
import pandas as pd
from sklearn.linear_model import LinearRegression
from statsmodels.tsa.statespace.sarimax import SARIMAX

try:
    from prophet import Prophet
    PROPHET_AVAILABLE = True
except Exception:  # noqa: BLE001 - Prophet is best-effort, see requirements.txt
    PROPHET_AVAILABLE = False

warnings.filterwarnings("ignore", module="statsmodels")
warnings.filterwarnings("ignore", module="prophet")
warnings.filterwarnings("ignore", module="cmdstanpy")


@dataclass
class ForecastResult:
    method: str  # "SARIMAX" or "Prophet"
    horizon_dates: list
    point_forecast: list[float]
    lower_ci: list[float]
    upper_ci: list[float]
    backtest_smape: dict[str, float] = field(default_factory=dict)  # method -> MAPE on holdout
    note: str = ""


def _smape(actual: np.ndarray, predicted: np.ndarray) -> float:
    """Symmetric MAPE, bounded [0, 200]. Used instead of plain MAPE because
    daily revenue can be near-zero on slow days, which sends ordinary MAPE
    to absurd values even when the forecast is directionally fine."""
    actual = np.asarray(actual, dtype=float)
    predicted = np.asarray(predicted, dtype=float)
    denom = (np.abs(actual) + np.abs(predicted))
    mask = denom != 0
    if not mask.any():
        return float("nan")
    return float(np.mean(np.abs(actual[mask] - predicted[mask]) / denom[mask] * 2) * 100)


def _fit_sarimax_forecast(series: pd.Series, steps: int, seasonal_period: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    model = SARIMAX(
        series, order=(1, 1, 1), seasonal_order=(1, 0, 1, seasonal_period),
        enforce_stationarity=False, enforce_invertibility=False,
    )
    fit = model.fit(disp=False)
    pred = fit.get_forecast(steps=steps)
    mean = pred.predicted_mean.to_numpy()
    ci = pred.conf_int(alpha=0.2)  # 80% CI
    return mean, ci.iloc[:, 0].to_numpy(), ci.iloc[:, 1].to_numpy()


def _fit_prophet_forecast(dates: pd.Series, values: pd.Series, steps: int, freq: str) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    df = pd.DataFrame({"ds": pd.to_datetime(dates), "y": values.to_numpy()})
    model = Prophet(interval_width=0.8)
    model.fit(df)
    future = model.make_future_dataframe(periods=steps, freq=freq)
    fc = model.predict(future).tail(steps)
    return fc["yhat"].to_numpy(), fc["yhat_lower"].to_numpy(), fc["yhat_upper"].to_numpy()


def backtest_and_forecast(
    dates_series: pd.Series, values_series: pd.Series, horizon_steps: int, freq: str, seasonal_period: int,
) -> ForecastResult:
    """Backtests SARIMAX and (if installed) Prophet on the last `horizon_steps`
    of known history, scores by SMAPE, and forecasts `horizon_steps` beyond the
    end of history using whichever method won the backtest.
    """
    n = len(values_series)
    if n < max(2 * seasonal_period, horizon_steps + seasonal_period):
        return ForecastResult(
            method="none", horizon_dates=[], point_forecast=[], lower_ci=[], upper_ci=[],
            note=f"Not enough history ({n} points) for a reliable forecast at this grain; skipped.",
        )

    holdout = min(horizon_steps, n // 4) or 1
    train_values = values_series.iloc[:-holdout]
    train_dates = dates_series.iloc[:-holdout]
    actual_holdout = values_series.iloc[-holdout:].to_numpy()

    smape_scores: dict[str, float] = {}

    try:
        sarimax_mean, _, _ = _fit_sarimax_forecast(train_values.reset_index(drop=True), holdout, seasonal_period)
        smape_scores["SARIMAX"] = _smape(actual_holdout, sarimax_mean)
    except Exception:  # noqa: BLE001
        smape_scores["SARIMAX"] = float("inf")

    if PROPHET_AVAILABLE:
        try:
            prophet_mean, _, _ = _fit_prophet_forecast(train_dates, train_values, holdout, freq)
            smape_scores["Prophet"] = _smape(actual_holdout, prophet_mean)
        except Exception:  # noqa: BLE001
            smape_scores["Prophet"] = float("inf")
    else:
        smape_scores["Prophet"] = float("inf")

    winner = min(smape_scores, key=smape_scores.get)
    if smape_scores[winner] == float("inf"):
        return ForecastResult(
            method="none", horizon_dates=[], point_forecast=[], lower_ci=[], upper_ci=[],
            backtest_smape=smape_scores,
            note="Both SARIMAX and Prophet failed to fit this series; forecast skipped.",
        )

    last_date = pd.to_datetime(dates_series.iloc[-1])
    horizon_dates = pd.date_range(last_date, periods=horizon_steps + 1, freq=freq)[1:]

    if winner == "SARIMAX":
        mean, lo, hi = _fit_sarimax_forecast(values_series.reset_index(drop=True), horizon_steps, seasonal_period)
    else:
        mean, lo, hi = _fit_prophet_forecast(dates_series, values_series, horizon_steps, freq)

    return ForecastResult(
        method=winner,
        horizon_dates=list(horizon_dates),
        point_forecast=list(mean),
        lower_ci=list(lo),
        upper_ci=list(hi),
        backtest_smape=smape_scores,
        note=(
            f"{winner} won the backtest (SMAPE {smape_scores[winner]:.1f}% vs. "
            f"{'/'.join(f'{k}={v:.1f}%' for k, v in smape_scores.items() if k != winner)})."
            + ("" if PROPHET_AVAILABLE else " Prophet was unavailable in this environment; SARIMAX-only.")
        ),
    )


def forecast_daily_revenue(daily: pd.DataFrame, horizon_days: int = 90) -> ForecastResult:
    if daily.empty:
        return ForecastResult("none", [], [], [], [], note="No daily revenue data available.")
    series = daily.set_index("date")["value"].asfreq("D").fillna(0)
    return backtest_and_forecast(pd.Series(series.index), series.reset_index(drop=True), horizon_days, "D", seasonal_period=7)


def forecast_monthly_series(monthly: pd.DataFrame, value_col: str, months_ahead: int = 3) -> ForecastResult:
    if monthly.empty or value_col not in monthly:
        return ForecastResult("none", [], [], [], [], note=f"No monthly data available for {value_col}.")
    dates_series = pd.to_datetime(monthly["year_month"] + "-01")
    values_series = monthly[value_col].fillna(0)
    return backtest_and_forecast(dates_series, values_series, months_ahead, "MS", seasonal_period=12)


@dataclass
class TrendProjection:
    slope_per_month: float
    r_squared: float
    projected_next: float
    note: str


def project_directional_trend(monthly: pd.DataFrame, value_col: str) -> TrendProjection:
    """For non-time-series-shaped measures (Pipeline Health, Customer Growth):
    a plain linear trend against a month index, labeled directional rather
    than a calendar forecast."""
    if monthly.empty or value_col not in monthly or monthly[value_col].isna().all():
        return TrendProjection(0.0, 0.0, 0.0, f"No data available to project a trend for {value_col}.")

    df = monthly.dropna(subset=[value_col]).reset_index(drop=True)
    x = np.arange(len(df)).reshape(-1, 1)
    y = df[value_col].to_numpy()
    model = LinearRegression().fit(x, y)
    r2 = model.score(x, y)
    next_x = np.array([[len(df)]])
    projected = float(model.predict(next_x)[0])
    direction = "improving" if model.coef_[0] > 0 else "declining"
    return TrendProjection(
        slope_per_month=float(model.coef_[0]), r_squared=float(r2), projected_next=projected,
        note=f"{value_col} is trending {direction} (R^2={r2:.2f} on {len(df)} months) -- directional, not a calendar forecast.",
    )
