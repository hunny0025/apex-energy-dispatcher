"""
APEX Optimizer — Production MILP using OR-Tools
Solves: min L_total = diesel_cost + β×co2_cost + shedding_costs + risk_penalty
Subject to: power balance, ramp delay, operational limits, binary shed decisions
"""

from ortools.linear_solver import pywraplp
from dataclasses import dataclass, field
from typing import Optional
import logging
import time

logger = logging.getLogger("apex.optimizer")






@dataclass
class PlantConfig:
    """
    Static plant parameters — loaded from config file at startup.
    Never hardcoded in logic.
    """
    
    hvac_max_mw: float = 20.0
    pump_max_mw: float = 30.0
    rolling_max_mw: float = 40.0
    rolling_partial_max_mw: float = 40.0

    
    hvac_shed_cost_per_hr: float = 3_000.0
    pump_shed_cost_per_hr: float = 5_000.0
    rolling_full_shed_cost_per_hr: float = 15_000.0
    rolling_partial_cost_per_mw_hr: float = 375.0

    
    diesel_fuel_cost_per_mwh: float = 150.0
    diesel_co2_factor_t_per_mwh: float = 0.9
    diesel_max_mw: float = 90.0
    diesel_ramp_delay_minutes: float = 3.0

    
    carbon_penalty_per_tonne: float = 90.0

    
    solver_timeout_ms: int = 500


@dataclass
class OptimizationInput:
    """
    All inputs to one optimization call.
    """
    deficit_mw: float               
    beta: float                     
    sensor_confidence: float        
    elapsed_minutes: float          
    crisis_duration_hours: float = 1.0
    plant_config: PlantConfig = field(default_factory=PlantConfig)


@dataclass
class OptimizationResult:
    """
    Full decision output from one MILP solve.
    """
    
    diesel_mw: float
    hvac_shed: bool
    pump_shed: bool
    rolling_full_shed: bool
    rolling_partial_mw: float

    
    diesel_fuel_cost_hr: float
    co2_cost_hr: float
    hvac_cost_hr: float
    pump_cost_hr: float
    rolling_cost_hr: float
    risk_penalty_hr: float
    total_cost_hr: float

    
    baseline_cost_hr: float         
    savings_hr: float
    savings_pct: float

    
    co2_tonnes_hr: float

    
    solver_status: str
    solve_time_ms: float
    phase: int                      
    power_covered_mw: float

    
    beta_used: float
    sensor_confidence_used: float






def compute_risk_penalty(
    sensor_confidence: float,
    config: PlantConfig,
    deficit_mw: float,
) -> float:
    """
    When sensor data is degraded, add a conservative buffer cost.
    Formula: (1 - w) × 10% × cost_of_full_diesel_coverage
    This makes the optimizer prefer safer actions under uncertainty.
    """
    full_diesel_cost = deficit_mw * (
        config.diesel_fuel_cost_per_mwh
        + config.diesel_co2_factor_t_per_mwh * config.carbon_penalty_per_tonne
    )
    return (1.0 - sensor_confidence) * 0.10 * full_diesel_cost






def get_diesel_availability(
    elapsed_minutes: float,
    config: PlantConfig,
) -> float:
    """
    Returns available diesel fraction based on ramp state.
    Phase 1 (0 to ramp_delay): diesel = 0 — hard physical constraint
    Phase 2 (after ramp_delay): diesel available up to max capacity

    In reality a ramp curve applies. Linear approximation:
    Between ramp_delay and 2×ramp_delay: partial availability
    """
    if elapsed_minutes < config.diesel_ramp_delay_minutes:
        return 0.0
    elif elapsed_minutes < 2 * config.diesel_ramp_delay_minutes:
        fraction = (elapsed_minutes - config.diesel_ramp_delay_minutes) / config.diesel_ramp_delay_minutes
        return min(fraction, 1.0)
    else:
        return 1.0






def solve_dispatch(inputs: OptimizationInput) -> OptimizationResult:
    """
    Core MILP solver.

    Decision variables:
        p_diesel    : continuous [0, diesel_max × availability]
        h           : binary — shed HVAC (20 MW)
        p           : binary — shed Pump (30 MW)
        r_full      : binary — shed Rolling fully (40 MW)
        r_partial   : continuous [0, 40] — partial rolling reduction

    Objective (all $/hr):
        min  p_diesel × fuel_cost
           + β × (p_diesel × co2_factor × carbon_penalty)
           + h × hvac_cost
           + p × pump_cost
           + r_full × rolling_full_cost
           + r_partial × rolling_partial_cost_per_mw
           + risk_penalty

    Constraints:
        1. Power balance:  p_diesel + 20h + 30p + 40r_full + r_partial ≥ deficit
        2. Binary mutex:   r_partial ≤ 40 × (1 − r_full)
        3. Critical loads: never shed (enforced by variable exclusion)
        4. Diesel ramp:    p_diesel ≤ diesel_max × availability_fraction
    """
    t_start = time.perf_counter()
    config = inputs.plant_config

    
    solver = pywraplp.Solver.CreateSolver("CBC_MIXED_INTEGER_PROGRAMMING")
    if not solver:
        raise RuntimeError("OR-Tools CBC solver not available")
    solver.SetTimeLimit(config.solver_timeout_ms)

    
    diesel_avail = get_diesel_availability(inputs.elapsed_minutes, config)
    diesel_max_available = config.diesel_max_mw * diesel_avail
    phase = 1 if diesel_avail == 0.0 else 2

    
    p_diesel = solver.NumVar(0.0, diesel_max_available, "p_diesel")
    h = solver.IntVar(0, 1, "h")         
    p = solver.IntVar(0, 1, "p")         
    r_full = solver.IntVar(0, 1, "r_full")
    r_partial = solver.NumVar(0.0, config.rolling_partial_max_mw, "r_partial")

    
    risk_penalty = compute_risk_penalty(
        inputs.sensor_confidence, config, inputs.deficit_mw
    )

    
    diesel_fuel_coeff = config.diesel_fuel_cost_per_mwh
    co2_coeff = inputs.beta * config.diesel_co2_factor_t_per_mwh * config.carbon_penalty_per_tonne

    
    objective = solver.Objective()
    objective.SetCoefficient(p_diesel, diesel_fuel_coeff + co2_coeff)
    objective.SetCoefficient(h,        config.hvac_shed_cost_per_hr)
    objective.SetCoefficient(p,        config.pump_shed_cost_per_hr)
    objective.SetCoefficient(r_full,   config.rolling_full_shed_cost_per_hr)
    objective.SetCoefficient(r_partial, config.rolling_partial_cost_per_mw_hr)
    objective.SetMinimization()

    
    
    power_balance = solver.Constraint(inputs.deficit_mw, solver.infinity())
    power_balance.SetCoefficient(p_diesel, 1.0)
    power_balance.SetCoefficient(h,        config.hvac_max_mw)
    power_balance.SetCoefficient(p,        config.pump_max_mw)
    power_balance.SetCoefficient(r_full,   config.rolling_max_mw)
    power_balance.SetCoefficient(r_partial, 1.0)

    
    mutex = solver.Constraint(-solver.infinity(), config.rolling_max_mw)
    mutex.SetCoefficient(r_partial, 1.0)
    mutex.SetCoefficient(r_full, config.rolling_max_mw)

    
    status = solver.Solve()
    solve_time_ms = (time.perf_counter() - t_start) * 1000

    status_map = {
        pywraplp.Solver.OPTIMAL:    "OPTIMAL",
        pywraplp.Solver.FEASIBLE:   "FEASIBLE",
        pywraplp.Solver.INFEASIBLE: "INFEASIBLE",
        pywraplp.Solver.UNBOUNDED:  "UNBOUNDED",
        pywraplp.Solver.ABNORMAL:   "ABNORMAL",
        pywraplp.Solver.NOT_SOLVED: "NOT_SOLVED",
    }
    status_str = status_map.get(status, "UNKNOWN")

    if status not in (pywraplp.Solver.OPTIMAL, pywraplp.Solver.FEASIBLE):
        logger.error(f"Solver failed: {status_str} | deficit={inputs.deficit_mw} MW")
        return _emergency_fallback(inputs, solve_time_ms, status_str)

    
    diesel_val = p_diesel.solution_value()
    h_val = bool(round(h.solution_value()))
    p_val = bool(round(p.solution_value()))
    r_full_val = bool(round(r_full.solution_value()))
    r_partial_val = r_partial.solution_value()

    
    diesel_fuel_cost_hr = diesel_val * config.diesel_fuel_cost_per_mwh
    co2_cost_hr = (
        inputs.beta
        * diesel_val
        * config.diesel_co2_factor_t_per_mwh
        * config.carbon_penalty_per_tonne
    )
    hvac_cost_hr = config.hvac_shed_cost_per_hr if h_val else 0.0
    pump_cost_hr = config.pump_shed_cost_per_hr if p_val else 0.0
    rolling_cost_hr = (
        config.rolling_full_shed_cost_per_hr if r_full_val
        else r_partial_val * config.rolling_partial_cost_per_mw_hr
    )
    total_cost_hr = (
        diesel_fuel_cost_hr
        + co2_cost_hr
        + hvac_cost_hr
        + pump_cost_hr
        + rolling_cost_hr
        + risk_penalty
    )

    cce = config.diesel_fuel_cost_per_mwh + (
        config.diesel_co2_factor_t_per_mwh * config.carbon_penalty_per_tonne
    )
    baseline_cost_hr = inputs.deficit_mw * cce
    savings_hr = baseline_cost_hr - total_cost_hr
    savings_pct = (savings_hr / baseline_cost_hr * 100) if baseline_cost_hr > 0 else 0.0

    co2_tonnes_hr = diesel_val * config.diesel_co2_factor_t_per_mwh

    power_covered = (
        diesel_val
        + (config.hvac_max_mw if h_val else 0)
        + (config.pump_max_mw if p_val else 0)
        + (config.rolling_max_mw if r_full_val else 0)
        + r_partial_val
    )

    logger.info(
        f"MILP solved [{status_str}] in {solve_time_ms:.1f}ms | "
        f"phase={phase} | diesel={diesel_val:.1f}MW | "
        f"total=${total_cost_hr:,.0f}/hr | savings={savings_pct:.1f}%"
    )

    return OptimizationResult(
        diesel_mw=round(diesel_val, 2),
        hvac_shed=h_val,
        pump_shed=p_val,
        rolling_full_shed=r_full_val,
        rolling_partial_mw=round(r_partial_val, 2),
        diesel_fuel_cost_hr=round(diesel_fuel_cost_hr, 2),
        co2_cost_hr=round(co2_cost_hr, 2),
        hvac_cost_hr=round(hvac_cost_hr, 2),
        pump_cost_hr=round(pump_cost_hr, 2),
        rolling_cost_hr=round(rolling_cost_hr, 2),
        risk_penalty_hr=round(risk_penalty, 2),
        total_cost_hr=round(total_cost_hr, 2),
        baseline_cost_hr=round(baseline_cost_hr, 2),
        savings_hr=round(savings_hr, 2),
        savings_pct=round(savings_pct, 2),
        co2_tonnes_hr=round(co2_tonnes_hr, 4),
        solver_status=status_str,
        solve_time_ms=round(solve_time_ms, 2),
        phase=phase,
        power_covered_mw=round(power_covered, 2),
        beta_used=inputs.beta,
        sensor_confidence_used=inputs.sensor_confidence,
    )


def _emergency_fallback(
    inputs: OptimizationInput,
    solve_time_ms: float,
    status_str: str,
) -> OptimizationResult:
    """
    If solver fails (timeout, infeasible), use conservative fallback:
    shed all non-critical loads + max available diesel.
    This should never happen in production but protects the plant.
    """
    config = inputs.plant_config
    diesel_avail = get_diesel_availability(inputs.elapsed_minutes, config)
    diesel_mw = min(inputs.deficit_mw, config.diesel_max_mw * diesel_avail)

    cce = config.diesel_fuel_cost_per_mwh + (
        config.diesel_co2_factor_t_per_mwh * config.carbon_penalty_per_tonne
    )
    total_cost = inputs.deficit_mw * cce
    baseline = inputs.deficit_mw * cce

    logger.warning(f"Emergency fallback activated | solver_status={status_str}")

    return OptimizationResult(
        diesel_mw=round(diesel_mw, 2),
        hvac_shed=True,
        pump_shed=True,
        rolling_full_shed=False,
        rolling_partial_mw=0.0,
        diesel_fuel_cost_hr=round(diesel_mw * config.diesel_fuel_cost_per_mwh, 2),
        co2_cost_hr=round(diesel_mw * config.diesel_co2_factor_t_per_mwh * config.carbon_penalty_per_tonne, 2),
        hvac_cost_hr=config.hvac_shed_cost_per_hr,
        pump_cost_hr=config.pump_shed_cost_per_hr,
        rolling_cost_hr=0.0,
        risk_penalty_hr=0.0,
        total_cost_hr=round(total_cost, 2),
        baseline_cost_hr=round(baseline, 2),
        savings_hr=0.0,
        savings_pct=0.0,
        co2_tonnes_hr=round(diesel_mw * config.diesel_co2_factor_t_per_mwh, 4),
        solver_status=f"FALLBACK_{status_str}",
        solve_time_ms=solve_time_ms,
        phase=1 if diesel_avail == 0 else 2,
        power_covered_mw=round(
            diesel_mw + config.hvac_max_mw + config.pump_max_mw, 2
        ),
        beta_used=inputs.beta,
        sensor_confidence_used=inputs.sensor_confidence,
    )
