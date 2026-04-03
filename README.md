# APEX: Autonomous Production & Execution System

APEX is a modular platform for industrial optimization, forecasting, and real-time monitoring.

## 📁 Project Structure

```text
apex/
│
├── backend/
│   ├── main.py              # FastAPI (API layer)
│   ├── optimizer.py         # Optimization (OR-Tools)
│   ├── predictor.py         # ML forecast (PyTorch)
│   ├── kalman.py            # Processing (fault + Kalman)
│   ├── audit.py             # Logging / DB
│   ├── simulator.py         # Fake input data
│   ├── models/              # ML models (saved weights)
│   └── requirements.txt
│
├── frontend/
│   ├── src/
│   │   ├── components/      # UI components
│   │   ├── pages/           # main dashboard page
│   │   ├── App.jsx
│   │   └── api.js           # API calls
│   ├── public/
│   └── package.json
│
├── data/
│   └── dataset.csv          # training / sample data
│
├── docs/
│   └── architecture.md      # system explanation
│
├── .gitignore
└── README.md
```

## 🔧 Getting Started

### Backend
1. `cd backend`
2. `pip install -r requirements.txt`
3. `uvicorn main:app --reload`

### Frontend
1. `cd frontend`
2. `npm install`
3. `npm run dev`
