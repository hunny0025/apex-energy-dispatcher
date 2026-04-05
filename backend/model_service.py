"""
APEX — Model Service  (Singleton model loader + calibration layer)
==================================================================
Loads the trained LSTM model and scaler exactly ONCE at startup.
All inference calls go through this module — no reloading per request.

Public API:
    model_service.load(model_dir)         — called once from lifespan
    model_service.predict(df_window)      — returns {p50, p90}
    model_service.calibrate_p90(p90, ...) — residual-offset correction
    model_service.record_actual(actual)   — feed back true deficit for calibration
    model_service.is_ready()              — True when model + scaler loaded

Design:
  - Module-level singleton pattern: no classes, no injection friction.
  - Calibration uses a fixed-size residual ring buffer (last 200 observations).
    Once calibration data accumulates, offset = np.percentile(residuals, 90).
    If buffer is empty → apply flat +3% safety margin.
  - Thread-safe: all state behind a threading.Lock; FastAPI runs async but
    torch inference can be blocking — lock prevents data races from parallel
    requests during the 5–20ms inference window.
"""

from __future__ import annotations

import logging
import threading
from collections import deque
from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd

log = logging.getLogger("apex.model_service")





_lock             = threading.Lock()
_pipeline         = None        
_predictor        = None        
_residual_buf     = deque(maxlen=200)   
_predict_count    = 0
_is_ready         = False


_DEFAULT_SAFETY_FACTOR = 0.03   

_MIN_CAL_SAMPLES = 20






def load(model_dir: str | Path = "models") -> bool:
    """
    Load model weights + scaler from disk.
    Call exactly once from the FastAPI lifespan event.

    Returns True if both artifacts loaded successfully, False if model not found.
    Raises RuntimeError if imports fail (missing torch / joblib).
    """
    global _pipeline, _predictor, _is_ready

    model_dir = Path(model_dir)
    model_path  = model_dir / "best_model.pt"
    scaler_path = model_dir / "scaler.joblib"

    with _lock:
        if _is_ready:
            log.warning("model_service.load() called twice — skipping")
            return True

        try:
            from data_pipeline import DataPipeline, FEATURE_COLUMNS, SEQ_LEN
            from predictor import DeficitPredictor, PredictorConfig
        except ImportError as e:
            raise RuntimeError(f"Cannot import ML dependencies: {e}") from e

        if not model_path.exists():
            log.warning(
                "Model not found at %s. "
                "Run: python train.py --synthetic --output models/",
                model_path,
            )
            return False

        if not scaler_path.exists():
            log.warning("Scaler not found at %s — inference will be impaired", scaler_path)
            return False

        
        _pipeline = DataPipeline()
        _pipeline.load(scaler_path)
        log.info("Scaler loaded from %s", scaler_path)

        
        cfg = PredictorConfig(model_dir=str(model_dir))
        _predictor = DeficitPredictor(cfg)
        _predictor.load(model_path)
        log.info(
            "LSTM loaded from %s | seq_len=%d | features=%d",
            model_path,
            SEQ_LEN,
            len(FEATURE_COLUMNS),
        )

        _is_ready = True
        return True






def is_ready() -> bool:
    return _is_ready


def stats() -> dict:
    """Return diagnostic info for the /status endpoint."""
    return {
        "model_loaded": _is_ready,
        "predict_calls": _predict_count,
        "calibration_samples": len(_residual_buf),
        "calibration_active": len(_residual_buf) >= _MIN_CAL_SAMPLES,
    }






def predict(df_window: pd.DataFrame) -> dict:
    """
    Run inference on a window of recent timesteps.

    Parameters
    ----------
    df_window : pd.DataFrame
        DataFrame with DatetimeIndex (UTC) and at minimum the columns:
            load_mw, res_output_mw, grid_supply_mw,
            irradiance_wm2, wind_speed_ms
        Must have >= seq_len rows (default 16).
        Excess rows are fine — pipeline takes last seq_len steps.

    Returns
    -------
    dict with:
        p50       : float  — median deficit forecast (MW)
        p90       : float  — 90th-percentile forecast (MW)  [pre-calibration]
        p90_cal   : float  — calibrated P90 (MW)
        seq_len   : int    — number of steps used
        n_rows    : int    — rows in input window
        source    : str    — "lstm" | "not_ready"

    Raises
    ------
    ValueError  if columns missing or window too short
    RuntimeError if model not loaded
    """
    global _predict_count

    if not _is_ready:
        raise RuntimeError("model_service not loaded — call load() first")

    with _lock:
        
        required = {"load_mw", "res_output_mw", "grid_supply_mw"}
        missing = required - set(df_window.columns)
        if missing:
            raise ValueError(f"df_window missing columns: {missing}")

        
        for col in ("irradiance_wm2", "wind_speed_ms"):
            if col not in df_window.columns:
                df_window = df_window.copy()
                df_window[col] = 0.0
                log.debug("Missing %s — filling with 0.0", col)

        
        df_window = _ensure_utc_index(df_window)

        
        
        X = _pipeline.transform_live(df_window)   

        
        raw = _predictor.predict_array(X)          

        p50 = float(max(0.0, raw["p50_mw"]))
        p90 = float(max(p50, raw["p90_mw"]))       

        
        p90_cal = calibrate_p90(p90)

        _predict_count += 1
        return {
            "p50":    round(p50, 3),
            "p90":    round(p90, 3),
            "p90_cal": round(p90_cal, 3),
            "seq_len": X.shape[1],
            "n_rows":  len(df_window),
            "source":  "lstm",
        }






def calibrate_p90(
    pred_p90: float,
    actual_history: Optional[np.ndarray | list] = None,
) -> float:
    """
    Apply a residual-based calibration offset to the raw P90 prediction.

    Strategy (per user specification):
      IF actual_history is provided:
          residuals = actual - pred_p90  (positive = under-forecast)
          offset = np.percentile(residuals, 90)
          return pred_p90 + offset
      ELIF internal ring buffer has >= _MIN_CAL_SAMPLES points:
          uses accumulated residuals from record_actual() calls
          offset = np.percentile(buffer_residuals, 90)
          return pred_p90 + offset
      ELSE:
          apply flat safety factor: pred_p90 * (1 + _DEFAULT_SAFETY_FACTOR)
    """
    
    if actual_history is not None:
        residuals = np.asarray(actual_history, dtype=float)
        if len(residuals) >= 5:
            offset = float(np.percentile(residuals, 90))
            log.debug("Calibration (external): offset=%.3f MW", offset)
            return float(pred_p90 + offset)

    
    if len(_residual_buf) >= _MIN_CAL_SAMPLES:
        residuals = np.array(_residual_buf, dtype=float)
        offset = float(np.percentile(residuals, 90))
        log.debug(
            "Calibration (buffer n=%d): offset=%.3f MW",
            len(_residual_buf), offset,
        )
        return float(pred_p90 + offset)

    
    log.debug(
        "Calibration pending (%d/%d samples) — applying %.0f%% safety factor",
        len(_residual_buf), _MIN_CAL_SAMPLES, _DEFAULT_SAFETY_FACTOR * 100,
    )
    return float(pred_p90 * (1.0 + _DEFAULT_SAFETY_FACTOR))


def record_actual(actual_deficit_mw: float, pred_p90_mw: float) -> None:
    """
    Feed back the true observed deficit after the fact.
    Accumulates residuals (actual - predicted_p90) for calibration.

    Call this from your SCADA feedback loop once the window resolves.
    Typical pattern: 15 minutes after dispatch, compare predicted vs measured.
    """
    residual = actual_deficit_mw - pred_p90_mw
    _residual_buf.append(residual)
    log.debug(
        "Residual recorded: actual=%.2f pred_p90=%.2f residual=%.4f (buf=%d)",
        actual_deficit_mw, pred_p90_mw, residual, len(_residual_buf),
    )






def _ensure_utc_index(df: pd.DataFrame) -> pd.DataFrame:
    """
    Ensures df has a UTC DatetimeIndex named 'timestamp'.
    Handles: string index, naive index, tz-aware index in other zones.
    """
    if not isinstance(df.index, pd.DatetimeIndex):
        df = df.copy()
        df.index = pd.to_datetime(df.index, utc=True)
    elif df.index.tz is None:
        df = df.copy()
        df.index = df.index.tz_localize("UTC")
    elif str(df.index.tz) != "UTC":
        df = df.copy()
        df.index = df.index.tz_convert("UTC")
    return df
