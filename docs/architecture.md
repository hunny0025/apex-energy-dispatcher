# APEX — Full System Architecture

## Overview

APEX is a **modular monolith** designed for edge deployment.
Each layer can be extracted to a microservice as the system scales.

---

## Layered Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  LAYER 7 — FRONTEND (Dashboard)                             │
│  React + WebSocket + Chart.js                               │
│  Live dispatch status | Cost breakdown | Pareto slider      │
└─────────────────────────┬───────────────────────────────────┘
                          │ HTTP / WebSocket
┌─────────────────────────▼───────────────────────────────────┐
│  LAYER 6 — API (FastAPI)                                    │
│  main.py                                                    │
│  POST /dispatch  POST /feedback  GET /pareto  GET /status   │
└──────┬──────────────┬──────────────┬──────────────┬─────────┘
       │              │              │              │
┌──────▼──────┐ ┌─────▼──────┐ ┌────▼────┐ ┌──────▼──────┐
│  LAYER 5    │ │  LAYER 5   │ │ LAYER 5 │ │  LAYER 5    │
│ MODEL SERV. │ │  ESTIMATOR │ │ OPTIM.  │ │  AUDIT      │
│service.py   │ │  Kalman    │ │optim.py │ │ AuditLogger │
│LSTM + CALIB │ │  Filter    │ │  MILP   │ │  JSONL      │
└──────┬──────┘ └─────┬──────┘ └────┬────┘ └─────────────┘
       │              │              │
┌──────▼──────────────▼──────────────▼──────────────────────┐
│  LAYER 4 — PROCESSING                                      │
│  FaultDetector (Z-score + Nameplate)                       │
│  DataPipeline (Scaling + Feature Engineering)              │
└─────────────────────────┬──────────────────────────────────┘
                          │
┌─────────────────────────▼──────────────────────────────────┐
│  LAYER 3 — SCADA ADAPTER                                   │
│  OPC-UA / MQTT Client                                      │
│  Polls energy tags every 60s                               │
└─────────────────────────┬──────────────────────────────────┘
                          │
┌─────────────────────────▼──────────────────────────────────┐
│  LAYER 2 — PLANT SENSORS                                   │
│  Load / Solar / Wind / Grid Meters                         │
└────────────────────────────────────────────────────────────┘
```

---

## Data Flow — The "Dispatch Loop"

Every 60 seconds, the system executes the following pipeline:

| Step | Component | Description |
|---|---|---|
| **Step 1** | **Input** | SCADA readings ingested (Load, RES, Grid). |
| **Step 2** | **Fault Detection** | `FaultDetector` validates signal health (Z-score, Nameplate limits). |
| **Step 3** | **Kalman Filter** | `EnergyStateEstimator` filters noise and handles sensor dropouts. |
| **Step 4** | **LSTM Forecast** | `model_service` runs LSTM inference on the last 16 timesteps to predict P50/P90 deficit. |
| **Step 5** | **Calibration** | Predicted P90 is adjusted using a **Residual Calibration Layer** (Feedback Loop). |
| **Step 6** | **Optimization** | `solve_dispatch` (MILP) finds the cost-ESG optimal power allocation. |
| **Step 7** | **API / Action** | Dispatch commands returned to SCADA and logged to Audit. |

---

## Module Responsibilities

| Module | Location | Responsibility |
|---|---|---|
| **Main API** | `backend/main.py` | Orchestration, Routing, Fault Detection, Kalman Filter. |
| **Model Service**| `backend/model_service.py` | Singleton model loader, LSTM inference, P90 Calibration. |
| **Predictor** | `backend/predictor.py` | Quantile LSTM Network architecture. |
| **Optimizer** | `backend/optimizer.py` | MILP Solver logic using Google OR-Tools. |
| **Data Pipeline**| `backend/data_pipeline.py` | Pre-processing, Scaling, Feature Engineering. |

---

## Deployment & Monitoring

- **Persistence**: Models saved in `backend/models/`. Audit logs in `backend/audit/`.
- **Feedback**: `/feedback` endpoint allows the SCADA system to feed back actual deficit results to improve calibration accuracy over time.
- **Latency**: End-to-end dispatch cycle completes in < 100ms on standard edge hardware.
