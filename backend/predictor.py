"""
APEX Predictor — LSTM for deficit forecasting
==============================================
Single source of truth for features: data_pipeline.FEATURE_COLUMNS
This module does NOT do any feature engineering or scaling.
All preprocessing is owned by DataPipeline (data_pipeline.py).

Architecture:
  Input:  (batch, SEQ_LEN=16, N_FEATURES=26) — scaled by DataPipeline.scaler
  Output: (batch, 2) — [P50_MW, P90_MW] deficit forecast (raw MW, not scaled)

Quantile loss (pinball):
  q=0.50 → symmetric penalty
  q=0.90 → penalises under-prediction 9× more than over-prediction
  P90 conservatism is critical: we'd rather pre-shed than blackout.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Optional, Tuple

import numpy as np
import torch
import torch.nn as nn
from torch.optim.lr_scheduler import ReduceLROnPlateau
from torch.utils.data import Dataset, DataLoader


from data_pipeline import FEATURE_COLUMNS, TARGET_COLUMN, DataPipeline, SEQ_LEN

logger = logging.getLogger("apex.predictor")

N_FEATURES = len(FEATURE_COLUMNS)   






@dataclass
class PredictorConfig:
    
    hidden_size:   int   = 128
    num_layers:    int   = 2
    dropout:       float = 0.2
    bidirectional: bool  = False

    
    batch_size:    int   = 64
    learning_rate: float = 1e-3
    max_epochs:    int   = 200
    patience:      int   = 20
    weight_decay:  float = 1e-4

    
    quantiles: list = field(default_factory=lambda: [0.50, 0.90])

    
    model_dir:  str = "models"






class QuantileLoss(nn.Module):
    """
    Pinball loss — no distributional assumption.
    For q=0.90: L = 0.90 × max(0, y - ŷ) + 0.10 × max(0, ŷ - y)
    """
    def __init__(self, quantiles: list):
        super().__init__()
        self.quantiles = quantiles

    def forward(self, predictions: torch.Tensor, targets: torch.Tensor) -> torch.Tensor:
        
        
        
        losses = []
        for i, q in enumerate(self.quantiles):
            err = targets[:, 0] - predictions[:, i]   
            losses.append(torch.max(q * err, (q - 1) * err).mean())
        return torch.stack(losses).mean()






class SequenceDataset(Dataset):
    """
    Wraps pre-built (X, y) numpy arrays from DataPipeline._make_sequences().
    X shape: (N, SEQ_LEN, N_FEATURES)
    y shape: (N, horizon)
    """
    def __init__(self, X: np.ndarray, y: np.ndarray):
        self.X = torch.FloatTensor(X)
        self.y = torch.FloatTensor(y)

    def __len__(self):   return len(self.X)
    def __getitem__(self, i): return self.X[i], self.y[i]






class DeficitLSTM(nn.Module):
    """
    Multi-quantile LSTM.
    input_size is always N_FEATURES = len(data_pipeline.FEATURE_COLUMNS).
    This guarantee means training and inference use the same feature space.
    """
    def __init__(self, cfg: PredictorConfig, n_features: int, n_quantiles: int):
        super().__init__()
        self.cfg = cfg

        self.lstm = nn.LSTM(
            input_size=n_features,
            hidden_size=cfg.hidden_size,
            num_layers=cfg.num_layers,
            dropout=cfg.dropout if cfg.num_layers > 1 else 0.0,
            batch_first=True,
            bidirectional=cfg.bidirectional,
        )
        lstm_out = cfg.hidden_size * (2 if cfg.bidirectional else 1)
        self.head = nn.Sequential(
            nn.Linear(lstm_out, 64),
            nn.ReLU(),
            nn.Dropout(cfg.dropout),
            nn.Linear(64, n_quantiles),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        out, _ = self.lstm(x)
        return self.head(out[:, -1, :])   






class DeficitPredictor:
    """
    Owns the LSTM model only.
    Does NOT own feature engineering or scaling — those belong to DataPipeline.

    Workflow:
      Training:   pipeline.fit_transform(df) → X_train, y_train, X_val, y_val
                  predictor.train(X_train, y_train, X_val, y_val)

      Inference:  pipeline.transform_live(recent_df) → X_live  (1, SEQ_LEN, N_FEATURES)
                  predictor.predict_array(X_live) → {p50_mw, p90_mw}
    """

    def __init__(self, cfg: Optional[PredictorConfig] = None):
        self.cfg = cfg or PredictorConfig()
        self.model: Optional[DeficitLSTM] = None
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        Path(self.cfg.model_dir).mkdir(parents=True, exist_ok=True)
        logger.info("DeficitPredictor | device=%s | features=%d", self.device, N_FEATURES)

    

    def train(
        self,
        X_train: np.ndarray,
        y_train: np.ndarray,
        X_val:   np.ndarray,
        y_val:   np.ndarray,
    ) -> dict:
        """
        Train on pre-processed arrays from DataPipeline.fit_transform().

        Args:
            X_train: (N_train, SEQ_LEN, N_FEATURES) — already scaled
            y_train: (N_train, horizon) — raw MW (NOT scaled)
            X_val, y_val: validation split

        Returns:
            history dict with train_loss and val_loss arrays
        """
        n_features  = X_train.shape[2]
        n_quantiles = len(self.cfg.quantiles)

        
        if n_features != N_FEATURES:
            raise ValueError(
                f"Feature mismatch: got {n_features} features from data, "
                f"but pipeline defines {N_FEATURES}. "
                f"Re-run DataPipeline.fit_transform()."
            )

        train_loader = DataLoader(
            SequenceDataset(X_train, y_train),
            batch_size=self.cfg.batch_size, shuffle=True,
            num_workers=0,  
            pin_memory=self.device.type == "cuda",
        )
        val_loader = DataLoader(
            SequenceDataset(X_val, y_val),
            batch_size=self.cfg.batch_size, shuffle=False, num_workers=0,
        )

        self.model = DeficitLSTM(self.cfg, n_features, n_quantiles).to(self.device)
        criterion  = QuantileLoss(self.cfg.quantiles)
        optimizer  = torch.optim.AdamW(
            self.model.parameters(),
            lr=self.cfg.learning_rate,
            weight_decay=self.cfg.weight_decay,
        )
        
        scheduler = ReduceLROnPlateau(optimizer, mode="min", factor=0.5, patience=7)

        best_val  = float("inf")
        no_improve = 0
        history   = {"train_loss": [], "val_loss": []}
        best_path = Path(self.cfg.model_dir) / "best_model.pt"

        for epoch in range(1, self.cfg.max_epochs + 1):
            
            self.model.train()
            t_losses = []
            for Xb, yb in train_loader:
                Xb, yb = Xb.to(self.device), yb.to(self.device)
                optimizer.zero_grad()
                loss = criterion(self.model(Xb), yb)
                loss.backward()
                nn.utils.clip_grad_norm_(self.model.parameters(), 1.0)
                optimizer.step()
                t_losses.append(loss.item())

            
            self.model.eval()
            v_losses = []
            with torch.no_grad():
                for Xb, yb in val_loader:
                    loss = criterion(self.model(Xb.to(self.device)), yb.to(self.device))
                    v_losses.append(loss.item())

            t_loss = float(np.mean(t_losses))
            v_loss = float(np.mean(v_losses))
            history["train_loss"].append(t_loss)
            history["val_loss"].append(v_loss)
            scheduler.step(v_loss)

            if epoch % 10 == 0:
                current_lr = optimizer.param_groups[0]["lr"]
                logger.info("Epoch %03d | train=%.4f | val=%.4f | lr=%.2e", epoch, t_loss, v_loss, current_lr)

            if v_loss < best_val:
                best_val = v_loss
                no_improve = 0
                self.save(best_path)
            else:
                no_improve += 1
                if no_improve >= self.cfg.patience:
                    logger.info("Early stopping at epoch %d", epoch)
                    break

        self._load_weights(best_path)
        logger.info("Training complete | best_val=%.4f | epochs=%d", best_val, len(history["val_loss"]))
        return history

    

    def evaluate(self, X_val: np.ndarray, y_val: np.ndarray) -> dict:
        """
        Compute MAE, RMSE, and P90 coverage on pre-processed arrays.
        P90 coverage target: 0.88–0.92 (should bound ~90% of true deficits).
        """
        if self.model is None:
            raise RuntimeError("No model loaded. Train or load first.")

        loader = DataLoader(SequenceDataset(X_val, y_val), batch_size=256, shuffle=False)
        self.model.eval()
        all_preds, all_targets = [], []
        with torch.no_grad():
            for Xb, yb in loader:
                all_preds.append(self.model(Xb.to(self.device)).cpu().numpy())
                all_targets.append(yb.numpy())

        preds   = np.vstack(all_preds)          
        targets = np.vstack(all_targets).squeeze()

        p50, p90 = preds[:, 0], preds[:, 1]
        mae_p50      = float(np.mean(np.abs(p50 - targets)))
        rmse_p50     = float(np.sqrt(np.mean((p50 - targets)**2)))
        p90_coverage = float(np.mean(targets <= p90))

        metrics = {
            "mae_p50_mw":   round(mae_p50, 4),
            "rmse_p50_mw":  round(rmse_p50, 4),
            "p90_coverage": round(p90_coverage, 4),
            "p90_calibrated": abs(p90_coverage - 0.90) < 0.03,
        }
        logger.info("Evaluation: %s", json.dumps(metrics))
        return metrics

    

    def predict_array(self, X_live: np.ndarray) -> dict:
        """
        Inference on a pre-processed live window.

        Args:
            X_live: numpy array of shape (1, SEQ_LEN, N_FEATURES)
                    produced by DataPipeline.transform_live(recent_df)

        Returns:
            {"p50_mw": float, "p90_mw": float}
        """
        if self.model is None:
            raise RuntimeError("No model loaded. Call load() first.")
        if X_live.shape[2] != N_FEATURES:
            raise ValueError(
                f"Feature count mismatch: got {X_live.shape[2]}, expected {N_FEATURES}. "
                f"Use DataPipeline.transform_live() to prepare input."
            )

        tensor = torch.FloatTensor(X_live).to(self.device)
        self.model.eval()
        with torch.no_grad():
            out = self.model(tensor).cpu().numpy()[0]

        return {
            "p50_mw": float(max(0.0, out[0])),
            "p90_mw": float(max(0.0, out[1])),
        }

    

    def save(self, path: Path) -> None:
        """Save model weights + config. Scaler is saved separately by DataPipeline."""
        torch.save({
            "model_state":  self.model.state_dict(),
            "config":       asdict(self.cfg),
            "n_features":   N_FEATURES,
            "feature_cols": FEATURE_COLUMNS,   
        }, path)

    def load(self, path: Path) -> None:
        """Load model and verify feature list matches current pipeline."""
        ckpt = torch.load(path, map_location=self.device)

        
        saved_features = ckpt.get("feature_cols", [])
        if saved_features and saved_features != FEATURE_COLUMNS:
            raise ValueError(
                f"Feature mismatch between saved model and current pipeline. "
                f"Saved: {saved_features}\nCurrent: {FEATURE_COLUMNS}\n"
                f"Re-train the model."
            )

        self.cfg   = PredictorConfig(**ckpt["config"])
        n_features = ckpt.get("n_features", N_FEATURES)
        self.model = DeficitLSTM(self.cfg, n_features, len(self.cfg.quantiles)).to(self.device)
        self.model.load_state_dict(ckpt["model_state"])
        self.model.eval()
        logger.info("Model loaded from %s | features=%d", path, n_features)

    def _load_weights(self, path: Path) -> None:
        """Internal: reload best weights after training (no feature check needed)."""
        ckpt = torch.load(path, map_location=self.device)
        self.model.load_state_dict(ckpt["model_state"])
        self.model.eval()
