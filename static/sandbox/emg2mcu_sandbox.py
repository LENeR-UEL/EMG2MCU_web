"""Display helpers for the EMG2MCU Sandbox notebook.

Inside the Sandbox (Pyodide in a web worker) the helpers send structured results to the
page, which renders them as tables, stat tiles, matplotlib figures and code blocks. Anywhere
else (e.g. a downloaded copy of the notebook in Jupyter with the real ``emg2mcu`` package
installed) they fall back to IPython's display.
"""

from __future__ import annotations

import base64
import io
import json
import math
import time
import traceback

import numpy as np
import pandas as pd

try:  # only present inside the Sandbox worker
    from sandbox_bridge import emit as _bridge_emit
except ImportError:
    _bridge_emit = None

IN_SANDBOX = _bridge_emit is not None
MAX_TABLE_ROWS = 500

__all__ = ["display", "show_signal", "show_events", "show_features", "show_models", "show_filter", "show_code"]


# ---------------------------------------------------------------------------
# data conversion
# ---------------------------------------------------------------------------


def _plain(value):
    """Make numpy/pandas scalars JSON-friendly (NaN/inf -> None)."""
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating, float)):
        value = float(value)
        return None if math.isnan(value) or math.isinf(value) else value
    if isinstance(value, (np.bool_,)):
        return bool(value)
    if value is None or isinstance(value, (int, str, bool)):
        return value
    if isinstance(value, pd.Timestamp):
        return value.isoformat()
    return str(value)


def _round(x: float, digits: int = 4) -> float | None:
    """Round to a few significant digits (NaN/inf -> None) to keep the JSON small."""
    x = float(x)
    if math.isnan(x) or math.isinf(x):
        return None
    return float(f"{x:.{digits}g}")


def _table(df: pd.DataFrame, caption: str | None = None, max_rows: int = MAX_TABLE_ROWS) -> dict:
    shown = df.head(max_rows)
    keep_index = df.index.name is not None or not pd.api.types.is_integer_dtype(df.index)
    if keep_index:
        shown = shown.reset_index()
    return {
        "kind": "table",
        "caption": caption,
        "columns": [str(c) for c in shown.columns],
        "rows": [[_plain(v) for v in row] for row in shown.itertuples(index=False, name=None)],
        "total": int(len(df)),
    }


# ---------------------------------------------------------------------------
# public helpers (page-side rendering for the Sandbox; IPython display elsewhere)
# ---------------------------------------------------------------------------


def _emit(payload: dict) -> None:
    _bridge_emit(json.dumps(payload, default=_plain, allow_nan=False))


def _is_figure(obj) -> bool:
    return type(obj).__name__ == "Figure" and hasattr(obj, "savefig")


def _emit_figure(fig) -> None:
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=110, bbox_inches="tight")
    _emit({"kind": "image", "png": base64.b64encode(buf.getvalue()).decode("ascii")})


def _flush_figures() -> None:
    import sys
    if "matplotlib.pyplot" not in sys.modules:
        return
    import matplotlib.pyplot as plt
    for num in plt.get_fignums():
        _emit_figure(plt.figure(num))
    plt.close("all")


def display(*objs) -> None:
    """Show objects in the cell output: DataFrames as tables, figures as inline PNG, anything else as text."""
    if not IN_SANDBOX:
        from IPython.display import display as ipy_display
        for obj in objs:
            ipy_display(obj)
        return
    for obj in objs:
        if obj is None:
            continue
        if isinstance(obj, tuple):
            display(*obj)
        elif _is_figure(obj):
            _emit_figure(obj)
        elif isinstance(obj, pd.DataFrame):
            _emit(_table(obj))
        elif isinstance(obj, pd.Series):
            _emit(_table(obj.to_frame()))
        else:
            _emit({"kind": "text", "text": repr(obj)})


def show_signal(raw: np.ndarray, filtered: np.ndarray, fs: int, channel_names: list[str] | None = None,
                max_samples: int = 4000) -> None:
    """Show a multi-channel signal: top half raw, bottom half filtered, one panel per channel."""
    if not IN_SANDBOX:
        import matplotlib.pyplot as plt
        n_ch = raw.shape[1]
        fig, axes = plt.subplots(n_ch, 2, figsize=(11, 2.2 * n_ch), sharex=True)
        if n_ch == 1:
            axes = axes[None, :]
        for c in range(n_ch):
            axes[c, 0].plot(raw[:, c], linewidth=0.8)
            axes[c, 0].set_title(f"{channel_names[c] if channel_names else f'ch{c+1}'} (raw)")
            axes[c, 1].plot(filtered[:, c], linewidth=0.8, color="#0e8a78")
            axes[c, 1].set_title(f"{channel_names[c] if channel_names else f'ch{c+1}'} (filtered)")
        fig.tight_layout()
        display(fig)
        return
    n_ch = raw.shape[1]
    # downsample for the page
    step = max(1, raw.shape[0] // max_samples)
    t = (np.arange(raw.shape[0]) / fs).tolist()
    _emit({
        "kind": "signal",
        "fs": int(fs),
        "t": t[::step],
        "raw": [[float(v) for v in raw[::step, c]] for c in range(n_ch)],
        "filtered": [[float(v) for v in filtered[::step, c]] for c in range(n_ch)],
        "channels": channel_names or [f"ch{c+1}" for c in range(n_ch)],
    })


def show_events(envelope: np.ndarray, events: list[tuple[int, int]], labels: list[int], label_names: list[str],
                fs: int, max_samples: int = 4000) -> None:
    """Show the smoothed envelope with the detected events highlighted by their class colour."""
    palette = ["#2f4ae0", "#e08a12", "#0e8a78", "#c0365a", "#7a4cc2", "#5f8a1e", "#3f7fb0", "#d2552b"]
    if not IN_SANDBOX:
        import matplotlib.pyplot as plt
        fig, ax = plt.subplots(figsize=(11, 2.5))
        t = np.arange(len(envelope)) / fs
        ax.plot(t, envelope, linewidth=1, color="#4c5573")
        for (s, e), lab in zip(events, labels):
            ax.axvspan(s / fs, e / fs, color=palette[lab % len(palette)], alpha=0.18)
        ax.set_title("Smoothed envelope and detected events")
        ax.set_xlabel("Time (s)"); ax.set_ylabel("Envelope (a.u.)")
        fig.tight_layout()
        display(fig)
        return
    step = max(1, envelope.shape[0] // max_samples)
    _emit({
        "kind": "events",
        "fs": int(fs),
        "t": (np.arange(envelope.shape[0]) / fs).tolist()[::step],
        "envelope": [float(v) for v in envelope[::step]],
        "events": [[int(s), int(e), int(lab), label_names[lab] if 0 <= lab < len(label_names) else str(lab)]
                   for (s, e), lab in zip(events, labels)],
        "palette": palette[:max(1, len(label_names))],
    })


def show_features(features: pd.DataFrame, labels: np.ndarray, label_names: list[str]) -> None:
    """Show the per-window feature matrix: stats per class on the left, a sample of rows on the right."""
    summary = features.copy()
    summary["class"] = [label_names[int(l)] for l in labels]
    means = summary.groupby("class").mean(numeric_only=True)
    counts = summary["class"].value_counts().to_frame("windows")
    if not IN_SANDBOX:
        display(counts, means.round(4))
        return
    _emit({"kind": "table", "caption": "Windows per class", "columns": list(counts.columns),
           "rows": [[_plain(v) for v in row] for row in counts.itertuples(index=True, name=None)],
           "total": int(len(counts))})
    _emit({"kind": "table", "caption": "Feature means per class", "columns": list(means.columns),
           "rows": [[_plain(v) for v in row] for row in means.round(4).itertuples(index=True, name=None)],
           "total": int(len(means))})


def show_models(results: pd.DataFrame) -> None:
    """Show a cross-validated model comparison as stat tiles and a sortable table."""
    if not IN_SANDBOX:
        display(results.round(4).sort_values("accuracy", ascending=False).reset_index(drop=True))
        return
    rows = results.sort_values("accuracy", ascending=False).reset_index(drop=True)
    _emit({"kind": "table", "caption": "Cross-validated model ranking (sorted by accuracy)",
           "columns": list(rows.columns),
           "rows": [[_plain(v) for v in row] for row in rows.round(4).itertuples(index=False, name=None)],
           "total": int(len(rows))})
    metrics = {"Accuracy (best)": float(rows["accuracy"].iloc[0]), "F1 (best)": float(rows["f1"].iloc[0])}
    _emit({"kind": "metrics", "metrics": metrics})


def show_filter(b_bp, a_bp, b_n, a_n) -> None:
    """Show the biquad coefficients the deployable filter would ship to the ESP32."""
    if not IN_SANDBOX:
        import pandas as pd
        bp = pd.DataFrame({"b": b_bp, "a": -a_bp}).round(6)
        n = pd.DataFrame({"b": b_n, "a": -a_n}).round(6)
        print("Bandpass (biquad):")
        display(bp)
        print("Notch (biquad):")
        display(n)
        return
    _emit({
        "kind": "filter",
        "bandpass": {"b": [float(v) for v in b_bp], "a": [float(v) for v in -a_bp]},
        "notch": {"b": [float(v) for v in b_n], "a": [float(v) for v in -a_n]},
    })


def show_code(text: str, language: str = "cpp", caption: str | None = None) -> None:
    """Show a code block on the page (e.g. the deployable Arduino sketch)."""
    if not IN_SANDBOX:
        from IPython.display import Markdown, display as ipy_display
        ipy_display(Markdown(f"```{language}\n{text}\n```"))
        return
    _emit({"kind": "code", "language": language, "text": text, "caption": caption})


# ---------------------------------------------------------------------------
# matplotlib: show figures inline, like Jupyter's inline backend
# ---------------------------------------------------------------------------


def _setup() -> None:
    import matplotlib
    matplotlib.use("agg")
    import matplotlib.pyplot as plt
    plt.show = lambda *args, **kwargs: _flush_figures()


# ---------------------------------------------------------------------------
# cell execution (Sandbox only; called by worker.js)
# ---------------------------------------------------------------------------


class _Stream(io.TextIOBase):
    """stdout/stderr that forwards text to the page, batched so progress output stays cheap."""

    def __init__(self, name: str):
        self.name, self._buf, self._last = name, [], 0.0

    def writable(self) -> bool:
        return True

    def write(self, text: str) -> int:
        self._buf.append(text)
        if time.monotonic() - self._last > 0.1:
            self.flush()
        return len(text)

    def flush(self) -> None:
        if self._buf:
            _emit({"kind": "stream", "name": self.name, "text": "".join(self._buf)})
            self._buf = []
        self._last = time.monotonic()


_namespace: dict = {"__name__": "__main__"}


async def run_cell(code: str, count: int) -> bool:
    """Run one notebook cell; the value of a trailing expression is displayed, as in Jupyter."""
    import contextlib
    import linecache
    from pyodide.code import eval_code_async

    filename = f"<cell {count}>"
    linecache.cache[filename] = (len(code), None, code.splitlines(True), filename)  # source lines in tracebacks
    out, err = _Stream("stdout"), _Stream("stderr")
    ok = True
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            result = await eval_code_async(code, globals=_namespace, return_mode="last_expr", filename=filename)
            out.flush(); err.flush()
            if result is not None:
                display(result)
            _flush_figures()
        except BaseException as exc:  # noqa: BLE001 - report everything, like Jupyter
            ok = False
            out.flush(); err.flush()
            frames = traceback.extract_tb(exc.__traceback__)
            start = next((i for i, f in enumerate(frames) if f.filename.startswith("<cell")), 0)
            lines = traceback.format_list(frames[start:]) if frames else []
            _emit({
                "kind": "error",
                "ename": type(exc).__name__,
                "evalue": str(exc),
                "traceback": "".join(lines),
            })
    out.flush(); err.flush()
    return ok
