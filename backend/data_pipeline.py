"""
APEX — Data Pipeline
Full preprocessing from raw SCADA CSV to LSTM-ready tensors.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd
from sklearn.preprocessing import RobustScaler

log = logging.getLogger(__name__)

TARGET_FREQ = "15min"
SEQ_LEN     = 16
HORIZON     = 1






FEATURE_COLUMNS = [
    
    "load_mw",
    "res_output_mw",
    "grid_supply_mw",
    
    "load_mean_1h",
    "load_std_1h",
    "load_mean_4h",
    "deficit_mean_1h",
    "deficit_std_1h",
    
    "load_lag1",
    "load_lag4",
    "load_lag16",
    "deficit_lag1",   
    "deficit_lag4",   
    
    "irradiance_wm2",
    "wind_speed_ms",
    "storm_flag",
    
    "hour_sin",
    "hour_cos",
    "dow_sin",
    "dow_cos",
]
TARGET_COLUMN = "deficit_mw"


@dataclass
class PipelineConfig:
    target_freq:          str   = TARGET_FREQ
    seq_len:              int   = SEQ_LEN
    horizon:              int   = HORIZON
    hampel_k:             int   = 7
    hampel_t:             float = 3.0
    max_gap_fill_steps:   int   = 4
    plant_capacity_mw:    float = 500.0
    grid_cap_mw:          float = 350.0
    storm_wind_threshold: float = 15.0


def hampel_filter(series: pd.Series, k: int = 7, t: float = 3.0) -> pd.Series:
    clean = series.copy()
    rm = series.rolling(2 * k + 1, center=True).median()
    mad = series.rolling(2 * k + 1, center=True).apply(
        lambda x: np.median(np.abs(x - np.median(x))), raw=True
    )
    sigma = 1.4826 * mad
    outliers = np.abs(series - rm) > t * sigma
    clean[outliers] = rm[outliers]
    return clean


def add_temporal_features(df: pd.DataFrame) -> pd.DataFrame:
    hour = df.index.hour + df.index.minute / 60.0
    dow  = df.index.dayofweek.astype(float)
    df["hour_sin"] = np.sin(2 * np.pi * hour / 24.0)
    df["hour_cos"] = np.cos(2 * np.pi * hour / 24.0)
    df["dow_sin"]  = np.sin(2 * np.pi * dow  / 7.0)
    df["dow_cos"]  = np.cos(2 * np.pi * dow  / 7.0)
    return df


class DataPipeline:
    def __init__(self, cfg: Optional[PipelineConfig] = None) -> None:
        self.cfg = cfg or PipelineConfig()
        self.scaler = RobustScaler()
        self._fitted = False

    def fit_transform(self, df: pd.DataFrame, val_split: float = 0.2):
        df = self._clean(df)
        df = self._engineer_features(df)
        df = self._drop_na(df)
        n_val = int(len(df) * val_split)
        train_df, val_df = df.iloc[:len(df) - n_val], df.iloc[len(df) - n_val:]
        self.scaler.fit(train_df[FEATURE_COLUMNS])
        self._fitted = True
        X_train, y_train = self._make_sequences(train_df)
        X_val,   y_val   = self._make_sequences(val_df)
        log.info("Pipeline fit | train=%d | val=%d | features=%d", len(X_train), len(X_val), len(FEATURE_COLUMNS))
        return X_train, y_train, X_val, y_val

    def transform_live(self, df: pd.DataFrame) -> np.ndarray:
        assert self._fitted, "Call fit_transform() before transform_live()"
        df = self._clean(df)
        df = self._engineer_features(df)
        df = self._drop_na(df)
        if len(df) < self.cfg.seq_len:
            raise ValueError(f"Need at least {self.cfg.seq_len} rows, got {len(df)}")
        window = df.iloc[-self.cfg.seq_len:]
        return self.scaler.transform(window[FEATURE_COLUMNS])[np.newaxis, :, :]

    def save(self, path: Path) -> None:
        import joblib; joblib.dump(self.scaler, path)

    def load(self, path: Path) -> None:
        import joblib; self.scaler = joblib.load(path); self._fitted = True

    def _clean(self, df: pd.DataFrame) -> pd.DataFrame:
        df = df.copy()
        
        if not isinstance(df.index, pd.DatetimeIndex):
            df.index = pd.to_datetime(df.index, utc=True)
        elif df.index.tz is None:
            
            df.index = df.index.tz_localize("UTC")
        numeric_cols = df.select_dtypes(include=[np.number]).columns
        df = df[numeric_cols].resample(self.cfg.target_freq).mean()
        
        df = df.ffill(limit=self.cfg.max_gap_fill_steps)
        df = df.interpolate(method="time", limit=self.cfg.max_gap_fill_steps * 2)
        for col in ["load_mw", "res_output_mw"]:
            if col in df.columns:
                df[col] = hampel_filter(df[col], self.cfg.hampel_k, self.cfg.hampel_t)
        if "load_mw" in df.columns:
            df["load_mw"] = df["load_mw"].clip(0, self.cfg.plant_capacity_mw * 1.1)
        if "res_output_mw" in df.columns:
            df["res_output_mw"] = df["res_output_mw"].clip(0, None)
        if "grid_supply_mw" in df.columns:
            df["grid_supply_mw"] = df["grid_supply_mw"].clip(0, self.cfg.grid_cap_mw)
        return df

    def _engineer_features(self, df: pd.DataFrame) -> pd.DataFrame:
        df["deficit_mw"]      = (df["load_mw"] - df["res_output_mw"] - df["grid_supply_mw"]).clip(lower=0)
        df["load_mean_1h"]    = df["load_mw"].rolling(4,  min_periods=1).mean()
        df["load_std_1h"]     = df["load_mw"].rolling(4,  min_periods=2).std().fillna(0)
        df["load_mean_4h"]    = df["load_mw"].rolling(16, min_periods=1).mean()
        df["deficit_mean_1h"] = df["deficit_mw"].rolling(4,  min_periods=1).mean()
        df["deficit_std_1h"]  = df["deficit_mw"].rolling(4,  min_periods=2).std().fillna(0)
        df["load_lag1"]       = df["load_mw"].shift(1)
        df["load_lag4"]       = df["load_mw"].shift(4)
        df["load_lag16"]      = df["load_mw"].shift(16)
        df["deficit_lag1"]    = df["deficit_mw"].shift(1)
        df["deficit_lag4"]    = df["deficit_mw"].shift(4)
        if "wind_speed_ms" in df.columns:
            df["storm_flag"] = (df["wind_speed_ms"] > self.cfg.storm_wind_threshold).astype(float)
        else:
            df["storm_flag"] = 0.0
        if "irradiance_wm2" not in df.columns: df["irradiance_wm2"] = 0.0
        if "wind_speed_ms" not in df.columns:  df["wind_speed_ms"]  = 0.0
        return add_temporal_features(df)

    def _drop_na(self, df: pd.DataFrame) -> pd.DataFrame:
        before = len(df)
        df = df.dropna(subset=FEATURE_COLUMNS + [TARGET_COLUMN])
        if before - len(df) > 0:
            log.debug("Dropped %d rows with NaN", before - len(df))
        return df

    def _make_sequences(self, df: pd.DataFrame):
        X_scaled = self.scaler.transform(df[FEATURE_COLUMNS])
        y_raw    = df[TARGET_COLUMN].values
        X_seqs, y_seqs = [], []
        cfg = self.cfg
        for i in range(len(df) - cfg.seq_len - cfg.horizon + 1):
            X_seqs.append(X_scaled[i : i + cfg.seq_len])
            y_seqs.append(y_raw[i + cfg.seq_len : i + cfg.seq_len + cfg.horizon])
        return np.array(X_seqs, dtype=np.float32), np.array(y_seqs, dtype=np.float32)


class SyntheticGenerator:
    def __init__(self, plant_capacity_mw=500.0, res_normal_mw=150.0, grid_cap_mw=350.0,
                 storm_prob=0.02, storm_duration_steps=16, seed=42):
        self.capacity   = plant_capacity_mw
        self.res_normal = res_normal_mw
        self.grid_cap   = grid_cap_mw
        self.storm_prob = storm_prob
        self.storm_dur  = storm_duration_steps
        self.rng = np.random.default_rng(seed)

    def generate(self, start: str = "2023-01-01", periods_days: int = 365) -> pd.DataFrame:
        n   = periods_days * 24 * 4
        idx = pd.date_range(start, periods=n, freq="15min", tz="UTC")
        load = self._load_pattern(idx) + self.rng.normal(0, 0.5, n)
        irr, wind, storm = self._weather(idx, n)
        res  = self._res(irr, wind, storm) + self.rng.normal(0, 0.5, n)
        res  = np.clip(res, 0, None)
        grid = np.clip(load - res, 0, self.grid_cap) + self.rng.normal(0, 0.25, n)
        grid = np.clip(grid, 0, self.grid_cap)
        return pd.DataFrame({
            "load_mw": np.clip(load, 0, self.capacity),
            "res_output_mw": res,
            "grid_supply_mw": grid,
            "irradiance_wm2": np.clip(irr, 0, 1000),
            "wind_speed_ms": np.clip(wind, 0, 30),
        }, index=idx)

    def _load_pattern(self, idx):
        
        hour = idx.hour.to_numpy(dtype=float) + idx.minute.to_numpy(dtype=float) / 60.0
        dow  = idx.dayofweek.to_numpy(dtype=float)
        diurnal = 60 * np.exp(-0.5 * ((hour - 9) / 2.0)**2) + 80 * np.exp(-0.5 * ((hour - 19) / 2.5)**2)
        weekend = (dow >= 5).astype(float) * 0.15
        seasonal = 30 * np.sin(2 * np.pi * (idx.dayofyear.to_numpy(dtype=float) - 1) / 365)
        return 350.0 + diurnal - weekend * 350.0 + seasonal

    def _weather(self, idx, n):
        
        hour = idx.hour.to_numpy(dtype=float)
        irr  = 900 * np.exp(-0.5 * ((hour - 13) / 3.0)**2)
        irr  = np.where(irr < 5, 0.0, irr)   
        wind = self.rng.lognormal(1.5, 0.5, n) * (1 + 0.3 * np.sin(2 * np.pi * hour / 24))
        storm = np.zeros(n, dtype=bool)
        in_storm, countdown = False, 0
        for i in range(n):
            if in_storm:
                storm[i] = True; countdown -= 1
                if countdown <= 0: in_storm = False
            elif self.rng.random() < self.storm_prob:
                in_storm = True; countdown = self.storm_dur; storm[i] = True
        irr  = np.where(storm, 0.0, irr)    
        wind = np.where(storm, wind * 3.0, wind)
        return irr, wind, storm

    def _res(self, irr, wind, storm):
        solar = (irr / 900.0) * 90.0
        wind_mw = np.clip(0.0012 * wind**2.5, 0, 60.0)
        res = solar + wind_mw
        res[storm] *= 0.40
        return res
