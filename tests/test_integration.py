"""
APEX — Integration Tests (no mocks, real implementations)
Run: pytest tests/test_integration.py -v
"""
from __future__ import annotations
import asyncio, json, time
from pathlib import Path
import numpy as np
import pytest

# ── Kalman ──────────────────────────────────────────────────────────────────

class TestKalmanFilter:
    def setup_method(self):
        from backend.kalman import EnergyStateEstimator, KalmanConfig, SensorReading
        self.kf = EnergyStateEstimator(KalmanConfig(), np.array([500., 150., 350.]))
        self.SensorReading = SensorReading

    def _r(self, load=500., res=150., grid=350., faults=None):
        return self.SensorReading(time.time(), load, res, grid, faults or {})

    def test_nominal_returns_output(self):
        from backend.kalman import KalmanOutput
        assert isinstance(self.kf.update(self._r()), KalmanOutput)

    def test_deficit_near_zero_balanced(self):
        out = self.kf.update(self._r())
        assert 0.0 <= out.deficit_est < 10.0

    def test_deficit_positive_when_res_drops(self):
        for _ in range(5): self.kf.update(self._r())
        out = self.kf.update(self._r(res=60))
        assert out.deficit_est > 30.0

    def test_fault_reduces_active_count(self):
        out = self.kf.update(self._r(faults={"res": True}))
        assert out.n_sensors_active == 2

    def test_all_faulted_no_crash(self):
        out = self.kf.update(self._r(faults={"scada": True, "res": True, "grid": True}))
        assert out.P_load_est > 0

    def test_state_nonnegative(self):
        for _ in range(10): self.kf.update(self._r())
        out = self.kf.update(self._r(load=50, res=200, grid=0))
        assert out.P_load_est >= 0 and out.P_renewable_est >= 0


# ── Fault detector ───────────────────────────────────────────────────────────

class TestFaultDetector:
    def setup_method(self):
        from backend.fault_detector import FaultDetector, SensorSpec, FaultConfig
        self.det = FaultDetector([
            SensorSpec("scada", 600.), SensorSpec("res", 200.), SensorSpec("grid", 400.)
        ], FaultConfig(zscore_min_warmup=5))

    def test_nominal_not_flagged(self):
        r = self.det.check({"scada": 495., "res": 148., "grid": 347.})
        assert r.w_score == 1.0

    def test_nameplate_exceeded_flagged(self):
        r = self.det.check({"scada": 750., "res": 148., "grid": 347.})
        assert r.faults["scada"].flagged

    def test_zero_dropout_after_threshold(self):
        for _ in range(3): r = self.det.check({"scada": 495., "res": 0., "grid": 347.})
        assert r.faults["res"].flagged

    def test_w_score_formula(self):
        r = self.det.check({"scada": 750., "res": 148., "grid": 347.})
        assert abs(r.w_score - 2/3) < 0.01

    def test_missing_sensor_flagged(self):
        r = self.det.check({"scada": 495., "grid": 347.})
        assert r.faults["res"].flagged

    def test_negative_flagged(self):
        r = self.det.check({"scada": -10., "res": 148., "grid": 347.})
        assert r.faults["scada"].flagged


# ── Optimizer ────────────────────────────────────────────────────────────────

class TestOptimizer:
    def test_phase2_covers_deficit(self):
        from backend.optimizer import solve_dispatch, OptimizationInput
        result = solve_dispatch(OptimizationInput(deficit_mw=90, beta=1.0, sensor_confidence=1.0, elapsed_minutes=5))
        mw = (result.diesel_mw + (20 if result.hvac_shed else 0) +
              (30 if result.pump_shed else 0) + (40 if result.rolling_full_shed else 0) +
              result.rolling_partial_mw)
        assert mw >= 89.9

    def test_phase1_diesel_zero(self):
        from backend.optimizer import solve_dispatch, OptimizationInput
        r = solve_dispatch(OptimizationInput(deficit_mw=90, beta=1.0, sensor_confidence=1.0, elapsed_minutes=1.0))
        assert r.diesel_mw < 0.01

    def test_optimized_cheaper_than_baseline(self):
        from backend.optimizer import solve_dispatch, OptimizationInput
        r = solve_dispatch(OptimizationInput(deficit_mw=90, beta=1.0, sensor_confidence=1.0, elapsed_minutes=10))
        assert r.total_cost_hr < r.baseline_cost_hr

    def test_high_beta_less_diesel(self):
        from backend.optimizer import solve_dispatch, OptimizationInput
        r1 = solve_dispatch(OptimizationInput(90, 1.0, 1.0, 10))
        r3 = solve_dispatch(OptimizationInput(90, 3.0, 1.0, 10))
        assert r3.diesel_mw <= r1.diesel_mw + 0.01

    def test_low_w_higher_cost(self):
        from backend.optimizer import solve_dispatch, OptimizationInput
        rg = solve_dispatch(OptimizationInput(90, 1.0, 1.0,  10))
        rb = solve_dispatch(OptimizationInput(90, 1.0, 0.5, 10))
        assert rb.total_cost_hr >= rg.total_cost_hr - 0.01


# ── Data pipeline ────────────────────────────────────────────────────────────

class TestDataPipeline:
    def test_synthetic_shape(self):
        from backend.data_pipeline import SyntheticGenerator
        df = SyntheticGenerator().generate(periods_days=7)
        assert len(df) == 7 * 24 * 4
        assert "load_mw" in df.columns

    def test_pipeline_produces_sequences(self):
        from backend.data_pipeline import DataPipeline, SyntheticGenerator
        df = SyntheticGenerator().generate(periods_days=60)
        X_tr, y_tr, X_v, y_v = DataPipeline().fit_transform(df)
        assert X_tr.ndim == 3 and X_tr.shape[1] == 16

    def test_deficit_nonnegative(self):
        from backend.data_pipeline import DataPipeline, SyntheticGenerator
        df = SyntheticGenerator().generate(periods_days=30)
        _, y_tr, _, y_v = DataPipeline().fit_transform(df)
        assert (y_tr >= 0).all() and (y_v >= 0).all()


# ── Audit logger ─────────────────────────────────────────────────────────────

class TestAuditLogger:
    def test_chain_integrity(self, tmp_path):
        from backend.audit import AuditLogger, AuditRecord, verify_chain
        logger = AuditLogger(tmp_path)
        async def run():
            await logger.startup()
            for _ in range(5):
                await logger.log(AuditRecord(event_type="dispatch", total_cost_hr=1000.))
            await asyncio.sleep(0.2)
            await logger.shutdown()
        asyncio.run(run())
        files = list(tmp_path.glob("*.jsonl"))
        assert len(files) == 1
        valid, broken = verify_chain(files[0])
        assert valid and broken is None

    def test_tamper_detected(self, tmp_path):
        from backend.audit import AuditLogger, AuditRecord, verify_chain
        logger = AuditLogger(tmp_path)
        async def run():
            await logger.startup()
            await logger.log(AuditRecord(event_type="dispatch", total_cost_hr=100.))
            await logger.log(AuditRecord(event_type="dispatch", total_cost_hr=200.))
            await asyncio.sleep(0.2)
            await logger.shutdown()
        asyncio.run(run())
        path = list(tmp_path.glob("*.jsonl"))[0]
        lines = path.read_text().strip().split("\n")
        rec = json.loads(lines[1]); rec["total_cost_hr"] = 999999.
        lines[1] = json.dumps(rec)
        path.write_text("\n".join(lines) + "\n")
        valid, broken = verify_chain(path)
        assert not valid and broken is not None


# ── Config ───────────────────────────────────────────────────────────────────

class TestConfig:
    def test_diesel_cce(self):
        from backend.config import Settings
        assert abs(Settings().diesel_cce - 231.0) < 0.01

    def test_phase_fractions(self):
        from backend.config import Settings
        s = Settings()
        assert abs(s.phase1_fraction + s.phase2_fraction - 1.0) < 1e-9
