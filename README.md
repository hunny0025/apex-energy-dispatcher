# APEX — Advanced Plant Energy X-Dispatcher

APEX is an energy dispatch system that uses Kalman filtering, LSTM forecasting, and MILP optimization to manage industrial power allocation.

---

## 🛠 Setup & Run

### 1. Installation
```bash
cd backend
pip install -r requirements.txt
```

### 2. Data Preparation
```bash
python prepare_entsoe_dataset.py
```

### 3. Model Training
```bash
python train.py --epochs 50 --output models/
```

### 4. Start Server
```bash
uvicorn main:app --host 0.0.0.1 --port 8000
```

---

## 📡 API Endpoints

- **POST `/dispatch`**: Submit recent SCADA history to get a dispatch decision.
- **POST `/feedback`**: Submit actual observed deficits for model calibration.
- **GET `/status`**: Check system health and model loading status.
