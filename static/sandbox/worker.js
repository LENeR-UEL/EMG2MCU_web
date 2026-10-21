// Python kernel for the Sandbox: Pyodide in a (module) web worker, so long runs don't freeze the page.
// Pyodide 314+ only supports module workers, hence `new Worker(..., {type: "module"})` in notebook.js.
// Messages in:  {type: "run", id, code, count} | {type: "file", name, bytes}
// Messages out: {type: "status", state, text} | {type: "output", id, out} | {type: "done", id, ok}
import { loadPyodide } from "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/pyodide.mjs";

let currentId = null, runCell = null;
const status = (state, text) => postMessage({ type: "status", state, text });

const ready = (async () => {
  status("loading", "Loading Python…");
  const py = await loadPyodide();
  py.registerJsModule("sandbox_bridge", { emit: (json) => postMessage({ type: "output", id: currentId, out: JSON.parse(json) }) });
  status("loading", "Installing scikit-learn, scipy, pandas, matplotlib…");
  // scikit-learn pulls numpy automatically; matplotlib needs to be loaded explicitly; pandas ships with Pyodide
  // but must be loaded the same way as the rest
  await py.loadPackage(["micropip", "numpy", "scipy", "pandas", "scikit-learn", "matplotlib"]);
  // The Sandbox uses a lightweight in-memory pipeline (no EMG2MCU package), so it stays compatible with
  // Pyodide's pure-Python / pure-C wheels. The same display helpers, however, also work with the real
  // EMG2MCU package when run in Jupyter — the bridge module is only present in the Sandbox.
  const helpers = await fetch("emg2mcu_sandbox.py");
  if (!helpers.ok) throw new Error(`emg2mcu_sandbox.py: HTTP ${helpers.status}`);
  py.FS.writeFile("/home/pyodide/emg2mcu_sandbox.py", await helpers.text());
  status("loading", "Importing libraries…");
  await py.runPythonAsync(
    "import emg2mcu_sandbox; emg2mcu_sandbox._setup(); " +
    "import numpy, scipy, pandas, sklearn, matplotlib"
  );
  runCell = py.pyimport("emg2mcu_sandbox").run_cell;
  const versions = py.runPython(
    "import sys, numpy, scipy, pandas, sklearn; " +
    "f'Python {sys.version.split()[0]} · NumPy {numpy.__version__} · SciPy {scipy.__version__} · pandas {pandas.__version__} · scikit-learn {sklearn.__version__}'"
  );
  status("ready", versions);
  return py;
})();
ready.catch((err) => status("error", `Python failed to start: ${err.message || err}`));

// Run messages one at a time, in order.
let queue = Promise.resolve();
self.onmessage = (event) => {
  const msg = event.data;
  queue = queue.then(() => handle(msg)).catch(() => {});
};

async function handle(msg) {
  const py = await ready;
  if (msg.type === "file") {
    py.FS.writeFile(`/home/pyodide/${msg.name}`, new Uint8Array(msg.bytes));
    postMessage({ type: "file-saved", name: msg.name });
    return;
  }
  if (msg.type === "run") {
    currentId = msg.id;
    status("busy", "Running…");
    let ok = false;
    try {
      ok = await runCell(msg.code, msg.count);
    } catch (err) {
      postMessage({ type: "output", id: msg.id, out: { kind: "error", ename: "SandboxError", evalue: String(err.message || err), traceback: "" } });
    }
    postMessage({ type: "done", id: msg.id, ok });
    status("ready");
    currentId = null;
  }
}
