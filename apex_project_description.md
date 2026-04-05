# APEX — AI Energy Dispatcher
**Comprehensive Master Documentation (Basic to Advanced)**

---

## 🟢 PART 1: THE BASICS (Overview & Setup)

### 1.1 What is APEX?
APEX is an industrial-grade, AI-powered energy dispatcher designed for real-time SCADA environments. Traditional grid management systems are reactive—they simply alert human operators *after* a sensor crosses a dangerous threshold. 

APEX is a **proactive, closed-loop system**. It ingests live, noisy data (load demands, solar/wind generation, grid limitations), predicts future failures *before* they happen, and autonomously calculates the absolute most cost-effective and environmentally friendly way to fix the problem using an advanced mathematical solver.

### 1.2 Folder Structure
The repository is split into two independent services:
- `/frontend/` — A React + Tailwind dashboard emulating a Bloomberg Terminal.
- `/backend/` — A Python FastAPI server housing the PyTorch Machine Learning models and mathematical optimizers.

### 1.3 How to Run Locally
**Terminal 1 (Backend):**
```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 10000 --reload
```

**Terminal 2 (Frontend):**
```bash
cd frontend
npm install
npm run dev
```

---

## 🟡 PART 2: INTERMEDIATE (The Control Interface)

The frontend is specifically designed to look exactly like mission-critical software. It actively forbids native browser scrolling (`overflow-hidden`), forcing all components into a mathematically calculated Flex/CSS-Grid that perfectly hugs the edges of any 1080p, 1440p, or 4K monitor. 

It is divided into 4 specific sub-dashboards on the left navigation rail:

### 2.1 Command Center
- **Top Metric Cards**: Displays the raw Plant State (Load vs Renewables vs Grid Supply).
- **Power Flow Terminal**: A massive `Recharts` AreaChart visualizing the live interaction between supply and demand.
- **Dispatch Action**: Changes dynamically from `NOMINAL` (safe) to `DISPATCH RSV` (using backup diesel) to `SHED LOAD` (forced blackouts).

### 2.2 Risk Analysis
- **Forecast Band Validation**: A chart explicitly visualizing the AI's P50 (expected) forecast vs the P90 (worst-case boundary) forecast.
- **Temporal Heatmap**: A scatter plot tracing the Risk Level (`LOW`/`MED`/`HIGH`) over time.

### 2.3 What-If Simulator (Interactive)
Allows judges/operators to intentionally try to "break" the system by sliding manual overrides:
- **Load Bias Slider**: Synthetically increases consumer demand.
- **Renewable Bias Slider**: Synthetically drops solar/wind generation.
- **ESG Beta (β) Slider**: Alters how much the system cares about carbon emissions vs financial costs.
- **Decision Cost Impaction Chart**: Cost breakdown mapping Diesel OPEX against Load Shed Penalties in real-time.

### 2.4 System Audit
- **Compute Latency**: Monitors the exact millisecond ping time of the Base Inference (LSTM prediction) vs the MILP Optimization routing.
- **Neural Network Calibration**: Overlays the realized, real-world data against the model's historical predictions to prove that the AI is accurately bounding the problem.

---

## 🔴 PART 3: ADVANCED (The Intelligence Architecture)

APEX calculates decisions through a strict, 3-phase technical pipeline residing in `main.py`.

### Phase 1: State Estimation (`EnergyStateEstimator`)
Raw SCADA sensors suffer from electrical noise, packet loss, and drift. APEX routes the raw incoming JSON stream through a **Kalman Filter** (`FilterPy`). The state estimator uses matrix mathematics to track the true energy state, smoothing out anomalous sensor spikes and guaranteeing the ML model isn't poisoned by bad readings.

### Phase 2: Probabilistic Sequence Forecasting (`DeficitPredictor`)
Filtered data passes into a **Long Short-Term Memory (LSTM)** Neural Network built in PyTorch. 
- *The Innovation*: Standard models output a single point (e.g., "Demand will be 100MW"). APEX uses a highly specialized **Quantile Loss Function** to project probabilistic bounds.
  - **q=0.50 (P50)**: The median expectation.
  - **q=0.90 (P90)**: The 90th percentile risk threshold.
Instead of managing the nominal state, APEX optimizes exclusively against the P90 band to guarantee the grid survives severe, unexpected outlier events.

### Phase 3: MILP Dispatch Optimization (`Google OR-Tools`)
Once the LSTM predicts an unavoidable P90 deficit, APEX must figure out how to mitigate it. It boots up a Mixed-Integer Linear Programming (MILP) solver.
- **The Constraints**: The plant has a limit on diesel generation and a massive financial penalty ($3,000/MW) for cutting power to corporate clients (Load Shedding).
- **The ESG Shift**: The system evaluates the `Beta (β)` variable. If `β` is low, the solver relies on cheap diesel. If `β` is high, diesel's synthetic carbon-penalty cost skyrockets, forcing the solver to choose targeted load shedding instead to meet environmental regulations.

---

## 🛠️ PART 4: PRODUCTION & MLOPS

APEX is structured for enterprise cloud deployment:

### Custom MLOps Pipeline
Because real SCADA datasets are heavily protected, the APEX backend contains an automated synthetic data factory. 
Running `python train.py --synthetic` will mathematically generate 365 days of cyclic, noisy factory load data and perfectly correlated solar/wind curves. It then automatically initiates a PyTorch training loop across 50-100 epochs, tests the Quantile Coverage bounds, and ejects a production-ready `best_model.pt` binary and `scaler.joblib` to the `/models` directory.

### Render Cloud Deployment
The backend acts as an ASGI Web Service. By executing:
`uvicorn main:app --host 0.0.0.0 --port $PORT`
Render dynamically binds the FastAPI framework to the wide web. APEX natively supports wildcard CORS middleware (`allow_origins=["*"]`), ensuring unrestricted communication between the deployed edge interface and the central intelligence server. All operational routing executes in under ~60 milliseconds.
