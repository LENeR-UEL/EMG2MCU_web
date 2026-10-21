// EMG2MCU Sandbox: renders quickstart_synthetic.ipynb as runnable cells backed by a Pyodide web worker
// (worker.js). Rich outputs come from emg2mcu_sandbox.py as JSON messages. After SMX_web's sandbox/notebook.js.
(() => {
  const NB_URL = "quickstart_synthetic.ipynb";
  const PARAM_RE = /^(\s*)([A-Za-z_]\w*)(\s*=\s*)(.*?)(\s*#\s*@param\s*(.*))$/;
  const MARKDOWN_RE = /^\s*#\s*@markdown\s?(.*)$/;
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const fmtNum = (v) => {
    if (typeof v !== "number") return v == null ? "" : String(v);
    if (Number.isInteger(v)) return String(v);
    if (v !== 0 && Math.abs(v) < 1e-3) return v.toExponential(2);
    return String(+v.toFixed(Math.abs(v) >= 100 ? 1 : 4));
  };

  const PALETTE = ["--z1", "--z2", "--z3", "--z4", "--z5", "--z6", "--z7", "--z8"];
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const colour = (i) => css(PALETTE[i % PALETTE.length]);

  const nbEl = $("#notebook"), runAllBtn = $("#run-all"), kernelEl = $("#kernel");
  let cells = [];
  let worker = null, kernelInfo = "", execCount = 0, nextRunId = 1, running = false;
  let readyResolve, kernelReady;
  const pending = new Map();                          // run id -> {cell, resolve}

  // ---- kernel ---------------------------------------------------------------
  function startKernel() {
    kernelReady = new Promise((resolve) => (readyResolve = resolve));
    worker = new Worker("worker.js", { type: "module" });
    worker.onmessage = (e) => onWorker(e.data);
    worker.onerror = (e) => setKernel("error", `Python worker failed: ${e.message || "unknown error"}`);
    setKernel("loading", "Starting Python…");
  }

  function setKernel(state, text) {
    if (state === "ready" && text) kernelInfo = text;
    kernelEl.dataset.state = state;
    $(".kernel-text", kernelEl).textContent = state === "ready" ? `Ready · ${kernelInfo}` : text || "Running…";
    runAllBtn.disabled = state === "loading" || state === "error";
    if (state === "ready" || state === "error") $("#first-run").hidden = true;
  }

  function onWorker(msg) {
    if (msg.type === "status") {
      if (msg.state === "ready" && !msg.text) return setKernel(running ? "busy" : "ready");
      setKernel(msg.state, msg.text);
      if (msg.state === "ready") readyResolve();
    } else if (msg.type === "output") {
      const p = pending.get(msg.id);
      if (p) renderOutput(p.cell, msg.out);
    } else if (msg.type === "done") {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (p) p.resolve(msg.ok);
    }
  }

  function restartKernel() {
    worker.terminate();
    for (const { cell, resolve } of pending.values()) {
      renderOutput(cell, { kind: "error", ename: "Restarted", evalue: "Python was restarted while this cell was running.", traceback: "" });
      resolve(false);
    }
    pending.clear();
    execCount = 0;
    cells.filter((c) => c.type === "code").forEach((c) => { c.count = null; setPrompt(c); c.el.dataset.state = ""; c.el.classList.add("stale"); });
    startKernel();
  }

  // ---- running cells --------------------------------------------------------
  function setPrompt(cell, text) {
    cell.prompt.textContent = `In [${text ?? cell.count ?? " "}]:`;
  }

  async function runCell(cell) {
    if (cell.type !== "code") return true;
    cell.el.dataset.state = "queued";
    setPrompt(cell, "*");
    await kernelReady;
    const id = nextRunId++, count = ++execCount;
    clearOutputs(cell);
    cell.el.classList.remove("stale");
    cell.el.dataset.state = "running";
    if (cell.form) cell.el.classList.remove("params-changed");
    const ok = await new Promise((resolve) => {
      pending.set(id, { cell, resolve });
      worker.postMessage({ type: "run", id, code: cell.cm.getValue(), count });
    });
    cell.count = count;
    setPrompt(cell);
    cell.el.dataset.state = ok ? "done" : "error";
    return ok;
  }

  async function runAll(from = 0) {
    if (running) return;
    running = true;
    runAllBtn.classList.remove("pulse");
    const todo = cells.slice(from).filter((c) => c.type === "code");
    todo.forEach((c) => { c.el.dataset.state = "queued"; setPrompt(c, "*"); });
    try {
      for (let i = 0; i < todo.length; i++) {
        if (!(await runCell(todo[i]))) {
          todo.slice(i + 1).forEach((c) => { c.el.dataset.state = ""; setPrompt(c); });
          break;
        }
      }
    } finally {
      running = false;
      if (kernelEl.dataset.state === "busy") setKernel("ready");
    }
  }

  // ---- notebook structure ----------------------------------------------------
  const srcText = (s) => (Array.isArray(s) ? s.join("") : s || "");

  async function loadNotebook() {
    const nb = await (await fetch(NB_URL)).json();
    cells.forEach((c) => clearOutputs(c));
    nbEl.innerHTML = "";
    cells = [];
    for (const c of nb.cells) {
      addCell(c.cell_type === "markdown" ? "markdown" : "code", srcText(c.source), { form: !!(c.metadata && c.metadata.sandbox && c.metadata.sandbox.form) });
    }
    const bar = el("div", "add-cell", `<button type="button" class="btn btn-sm">+ Add code cell</button>`);
    bar.querySelector("button").onclick = () => addCell("code", "", { focus: true });
    nbEl.append(bar);
  }

  function addCell(type, source, { form = false, after = null, focus = false } = {}) {
    const cell = { type, form, count: null, graphs: [], plots: [] };
    if (type === "markdown") {
      cell.el = el("div", "cell md");
      cell.el.innerHTML = `<div class="cell-gutter"></div><div class="cell-main"><div class="cell-box"><div class="md-body"></div></div></div>`;
      $(".md-body", cell.el).innerHTML = DOMPurify.sanitize(marked.parse(source));
      cell.source = source;
    } else {
      buildCodeCell(cell, source);
    }
    const index = after ? cells.indexOf(after) + 1 : cells.length;
    const ref = after ? after.el.nextSibling : $(".add-cell", nbEl);
    nbEl.insertBefore(cell.el, ref || null);
    cells.splice(index, 0, cell);
    if (cell.cm) { cell.cm.refresh(); if (focus) cell.cm.focus(); }
    return cell;
  }

  function buildCodeCell(cell, source) {
    cell.el = el("div", "cell code");
    cell.el.innerHTML = `
      <div class="cell-gutter">
        <span class="prompt">In [ ]:</span>
        <button type="button" class="run-btn" title="Run cell (Shift+Enter)" aria-label="Run cell"><svg viewBox="0 0 10 12"><path d="M0 0l10 6-10 6z"/></svg></button>
      </div>
      <div class="cell-main">
        <div class="cell-box">
          ${cell.form ? `<div class="form"></div><div class="changed-note">Parameters changed. <button type="button" class="btn btn-sm btn-primary">▶ Run all</button></div>` : ""}
          ${cell.form ? `<button type="button" class="code-toggle" aria-expanded="false">Show code</button>` : ""}
          <div class="cell-editor"${cell.form ? " hidden" : ""}></div>
        </div>
        <div class="cell-tools">
          <button type="button" data-act="add">+ Code below</button>
          ${cell.form ? "" : `<button type="button" data-act="delete">Delete</button>`}
        </div>
        <div class="cell-output"></div>
      </div>`;
    cell.prompt = $(".prompt", cell.el);
    cell.out = $(".cell-output", cell.el);
    const runKey = isMac ? "Cmd-Enter" : "Ctrl-Enter";
    cell.cm = CodeMirror($(".cell-editor", cell.el), {
      value: source, mode: "python", lineNumbers: true, indentUnit: 4,
      matchBrackets: true, viewportMargin: Infinity, extraKeys: { "Shift-Enter": () => runCell(cell) },
    });
    cell.cm.setOption("extraKeys", { ...cell.cm.getOption("extraKeys"), [`${isMac ? "Cmd" : "Ctrl"}-Enter`]: () => runCell(cell) });
    $(".run-btn", cell.el).onclick = () => runCell(cell);
    cell.cm.on("keyHandled", (_cm, name) => { if (name === "Enter") runCell(cell); });
    $('[data-act="add"]', cell.el).onclick = () => addCell("code", "", { after: cell, focus: true });
    if (!cell.form) {
      $('[data-act="delete"]', cell.el).onclick = () => {
        cell.el.remove();
        const i = cells.indexOf(cell);
        if (i >= 0) cells.splice(i, 1);
      };
    }
    if (cell.form) {
      const toggle = $(".code-toggle", cell.el);
      toggle.onclick = () => {
        const editor = $(".cell-editor", cell.el);
        editor.hidden = !editor.hidden;
        toggle.textContent = editor.hidden ? "Show code" : "Hide code";
        toggle.setAttribute("aria-expanded", String(!editor.hidden));
        if (!editor.hidden) cell.cm.refresh();
      };
      $(".changed-note .btn", cell.el).onclick = () => runAll();
      let timer = 0;
      cell.cm.on("change", () => {
        if (cell.syncing) return;
        clearTimeout(timer);
        timer = setTimeout(() => buildForm(cell), 250);
        paramsChanged(cell);
      });
      buildForm(cell);
    }
  }

  function focusNext(cell) {
    const next = cells.slice(cells.indexOf(cell) + 1).find((c) => c.type === "code");
    (next || addCell("code", "")).cm.focus();
  }

  function paramsChanged(cell) {
    if (cell.count == null) return; // not run yet: nothing is out of date
    cell.el.classList.add("params-changed");
    runAllBtn.classList.add("pulse");
    cells.slice(cells.indexOf(cell)).forEach((c) => c.type === "code" && c.el.classList.add("stale"));
  }

  // ---- parameter form (Colab-style "# @param" and "# @markdown" lines) --------
  function parseSpec(text) {
    text = text.trim();
    try {
      if (text.startsWith("[")) return { type: "select", options: JSON.parse(text) };
      if (text.startsWith("{")) return JSON.parse(text.replace(/([{,]\s*)([A-Za-z_]\w*)\s*:/g, '$1"$2":'));
    } catch { /* fall through */ }
    return { type: "string" };
  }
  function pyValue(raw) {
    if (raw === "True") return true;
    if (raw === "False") return false;
    const q = /^(['"])(.*)\1$/.exec(raw);
    if (q) return q[2];
    if (raw !== "" && !Number.isNaN(Number(raw))) return Number(raw);
    return raw;
  }
  const pyLiteral = (v) => (typeof v === "boolean" ? (v ? "True" : "False") : typeof v === "number" ? String(v) : JSON.stringify(String(v)));

  function formItems(cell) {
    const out = [];
    cell.cm.getValue().split("\n").forEach((line, i) => {
      const md = MARKDOWN_RE.exec(line);
      if (md) { out.push({ kind: "markdown", text: md[1] }); return; }
      const m = PARAM_RE.exec(line);
      if (m) out.push({ kind: "param", line: i, name: m[2], raw: m[4], value: pyValue(m[4]), spec: parseSpec(m[6]) });
    });
    return out;
  }
  const params = (cell) => formItems(cell).filter((x) => x.kind === "param");

  function setParam(cell, name, literal) {
    const doc = cell.cm.getDoc();
    for (let i = 0; i < doc.lineCount(); i++) {
      const line = doc.getLine(i), m = PARAM_RE.exec(line);
      if (!m || m[2] !== name) continue;
      cell.syncing = true;
      doc.replaceRange(m[1] + m[2] + m[3] + literal + m[5], { line: i, ch: 0 }, { line: i, ch: line.length });
      cell.syncing = false;
      paramsChanged(cell);
      return;
    }
  }

  function buildForm(cell) {
    const form = $(".form", cell.el);
    form.innerHTML = "";
    for (const p of formItems(cell)) {
      if (p.kind === "markdown") {
        form.append(el("div", "form-head", DOMPurify.sanitize(marked.parseInline(p.text))));
        continue;
      }
      const { spec } = p, id = `p-${p.name}`;
      const label = esc(spec.label || p.name.replace(/_/g, " "));
      const name = `<span class="fname">${esc(p.name)}</span>`;
      let field;
      if (spec.type === "boolean") {
        field = el("div", "field check", `<input type="checkbox" id="${id}"${p.value === true ? " checked" : ""}><label for="${id}">${label}</label>`);
        $("input", field).onchange = (e) => setParam(cell, p.name, e.target.checked ? "True" : "False");
      } else if (spec.type === "select") {
        field = el("div", "field", `<label for="${id}">${label}</label><select id="${id}">${spec.options.map((o, k) =>
          `<option value="${k}"${String(o) === String(p.value) ? " selected" : ""}>${esc(o)}</option>`).join("")}</select>${name}`);
        $("select", field).onchange = (e) => setParam(cell, p.name, pyLiteral(spec.options[+e.target.value]));
      } else if (spec.type === "slider") {
        const step = spec.step ?? 1;
        field = el("div", "field", `<label for="${id}">${label}</label><div class="slider">
          <input type="range" id="${id}" min="${spec.min ?? 0}" max="${spec.max ?? 100}" step="${step}" value="${esc(p.value)}"><output>${esc(p.value)}</output></div>${name}`);
        const range = $("input", field), output = $("output", field);
        range.oninput = () => { output.textContent = range.value; };
        range.onchange = () => setParam(cell, p.name, String(+range.value));
      } else if (spec.type === "integer" || spec.type === "number") {
        field = el("div", "field", `<label for="${id}">${label}</label><input type="text" inputmode="decimal" id="${id}" value="${esc(p.raw)}" spellcheck="false">${name}`);
        const input = $("input", field);
        input.onchange = () => {
          const v = input.value.trim(), okNum = v !== "" && !Number.isNaN(Number(v)) && (spec.type !== "integer" || Number.isInteger(Number(v)));
          input.classList.toggle("invalid", !okNum);
          if (okNum) setParam(cell, p.name, v);
        };
      } else {
        field = el("div", "field", `<label for="${id}">${label}</label><input type="text" id="${id}" value="${esc(p.value)}" placeholder="${esc(spec.placeholder || "")}" spellcheck="false">${name}`);
        $("input", field).onchange = (e) => setParam(cell, p.name, pyLiteral(e.target.value));
      }
      form.append(field);
    }
  }

  // ---- output rendering ----------------------------------------------------
  function clearOutputs(cell) {
    cell.out.innerHTML = "";
    cell.graphs = [];
    cell.plots = [];
  }

  function finishLog(cell, ok) {
    if (!cell.out.lastChild || cell.out.lastChild.dataset.kind !== "log") {
      const log = el("div", `out-log${ok ? "" : " error"}`, ""); log.dataset.kind = "log";
      cell.out.append(log);
    }
  }
  function appendLog(cell, name, text) {
    let log = cell.out.querySelector(".out-log");
    if (!log) { log = el("div", "out-log", ""); log.dataset.kind = "log"; cell.out.append(log); }
    const cls = name === "stderr" ? "err" : "";
    const span = el("span", cls, text);
    log.append(span);
    log.scrollTop = log.scrollHeight;
  }

  function renderOutput(cell, out) {
    let node = null;
    if (out.kind === "text") node = el("pre", "out-text", esc(out.text));
    else if (out.kind === "image") node = el("img", "out-img", null);
    else if (out.kind === "error") {
      node = el("div", "out-error", `<strong>${esc(out.ename)}</strong>: <span class="evalue">${esc(out.evalue)}</span>${
        out.traceback ? `<pre>${esc(out.traceback)}</pre>` : ""
      }`);
    }
    else if (out.kind === "stream") { appendLog(cell, out.name, out.text); return; }
    else if (out.kind === "table") node = renderTable(out);
    else if (out.kind === "metrics") node = renderMetrics(out);
    else if (out.kind === "signal") node = renderSignal(out);
    else if (out.kind === "events") node = renderEvents(out);
    else if (out.kind === "filter") node = renderFilter(out);
    else if (out.kind === "code") node = renderCode(out);
    if (!node) node = el("pre", "out-text", esc(JSON.stringify(out)));
    cell.out.append(node);
  }

  function renderTable(t) {
    const wrap = el("div", "out-table");
    const numeric = t.columns.map((_, j) => t.rows.length > 0 && t.rows.every((r) => r[j] == null || typeof r[j] === "number"));
    let rows = t.rows.slice(), sortCol = -1, dir = 1;
    wrap.innerHTML = `${t.caption ? `<div class="tbl-caption">${esc(t.caption)}</div>` : ""}<div class="tbl-scroll"><table>
      <thead><tr>${t.columns.map((c, j) => `<th scope="col" data-j="${j}"${numeric[j] ? ' class="numc"' : ""}>${esc(c)}</th>`).join("")}</tr></thead><tbody></tbody></table></div>
      <div class="tbl-foot">${t.total > t.rows.length ? `Showing the first ${t.rows.length} of ${t.total} rows` : `${t.total} row${t.total === 1 ? "" : "s"}`}${t.columns.length > 1 ? " · click a header to sort" : ""}</div>`;
    const tbody = $("tbody", wrap);
    const draw = () => {
      tbody.innerHTML = rows.map((r) => `<tr>${r.map((v, j) => `<td${numeric[j] ? ' class="numc"' : ""}>${esc(fmtNum(v))}</td>`).join("")}</tr>`).join("");
    };
    wrap.querySelectorAll("th").forEach((th) => (th.onclick = () => {
      const j = +th.dataset.j;
      dir = sortCol === j ? -dir : numeric[j] ? -1 : 1;
      sortCol = j;
      rows = t.rows.slice().sort((a, b) => {
        const x = a[j], y = b[j];
        if (x == null) return 1;
        if (y == null) return -1;
        return (numeric[j] ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * dir;
      });
      wrap.querySelectorAll("th").forEach((h) => h.removeAttribute("aria-sort"));
      th.setAttribute("aria-sort", dir > 0 ? "ascending" : "descending");
      draw();
    }));
    draw();
    return wrap;
  }

  function renderMetrics(s) {
    const tiles = el("div", "tiles tiles-wide");
    for (const [name, v] of Object.entries(s.metrics)) {
      tiles.append(el("div", "tile", `<div class="k">${esc(name)}</div><div class="v">${v.toFixed(3)}</div>
        <div class="meter" aria-hidden="true"><span style="width:${Math.max(0, Math.min(1, v)) * 100}%"></span></div>`));
    }
    return tiles;
  }

  // Inline SVG renderer for a multi-channel signal: one panel per channel, raw in the top half and filtered in the bottom half.
  function renderSignal(d) {
    const wrap = el("div", "out-signal");
    const n = d.raw.length, step = Math.max(1, Math.floor(d.t.length / 1200));
    const xMin = d.t[0], xMax = d.t[d.t.length - 1];
    const all = d.raw.flat().concat(d.filtered.flat());
    let yMin = Math.min(...all), yMax = Math.max(...all);
    if (yMin === yMax) { yMin -= 1; yMax += 1; }
    const pad = (yMax - yMin) * 0.08;
    yMin -= pad; yMax += pad;
    const W = 720, rowH = 90, margin = { l: 50, r: 12, t: 16, b: 22 };
    const inner = W - margin.l - margin.r;
    const x = (v) => margin.l + (v - xMin) / (xMax - xMin) * inner;
    const y = (v) => margin.t + (1 - (v - yMin) / (yMax - yMin)) * (rowH - margin.t - margin.b);
    const path = (arr) => {
      let p = "", started = false;
      for (let i = 0; i < arr.length; i += step) {
        const px = x(d.t[i]), py = y(arr[i]);
        p += (started ? "L" : "M") + px.toFixed(1) + "," + py.toFixed(1);
        started = true;
      }
      return p;
    };
    const rows = [];
    for (let c = 0; c < n; c++) {
      const top = c * rowH, bottom = top + rowH / 2;
      rows.push(`
        <g transform="translate(0,${top})">
          <text x="6" y="14" class="axis">${esc(d.channels[c] || "ch" + (c + 1))}</text>
          <rect x="${margin.l}" y="${margin.t}" width="${inner}" height="${rowH / 2 - margin.t - margin.b / 2}" class="panel"/>
          <path d="${path(d.raw[c])}" stroke="#2f4ae0" stroke-width="1" fill="none"/>
          <text x="${margin.l + 4}" y="${margin.t + 12}" class="legend">raw</text>
          <g transform="translate(0,${rowH / 2})">
            <rect x="${margin.l}" y="${margin.t}" width="${inner}" height="${rowH / 2 - margin.t - margin.b}" class="panel"/>
            <path d="${path(d.filtered[c])}" stroke="#0e8a78" stroke-width="1" fill="none"/>
            <text x="${margin.l + 4}" y="${margin.t + 12}" class="legend">filtered</text>
          </g>
        </g>`);
    }
    wrap.innerHTML = `
      <style>.out-signal svg{font:11px var(--mono);color:#4c5573;width:100%;height:auto;display:block;background:#fff;border:1.5px solid var(--line);border-radius:8px}
        .out-signal .panel{fill:#f7f9ff;stroke:#dde3f0;stroke-width:1}
        .out-signal .axis{fill:#10142b;font-weight:600}
        .out-signal .legend{fill:#4c5573}</style>
      <svg viewBox="0 0 ${W} ${n * rowH}" role="img" aria-label="EMG signal (raw on top, bandpass+notch filtered on the bottom) per channel">
        ${rows.join("")}
      </svg>`;
    return wrap;
  }

  // SVG envelope with the detected events highlighted by their class colour.
  function renderEvents(d) {
    const wrap = el("div", "out-events");
    const step = Math.max(1, Math.floor(d.t.length / 1200));
    const xMin = d.t[0], xMax = d.t[d.t.length - 1];
    const yMin = Math.min(...d.envelope), yMax = Math.max(...d.envelope);
    const W = 720, H = 180, margin = { l: 50, r: 12, t: 18, b: 26 };
    const inner = W - margin.l - margin.r;
    const x = (v) => margin.l + (v - xMin) / (xMax - xMin) * inner;
    const y = (v) => margin.t + (1 - (v - yMin) / (yMax - yMin)) * (H - margin.t - margin.b);
    let p = "";
    for (let i = 0; i < d.envelope.length; i += step) p += (i === 0 ? "M" : "L") + x(d.t[i]).toFixed(1) + "," + y(d.envelope[i]).toFixed(1);
    const eventsSvg = d.events.map(([s, e, lab, name]) =>
      `<rect x="${x(s / d.fs)}" y="${margin.t}" width="${Math.max(1, x(e / d.fs) - x(s / d.fs))}" height="${H - margin.t - margin.b}" fill="${d.palette[lab % d.palette.length]}" opacity="0.18"/>`
    ).join("");
    const legendSvg = d.palette.slice(0, d.events.length ? (Math.max(...d.events.map((x) => x[2])) + 1) : 0).map((c, i) =>
      `<span><span class="sw" style="background:${c}"></span>${esc(d.events.find((e) => e[2] === i)?.[3] || i)}</span>`
    ).join("");
    wrap.innerHTML = `
      <style>.out-events svg{font:11px var(--mono);color:#4c5573;width:100%;height:auto;display:block;background:#fff;border:1.5px solid var(--line);border-radius:8px}
        .out-events .axis{fill:#10142b;font-weight:600}
        .out-events .sw{display:inline-block;width:12px;height:12px;border-radius:3px;border:1.5px solid var(--line);vertical-align:-1px;margin-right:4px}
        .out-events .legend{display:flex;flex-wrap:wrap;gap:6px 14px;padding:8px 12px;font-size:.85rem;border-top:1.5px solid var(--line);background:#f7f9ff}
        .out-events .frame{padding:0 0 0 0}</style>
      <div class="frame">
        <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Smoothed envelope and detected events">
          ${eventsSvg}
          <path d="${p}" stroke="#4c5573" stroke-width="1" fill="none"/>
          <text x="${margin.l}" y="${H - 8}" class="axis">time (s)</text>
        </svg>
        <div class="legend">${legendSvg}</div>
      </div>`;
    return wrap;
  }

  // The deployable biquad filter coefficients as two SVG bar charts.
  function renderFilter(d) {
    const wrap = el("div", "out-filter");
    const panel = (title, coeff) => {
      const W = 360, H = 180, margin = { l: 36, r: 12, t: 28, b: 24 };
      const inner = W - margin.l - margin.r;
      const labels = coeff.b.map((_, i) => `b[${i}]`).concat(coeff.a.map((_, i) => `-a[${i}]`));
      const values = coeff.b.concat(coeff.a);
      const xMin = Math.min(...values, 0), xMax = Math.max(...values, 0);
      const bw = inner / labels.length;
      const barH = H - margin.t - margin.b;
      const bars = values.map((v, i) => {
        const zero = margin.l + (0 - xMin) / (xMax - xMin) * inner;
        const len = (v / (xMax - xMin)) * inner;
        const x = margin.l + i * bw;
        const y = v >= 0 ? margin.t + barH * (1 - Math.abs(len) / inner) : margin.t + barH / 2;
        const h = Math.max(1, barH / 2 - Math.abs(barH * len / inner / 2));
        const color = v >= 0 ? "#2f4ae0" : "#c0365a";
        return `<rect x="${x + 2}" y="${y}" width="${bw - 4}" height="${h}" fill="${color}"/><text x="${x + bw / 2}" y="${H - 8}" text-anchor="middle" font-size="9" fill="#4c5573">${labels[i]}</text>`;
      }).join("");
      return `<div class="panel">
        <div class="title">${title}</div>
        <svg viewBox="0 0 ${W} ${H}">${bars}<line x1="${margin.l + (0 - xMin) / (xMax - xMin) * inner}" y1="${margin.t}" x2="${margin.l + (0 - xMin) / (xMax - xMin) * inner}" y2="${H - margin.b}" stroke="#10142b" stroke-width="0.5"/></svg>
      </div>`;
    };
    wrap.innerHTML = `
      <style>.out-filter{display:flex;flex-wrap:wrap;gap:14px}
        .out-filter .panel{flex:1 1 320px;background:#fff;border:1.5px solid var(--line);border-radius:8px;overflow:hidden}
        .out-filter .title{padding:8px 12px;font-weight:600;color:#10142b;background:#f7f9ff;border-bottom:1.5px solid var(--line)}
        .out-filter svg{width:100%;height:auto;display:block}</style>
      ${panel("Bandpass biquad", d.bandpass)}${panel("Notch biquad (60 Hz)", d.notch)}`;
    return wrap;
  }

  function renderCode(c) {
    const wrap = el("div", "out-code");
    wrap.innerHTML = `<div class="code-head">${c.caption ? `<span>${esc(c.caption)}</span>` : `<span>${esc(c.language || "")}</span>`}<button type="button" class="copy" data-copy>Copy</button></div>
      <pre><code class="lang-${esc(c.language || "")}">${esc(c.text)}</code></pre>`;
    $("button", wrap).onclick = async () => {
      try {
        if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(c.text);
        $("button", wrap).textContent = "Copied";
        setTimeout(() => { $("button", wrap).textContent = "Copy"; }, 1600);
      } catch {}
    };
    return wrap;
  }

  // ---- toolbar ---------------------------------------------------------------------
  function downloadNotebook() {
    const base = new URL(".", location.href).href;
    const setup = [
      "# Running this notebook outside the EMG2MCU Sandbox? This cell fetches the display helpers once",
      "# and makes a tiny in-memory EMG2MCU-compatible pipeline (numpy/scipy/sklearn/matplotlib) available.",
      "# To use the real package, install it with pip and replace the local pipeline with `import EMG2MCU`.",
      "import importlib.util, urllib.request",
      'if importlib.util.find_spec("emg2mcu_sandbox") is None:',
      `    urllib.request.urlretrieve("${base}emg2mcu_sandbox.py", "emg2mcu_sandbox.py")`,
    ].join("\n");
    const lines = (s) => s.split("\n").map((l, i, a) => (i < a.length - 1 ? l + "\n" : l));
    const nb = {
      nbformat: 4, nbformat_minor: 5,
      metadata: { kernelspec: { name: "python3", display_name: "Python 3", language: "python" }, language_info: { name: "python" } },
      cells: [
        { cell_type: "code", id: "setup", metadata: {}, execution_count: null, outputs: [], source: lines(setup) },
        ...cells.map((c, i) => (c.type === "markdown"
          ? { cell_type: "markdown", id: `cell-${i}`, metadata: {}, source: lines(c.source) }
          : { cell_type: "code", id: `cell-${i}`, metadata: c.form ? { sandbox: { form: true } } : {}, execution_count: null, outputs: [], source: lines(c.cm.getValue()) })),
      ],
    };
    const a = el("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(nb, null, 1) + "\n"], { type: "application/x-ipynb+json" }));
    a.download = "emg2mcu_quickstart_synthetic.ipynb";
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  runAllBtn.onclick = () => runAll();
  $("#restart").onclick = () => restartKernel();
  $("#download").onclick = downloadNotebook;
  $("#reset").onclick = async () => {
    if (!confirm("Restore the original notebook? Your edits to the cells will be lost.")) return;
    await loadNotebook();
    runAll();
  };

  startKernel();
  loadNotebook()
    .then(() => runAll())
    .catch((err) => { nbEl.innerHTML = `<div class="out-error"><strong>Could not load the notebook</strong> <span class="evalue">${esc(err.message || err)}</span></div>`; });
})();
