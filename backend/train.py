"""
APEX — Model Training Script
Run: python train.py --synthetic --epochs 50 --output models/
     python train.py --data your_data.csv --epochs 100 --output models/
"""
from __future__ import annotations
import argparse, json, logging, sys
from pathlib import Path
import numpy as np

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s — %(message)s")
log = logging.getLogger("apex.train")

def parse_args():
    p = argparse.ArgumentParser(description="Train APEX LSTM predictor")
    p.add_argument("--data",       type=Path, default=None)
    p.add_argument("--synthetic",  action="store_true")
    p.add_argument("--output",     type=Path, default=Path("models"))
    p.add_argument("--epochs",     type=int,  default=100)
    p.add_argument("--batch_size", type=int,  default=64)
    p.add_argument("--lr",         type=float, default=1e-3)
    p.add_argument("--seed",       type=int,   default=42)
    return p.parse_args()

def main():
    args = parse_args()
    try:
        import torch
        from data_pipeline import DataPipeline, SyntheticGenerator, FEATURE_COLUMNS
        from predictor import DeficitPredictor, PredictorConfig
    except ImportError as e:
        log.error("Missing dependency: %s — run: pip install -r requirements.txt", e)
        sys.exit(1)

    torch.manual_seed(args.seed)
    np.random.seed(args.seed)

    
    if args.synthetic:
        log.info("Generating synthetic data (365 days)...")
        raw_df = SyntheticGenerator(seed=args.seed).generate(periods_days=365)
    elif args.data:
        import pandas as pd
        log.info("Loading %s", args.data)
        raw_df = pd.read_csv(args.data, parse_dates=["timestamp"], index_col="timestamp")
        if raw_df.index.tz is None:
            raw_df.index = raw_df.index.tz_localize("UTC")
    else:
        log.error("Provide --data or --synthetic"); sys.exit(1)

    log.info("Raw data: %d rows (%s → %s)", len(raw_df), raw_df.index[0], raw_df.index[-1])

    
    
    pipeline = DataPipeline()
    X_train, y_train, X_val, y_val = pipeline.fit_transform(raw_df, val_split=0.2)
    log.info("Sequences | train=%s | val=%s | n_features=%d", X_train.shape, X_val.shape, len(FEATURE_COLUMNS))

    
    
    cfg = PredictorConfig(
        max_epochs=args.epochs,
        batch_size=args.batch_size,
        learning_rate=args.lr,
        model_dir=str(args.output),
    )
    predictor = DeficitPredictor(cfg)
    history = predictor.train(X_train, y_train, X_val, y_val)

    
    metrics = predictor.evaluate(X_val, y_val)
    log.info("Validation results:")
    for k, v in metrics.items():
        log.info("  %s: %s", k, v)

    coverage = metrics.get("p90_coverage", -1)
    if not (0.88 <= coverage <= 0.92):
        log.warning(
            "P90 coverage %.1f%% is outside target 88–92%%.\n"
            "  → Under-coverage: increase q=0.90 weight in QuantileLoss\n"
            "  → Over-coverage:  reduce q=0.90 weight",
            coverage * 100,
        )

    
    args.output.mkdir(parents=True, exist_ok=True)
    scaler_path = args.output / "scaler.joblib"
    pipeline.save(scaler_path)
    log.info("Scaler → %s", scaler_path)

    
    report = {
        "epochs_trained":    len(history["train_loss"]),
        "final_train_loss":  float(history["train_loss"][-1]),
        "final_val_loss":    float(history["val_loss"][-1]),
        "validation_metrics": {k: float(v) if isinstance(v, (int, float)) else v
                               for k, v in metrics.items()},
        "train_samples":     int(X_train.shape[0]),
        "val_samples":       int(X_val.shape[0]),
        "n_features":        int(X_train.shape[2]),
        "seq_len":           int(X_train.shape[1]),
        "feature_columns":   FEATURE_COLUMNS,
    }
    report_path = args.output / "training_report.json"
    with open(report_path, "w") as f:
        json.dump(report, f, indent=2)

    log.info("Model    → %s/best_model.pt", args.output)
    log.info("Scaler   → %s", scaler_path)
    log.info("Report   → %s", report_path)
    log.info("Done.")

if __name__ == "__main__":
    main()
