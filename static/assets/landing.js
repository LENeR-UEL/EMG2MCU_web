// Light/dark toggle. The choice is saved per browser; the inline script in index.html
// applies it before first paint. Light is the default.
const themeBtn = document.getElementById("theme-toggle");
function setTheme(dark) {
  if (dark) document.documentElement.dataset.theme = "dark";
  else delete document.documentElement.dataset.theme;
  themeBtn.setAttribute("aria-pressed", String(dark));
  themeBtn.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
  themeBtn.title = themeBtn.getAttribute("aria-label");
}
setTheme(document.documentElement.dataset.theme === "dark");
themeBtn.addEventListener("click", () => {
  const dark = document.documentElement.dataset.theme !== "dark";
  setTheme(dark);
  try { localStorage.setItem("emg2mcu.theme", dark ? "dark" : "light"); } catch {}
});

// Copy buttons: copy the nearest [data-copy-src] in the same block.
// navigator.clipboard needs a secure context, so fall back to execCommand on plain http.
async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand("copy");
  area.remove();
  if (!ok) throw new Error("copy failed");
}

document.querySelectorAll("[data-copy]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const block = btn.closest(".install, .code-card");
    const src = block && block.querySelector("[data-copy-src]");
    if (!src) return;
    try {
      await copyText(src.textContent.trim());
      btn.textContent = "Copied";
      btn.classList.add("done");
    } catch {
      btn.textContent = "Select & copy";
    }
    setTimeout(() => { btn.textContent = "Copy"; btn.classList.remove("done"); }, 1600);
  });
});

// Show the latest PyPI release; the static text stays if the request fails.
const versionEl = document.getElementById("version");
if (versionEl) {
  fetch("https://pypi.org/pypi/emg2mcu/json")
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .then((d) => {
      const v = d && d.info && d.info.version;
      if (v) versionEl.textContent = `emg2mcu ${v}`;
    })
    .catch(() => {});
}
