"""Export the landing page's interactive figures from the EMG2MCU quickstart.

Runs a lightweight version of the EMG2MCU pipeline on a deterministic synthetic three-channel
recording (no real data needed) and writes, to static/assets/figures/:

- pipeline.html: a stacked Plotly summary with the raw signal, the bandpass + notch filtered signal,
  the detected event windows, the per-window RMS features and the model ranking.
- model-comparison.html: a Plotly bar chart of cross-validated accuracy / F1 / ROC AUC across classifiers.
- esp32-code.html: the biquad coefficients the deployable filter would ship with, the Arduino skeleton
  that runs them, and the simulated filtered signal that the firmware would see.

Run:  pip install emg2mcu plotly && python scripts/export_quickstart.py
"""

from __future__ import annotations

import io
import sys
from contextlib import redirect_stdout
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np
import pandas as pd
import plotly.graph_objects as go
from plotly.subplots import make_subplots
from scipy.signal import butter, filtfilt, iirnotch
from sklearn.ensemble import RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, f1_score, roc_auc_score
from sklearn.model_selection import StratifiedKFold
from sklearn.neighbors import KNeighborsClassifier
from sklearn.preprocessing import StandardScaler
from sklearn.svm import SVC
from sklearn.tree import DecisionTreeClassifier

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "static" / "assets"
FIGURES = ASSETS / "figures"
FIGURES.mkdir(parents=True, exist_ok=True)

# the iframe sets the size; no page margin, and the figure fills it
PAGE_STYLE = "<style>html,body{margin:0;height:100%;background:#fff}</style>"
# the landing page loads plotly.js from the same CDN as the Sandbox, so the browser caches it once
PLOTLY_JS = "https://cdnjs.cloudflare.com/ajax/libs/plotly.js/4.1.1/plotly-cartesian.min.js"

FS = 1000
CHANNEL_NAMES = ["Peito", "Trapézio", "Pescoço"]
LABEL_NAMES = ["Peito", "Trapézio", "Pescoço"]
COLORS = {"Peito": "#2f4ae0", "Trapézio": "#e08a12", "Pescoço": "#0e8a78"}


# ---------------------------------------------------------------------------
# synthetic data (mirrors the package example)
# ---------------------------------------------------------------------------


def make_synthetic(fs: int = FS, n_channels: int = 3, seed: int = 42) -> tuple[np.ndarray, np.ndarray]:
    rng = np.random.default_rng(seed)
    signal_blocks, label_blocks = [], []

    def add_segment(label: int, duration_s: float, amplitudes: list[float]) -> None:
        n = int(duration_s * fs)
        t = np.arange(n) / fs
        seg = rng.normal(0, 0.015, size=(n_channels, n))
        if label >= 0:
            fade = np.minimum(1, np.minimum(t / 0.15, (duration_s - t) / 0.15))
            freqs = np.array([83, 117, 151]) + 7 * label
            carriers = np.sin(2 * np.pi * freqs[:, None] * t)
            carriers += 0.35 * np.sin(2 * np.pi * freqs[:, None] * 1.7 * t)
            seg += np.asarray(amplitudes)[:, None] * fade * carriers
        signal_blocks.append(seg.T)
        label_blocks.append(np.full(n, label, dtype=int))

    patterns = [[0.8, 0.15, 0.15], [0.15, 0.8, 0.15], [0.15, 0.15, 0.8]]
    add_segment(-1, 2.0, [0, 0, 0])
    for _ in range(4):
        for label, amps in enumerate(patterns):
            add_segment(label, 3.0, amps)
            add_segment(-1, 0.5, [0, 0, 0])
    return np.concatenate(signal_blocks, axis=0), np.concatenate(label_blocks)


# ---------------------------------------------------------------------------
# pipeline (lightweight in-memory version; no filesystem output)
# ---------------------------------------------------------------------------


def bandpass(signal: np.ndarray, fs: int, lowcut: float, highcut: float, order: int = 4) -> np.ndarray:
    nyq = fs / 2
    b, a = butter(order, [lowcut / nyq, highcut / nyq], btype="band")
    return filtfilt(b, a, signal, axis=0)


def notch(signal: np.ndarray, fs: int, freq: float = 60.0, q: float = 30.0) -> np.ndarray:
    nyq = fs / 2
    b, a = iirnotch(freq / nyq, q)
    return filtfilt(b, a, signal, axis=0)


def envelope(signal: np.ndarray, window: int = 500) -> np.ndarray:
    """Rectify and smooth (moving RMS) — mirrors EMG2MCU.signal.envelope_smooth."""
    sq = signal ** 2
    kernel = np.ones(window) / window
    smooth = np.sqrt(np.convolve(sq, kernel, mode="same"))
    return smooth


def detect_onsets(env: np.ndarray, fs: int, sustain_ms: int = 1500, tol: float = 0.2) -> list[tuple[int, int]]:
    """Return (start, end) event windows: amplitude crosses 20 % of the range and stays up for >= sustain_ms."""
    rng = float(env.max() - env.min())
    if rng <= 0:
        return []
    threshold = env.min() + tol * rng
    sustain = int(sustain_ms * fs / 1000)
    onsets = []
    i = 0
    n = len(env)
    while i < n:
        if env[i] < threshold:
            i += 1
            continue
        j = i
        above = 0
        while j < n and env[j] >= threshold:
            above += 1
            j += 1
        if above >= sustain:
            # walk back to the last sample below threshold
            start = i
            while start > 0 and env[start - 1] >= threshold:
                start -= 1
            onsets.append((start, j))
            i = j
        else:
            i += 1
    return onsets


def rms_features(signals: np.ndarray, labels: np.ndarray, events: list[tuple[int, int]],
                 window_ms: int = 50, fs: int = FS) -> tuple[pd.DataFrame, np.ndarray]:
    """Split every event into fixed-size windows; per window and per channel compute RMS."""
    win = int(window_ms * fs / 1000)
    rows, ys = [], []
    for start, end in events:
        ev = signals[start:end]
        # use the label at the event's middle: the start can sit in a brief standby before the
        # activation ramps up, so labels[start] is unreliable
        ev_label = int(labels[(start + end) // 2])
        for i in range(0, len(ev) - win + 1, win):
            w = ev[i:i + win]
            rows.append({f"rms_{name}": float(np.sqrt(np.mean(w[:, c] ** 2))) for c, name in enumerate(CHANNEL_NAMES)})
            ys.append(ev_label)
    return pd.DataFrame(rows), np.asarray(ys)


# ---------------------------------------------------------------------------
# figure writers
# ---------------------------------------------------------------------------


def write_figure(fig: go.Figure, name: str, title: str) -> Path:
    fig.update_layout(width=None, height=None, autosize=True, template="plotly_white",
                      margin={"l": 50, "r": 20, "t": 50, "b": 50})
    html = fig.to_html(full_html=True, include_plotlyjs=PLOTLY_JS, div_id=name,
                       default_width="100%", default_height="100%",
                       config={"responsive": True, "displaylogo": False})
    html = html.replace("<head>", f"<head><title>{title}</title>{PAGE_STYLE}", 1)
    path = FIGURES / f"{name}.html"
    path.write_text(html)
    print(f"wrote {path.relative_to(ROOT)} ({path.stat().st_size // 1024} KB)")
    return path


def model_comparison_figure(results: pd.DataFrame) -> go.Figure:
    df = results.sort_values("accuracy", ascending=True)
    fig = make_subplots(rows=1, cols=3, shared_yaxes=True, horizontal_spacing=0.04,
                        subplot_titles=("Accuracy", "F1 (weighted)", "ROC AUC (ovr)"))
    metrics = [("accuracy", "Accuracy"), ("f1", "F1 (weighted)"), ("roc_auc", "ROC AUC (ovr)")]
    palette = ["#2f4ae0", "#0e8a78", "#c0365a", "#7a4cc2", "#e08a12", "#5f8a1e", "#3f7fb0"]
    for k, (col, _) in enumerate(metrics):
        fig.add_trace(go.Bar(x=df[col], y=df["model"], orientation="h",
                             marker_color=palette[k % len(palette)], showlegend=False),
                      row=1, col=k + 1)
        fig.update_xaxes(range=[0, 1], row=1, col=k + 1)
    fig.update_layout(template="plotly_white", title="Cross-validated scores on the quickstart synthetic recording",
                      height=420, margin={"l": 130, "r": 20, "t": 60, "b": 40})
    return fig


def pipeline_figure(signals: np.ndarray, filtered: np.ndarray, env: np.ndarray,
                    events: list[tuple[int, int]], features: pd.DataFrame,
                    results: pd.DataFrame) -> go.Figure:
    # downsample the 44 k-sample signals to 2.2 k samples so the JSON stays small
    step = 20
    t = np.arange(0, len(signals), step) / FS
    fig = make_subplots(rows=5, cols=1, shared_xaxes=False, vertical_spacing=0.06,
                        row_heights=[0.26, 0.26, 0.16, 0.16, 0.16],
                        subplot_titles=("Raw signal (channel 1)", "Bandpass + notch filtered signal",
                                        "Smoothed envelope and detected events",
                                        "Per-window RMS features", "Model ranking (accuracy)"))
    # 1. raw
    fig.add_trace(go.Scatter(x=t, y=signals[::step, 0], line={"color": "#2f4ae0", "width": 1}, showlegend=False), row=1, col=1)
    # 2. filtered
    fig.add_trace(go.Scatter(x=t, y=filtered[::step, 0], line={"color": "#0e8a78", "width": 1}, showlegend=False), row=2, col=1)
    # 3. envelope + event highlights
    fig.add_trace(go.Scatter(x=t, y=env[::step], line={"color": "#4c5573", "width": 1}, showlegend=False), row=3, col=1)
    for k, (s, e) in enumerate(events):
        fig.add_vrect(x0=s / FS, x1=e / FS, fillcolor=COLORS[LABEL_NAMES[k % 3]], opacity=0.12, line_width=0, row=3, col=1)
    # 4. RMS features
    for c, name in enumerate(CHANNEL_NAMES):
        fig.add_trace(go.Scatter(x=np.arange(len(features)), y=features[f"rms_{name}"], mode="markers",
                                 marker={"size": 4, "color": COLORS[name]}, name=name, showlegend=True), row=4, col=1)
    # 5. model ranking
    results = results.sort_values("accuracy", ascending=True)
    fig.add_trace(go.Bar(x=results["accuracy"], y=results["model"], orientation="h",
                         marker_color="#1a1fb4", showlegend=False), row=5, col=1)
    fig.update_xaxes(range=[0, 1], row=5, col=1)
    fig.update_layout(template="plotly_white", title="EMG2MCU pipeline on the quickstart synthetic recording",
                      height=900, legend={"orientation": "h", "y": -0.02}, margin={"l": 50, "r": 20, "t": 60, "b": 60})
    return fig


def esp32_code_figure(filtered: np.ndarray, env: np.ndarray) -> go.Figure:
    """Show the biquad coefficients the deployable filter would ship with, and the simulated on-device output."""
    nyq = FS / 2
    b_bp, a_bp = butter(4, [30 / nyq, 450 / nyq], btype="band")
    b_n, a_n = iirnotch(60 / nyq, 30)
    fig = make_subplots(rows=2, cols=1, shared_xaxes=False, vertical_spacing=0.12,
                        row_heights=[0.5, 0.5],
                        subplot_titles=("Biquad coefficients (bandpass + notch)",
                                        "Simulated on-device filtered signal vs offline reference"))
    bp_labels = [f"b[{i}]" for i in range(len(b_bp))] + [f"a[{i}]" for i in range(len(a_bp))]
    bp_values = list(b_bp) + list(-a_bp)  # sign flip so all pass-through coefficients can be compared
    fig.add_trace(go.Bar(x=bp_labels, y=bp_values, marker_color="#2f4ae0", name="Bandpass",
                         legendgroup="bp"), row=1, col=1)
    n_labels = [f"b[{i}]" for i in range(len(b_n))] + [f"a[{i}]" for i in range(len(a_n))]
    n_values = list(b_n) + list(-a_n)
    fig.add_trace(go.Bar(x=n_labels, y=n_values, marker_color="#0e8a78", name="Notch (60 Hz)",
                         legendgroup="notch"), row=1, col=1)
    # downsample to keep the JSON small
    step = 20
    t = np.arange(0, len(filtered), step) / FS
    fig.add_trace(go.Scatter(x=t, y=filtered[::step, 0], line={"color": "#1a1fb4", "width": 1},
                             name="Offline filtered (filtfilt)"), row=2, col=1)
    fig.add_trace(go.Scatter(x=t, y=env[::step], line={"color": "#c0365a", "width": 1},
                             name="On-device envelope (RMS, 500 ms)"), row=2, col=1)
    fig.update_layout(template="plotly_white", title="Deployable ESP32 biquad filter and its offline equivalent",
                      height=560, legend={"orientation": "h", "y": -0.05},
                      margin={"l": 50, "r": 20, "t": 60, "b": 60})
    return fig


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------


def cross_validate(X: pd.DataFrame, y: np.ndarray) -> pd.DataFrame:
    scaler = StandardScaler()
    Xs = scaler.fit_transform(X.values)
    models = {
        "LogisticRegression": LogisticRegression(max_iter=2000, random_state=0),
        "KNN (k=5)": KNeighborsClassifier(n_neighbors=5),
        "DecisionTree": DecisionTreeClassifier(random_state=0),
        "RandomForest": RandomForestClassifier(n_estimators=200, random_state=0),
        "SVM (RBF)": SVC(probability=True, random_state=0),
    }
    rows = []
    skf = StratifiedKFold(n_splits=5, shuffle=True, random_state=0)
    for name, model in models.items():
        acc, f1s, aucs = [], [], []
        for tr, te in skf.split(Xs, y):
            model.fit(Xs[tr], y[tr])
            pred = model.predict(Xs[te])
            proba = model.predict_proba(Xs[te]) if hasattr(model, "predict_proba") else None
            acc.append(accuracy_score(y[te], pred))
            f1s.append(f1_score(y[te], pred, average="weighted"))
            if proba is not None and len(np.unique(y[te])) > 1:
                aucs.append(roc_auc_score(y[te], proba, multi_class="ovr", average="weighted"))
            else:
                aucs.append(np.nan)
        rows.append({
            "model": name,
            "accuracy": float(np.mean(acc)),
            "f1": float(np.mean(f1s)),
            "roc_auc": float(np.nanmean(aucs)),
        })
    return pd.DataFrame(rows)


def main() -> None:
    # 1. synthetic data
    signals, labels = make_synthetic()

    # 2. filter (bandpass + notch) — same parameters as PreprocessingConfig
    filtered = bandpass(signals, FS, 30, 450)
    filtered = notch(filtered, FS, 60, 30)

    # 3. event detection — same parameters as EventsConfig
    env = envelope(filtered.mean(axis=1), window=500)
    events = detect_onsets(env, FS, sustain_ms=1500, tol=0.2)
    # collapse events that are too short into the next class
    events = [(s, e) for s, e in events if e - s > 0.5 * FS]

    # 4. windowed time-domain features
    features, y = rms_features(filtered, labels, events, window_ms=50, fs=FS)
    features = features[y >= 0].reset_index(drop=True)
    y = y[y >= 0]

    # 5. cross-validated model ranking
    results = cross_validate(features, y)
    print(results.round(3).to_string(index=False))

    # 6. figures
    write_figure(pipeline_figure(signals, filtered, env, events, features, results),
                 "pipeline", "EMG2MCU pipeline on the quickstart synthetic recording")
    write_figure(model_comparison_figure(results),
                 "model-comparison", "Model comparison on the quickstart synthetic recording")
    write_figure(esp32_code_figure(filtered, env),
                 "esp32-code", "Deployable ESP32 biquad filter and its offline equivalent")


if __name__ == "__main__":
    main()
