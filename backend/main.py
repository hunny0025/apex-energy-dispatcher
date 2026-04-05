"""
APEX Main — FastAPI application  (v2 — model_service integrated)
================================================================
Pipeline per request:
  Raw sensor → Fault detector → Kalman estimator
  → model_service.predict() [LSTM P50/P90]
  → model_service.calibrate_p90()
  → MILP optimizer [cost-ESG dispatch]
  → Async audit log
  → JSON response

All ML inference goes through model_service (singleton, loaded once at startup).
Field names use the canonical pipeline schema throughout:
    load_mw, res_output_mw, grid_supply_mw, irradiance_wm2, wind_speed_ms
"""

import asyncio
import json
import logging
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, field_validator

import model_service
from optimizer import (
    OptimizationInput,
    OptimizationResult,
    PlantConfig,
    solve_dispatch,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
)
logger = logging.getLogger("apex.main")






class EnergyStateEstimator:
    """
    Kalman filter tracking true energy state from noisy sensor readings.
    State vector: x = [P_load, P_renewable, P_grid]  (MW)
    """

    def __init__(self):
        try:
            from filterpy.kalman import KalmanFilter
            self.kf = KalmanFilter(dim_x=3, dim_z=3)
            self.kf.F = np.eye(3)
            self.kf.H = np.eye(3)
            self.kf.Q = np.diag([0.5, 2.0, 1.5])
            self.kf.R = np.diag([1.0, 3.0, 1.5])
            self.kf.P = np.eye(3) * 100.0
            self._use_kf = True
        except ImportError:
            logger.warning("filterpy not installed — using pass-through estimator")
            self._use_kf = False
        self._initialised = False

    def update(
        self,
        load_mw: float,
        renewable_mw: float,
        grid_mw: float,
        load_reliable: bool = True,
        renewable_reliable: bool = True,
        grid_reliable: bool = True,
    ) -> dict:
        z = np.array([load_mw, renewable_mw, grid_mw])

        if self._use_kf:
            self.kf.R = np.diag([
                1.0  if load_reliable      else 1e6,
                3.0  if renewable_reliable else 1e6,
                1.5  if grid_reliable      else 1e6,
            ])
            if not self._initialised:
                self.kf.x = z.reshape(3, 1)
                self._initialised = True
            else:
                self.kf.predict()
                self.kf.update(z)
            x = self.kf.x.flatten()
        else:
            x = z
            self._initialised = True

        return {
            "load_mw":          max(0.0, float(x[0])),
            "renewable_mw":     max(0.0, float(x[1])),
            "grid_mw":          max(0.0, float(x[2])),
            "deficit_mw":       max(0.0, float(x[0]) - float(x[1]) - float(x[2])),
            "state_cov_trace":  float(np.trace(self.kf.P)) if self._use_kf else 0.0,
        }






class FaultDetector:
    def __init__(self, window_size: int = 32):
        self.window_size = window_size
        self._buffers: dict[str, list] = {}

    def check(self, sensor_name: str, value: float, nameplate_max: Optional[float] = None) -> dict:
        if sensor_name not in self._buffers:
            self._buffers[sensor_name] = []
        buf = self._buffers[sensor_name]
        buf.append(value)
        if len(buf) > self.window_size:
            buf.pop(0)

        if nameplate_max is not None and value > nameplate_max:
            return {"reliable": False, "reason": "exceeds_nameplate", "z_score": None}
        if value < 0:
            return {"reliable": False, "reason": "negative_value", "z_score": None}
        if len(buf) >= 4:
            mean = np.mean(buf[:-1])
            std  = np.std(buf[:-1])
            if std > 0:
                z = abs(value - mean) / std
                if z > 3.0:
                    return {"reliable": False, "reason": "z_score_anomaly", "z_score": round(z, 2)}
        return {"reliable": True, "reason": "ok", "z_score": None}

    def compute_confidence(self, reliability_flags: list[bool]) -> float:
        n = len(reliability_flags)
        if n == 0:
            return 0.5
        return round(1.0 - sum(1 for r in reliability_flags if not r) / n, 4)






class AuditLogger:
    def __init__(self, log_path: str = "audit/apex_audit.jsonl"):
        self.log_path = Path(log_path)
        self.log_path.parent.mkdir(parents=True, exist_ok=True)

    def log(self, event_type: str, payload: dict):
        record = {
            "event_id":      str(uuid.uuid4()),
            "timestamp_utc": datetime.now(timezone.utc).isoformat(),
            "event_type":    event_type,
            **payload,
        }
        with open(self.log_path, "a") as f:
            f.write(json.dumps(record) + "\n")






class AppState:
    state_estimator: EnergyStateEstimator
    fault_detector:  FaultDetector
    audit_logger:    AuditLogger
    plant_config:    PlantConfig
    recent_readings: list   

app_state = AppState()






@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("APEX starting up...")

    app_state.plant_config    = PlantConfig()
    app_state.state_estimator = EnergyStateEstimator()
    app_state.fault_detector  = FaultDetector()
    app_state.audit_logger    = AuditLogger()
    app_state.recent_readings = []

    
    loaded = model_service.load(model_dir="models")
    if loaded:
        logger.info("ML model service ready")
    else:
        logger.warning(
            "ML model not found. Falling back to Kalman-only dispatch. "
            "Run: python train.py --synthetic --output models/"
        )

    app_state.audit_logger.log("system_startup", {"model_ready": loaded})
    logger.info("APEX ready | model=%s", "LSTM" if loaded else "Kalman-only")
    yield

    logger.info("APEX shutting down")
    app_state.audit_logger.log("system_shutdown", {"status": "ok"})






app = FastAPI(
    title="APEX Energy Decision System",
    version="2.0.0",
    description="Real-time AI dispatcher: LSTM forecast + MILP optimization",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)






class TimestepReading(BaseModel):
    """
    One 15-minute timestep of plant state.
    Field names match the canonical pipeline schema (load_mw, res_output_mw, ...).
    """
    timestamp:       str    = Field(..., description="ISO-8601 UTC timestamp")
    load_mw:         float  = Field(..., gt=0,  description="Total plant load (MW)")
    res_output_mw:   float  = Field(..., ge=0,  description="Renewable generation (MW)")
    grid_supply_mw:  float  = Field(..., ge=0,  description="Grid import (MW)")
    irradiance_wm2:  float  = Field(0.0, ge=0)
    wind_speed_ms:   float  = Field(0.0, ge=0)

    
    load_sensor_ok:      bool = True
    renewable_sensor_ok: bool = True
    grid_sensor_ok:      bool = True

    @field_validator("load_mw")
    @classmethod
    def load_reasonable(cls, v):
        if v > 10_000:
            raise ValueError("load_mw > 10,000 MW — likely sensor error")
        return v


class DispatchRequest(BaseModel):
    """
    Standard dispatch request: provide a sliding window of recent timesteps.
    Minimum 1 reading (Kalman-only fallback). LSTM activates at >= seq_len (16).
    """
    history: List[TimestepReading] = Field(
        ..., min_length=1, description="Recent timesteps, oldest first"
    )
    beta: float = Field(1.0, ge=0.5, le=5.0, description="ESG weight β")
    elapsed_incident_minutes: float = Field(
        0.0, ge=0.0, description="Minutes since deficit started (controls diesel ramp)"
    )
    override_deficit_mw: Optional[float] = Field(
        None, ge=0.0, description="Operator manual override for deficit"
    )


class DispatchResponse(BaseModel):
    request_id:        str
    timestamp_utc:     str
    sensor_confidence: float
    estimated_state:   dict
    forecast:          dict
    decision:          dict
    audit_id:          str
    latency_ms:        float






def _adaptive_beta(base_beta: float, sensor_confidence: float) -> float:
    """Slightly increase β (eco-weighting) when sensors are unreliable."""
    penalty = max(0.0, (0.8 - sensor_confidence) * 0.5)
    return min(base_beta + penalty, 3.5)


def _build_window_df(history: List[TimestepReading]) -> pd.DataFrame:
    """Convert list of TimestepReading → UTC-indexed DataFrame for model_service."""
    rows = []
    for r in history:
        rows.append({
            "timestamp":      pd.Timestamp(r.timestamp, tz="UTC")
                              if "+" not in r.timestamp and "Z" not in r.timestamp
                              else pd.Timestamp(r.timestamp).tz_convert("UTC"),
            "load_mw":        r.load_mw,
            "res_output_mw":  r.res_output_mw,
            "grid_supply_mw": r.grid_supply_mw,
            "irradiance_wm2": r.irradiance_wm2,
            "wind_speed_ms":  r.wind_speed_ms,
        })
    df = pd.DataFrame(rows).set_index("timestamp")
    df = df.rename_axis("timestamp")
    return df






@app.get("/health")
async def health():
    ms = model_service.stats()
    return {
        "status":           "ok",
        "model_loaded":     ms["model_loaded"],
        "predict_calls":    ms["predict_calls"],
        "calibration_active": ms["calibration_active"],
        "timestamp_utc":    datetime.now(timezone.utc).isoformat(),
    }


@app.post("/dispatch", response_model=DispatchResponse)
async def dispatch(request: DispatchRequest, background_tasks: BackgroundTasks):
    """
    Main decision endpoint.

    Pipeline:
      1. Fault detection on latest sensor reading
      2. Kalman filter state estimation
      3. LSTM forecast via model_service.predict() → P50, P90
      4. P90 calibration via model_service.calibrate_p90()
      5. MILP optimization (passes P90 as conservative deficit to solver)
      6. Async audit log
      7. Return full decision

    Response time target: < 100 ms (MILP ~5–20 ms, LSTM ~10–30 ms on CPU)
    """
    t_start    = time.perf_counter()
    request_id = str(uuid.uuid4())

    
    latest = request.history[-1]

    
    fd = app_state.fault_detector
    load_chk  = fd.check("load",      latest.load_mw,       nameplate_max=2000.0)
    res_chk   = fd.check("renewable", latest.res_output_mw, nameplate_max=300.0)
    grid_chk  = fd.check("grid",      latest.grid_supply_mw,nameplate_max=500.0)

    load_rel  = latest.load_sensor_ok      and load_chk["reliable"]
    res_rel   = latest.renewable_sensor_ok and res_chk["reliable"]
    grid_rel  = latest.grid_sensor_ok      and grid_chk["reliable"]

    sensor_confidence = fd.compute_confidence([load_rel, res_rel, grid_rel])

    
    estimated = app_state.state_estimator.update(
        load_mw=latest.load_mw,
        renewable_mw=latest.res_output_mw,
        grid_mw=latest.grid_supply_mw,
        load_reliable=load_rel,
        renewable_reliable=res_rel,
        grid_reliable=grid_rel,
    )
    kalman_deficit = estimated["deficit_mw"]

    
    effective_deficit = (
        request.override_deficit_mw
        if request.override_deficit_mw is not None
        else kalman_deficit
    )

    
    forecast = {
        "p50_mw":    round(effective_deficit, 3),
        "p90_mw":    round(effective_deficit, 3),
        "p90_cal_mw": round(effective_deficit * 1.03, 3),  
        "source":    "kalman_only",
        "seq_len":   0,
    }

    if model_service.is_ready() and len(request.history) >= 2:
        try:
            window_df = _build_window_df(request.history)
            lstm_out  = model_service.predict(window_df)
            forecast  = {
                "p50_mw":     lstm_out["p50"],
                "p90_mw":     lstm_out["p90"],
                "p90_cal_mw": lstm_out["p90_cal"],
                "source":     lstm_out["source"],
                "seq_len":    lstm_out["seq_len"],
            }
            
            effective_deficit = lstm_out["p90_cal"]
        except Exception as e:
            logger.warning("LSTM forecast failed (Kalman fallback): %s", e)

    
    effective_beta = _adaptive_beta(request.beta, sensor_confidence)

    
    opt_input = OptimizationInput(
        deficit_mw=max(0.0, effective_deficit),
        beta=effective_beta,
        sensor_confidence=sensor_confidence,
        elapsed_minutes=request.elapsed_incident_minutes,
        plant_config=app_state.plant_config,
    )
    try:
        result: OptimizationResult = solve_dispatch(opt_input)
    except Exception as e:
        logger.error("Optimizer error: %s", e)
        raise HTTPException(status_code=500, detail=f"Optimizer error: {e}")

    
    latency_ms = round((time.perf_counter() - t_start) * 1000, 2)
    audit_id   = str(uuid.uuid4())

    decision = {
        "diesel_mw":           result.diesel_mw,
        "hvac_shed":           result.hvac_shed,
        "pump_shed":           result.pump_shed,
        "rolling_full_shed":   result.rolling_full_shed,
        "rolling_partial_mw":  result.rolling_partial_mw,
        "power_covered_mw":    result.power_covered_mw,
        "total_cost_hr":       result.total_cost_hr,
        "baseline_cost_hr":    result.baseline_cost_hr,
        "savings_hr":          result.savings_hr,
        "savings_pct":         result.savings_pct,
        "co2_tonnes_hr":       result.co2_tonnes_hr,
        "phase":               result.phase,
        "solver_status":       result.solver_status,
        "solve_time_ms":       result.solve_time_ms,
        "beta_used":           result.beta_used,
        "cost_breakdown": {
            "diesel_fuel":  result.diesel_fuel_cost_hr,
            "co2_penalty":  result.co2_cost_hr,
            "hvac":         result.hvac_cost_hr,
            "pump":         result.pump_cost_hr,
            "rolling":      result.rolling_cost_hr,
            "risk_buffer":  result.risk_penalty_hr,
        },
    }

    
    background_tasks.add_task(
        app_state.audit_logger.log,
        "dispatch_decision",
        {
            "audit_id":             audit_id,
            "request_id":           request_id,
            "sensor_confidence":    sensor_confidence,
            "kalman_deficit_mw":    kalman_deficit,
            "effective_deficit_mw": effective_deficit,
            "forecast":             forecast,
            "decision":             decision,
            "latency_ms":           latency_ms,
            "fault_flags":          {"load": load_chk, "renewable": res_chk, "grid": grid_chk},
            "n_history":            len(request.history),
        },
    )

    return DispatchResponse(
        request_id=request_id,
        timestamp_utc=datetime.now(timezone.utc).isoformat(),
        sensor_confidence=sensor_confidence,
        estimated_state=estimated,
        forecast=forecast,
        decision=decision,
        audit_id=audit_id,
        latency_ms=latency_ms,
    )






class FeedbackRequest(BaseModel):
    actual_deficit_mw: float = Field(..., ge=0)
    pred_p90_mw:       float = Field(..., ge=0)
    context:           Optional[str] = None

@app.post("/feedback")
async def feedback(req: FeedbackRequest):
    """
    Feed the true observed deficit back into the calibration ring buffer.
    Call this ~15 min after each dispatch once actual consumption is known.
    """
    model_service.record_actual(req.actual_deficit_mw, req.pred_p90_mw)
    return {
        "status":   "recorded",
        "residual": round(req.actual_deficit_mw - req.pred_p90_mw, 4),
        "buffer_size": model_service.stats()["calibration_samples"],
    }






@app.get("/audit/recent")
async def get_recent_audit(limit: int = 20):
    log_path = Path("audit/apex_audit.jsonl")
    if not log_path.exists():
        return {"records": [], "total": 0}
    lines   = log_path.read_text().strip().split("\n")
    records = [json.loads(line) for line in lines if line.strip()]
    return {"records": records[-limit:], "total": len(records)}


@app.get("/pareto")
async def pareto_frontier(
    deficit_mw:        float = 90.0,
    elapsed_minutes:   float = 5.0,
    sensor_confidence: float = 1.0,
):
    """Compute cost vs CO₂ Pareto frontier across β values."""
    results = []
    for beta in [0.5, 1.0, 1.5, 2.0, 2.5, 3.0]:
        r = solve_dispatch(OptimizationInput(
            deficit_mw=deficit_mw,
            beta=beta,
            sensor_confidence=sensor_confidence,
            elapsed_minutes=elapsed_minutes,
            plant_config=app_state.plant_config,
        ))
        results.append({
            "beta": beta,
            "total_cost_hr": r.total_cost_hr,
            "co2_tonnes_hr": r.co2_tonnes_hr,
            "diesel_mw":     r.diesel_mw,
            "savings_pct":   r.savings_pct,
        })
    return {"deficit_mw": deficit_mw, "pareto_points": results}


@app.get("/status")
async def system_status():
    ms = model_service.stats()
    return {
        **ms,
        "recent_readings_count": len(app_state.recent_readings),
        "kalman_initialised":    app_state.state_estimator._initialised,
        "plant_config":          app_state.plant_config.__dict__,
    }
