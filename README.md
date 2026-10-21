# EMG2MCU website

Website for the [EMG2MCU AutoML framework](https://github.com/LENeR-UEL/EMG2MCU)
(`pip install emg2mcu`), published with GitHub Pages at <https://lener-uel.github.io/EMG2MCU_web/>.
It mirrors the structure of the [SMX website](https://github.com/joseviniciusr/SMX_web): the same
navigation, the same code/notebook sandbox built on Pyodide, and the same GitHub Actions / Pages
deployment.

| Path | What |
|---|---|
| `static/index.html`, `static/assets/` | Landing page: what EMG2MCU is, the six-stage pipeline, model ranking, ESP32 deploy, install, quickstart, links to the [docs](https://emg2mcu.readthedocs.io/) |
| `static/sandbox/` | Sandbox: an in-browser notebook (below) |
| `scripts/export_quickstart.py` | Rebuilds the landing page's interactive figures from its quickstart snippet: the pipeline summary (`static/assets/figures/pipeline.html`), the model-comparison bars (`model-comparison.html`) and the deployable biquad filter (`esp32-code.html`). Needs `pip install emg2mcu plotly scipy` |

`.github/workflows/pages.yml` publishes `static/` on every push to `main` that touches it
(Settings → Pages → Source: **GitHub Actions**).

To preview the site locally: `cd static && python3 -m http.server`.

The landing page's figures are built by running a lightweight version of the pipeline on a
synthetic three-class recording and rendering the results with Plotly; each page loads
`plotly.js` from the same cdnjs file as the Sandbox, so the landing page itself carries no
plotting library. Static `assets/vendor/` is empty in this repo (the SMX site ships
[Cytoscape.js](https://js.cytoscape.org/) for its predicate graph; EMG2MCU has no such graph).

## Sandbox

`static/sandbox/` runs an EMG2MCU-shaped pipeline in the browser with
[Pyodide](https://pyodide.org) (Python 3.14 and scikit-learn / SciPy / matplotlib compiled to
WebAssembly), so it works on GitHub Pages with no server.

| File | What |
|---|---|
| `quickstart_synthetic.ipynb` | The notebook shown on the page: generates a synthetic three-class recording, applies the bandpass + notch filter, detects events, extracts time-domain features, cross-validates five classifiers and inspects the deployable biquad filter the firmware would ship with. Lines ending in `# @param {...}` become form fields and `# @markdown` lines head form sections, in the style of Google Colab. |
| `notebook.js` | Renders the cells (CodeMirror editors, Shift+Enter to run), the parameter form, metric tiles, tables, inline signal/envelope/coefficient figures and the deployable Arduino sketch. |
| `worker.js` | Python kernel: Pyodide in a module web worker. It installs scikit-learn and matplotlib from PyPI on start. |
| `emg2mcu_sandbox.py` | Display helpers (`show_signal`, `show_events`, `show_features`, `show_models`, `show_filter`, `show_code`, `display`). In the Sandbox they send JSON to the page; in Jupyter they fall back to IPython display, so a downloaded notebook runs there too. |

The notebook generates three classes of synthetic signals with the same generator the
EMG2MCU example uses: three sinusoid bursts per class, 150 ms fade-in / fade-out, Gaussian
background noise, and a standby segment between repetitions. The form configures the
recording size, the bandpass and notch cutoffs, the onset detector, the window size, the
time-domain feature set and the classifier. The last cell shows the biquad coefficients the
on-device filter would use and a skeleton Arduino sketch that runs them on the chip.

The first visit downloads about 30 MB (Pyodide, NumPy, SciPy, scikit-learn, matplotlib)
from the jsDelivr CDN and PyPI, which the browser then caches; with the default settings
the whole notebook runs in a few seconds. To upgrade Pyodide, change the version in the
`import` at the top of `worker.js`.
