"use strict";
/* Every <dialog> fades in over 0.3s (pure CSS) and fades out over 0.3s. Closing therefore waits for the fade to finish
   before the real close() happens; Esc is routed through the same path. */
(() => {
  const FADE_MS = 300, proto = HTMLDialogElement.prototype, realClose = proto.close, realShow = proto.showModal;
  proto.showModal = function (...args) {
    if (this._fadeTimer) {  // re-opened while still fading out: finish the old close first
      clearTimeout(this._fadeTimer); this._fadeTimer = null; this.classList.remove("closing"); realClose.call(this);
    }
    return realShow.apply(this, args);
  };
  proto.close = function (returnValue) {
    if (!this.open || this._fadeTimer) return;  // already closed, or already fading out
    if (returnValue !== undefined) this.returnValue = returnValue;
    this.classList.add("closing");
    this._fadeTimer = setTimeout(() => { this._fadeTimer = null; this.classList.remove("closing"); realClose.call(this); }, FADE_MS);
  };
  document.addEventListener("cancel", e => {  // Esc: stop the instant close and fade instead (the dialog's own handlers still run)
    if (e.target instanceof HTMLDialogElement) { e.preventDefault(); e.target.close(); }
  }, true);
})();
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const state = {
  meta: null, libs: [], libId: null, images: [],
  sel: new Set(), focus: null, anchor: null,
  presets: [], view: "library", before: false, clip: null, split: false, splitFrac: 0.5,
};

/* ---------- helpers ---------- */
// Text can only be selected inside a field that's being edited (the CSS says so too; this also covers Ctrl+A and drags that start elsewhere).
const EDITABLE = "input:not([type=range]):not([type=checkbox]):not([type=radio]):not([type=button]), textarea, [contenteditable=''], [contenteditable='true']";
document.addEventListener("selectstart", e => {
  const el = e.target instanceof Element ? e.target : e.target.parentElement;
  if (!el?.closest(EDITABLE)) e.preventDefault();
});
document.addEventListener("keydown", e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a" && !document.activeElement?.closest?.(EDITABLE)) e.preventDefault();
}, true);
async function api(method, url, body, signal) {
  const opt = { method, signal };
  if (method !== "GET") { opt.headers = { "Content-Type": "application/json" }; opt.body = JSON.stringify(body ?? {}); }
  const r = await fetch(url, opt);
  if (!r.ok) {
    let m = r.statusText;
    try { m = (await r.json()).error || m; } catch { /* ignore */ }
    throw new Error(m);
  }
  return r.json();
}
let toastTimer;
function toast(msg, err = false) {
  const t = $("#toast");
  t.textContent = msg; t.className = "show" + (err ? " err" : "");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.className = "", err ? 5000 : 2600);
}
const store = {
  get(k, d) { try { const v = localStorage.getItem("tl." + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("tl." + k, JSON.stringify(v)); } catch { /* ignore */ } },
};
const byId = id => state.images.find(i => i.id === id);
const focusImage = () => byId(state.focus);
const fmtBytes = n => n > 1e9 ? (n / 1e9).toFixed(2) + " GB" : n > 1e6 ? (n / 1e6).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1e3)) + " KB";
// `a` (when the entry was added) keeps a browser-cached thumbnail of an earlier, deleted entry that had the same id from being reused.
let thumbBust = 0;  // bumped when temp data is cleared so thumbnails are regenerated, not served from the browser cache
const thumbUrl = im => `/api/images/${im.id}/thumb?rev=${im.rev}&a=${im.added}${thumbBust ? "&b=" + thumbBust : ""}`;
/* ---------- URL routing: #/<library|develop>/<library id>[/<image id>] ---------- */
let routing = false;  // true while we are applying a URL, so that doing so doesn't create history entries
function parseHash() {
  const [view, lib, img] = location.hash.slice(1).split("/").filter(Boolean);
  if ((view !== "library" && view !== "develop") || !/^[0-9]+$/.test(lib || "")) return null;
  return { view, lib: +lib, img: /^[0-9]+$/.test(img || "") ? +img : null };
}
function syncHash(mode = "replace") {
  if (state.libId === null) return;
  const h = `#/${state.view}/${state.libId}${state.focus !== null ? "/" + state.focus : ""}`;
  if (location.hash === h) return;
  try { (mode === "push" && !routing ? history.pushState : history.replaceState).call(history, null, "", h); }
  catch { /* browsers rate-limit history updates */ }
}
async function applyRoute() {  // Back/Forward or an edited address bar
  const r = parseHash();
  if (!r) return syncHash("replace");  // not one of our URLs: put the address bar back to where we are
  if ((r.lib === state.libId && r.view === state.view && (r.img ?? state.focus) === state.focus)) return;
  routing = true;
  try {
    if (r.lib !== state.libId && state.libs.some(l => l.id === r.lib)) {
      flushAllSaves(); state.libId = r.lib; store.set("lib", r.lib); state.focus = r.img;
      await loadLibs(r.lib); await loadImages();
    } else if (r.img !== null && byId(r.img) && r.img !== state.focus) {
      state.sel = new Set([r.img]); state.anchor = r.img; setFocus(r.img);
    }
    if (r.view !== state.view) setView(r.view);
  } finally { routing = false; }
  syncHash("replace");
}

/* Unsaved slider edits are kept in localStorage until the server confirms them, so a refresh can't lose them. */
const pending = {
  set(im) { const p = store.get("pending", {}); p[im.id] = im.settings; store.set("pending", p); },
  clear(id) { const p = store.get("pending", {}); if (id in p) { delete p[id]; store.set("pending", p); } },
  async flush() {
    const p = store.get("pending", {}); store.set("pending", {});
    for (const [id, settings] of Object.entries(p)) { try { await api("PUT", `/api/images/${id}/settings`, { settings }); } catch { /* image gone */ } }
  },
};
const anyDialogOpen = () => !!$("dialog[open]");

/* ---------- libraries ---------- */
async function loadLibs(select) {
  state.libs = await api("GET", "/api/libraries");
  if (!state.libs.length) { await api("POST", "/api/libraries", { name: "My Library" }); return loadLibs(select); }
  const want = select ?? state.libId ?? store.get("lib");
  state.libId = state.libs.some(l => l.id === want) ? want : state.libs[0].id;
  renderLibButton();
  store.set("lib", state.libId);
}
const esc = s => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function loadImages(keepSel = false) {
  state.images = await api("GET", `/api/libraries/${state.libId}/images`);
  const ids = new Set(state.images.map(i => i.id));
  state.sel = new Set([...(keepSel ? state.sel : [])].filter(i => ids.has(i)));
  if (!ids.has(state.focus)) state.focus = null;
  if (state.focus === null && state.images.length) state.focus = state.images[0].id;
  if (state.focus !== null && !state.sel.size) state.sel = new Set([state.focus]);
  state.anchor = state.focus;
  buildLists();
  if (state.view === "develop") enterDevelop();
}

async function switchLib(id) {
  flushAllSaves();
  state.libId = id; store.set("lib", id); state.focus = null;
  await loadLibs(id); await loadImages();
  syncHash("push");
}

/* ---------- thumbnails: grid + filmstrip ---------- */
const STAR_HTML = `<span class="star" title="Featured">★</span>`;
function makeThumb(im) {
  const d = document.createElement("div");
  d.className = "thumb"; d.dataset.id = im.id; d.title = im.path;
  d.innerHTML = `<div class="im"></div><div class="nm">${esc(im.name)}</div>`;
  loadThumbImg(d, im);
  if (im.edited) d.insertAdjacentHTML("beforeend", `<span class="badge" title="Has adjustments">✎</span>`);
  if (im.featured) d.insertAdjacentHTML("beforeend", STAR_HTML);
  d.addEventListener("click", e => clickItem(e, im.id));
  d.addEventListener("dblclick", () => { state.focus = im.id; state.sel = new Set([im.id]); setView("develop"); });
  return d;
}
/* (Re)create the <img> in a thumbnail tile. A spinner shows until the thumbnail has been generated and loaded. */
function loadThumbImg(d, im) {
  const box = $(".im", d);
  box.innerHTML = `<img loading="lazy" alt="" draggable="false"><span class="spin"></span>`;
  box.classList.add("loading");
  const img = $("img", box);
  img.onload = () => box.classList.remove("loading");
  img.onerror = () => {
    box.classList.remove("loading");
    box.innerHTML = `<div class="bad">${im.missing ? "File missing" : "Cannot decode"}</div>`;
  };
  img.src = thumbUrl(im);
}
function buildLists() {
  const grid = $("#grid"), film = $("#filmstrip");
  grid.replaceChildren(...state.images.map(makeThumb));
  film.replaceChildren(...state.images.map(makeThumb));
  $("#emptyMsg").hidden = state.images.length > 0;
  refreshSelectionUI();
}
function refreshThumb(im) {
  $$(`.thumb[data-id="${im.id}"]`).forEach(d => {
    const old = $(".badge", d);
    if (im.edited && !old) d.insertAdjacentHTML("beforeend", `<span class="badge" title="Has adjustments">✎</span>`);
    if (!im.edited && old) old.remove();
    const star = $(".star", d);
    if (im.featured && !star) d.insertAdjacentHTML("beforeend", STAR_HTML);
    if (!im.featured && star) star.remove();
    const img = $("img", d);
    if (!img) return loadThumbImg(d, im);                 // previously failed: try again
    if (img.getAttribute("src") === thumbUrl(im)) return; // already showing this version
    $(".im", d).classList.add("loading");                 // spinner until the new thumbnail arrives
    img.src = thumbUrl(im);
  });
}
function refreshSelectionUI() {
  $$(".thumb").forEach(d => {
    const id = +d.dataset.id;
    d.classList.toggle("sel", state.sel.has(id));
    d.classList.toggle("focus", id === state.focus);
  });
  $("#countInfo").textContent = `${state.images.length} image${state.images.length === 1 ? "" : "s"} · ${state.sel.size} selected`;
  const f = $(`#filmstrip .thumb[data-id="${state.focus}"]`);
  if (f && state.view === "develop") f.scrollIntoView({ block: "nearest", inline: "nearest" });
}
function clickItem(e, id) {
  if (e.shiftKey && state.anchor !== null) {
    const a = state.images.findIndex(i => i.id === state.anchor), b = state.images.findIndex(i => i.id === id);
    const [lo, hi] = a < b ? [a, b] : [b, a];
    state.sel = new Set(state.images.slice(lo, hi + 1).map(i => i.id));
    setFocus(id, false);
  } else if (e.ctrlKey || e.metaKey) {
    if (state.sel.has(id) && state.sel.size > 1) { state.sel.delete(id); if (state.focus === id) setFocus([...state.sel][0], false); }
    else { state.sel.add(id); setFocus(id, false); }
    state.anchor = id;
  } else {
    state.sel = new Set([id]); state.anchor = id; setFocus(id, false);
  }
  refreshSelectionUI();
}
function setFocus(id, refresh = true) {
  if (id === state.focus) return;
  flushSave(state.focus);
  state.focus = id;
  syncHash("replace");
  if (refresh) refreshSelectionUI();
  if (state.view === "develop") { syncPanel(); loadStage(); }
}
function moveFocus(delta) {
  if (!state.images.length) return;
  const i = Math.max(0, Math.min(state.images.length - 1, state.images.findIndex(x => x.id === state.focus) + delta));
  const id = state.images[i].id;
  state.sel = new Set([id]); state.anchor = id; setFocus(id);
  refreshSelectionUI();
}

/* ---------- views ---------- */
function setView(v) {
  state.view = v;
  $("#libraryView").hidden = v !== "library";
  $("#developView").hidden = v !== "develop";
  $("#tabLib").classList.toggle("active", v === "library");
  $("#tabDev").classList.toggle("active", v === "develop");
  $("#presetsBtn").hidden = v !== "develop";  // presets only apply while developing
  if (v !== "develop") closePresetMenu();
  if (v === "develop") enterDevelop();
  refreshSelectionUI();
  syncHash("push");
}
function enterDevelop() {
  if (state.focus === null && state.images.length) state.focus = [...state.sel][0] ?? state.images[0].id;
  if (state.focus !== null && !state.sel.size) state.sel = new Set([state.focus]);
  syncPanel(); loadStage();
}

/* ---------- interface settings (this browser only, never in the repo) ---------- */
const UI_DEFAULTS = { panVelocity: 1, panDamping: 50, panUpdate: 0.25, panThreshold: 40 };
const uiSettings = () => {
  const o = { ...UI_DEFAULTS, ...store.get("ui", {}) };
  for (const k of Object.keys(UI_DEFAULTS)) if (!Number.isFinite(+o[k])) o[k] = UI_DEFAULTS[k];
  return o;
};

/* Momentum after a drag: keep gliding at the release velocity, slowing by the damping setting.
   step(dxPx, dyPx) moves the thing and returns, per axis, false when it hit an edge. */
let glideId = 0;
const stopGlide = () => { if (glideId) { cancelAnimationFrame(glideId); glideId = 0; } };
function glide(vx, vy, step, done) {
  stopGlide();
  const { panVelocity, panDamping } = uiSettings();
  vx *= panVelocity; vy *= panVelocity;                          // px per ms
  const keep = 0.995 - panDamping * 0.0015;                      // fraction of speed kept per 16.7 ms frame
  if (Math.hypot(vx, vy) < 0.05) return done?.();
  let last = performance.now();
  const frame = now => {
    const dt = Math.min(50, now - last); last = now;
    const [okX, okY] = step(vx * dt, vy * dt);
    if (!okX) vx = 0;
    if (!okY) vy = 0;
    const f = Math.pow(keep, dt / 16.7); vx *= f; vy *= f;
    if (Math.hypot(vx, vy) < 0.01) { glideId = 0; return done?.(); }
    glideId = requestAnimationFrame(frame);
  };
  glideId = requestAnimationFrame(frame);
}
/* Tracks recent pointer positions so the release velocity ignores a pause just before letting go. */
function velocityTracker() {
  let pts = [];
  return {
    add(e) { const t = performance.now(); pts.push({ t, x: e.clientX, y: e.clientY }); pts = pts.filter(p => t - p.t < 120); },
    release() {
      const t = performance.now(), a = pts[0], b = pts[pts.length - 1]; pts = [];
      if (!a || !b || b === a || t - b.t > 60) return [0, 0];
      const dt = b.t - a.t; return dt > 0 ? [(b.x - a.x) / dt, (b.y - a.y) / dt] : [0, 0];
    },
  };
}

/* ---------- develop panel ---------- */
const GRADS = {
  temperature: "linear-gradient(90deg,#3d7bd8,#cfd6e0 50%,#e8b430)",
  tint: "linear-gradient(90deg,#3fb85c,#cfcfcf 50%,#d44bc4)",
  saturation: "linear-gradient(90deg,#777,#e0443e)",
  vibrance: "linear-gradient(90deg,#777,#e0a43e)",
};
const HUE_GRAD = "linear-gradient(90deg,hsl(0,80%,55%),hsl(60,80%,55%),hsl(120,80%,55%),hsl(180,80%,55%),hsl(240,80%,55%),hsl(300,80%,55%),hsl(360,80%,55%))";

// Panel sections that start open; after that the viewer's own choice is remembered across refreshes.
const DEFAULT_OPEN_SECTIONS = ["Tone", "Sharpening", "Noise Reduction"];
const openSections = () => store.get("openSections", DEFAULT_OPEN_SECTIONS);
function buildPanel() {
  const host = $("#sliders"); host.innerHTML = "";
  const sections = [...new Set(state.meta.schema.map(p => p.section))];
  for (const name of sections) {
    const sec = document.createElement("div");
    sec.className = "sec";
    sec.innerHTML = `<div class="hd"><span class="ttl"><span class="tg"></span>${name}</span><span class="rs" title="Reset section">Reset</span></div>`;
    if (!openSections().includes(name)) sec.classList.add("collapsed");
    $(".hd", sec).addEventListener("click", e => {
      if (e.target.classList.contains("rs")) { resetKeys(state.meta.schema.filter(p => p.section === name).map(p => p.key)); return; }
      sec.classList.toggle("collapsed");
      const rest = openSections().filter(n => n !== name);
      store.set("openSections", sec.classList.contains("collapsed") ? rest : [...rest, name]);
    });
    for (const p of state.meta.schema.filter(p => p.section === name)) {
      const row = document.createElement("div");
      row.className = "row" + (p.kind === "hue" ? " hue" : GRADS[p.key] ? " grad" : "");
      row.dataset.key = p.key;
      if (p.kind === "hue") row.style.setProperty("--g", HUE_GRAD);
      else if (GRADS[p.key]) row.style.setProperty("--g", GRADS[p.key]);
      row.innerHTML = `<label title="Double-click to reset">${p.label}</label>
        <input type="range" min="${p.min}" max="${p.max}" step="${p.step}">
        <input type="number" min="${p.min}" max="${p.max}" step="${p.step}">`;
      if (p.kind !== "hue") {
        const cog = document.createElement("button");
        cog.className = "cog"; cog.type = "button"; cog.textContent = "⚙"; cog.title = `${p.label} strength…`;
        cog.addEventListener("click", () => openStrength(p));
        cog.addEventListener("dblclick", e => e.stopPropagation());
        $("label", row).append(cog);
      }
      const [range, num] = $$("input", row);
      range.addEventListener("input", () => setValue(p.key, +range.value));
      num.addEventListener("change", () => setValue(p.key, Math.min(p.max, Math.max(p.min, +num.value || 0))));
      const reset = () => setValue(p.key, p.default);
      $("label", row).addEventListener("dblclick", reset);
      range.addEventListener("dblclick", reset);
      sec.appendChild(row);
    }
    host.appendChild(sec);
  }
}
/* Per-slider strength multiplier (app-wide, stored on the server). */
function openStrength(p) {
  const [lo, hi] = state.meta.strength_range, dlg = $("#wbDlg");
  const range = $("#wbRange"), num = $("#wbNum");
  $("#wbTitle").textContent = `${p.section}: ${p.label} strength`;
  for (const el of [range, num]) { el.min = lo; el.max = hi; el.step = 0.01; }
  const set = v => { range.value = num.value = (Math.min(hi, Math.max(lo, +v || state.meta.strength_defaults[p.key]))).toFixed(2); };
  set(state.meta.strength[p.key]);
  range.oninput = () => set(range.value);
  num.onchange = () => set(num.value);
  $("#wbReset").onclick = () => set(state.meta.strength_defaults[p.key]);
  $("#wbCancel").onclick = () => dlg.close();
  $("#wbSave").onclick = async () => {
    try {
      const r = await api("PUT", "/api/prefs/strength", { [p.key]: +num.value });
      state.meta.strength = r.strength;
      dlg.close();
      thumbBust = Date.now(); buildLists(); busyWanted = true; scheduleRender();  // thumbnails and the open image re-render
    } catch (e) { toast("Could not save: " + e.message, true); }
  };
  dlg.showModal();
}
function syncPanel() {
  const im = focusImage();
  $$("#sliders .row").forEach(row => {
    const p = state.meta.schema.find(x => x.key === row.dataset.key);
    const v = im ? im.settings[p.key] : p.default;
    const [range, num] = $$("input", row);
    range.value = v; num.value = v;
    row.classList.toggle("changed", v !== p.default);
  });
  renderImgInfo(im, null);
  if (im) getInfo(im).then(i => {
    if (state.focus !== im.id) return;
    renderImgInfo(im, i);
  });
}
/* File name / size / full path in the panel, with a copy button after the name and after the path. */
function renderImgInfo(im, i) {
  const box = $("#imgInfo"); box.replaceChildren(); box.style.whiteSpace = "pre-wrap";
  if (!im) return;
  const line = (text, copy, label) => {
    const d = document.createElement("div"); d.className = "infoLine";
    d.append(text);
    if (copy) {
      const b = document.createElement("button");
      b.className = "copyBtn"; b.type = "button"; b.textContent = "⧉"; b.title = label; b.setAttribute("aria-label", label);
      b.onclick = async () => {
        try { await navigator.clipboard.writeText(copy); toast("Copied: " + copy); }
        catch { toast("Could not copy to the clipboard", true); }
      };
      d.append(" ", b);
    }
    box.append(d);
  };
  line(i?.error ? `${im.name} — ${i.error}` : im.name, im.name, "Copy file name");
  if (i && !i.error) line(`${i.width} × ${i.height}${i.raw ? " · RAW" : ""} · ${fmtBytes(i.bytes)}`);
  if (i && !i.error) line(im.path, im.path, "Copy full path");
}
function getInfo(im) {
  im._info ??= api("GET", `/api/images/${im.id}/info`).catch(e => ({ error: e.message }));
  return im._info;
}
function setValue(key, v) {
  const im = focusImage(); if (!im) return;
  im.settings[key] = v;
  const p = state.meta.schema.find(x => x.key === key);
  im.edited = JSON.stringify(im.settings) !== JSON.stringify(state.meta.defaults);
  const row = $(`#sliders .row[data-key="${key}"]`);
  const [range, num] = $$("input", row);
  range.value = v; num.value = v; row.classList.toggle("changed", v !== p.default);
  busyWanted = true; scheduleRender(); queueSave(im);
}
function resetKeys(keys) {
  const im = focusImage(); if (!im) return;
  keys.forEach(k => im.settings[k] = state.meta.defaults[k]);
  im.edited = JSON.stringify(im.settings) !== JSON.stringify(state.meta.defaults);
  syncPanel(); busyWanted = true; scheduleRender(0); queueSave(im);
}

/* ---------- saving ---------- */
const saveTimers = new Map();
function queueSave(im) {
  pending.set(im);
  clearTimeout(saveTimers.get(im.id));
  saveTimers.set(im.id, setTimeout(() => flushSave(im.id), 400));
}
async function flushSave(id) {
  if (!saveTimers.has(id)) return;
  clearTimeout(saveTimers.get(id)); saveTimers.delete(id);
  const im = byId(id); if (!im) return;
  try {
    const r = await api("PUT", `/api/images/${id}/settings`, { settings: im.settings });
    im.rev = r.rev; pending.clear(id); refreshThumb(im);
  } catch (e) { toast("Save failed: " + e.message, true); }
}
function flushAllSaves() { [...saveTimers.keys()].forEach(flushSave); }
window.addEventListener("beforeunload", () => {
  for (const id of saveTimers.keys()) {
    const im = byId(id);
    if (im) fetch(`/api/images/${id}/settings`, { method: "PUT", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ settings: im.settings }) });
  }
});

/* ---------- rendering ---------- */
let renderTimer = null, renderAbort = null, lastUrl = null;
// The loading indicator is only for renders caused by a setting change (or opening an image), not for pans and zooms.
let busyWanted = false;
let renderSeq = 0, renderBusy = false, lastLive = 0, renderCx = 0, renderCy = 0;  // renderCx/Cy: view centre of the last render
function scheduleRender(delay = 35) { clearTimeout(renderTimer); renderTimer = setTimeout(doRender, delay); }

/* View model. z = device pixels per image pixel; (cx, cy) = image pixel at the stage centre.
   `shown` is the normalised region [x, y, w, h] covered by the bitmap currently in #mainImg,
   so pans and zooms can reposition it instantly while a sharper render is on its way. */
const view = { fit: true, z: 1, cx: 0, cy: 0, iw: 0, ih: 0, shown: null, origShown: null };
let origKey = null, origUrl = null;  // identifies the region/zoom the "original" bitmap was rendered for
const dpr = () => window.devicePixelRatio || 1;
const stageBox = () => { const s = $("#stage"); return { w: s.clientWidth, h: s.clientHeight }; };
const fitZ = () => { const b = stageBox(); return Math.min(b.w * dpr() / view.iw, b.h * dpr() / view.ih); };
const curZ = () => view.fit ? fitZ() : view.z;
const MAX_Z = 8;

function resetView() {
  stopGlide();
  // Keep the current bitmap on screen (repositioned) until the fit-size render replaces it.
  Object.assign(view, { fit: true, cx: view.iw / 2, cy: view.ih / 2 });
  layoutImage(); updateZoomUI();
}
function layoutImage() {
  if (view.fit && view.iw) { view.cx = view.iw / 2; view.cy = view.ih / 2; }
  placeImage($("#mainImg"), view.shown);
  placeImage($("#origImg"), view.origShown);
  updateSplit();
}
function placeImage(img, shown) {
  if (!shown || !view.iw) { img.style.visibility = "hidden"; return; }
  const z = curZ() / dpr(), b = stageBox(), [rx, ry, rw, rh] = shown;
  Object.assign(img.style, {
    visibility: "visible",
    left: ((rx * view.iw - view.cx) * z + b.w / 2) + "px", top: ((ry * view.ih - view.cy) * z + b.h / 2) + "px",
    width: rw * view.iw * z + "px", height: rh * view.ih * z + "px",
    imageRendering: curZ() >= 2 ? "pixelated" : "auto",
  });
}

/* A/B split: original on the left of the line, corrected on the right. */
function updateSplit() {
  const on = state.split && !!view.iw, w = stageBox().w, x = Math.round(state.splitFrac * w);
  $("#origWrap").hidden = $("#splitLine").hidden = $("#tagOrig").hidden = $("#tagCorr").hidden = !on;
  $("#abBtn").classList.toggle("active", state.split);
  if (!on) return;
  $("#splitLine").style.left = x + "px";
  $("#origWrap").style.clipPath = `inset(0 ${w - x}px 0 0)`;
}
function setSplit(on) {
  state.split = on; origKey = null;
  if (!on) { view.origShown = null; }
  layoutImage(); if (on) scheduleRender(0);
}
function updateZoomUI() {
  if (!view.iw) return;
  const z = curZ();
  $("#zoomLbl").textContent = (view.fit ? "Fit " : "") + Math.round(z * 100) + "%";
  $("#zoomFit").classList.toggle("active", view.fit);
  $("#zoom100").classList.toggle("active", !view.fit && Math.abs(z - 1) < 0.005);
  $("#stage").classList.toggle("zoomed", !view.fit);
}
function clampCenter() {
  view.cx = Math.min(view.iw, Math.max(0, view.cx)); view.cy = Math.min(view.ih, Math.max(0, view.cy));
}
/* Zoom to newZ keeping the image point under stage position (mx, my) fixed. */
function zoomTo(newZ, mx, my) {
  if (!view.iw) return;
  stopGlide();
  const b = stageBox(), f = fitZ(), d = dpr(), z0 = curZ();
  mx ??= b.w / 2; my ??= b.h / 2;
  const px = view.cx + (mx - b.w / 2) * d / z0, py = view.cy + (my - b.h / 2) * d / z0;
  newZ = Math.min(MAX_Z, newZ);
  if (view.fit && newZ <= f * 1.001) return;                  // already at the farthest-out zoom
  if (!view.fit && Math.abs(newZ - z0) < z0 * 1e-4) return;   // already at the closest zoom
  if (newZ <= f * 1.001) { resetView(); scheduleRender(60); return; }
  view.fit = false; view.z = newZ;
  view.cx = px - (mx - b.w / 2) * d / newZ; view.cy = py - (my - b.h / 2) * d / newZ;
  clampCenter(); layoutImage(); updateZoomUI(); scheduleRender(120);
}

function loadStage() {
  stopGlide();
  const im = focusImage();
  $("#stageMsg").textContent = im ? "" : "No image selected";
  renderAbort?.abort();
  view.iw = view.ih = 0; view.shown = view.origShown = null; origKey = null; layoutImage(); updateZoomUI();
  histKey = null;
  if (!im) { drawHist(null); $("#busy").hidden = true; return; }
  busyWanted = true; $("#busy").hidden = false;  // decoding the file for the first time can take a while
  getInfo(im).then(i => {
    if (state.focus !== im.id) return;
    if (i.error) { $("#stageMsg").textContent = i.error; $("#busy").hidden = true; return; }
    view.iw = i.width; view.ih = i.height; resetView(); scheduleRender(0);
  });
}
// Increasing across page loads too, so the server can tell which of two requests is newer.
const renderStamp = () => Math.floor((performance.timeOrigin + performance.now()) * 1000);
async function fetchRender(id, settings, region, zoom, signal, tag = "main") {
  const r = await fetch(`/api/images/${id}/render`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ settings, region, zoom, tag, seq: renderStamp() }), signal,
  });
  if (r.status === 409) throw new DOMException("superseded by a newer render", "AbortError");  // the server skipped it
  if (!r.ok) { let m = r.statusText; try { m = (await r.json()).error; } catch { /* */ } throw new Error(m); }
  const hdr = r.headers.get("X-Region");
  if (!hdr) throw new Error("The Tonelith server is out of date. Close it and start it again (run.bat), then refresh this page.");
  return { actual: hdr.split(",").map(Number), url: URL.createObjectURL(await r.blob()) };
}
const loadInto = (img, url) => new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
async function doRender() {
  const im = focusImage(); if (!im || !view.iw) return;
  renderAbort?.abort();
  const ctl = renderAbort = new AbortController();
  const seq = ++renderSeq; renderBusy = true; renderCx = view.cx; renderCy = view.cy;
  const settings = state.before ? state.meta.defaults : im.settings;
  if (!view.fit) updateHistogram(im, settings);  // zoomed in: the preview is only part of the image, so use a small whole-image render
  const d = dpr(), z = curZ(), b = stageBox();
  let region;
  if (view.fit) region = [0, 0, 1, 1];
  else { // visible area plus a margin so small pans stay sharp
    const vw = b.w * d / z * 1.6, vh = b.h * d / z * 1.6;
    const x0 = Math.max(0, view.cx - vw / 2), y0 = Math.max(0, view.cy - vh / 2);
    const x1 = Math.min(view.iw, view.cx + vw / 2), y1 = Math.min(view.ih, view.cy + vh / 2);
    region = [x0 / view.iw, y0 / view.ih, (x1 - x0) / view.iw, (y1 - y0) / view.ih];
  }
  const zoom = Math.min(1, z);
  // The original only needs re-rendering when the image, region or zoom changes, not on slider edits.
  const key = `${im.id}|${region.map(v => v.toFixed(5))}|${zoom.toFixed(4)}`;
  const needOrig = state.split && key !== origKey;
  if (busyWanted) $("#busy").hidden = false;
  try {
    const [main, orig] = await Promise.all([
      fetchRender(im.id, settings, region, zoom, ctl.signal),
      needOrig ? fetchRender(im.id, state.meta.defaults, region, zoom, ctl.signal, "orig") : null,
    ]);
    if (state.focus !== im.id) { URL.revokeObjectURL(main.url); if (orig) URL.revokeObjectURL(orig.url); return; }
    await loadInto($("#mainImg"), main.url);
    if (lastUrl) URL.revokeObjectURL(lastUrl);
    lastUrl = main.url; view.shown = main.actual;
    if (orig) {
      await loadInto($("#origImg"), orig.url);
      if (origUrl) URL.revokeObjectURL(origUrl);
      origUrl = orig.url; view.origShown = orig.actual; origKey = key;
    }
    layoutImage();
    $("#stageMsg").textContent = "";
    if (view.fit) drawHist($("#mainImg"));
  } catch (e) {
    if (e.name === "AbortError") return;
    view.shown = view.origShown = null; layoutImage();
    $("#stageMsg").textContent = e.message;
  } finally {
    if (!ctl.signal.aborted) { $("#busy").hidden = true; busyWanted = false; }
    if (seq === renderSeq) renderBusy = false;
  }
}
/* While dragging or gliding, re-render the visible region every `panUpdate` seconds so the parts that have
   scrolled into view fill in. A render already under way is left to finish rather than being aborted. */
function liveRender() {
  const { panUpdate, panThreshold } = uiSettings(), now = performance.now();
  if (panUpdate <= 0 || renderBusy || now - lastLive < panUpdate * 1000 || movedPx() < Math.max(1, panThreshold)) return;
  lastLive = now; doRender();
}
/* How far (in screen px) the view has moved since the last render. */
const movedPx = () => Math.hypot(view.cx - renderCx, view.cy - renderCy) * curZ() / dpr();
/* After a drag/glide ends: render the final position, unless it has barely moved (no loading flicker for nothing). */
function settleRender() {
  if (!view.shown || movedPx() >= Math.max(1, uiSettings().panThreshold)) scheduleRender(60);
}
function setBefore(on) {
  if (state.split) return;  // the split view already shows the original
  if (state.view !== "develop" || state.before === on) return;
  state.before = on; $("#beforeTag").hidden = !on; scheduleRender(0);
}

let histAbort = null, histKey = null;
async function updateHistogram(im, settings) {
  const key = im.id + JSON.stringify(settings);
  if (key === histKey) return;  // panning doesn't change the histogram
  histKey = key;
  histAbort?.abort();
  const ctl = histAbort = new AbortController();
  try {
    const r = await fetchRender(im.id, settings, [0, 0, 1, 1], Math.min(1, 320 / Math.max(view.iw, view.ih)), ctl.signal, "hist");
    const img = new Image();
    try { await loadInto(img, r.url); if (!ctl.signal.aborted && state.focus === im.id && !view.fit) drawHist(img); }
    finally { URL.revokeObjectURL(r.url); }
  } catch { if (histAbort === ctl) histKey = null; /* cancelled, superseded or failed: keep the last drawing and retry next time */ }
}
function drawHist(img) {
  const c = $("#hist"), g = c.getContext("2d");
  g.clearRect(0, 0, c.width, c.height);
  if (!img || !img.naturalWidth) return;
  const w = 256, h = Math.max(1, Math.round(256 * img.naturalHeight / img.naturalWidth));
  const off = document.createElement("canvas"); off.width = w; off.height = h;
  const og = off.getContext("2d", { willReadFrequently: true });
  og.drawImage(img, 0, 0, w, h);
  const d = og.getImageData(0, 0, w, h).data, bins = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  for (let i = 0; i < d.length; i += 4) { bins[0][d[i]]++; bins[1][d[i + 1]]++; bins[2][d[i + 2]]++; }
  const max = Math.max(1, ...bins.map(b => { const s = [...b].sort((a, b) => b - a); return s[2] || s[0]; }));
  g.globalCompositeOperation = "lighter";
  ["#c8322b", "#2fa84f", "#2f6fd6"].forEach((col, ch) => {
    g.fillStyle = col;
    for (let x = 0; x < 256; x++) { const v = Math.min(1, bins[ch][x] / max) * c.height; g.fillRect(x, c.height - v, 1, v); }
  });
}

/* ---------- copy / paste ---------- */
function sectionsList() { return [...new Set(state.meta.schema.map(p => p.section))]; }
function openCopyDialog() {
  const box = $("#copyGroups");
  box.innerHTML = sectionsList().map(s => `<label><input type="checkbox" checked value="${s}"> ${s}</label>`).join("");
  $("#copyDlg").showModal();
}
/* Copy the edited image (as it looks with its current settings) to the system clipboard as a PNG. */
async function copyImageToClipboard() {
  const im = focusImage() ?? byId([...state.sel][0]);
  if (!im) return toast("Select an image to copy", true);
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") return toast("This browser can't copy images to the clipboard", true);
  flushAllSaves();
  toast(`Copying ${im.name}…`);
  // Handing the clipboard a promise keeps the click's permission alive while the image renders.
  const png = (async () => {
    const r = await fetch(`/api/images/${im.id}/render`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings: im.settings, region: [0, 0, 1, 1], zoom: 1 }) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    const bmp = await createImageBitmap(await r.blob());
    const c = document.createElement("canvas"); c.width = bmp.width; c.height = bmp.height;
    c.getContext("2d").drawImage(bmp, 0, 0);
    return await new Promise((ok, no) => c.toBlob(b => b ? ok(b) : no(new Error("PNG encode failed")), "image/png"));
  })();
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    toast(`Copied ${im.name} to the clipboard`);
  } catch (e) { toast("Could not copy the image: " + e.message, true); }
}
async function copySettings(sections) {
  const src = focusImage() ?? byId([...state.sel][0]);
  if (!src) return toast("No image to copy from", true);
  const keys = state.meta.schema.filter(p => !sections || sections.includes(p.section)).map(p => p.key);
  const settings = Object.fromEntries(keys.map(k => [k, src.settings[k]]));
  const payload = { tonelith: "settings", version: 1, source: src.name, settings };
  state.clip = payload;
  const text = JSON.stringify(payload);
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch { /* ignore */ } ta.remove();
  }
  toast(`Copied ${keys.length} settings from ${src.name}`);
}
async function pasteSettings() {
  let payload = null;
  try {
    const o = JSON.parse(await navigator.clipboard.readText());
    if (o && o.tonelith === "settings") payload = o;
  } catch { /* clipboard unreadable or not ours */ }
  payload ??= state.clip;
  if (!payload) return toast("Nothing to paste — copy settings first", true);
  await applySettingsToSelection(payload.settings, "Pasted settings onto");
}
/* Write `settings` onto every selected image (paste and presets share this). */
async function applySettingsToSelection(settings, doneMsg) {
  const ids = [...state.sel];
  if (!ids.length) return toast("Select images first", true);
  flushAllSaves();
  try {
    const r = await api("POST", "/api/images/settings", { ids, settings });
    for (const [id, v] of Object.entries(r)) {
      const im = byId(+id); if (!im) continue;
      im.settings = v.settings; im.rev = v.rev;
      im.edited = JSON.stringify(im.settings) !== JSON.stringify(state.meta.defaults);
      refreshThumb(im);
    }
    if (state.view === "develop") { syncPanel(); busyWanted = true; scheduleRender(0); }
    toast(`${doneMsg} ${ids.length} image${ids.length > 1 ? "s" : ""}`);
  } catch (e) { toast("Failed: " + e.message, true); }
}

/* ---------- file picker (server-side filesystem browser) ---------- */
function pickFs({ mode, title, start, types = "", okText = "" }) {  // types: "video" lists movie files; one file at a time
  return new Promise(resolve => {
    const dlg = $("#fsDlg");
    let cur = start || store.get("fsPath", "~"), sel = new Set(), entries = [], anchor = null;
    $("#fsSelAll").hidden = $("#fsSelNone").hidden = mode !== "files" || !!types;
    $("#fsTitle").textContent = title;
    $("#fsRecWrap").hidden = mode !== "folder";
    $("#fsOk").textContent = okText || mode === "files" ? okText || "Add" : mode === "folder" ? "Add this folder" : "Choose this folder";
    const upd = () => {
      $("#fsOk").disabled = mode === "files" ? sel.size === 0 : !cur;
      $("#fsSel").textContent = mode === "files" ? `${sel.size} file${sel.size === 1 ? "" : "s"} selected` : "";
    };
    $("#fsView").value = store.get("fsView", "files");
    const onView = () => { store.set("fsView", $("#fsView").value); draw(); };
    let places = [];
    const favName = p => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
    function drawPlaces() {
      const favs = store.get("favorites", []);
      $("#fsPlaces").innerHTML = [{ name: "Computer", path: "" }, ...places].map(p => `<div data-p="${esc(p.path)}">${esc(p.name)}</div>`).join("")
        + favs.map(p => `<div class="fav" data-p="${esc(p)}" title="${esc(p)}"><span class="star">★</span>${esc(favName(p))}</div>`).join("");
      const isFav = !!cur && favs.includes(cur);
      $("#fsFav").disabled = !cur;
      $("#fsFav").classList.toggle("remove", isFav);
      $("#fsFavTxt").textContent = isFav ? "Remove from favorites" : "Add to favorites";
      $("#fsFav").title = isFav ? "Remove this folder from favorites" : "Add this folder to favorites";
    }
    const onFav = () => {
      if (!cur) return;
      const favs = store.get("favorites", []);
      store.set("favorites", favs.includes(cur) ? favs.filter(f => f !== cur) : [...favs, cur]);
      drawPlaces();
    };
    // Thumbnails load through a small queue (3 at a time, visible ones only) so they never use up all the browser's
    // connections: navigating (Up, a place, a folder) must always get through, and it cancels whatever is still queued.
    let thumbCtl = null, thumbObs = null, thumbQ = [];
    const thumbCache = new Map();  // path -> object URL, for the folder being shown
    function stopThumbs() {
      thumbCtl?.abort(); thumbCtl = null; thumbObs?.disconnect(); thumbObs = null; thumbQ = [];
    }
    function clearThumbCache() { thumbCache.forEach(u => URL.revokeObjectURL(u)); thumbCache.clear(); }
    function startThumbs() {
      stopThumbs();
      const imgs = $$("#fsList img[data-src]");
      if (!imgs.length) return;
      const ctl = thumbCtl = new AbortController();
      let active = 0;  // per run, so a cancelled run can't throw the count off
      const pump = () => {
        while (active < 3 && thumbQ.length && !ctl.signal.aborted) {
          const img = thumbQ.shift(), path = img.dataset.path;
          active++;
          fetch(img.dataset.src, { signal: ctl.signal })
            .then(r => { if (!r.ok) throw new Error("thumb"); return r.blob(); })
            .then(b => { if (ctl.signal.aborted) return; const u = URL.createObjectURL(b); thumbCache.set(path, u); img.src = u; })
            .catch(() => { if (!ctl.signal.aborted) img.parentNode.textContent = "📄"; })
            .finally(() => { active--; pump(); });
        }
      };
      thumbObs = new IntersectionObserver(es => {
        for (const e of es) if (e.isIntersecting) { thumbObs.unobserve(e.target); thumbQ.push(e.target); }
        pump();
      }, { root: $("#fsList"), rootMargin: "200px" });
      imgs.forEach(i => thumbObs.observe(i));
    }
    async function go(path, selectPath) {
      stopThumbs();  // drop queued thumbnails straight away so this navigation isn't held up
      try {
        const r = await api("GET", `/api/fs?path=${encodeURIComponent(path)}&all=${$("#fsAll").checked ? 1 : 0}${types ? "&types=" + types : ""}`);
        if (r.path !== cur) clearThumbCache();
        cur = r.path; entries = r.entries; sel = new Set(selectPath ? [selectPath] : []); anchor = null;
        $("#fsPath").value = r.path; $("#fsUp").disabled = r.parent === null;
        $("#fsUp").dataset.p = r.parent ?? "";
        places = r.places;
        drawPlaces(); draw(); store.set("fsPath", cur);
      } catch (e) { $("#fsSel").textContent = e.message; }
    }
    function draw() {
      const thumbs = $("#fsView").value === "thumbs";
      $("#fsList").classList.toggle("thumbs", thumbs);
      if (thumbs) {  // widen tiles so each row fills the available width
        const w = $("#fsList").clientWidth - 4, gap = 8, cols = Math.max(1, Math.floor((w + gap) / (124 + gap)));
        $("#fsList").style.setProperty("--tile", Math.floor((w - gap * (cols - 1)) / cols) + "px");
      }
      $("#fsList").innerHTML = entries.map((e, i) => {
        const dim = !e.dir && !e.supported ? " dim" : "";
        if (thumbs) {
          const cached = thumbCache.get(e.path);
          const inner = e.dir ? "📁" : e.supported && types ? "🎞" : e.supported
            ? `<img alt="" data-path="${esc(e.path)}" ${cached ? `src="${cached}"` : `data-src="/api/fs/thumb?path=${encodeURIComponent(e.path)}"`}>` : "📄";
          return `<div class="ent${sel.has(e.path) ? " sel" : ""}${dim}" data-i="${i}" title="${esc(e.name)}"><div class="tb">${inner}</div><div class="nm">${esc(e.name)}</div></div>`;
        }
        return `<div class="ent${sel.has(e.path) ? " sel" : ""}${dim}" data-i="${i}"><span>${e.dir ? "📁" : types ? "🎞" : "🖼"}</span><span>${esc(e.name)}</span><span class="sz">${e.dir || !e.size ? "" : fmtBytes(e.size)}</span></div>`;
      }).join("") || `<div class="ent dim">Nothing here</div>`;
      if (thumbs) startThumbs(); else stopThumbs();
      upd();
    }
    const onList = e => {
      const row = e.target.closest(".ent"); if (!row || row.dataset.i === undefined) return;
      const ent = entries[+row.dataset.i];
      if (ent.dir) { go(ent.path); return; }
      if (mode !== "files") return;
      if (e.type === "dblclick") { sel = new Set([ent.path]); finish(true); return; }
      if (types) { sel = new Set([ent.path]); anchor = +row.dataset.i; draw(); return; }  // movies: one at a time
      const i = +row.dataset.i, additive = e.ctrlKey || e.metaKey;
      if (e.shiftKey && anchor !== null) {
        const [lo, hi] = anchor < i ? [anchor, i] : [i, anchor];
        const range = entries.slice(lo, hi + 1).filter(x => !x.dir && x.supported).map(x => x.path);
        sel = new Set(additive ? [...sel, ...range] : range);
      } else if (additive) {
        sel.has(ent.path) ? sel.delete(ent.path) : sel.add(ent.path);
        anchor = i;
      } else { sel = new Set([ent.path]); anchor = i; }
      draw();
    };
    const onSelAll = () => { sel = new Set(entries.filter(x => !x.dir && x.supported).map(x => x.path)); anchor = null; draw(); };
    const onSelNone = () => { sel = new Set(); anchor = null; draw(); };
    const onPlaces = e => { const d = e.target.closest("[data-p]"); if (d) go(d.dataset.p); };
    const onGo = () => {
      const v = $("#fsPath").value.trim().replace(/^"|"$/g, "");
      go(v, mode === "files" && /\.[A-Za-z0-9]+$/.test(v) ? v : null);
    };
    const onKey = e => { if (e.key === "Enter") onGo(); };
    const onUp = () => go($("#fsUp").dataset.p);
    const onAll = () => go(cur);
    const finish = ok => {
      stopThumbs(); clearThumbCache();
      cleanup();
      dlg.close();
      if (!ok) return resolve(null);
      resolve({ paths: mode === "files" ? [...sel] : [cur], recursive: $("#fsRec").checked });
    };
    const onOk = () => finish(true), onCancel = () => finish(false);
    const cleanup = () => {
      $("#fsList").removeEventListener("click", onList); $("#fsList").removeEventListener("dblclick", onList);
      $("#fsPlaces").removeEventListener("click", onPlaces); $("#fsGo").removeEventListener("click", onGo);
      $("#fsPath").removeEventListener("keydown", onKey); $("#fsUp").removeEventListener("click", onUp);
      $("#fsAll").removeEventListener("change", onAll); $("#fsOk").removeEventListener("click", onOk);
      $("#fsCancel").removeEventListener("click", onCancel); dlg.removeEventListener("cancel", onCancel);
      $("#fsFav").removeEventListener("click", onFav); $("#fsView").removeEventListener("change", onView);
      $("#fsSelAll").removeEventListener("click", onSelAll); $("#fsSelNone").removeEventListener("click", onSelNone);
    };
    $("#fsFav").addEventListener("click", onFav); $("#fsView").addEventListener("change", onView);
    $("#fsSelAll").addEventListener("click", onSelAll); $("#fsSelNone").addEventListener("click", onSelNone);
    $("#fsList").addEventListener("click", onList); $("#fsList").addEventListener("dblclick", onList);
    $("#fsPlaces").addEventListener("click", onPlaces); $("#fsGo").addEventListener("click", onGo);
    $("#fsPath").addEventListener("keydown", onKey); $("#fsUp").addEventListener("click", onUp);
    $("#fsAll").addEventListener("change", onAll); $("#fsOk").addEventListener("click", onOk);
    $("#fsCancel").addEventListener("click", onCancel); dlg.addEventListener("cancel", onCancel);
    dlg.showModal(); go(cur);
  });
}
async function addPaths(res) {
  if (!res || !res.paths.length) return;
  try {
    const r = await api("POST", `/api/libraries/${state.libId}/images`, res);
    let msg = `Added ${r.added} image${r.added === 1 ? "" : "s"}`;
    if (r.duplicates) msg += `, ${r.duplicates} already in library`;
    if (r.skipped.length) msg += `, ${r.skipped.length} unsupported skipped`;
    toast(msg, r.added === 0 && r.skipped.length > 0);
    if (state.view === "develop" && r.last_id) {  // developing: jump to the last photo that was just added
      flushAllSaves();
      state.focus = r.last_id; state.sel = new Set([r.last_id]);
    }
    await loadLibs(); await loadImages(true); syncHash("replace");
  } catch (e) { toast(e.message, true); }
}

/* ---------- export ---------- */
function openExport() {
  const n = state.sel.size;
  $("#expSelN").textContent = n; $("#expAllN").textContent = state.images.length;
  $$('input[name="expScope"]').forEach(r => r.checked = r.value === (n ? "selected" : "all"));
  const o = store.get("export", {});
  $("#expFmt").value = o.format ?? "jpeg"; $("#expQ").value = o.quality ?? 92; $("#expBits").value = o.bits ?? 8;
  $("#expResizeOn").checked = !!o.resize; $("#expLong").value = o.long ?? 2048;
  $("#expSuffix").value = o.suffix ?? "-edit"; $("#expDest").value = o.dest ?? state.meta.export_dir;
  $("#expErr").hidden = true; $("#expGo").disabled = false;
  syncExportForm(); $("#expDlg").showModal();
}
function syncExportForm() {
  const f = $("#expFmt").value;
  $("#expQRow").hidden = !(f === "jpeg" || f === "webp");
  $("#expBRow").hidden = !(f === "png" || f === "tiff");
  $("#expQv").textContent = $("#expQ").value;
  $("#expLong").disabled = !$("#expResizeOn").checked;
}
function expError(msg) { const e = $("#expErr"); e.textContent = msg; e.hidden = false; }
async function runExport() {
  const scope = $('input[name="expScope"]:checked').value;
  const opts = {
    format: $("#expFmt").value, quality: +$("#expQ").value, bits: +$("#expBits").value,
    long_edge: $("#expResizeOn").checked ? +$("#expLong").value : null,
    suffix: $("#expSuffix").value, dest: $("#expDest").value.trim(),
  };
  store.set("export", { ...opts, resize: $("#expResizeOn").checked, long: $("#expLong").value });
  if (scope === "selected" && !state.sel.size) return expError("No images are selected.");
  const body = scope === "selected" ? { ...opts, ids: [...state.sel] } : { ...opts, library_id: state.libId };
  $("#expGo").disabled = true; $("#expErr").hidden = true;
  flushAllSaves();
  await new Promise(r => setTimeout(r, 450)); // let pending settings land before they are snapshotted
  try {
    const r = await api("POST", "/api/export", body);
    $("#expDlg").close();
    toast(`Queued ${r.queued} image${r.queued === 1 ? "" : "s"} for export`);
    pollQueue();
  } catch (e) { expError(e.message); }
  $("#expGo").disabled = false;
}

/* ---------- export queue (progress in the header) ---------- */
let qTimer = null, qWasRunning = false, qHideTimer = null, qErrors = [];
async function pollQueue() {
  clearTimeout(qTimer);
  let s;
  try { s = await api("GET", "/api/export/status"); } catch { qTimer = setTimeout(pollQueue, 2000); return; }
  if (s.running) {
    qWasRunning = true; clearTimeout(qHideTimer);
    const box = $("#queue"); box.hidden = false; box.className = "group";
    $("#qBar").max = Math.max(1, s.total); $("#qBar").value = s.done;
    $("#qLbl").textContent = `Exporting ${Math.min(s.done + 1, s.total)} of ${s.total}` + (s.current ? ` · ${s.current}` : "");
    $("#qLbl").title = s.dests.join("\n");
    $("#qCancel").hidden = false; $("#qClose").hidden = true;
    qTimer = setTimeout(pollQueue, 500);
  } else if (qWasRunning) {
    qWasRunning = false; finishQueue(s);
  }
}
function finishQueue(s) {
  qErrors = s.errors;
  const box = $("#queue"); box.hidden = false;
  box.className = "group " + (s.errors.length ? "done bad" : "done");
  $("#qBar").max = Math.max(1, s.exported + s.errors.length); $("#qBar").value = s.exported + s.errors.length;
  let msg = `Exported ${s.exported} of ${s.total + s.cancelled}`;
  if (s.cancelled) msg += ` · ${s.cancelled} cancelled`;
  if (s.errors.length) msg += ` · ${s.errors.length} failed (click for details)`;
  $("#qLbl").textContent = msg; $("#qLbl").title = s.dests.join("\n");
  $("#qCancel").hidden = true; $("#qClose").hidden = false;
  toast(msg, s.errors.length > 0);
  if (!s.errors.length) { clearTimeout(qHideTimer); qHideTimer = setTimeout(() => $("#queue").hidden = true, 12000); }
}
async function cancelQueue() {
  let s;
  try { s = await api("GET", "/api/export/status"); } catch (e) { return toast(e.message, true); }
  if (!s.running) return pollQueue();
  const waiting = Math.max(0, s.total - s.done - 1);
  const ok = await confirmModal({
    title: "Cancel the export queue?",
    message: `${plural(waiting, "image is", "images are")} still waiting and will not be exported.${NL}` +
      `The image being processed right now will finish, and the ${s.done} already exported are kept.`,
    okText: "Cancel the queue", cancelText: "Keep exporting", danger: true,
  });
  if (!ok) return;
  try {
    const r = await api("POST", "/api/export/cancel", {});
    toast(`Cancelled ${r.cancelled} queued image${r.cancelled === 1 ? "" : "s"}`);
  } catch (e) { toast(e.message, true); }
  pollQueue();
}

/* ---------- temp folder ---------- */
async function openCache() {
  const c = (await api("GET", "/api/meta")).cache;
  $("#cachePath").textContent = c.path; $("#cacheInfo").textContent = `${c.files} files · ${fmtBytes(c.bytes)}`;
  $("#cacheDlg").showModal();
}

/* ---------- in-app dialogs (replace the browser's confirm / prompt / alert) ---------- */
function showMsg({ title, message = "", okText = "OK", cancelText = "Cancel", danger = false,
                   input = null, notice = false, scroll = false }) {
  return new Promise(resolve => {
    const dlg = $("#msgDlg"), box = $("#msgInput"), ok = $("#msgOk"), cancel = $("#msgCancel");
    $("#msgTitle").textContent = title;
    $("#msgBody").textContent = message; $("#msgBody").classList.toggle("scroll", scroll);
    box.hidden = input === null; box.value = input ?? "";
    ok.textContent = okText; cancel.textContent = cancelText;
    ok.classList.toggle("danger", danger); cancel.hidden = notice;
    dlg.returnValue = "";
    let done = false;  // answer as soon as the user decides, rather than after the fade-out
    const settle = yes => { if (!done) { done = true; resolve({ ok: yes, value: box.value }); } };
    ok.onclick = () => { settle(true); dlg.close("ok"); };
    cancel.onclick = () => { settle(false); dlg.close("cancel"); };
    box.onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); settle(true); dlg.close("ok"); } };
    dlg.oncancel = () => settle(false);  // Esc
    dlg.onclose = () => settle(false);
    dlg.showModal();
    // Destructive actions start on the safe button so a stray Enter can't confirm them.
    if (input !== null) { box.focus(); box.select(); } else (danger ? cancel : ok).focus();
  });
}
const confirmModal = async opts => (await showMsg(opts)).ok;
const promptModal = async opts => { const r = await showMsg({ ...opts, input: opts.value ?? "" }); return r.ok ? r.value : null; };
const infoModal = opts => showMsg({ okText: "Close", ...opts, notice: true, scroll: true });
const confirmDeleteLibrary = lib => confirmModal({
  title: `Delete library "${lib.name}"?`,
  message: `It contains ${plural(lib.count, "image", "images")}. Only the catalog entries and their settings are removed; ` +
    "your image files on disk are not touched.",
  okText: "Delete library", danger: true,
});

/* ---------- manage libraries ---------- */
const lm = { id: null, pvFor: null, pvReq: 0 };  // lm.id: library selected in the manager; pv*: its preview grid
const libById = id => state.libs.find(l => l.id === id);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const NL = String.fromCharCode(10);

function defaultLibName() {
  const d = new Date(), p = n => String(n).padStart(2, "0");
  const base = `library_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const taken = new Set(state.libs.map(l => l.name));
  let name = base, n = 2;
  while (taken.has(name)) name = `${base}_${n++}`;
  return name;
}
async function openLibManager() {
  await loadLibs(); lm.id = state.libId; lm.pvFor = null;  // refetch: images may have been added or featured since last time
  $("#libSearch").value = "";
  renderLibManager();
  $("#libDlg").showModal();
  $("#libList .libItem.on")?.scrollIntoView({ block: "nearest" });
}
/* ---------- preview zoom: click a thumbnail in the grid and it grows to fill the grid; X shrinks it back and removes it ---------- */
let pvZoom = null;  // the open overlay: { el, tile, a, b, x, busy, ready, url, ro }
const PV_MS = 380, PV_EASE = "cubic-bezier(.2,.8,.2,1)";
const pvRel = (r, base) => ({ left: r.left - base.left, top: r.top - base.top, width: r.width, height: r.height });
const pvPx = r => ({ left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
const pvBoxRect = () => $(".pvBox").getBoundingClientRect();
const pvGridRect = () => pvRel($("#pvGrid").getBoundingClientRect(), pvBoxRect());

function openPreviewZoom(tile, im) {
  if (pvZoom) return;
  const thumb = $("img", tile);
  if (!thumb || !thumb.complete || !thumb.naturalWidth) return;  // thumbnail not loaded (or failed): nothing to grow
  const from = pvRel(tile.getBoundingClientRect(), pvBoxRect()), to = pvGridRect();
  const el = document.createElement("div");
  el.className = "pvZoom";
  el.innerHTML = `<img class="pvA" alt="" draggable="false"><img class="pvB" alt="" draggable="false">` +
    `<button class="pvX" title="Close" aria-label="Close preview">✕</button>`;
  const a = $(".pvA", el), b = $(".pvB", el), x = $(".pvX", el);
  a.src = thumb.src;                        // starts as the tile's own thumbnail, so it grows out of the tile seamlessly
  b.style.opacity = 0; x.style.opacity = 0;
  Object.assign(el.style, pvPx(from));
  $(".pvBox").appendChild(el);
  tile.style.visibility = "hidden";         // the tile "becomes" the overlay while it is open
  const z = pvZoom = { el, tile, a, b, x, busy: true, ready: false, url: null, ro: null };
  const anim = el.animate([pvPx(from), pvPx(to)], { duration: PV_MS, easing: PV_EASE, fill: "forwards" });
  anim.onfinish = () => {
    Object.assign(el.style, pvPx(pvGridRect())); anim.cancel(); z.busy = false;
    x.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, fill: "forwards" }); x.focus();
    z.ro = new ResizeObserver(() => { if (!z.busy) Object.assign(el.style, pvPx(pvGridRect())); });  // stay glued to the grid
    z.ro.observe($(".pvBox"));
    if (z.ready) showZoomImage(z);
  };
  x.onclick = closePreviewZoom;
  loadZoomImage(z, im);
}
/* A bigger render of the whole photo (with its saved edits), faded in over the thumbnail once it arrives. */
async function loadZoomImage(z, im) {
  try {
    const info = await api("GET", `/api/images/${im.id}/info`);
    if (info.error) return;
    const r = await fetch(`/api/images/${im.id}/render`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ region: [0, 0, 1, 1], zoom: Math.min(1, 1100 / Math.max(info.width, info.height)) }),
    });
    if (!r.ok) return;
    const url = URL.createObjectURL(await r.blob());
    if (pvZoom !== z) { URL.revokeObjectURL(url); return; }
    await new Promise((res, rej) => { z.b.onload = res; z.b.onerror = rej; z.b.src = url; });
    if (pvZoom !== z) { URL.revokeObjectURL(url); return; }
    z.url = url; z.ready = true;
    if (!z.busy) showZoomImage(z);
  } catch { /* keep showing the thumbnail */ }
}
function showZoomImage(z) { z.b.style.opacity = 1; z.a.style.opacity = 0; }
function closePreviewZoom() {
  const z = pvZoom;
  if (!z || z.busy) return;
  if (!z.tile.isConnected) { destroyPreviewZoom(); return; }
  z.busy = true; z.ro?.disconnect();
  z.x.style.opacity = 0; z.a.style.opacity = 1; z.b.style.opacity = 0;  // back to the thumbnail while it shrinks
  const now = pvRel(z.el.getBoundingClientRect(), pvBoxRect()), to = pvRel(z.tile.getBoundingClientRect(), pvBoxRect());
  z.el.animate([pvPx(now), pvPx(to)], { duration: PV_MS, easing: PV_EASE, fill: "forwards" }).onfinish = destroyPreviewZoom;
}
function destroyPreviewZoom() {
  const z = pvZoom;
  if (!z) return;
  pvZoom = null; z.ro?.disconnect();
  if (z.url) URL.revokeObjectURL(z.url);
  z.el.remove(); z.tile.style.visibility = "";
}

/* 5x5 preview: the library's featured images if it has any, otherwise its first 25. */
async function loadLibPreview(id) {
  const token = ++lm.pvReq, grid = $("#pvGrid"), label = $("#pvLabel");
  destroyPreviewZoom();  // a different library (or a refresh) invalidates any open zoom
  grid.replaceChildren(); label.textContent = "";
  let r;
  try { r = await api("GET", `/api/libraries/${id}/preview`); } catch { return; }
  if (token !== lm.pvReq) return;  // the selection changed while this was loading
  if (!r.total) { label.textContent = "This library is empty."; return; }
  if (r.mode === "featured") {
    label.innerHTML = `<span class="pvStar">★</span> Featured images` +
      (r.featured > r.images.length ? ` (showing ${r.images.length} of ${r.featured})` : ` (${r.featured})`);
  } else {
    label.textContent = r.total > r.images.length ? `First ${r.images.length} of ${r.total} images` : plural(r.total, "image", "images");
  }
  grid.replaceChildren(...r.images.map(im => {
    const tile = document.createElement("div");
    tile.className = "pvTile"; tile.title = im.name; tile.innerHTML = `<div class="im"></div>`;
    loadThumbImg(tile, im);  // same loading spinner / error handling as the main thumbnails
    tile.addEventListener("click", () => openPreviewZoom(tile, im));
    return tile;
  }));
}
/* ---------- library location (city / province or state / country) ---------- */
const LOC_FIELDS = [["city", "#libCity"], ["region", "#libRegion"], ["country", "#libCountry"]];
const locText = p => [p.city, p.region, p.country].filter(Boolean).join(", ");

function fillLocationFields(lib) {  // don't overwrite a box the user is typing in
  for (const [key, sel] of LOC_FIELDS) if (document.activeElement !== $(sel)) $(sel).value = lib[key] || "";
}
async function saveLocation(libId = lm.id) {
  const body = Object.fromEntries(LOC_FIELDS.map(([key, sel]) => [key, $(sel).value.trim()]));
  await api("PUT", `/api/libraries/${libId}`, body);
  await loadLibs();
}

/* Coordinates -> place names. BigDataCloud's client-side endpoint (no key needed), with OpenStreetMap as a fallback. */
async function reverseGeocode(lat, lon) {
  try {
    const r = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`);
    if (r.ok) {
      const d = await r.json();
      const place = { city: d.city || d.locality || "", region: d.principalSubdivision || "", country: (d.countryName || "").replace(/ [(]the[)]$/i, "") };
      if (place.city || place.region || place.country) return place;
    }
  } catch { /* fall through to the second service */ }
  const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&addressdetails=1&accept-language=en&lat=${lat}&lon=${lon}`);
  if (!r.ok) throw new Error("The place-name lookup service didn't respond.");
  const a = (await r.json()).address || {};
  return { city: a.city || a.town || a.village || a.municipality || a.hamlet || "", region: a.state || a.province || a.region || a.county || "", country: a.country || "" };
}
function geoErrorText(e) {
  if (e && e.code === 1) return "Location permission was denied. Allow it in your browser's site settings, or type the location in.";
  if (e && e.code === 2) return "Your device couldn't work out its location. You can type it in instead.";
  if (e && e.code === 3) return "Finding your location took too long. Try again, or type it in.";
  if (e instanceof TypeError) return "Couldn't reach the place-name lookup service. Check your internet connection, or type the location in.";
  return (e && e.message) || "Couldn't get your location.";
}
async function useMyLocation() {
  const libId = lm.id, msg = $("#locMsg"), btn = $("#locBtn");
  if (!navigator.geolocation) { msg.textContent = "This browser can't provide a location. You can type it in instead."; return; }
  btn.disabled = true; msg.textContent = "";  // the lookup runs quietly; only a failure is reported
  try {
    const pos = await new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, { timeout: 15000, maximumAge: 600000 }));
    const place = await reverseGeocode(pos.coords.latitude, pos.coords.longitude);
    if (!locText(place)) throw new Error("No place name was found for your location.");
    if (lm.id === libId) for (const [key, sel] of LOC_FIELDS) $(sel).value = place[key];
    await api("PUT", `/api/libraries/${libId}`, place);
    await loadLibs();
  } catch (e) { if (lm.id === libId) msg.textContent = geoErrorText(e); }
  finally { btn.disabled = false; }
}

/* The left-hand list, filtered by the search box. Returns the libraries currently shown. */
function renderLibList() {
  const raw = $("#libSearch").value.trim(), q = raw.toLowerCase();
  const shown = state.libs.filter(l => l.name.toLowerCase().includes(q));
  $("#libList").innerHTML = shown.length
    ? shown.map(l =>
      `<div class="libItem${l.id === lm.id ? " on" : ""}${l.id === state.libId ? " cur" : ""}" data-id="${l.id}" title="${esc(l.name)}"><span class="n">${esc(l.name)}</span><span class="c">${l.count}</span></div>`).join("")
    : `<div class="none">No libraries match "${esc(raw)}".</div>`;
  return shown;
}
function renderLibManager({ focusName = false } = {}) {
  if (!libById(lm.id)) lm.id = state.libs[0]?.id ?? null;
  renderLibList();
  const lib = libById(lm.id);
  $("#libEditBody").hidden = !lib; $("#libNone").hidden = !!lib;
  $("#libDelete").disabled = $("#libOpen").disabled = !lib;
  if (!lib) { lm.pvFor = null; lm.pvReq++; $("#pvGrid").replaceChildren(); $("#pvLabel").textContent = ""; return; }
  $("#libName").value = lib.name;
  fillLocationFields(lib);
  if (lm.pvFor !== lib.id) { lm.pvFor = lib.id; loadLibPreview(lib.id); }  // not on every re-render (e.g. a rename)

  if (focusName) { $("#libName").focus(); $("#libName").select(); }
}
function askDuplicates(check, dstName) {
  return new Promise(resolve => {
    const dlg = $("#dupDlg");
    $("#dupMsg").textContent = `Checked ${plural(check.total, "image", "images")}: ${check.new} will be added to "${dstName}" as new entries, ` +
      `and ${check.duplicates} already ${check.duplicates === 1 ? "has an entry" : "have entries"} there.`;
    $("#dupN").textContent = plural(check.duplicates, "existing entry", "existing entries");
    const finish = v => { dlg.close(); resolve(v); };
    $("#dupOver").onclick = () => finish("overwrite");
    $("#dupCopy").onclick = () => finish("copy");
    $("#dupCancel").onclick = () => finish(null);
    dlg.oncancel = () => resolve(null);  // Esc
    dlg.showModal();
  });
}
/* Copy image entries (with their settings) into another library, used by the right-click "Add to library".
   Returns a message describing the outcome. */
async function copyIds(ids, dst) {
  await Promise.all([...saveTimers.keys()].map(flushSave));  // copy the latest settings, not stale ones
  // 1) Look at every image first so the question is asked once, with real numbers.
  const check = await api("POST", `/api/libraries/${dst.id}/copy-check`, { ids });
  let mode = null;
  if (check.duplicates) {
    mode = await askDuplicates(check, dst.name);
    if (!mode) return "Copy cancelled.";
  }
  // 2) Apply the one decision to every duplicate.
  const r = await api("POST", `/api/libraries/${dst.id}/copy`, { ids, on_duplicate: mode });
  const parts = [];
  if (r.added) parts.push(`${r.added} added`);
  if (r.overwritten) parts.push(`${r.overwritten} overwritten`);
  if (r.copied) parts.push(`${r.copied} added as new copies`);
  await loadLibs();
  if (dst.id === state.libId) await loadImages(true);
  return `Copied to "${dst.name}": ${parts.join(", ") || "nothing changed"}.`;
}
function wireLibManager() {
  $("#manageLibs").onclick = openLibManager;
  $("#libClose").onclick = () => $("#libDlg").close();
  $("#libDlg").addEventListener("close", destroyPreviewZoom);
  // Esc closes the zoomed image first, not the whole window.
  document.addEventListener("keydown", e => { if (e.key === "Escape" && pvZoom) { e.preventDefault(); e.stopPropagation(); closePreviewZoom(); } }, true);
  $("#libSearch").addEventListener("input", renderLibList);
  $("#libSearch").addEventListener("keydown", e => {  // Enter opens the first match in the edit panel
    if (e.key !== "Enter") return;
    e.preventDefault();
    const first = renderLibList()[0];
    if (first) { lm.id = first.id; renderLibManager(); }
  });
  $("#libList").addEventListener("click", e => {
    const row = e.target.closest(".libItem"); if (!row) return;
    lm.id = +row.dataset.id; $("#locMsg").textContent = "";
    renderLibManager();
  });
  $("#libAdd").onclick = async () => {
    try {
      const { id } = await api("POST", "/api/libraries", { name: defaultLibName() });
      await loadLibs(); lm.id = id;
      $("#libSearch").value = "";  // make sure the new library is visible in the list
      renderLibManager({ focusName: true });
      $("#libList .libItem.on")?.scrollIntoView({ block: "nearest" });  // straight into editing the new library's name
    } catch (e) { toast(e.message, true); }
  };
  const nameBox = $("#libName");
  nameBox.addEventListener("keydown", e => { if (e.key === "Enter") nameBox.blur(); });
  nameBox.addEventListener("change", async () => {
    const lib = libById(lm.id); if (!lib) return;
    const name = nameBox.value.trim();
    if (!name) { nameBox.value = lib.name; return; }
    if (name === lib.name) return;
    try { await api("PUT", `/api/libraries/${lib.id}`, { name }); await loadLibs(); }
    catch (e) { toast(e.message, true); }
    renderLibManager();
  });
  $("#locBtn").onclick = useMyLocation;
  for (const [, sel] of LOC_FIELDS) {
    $(sel).addEventListener("keydown", e => { if (e.key === "Enter") $(sel).blur(); });
    $(sel).addEventListener("change", async () => {  // typed by hand: save when the box loses focus
      try { await saveLocation(); $("#locMsg").textContent = ""; } catch (e) { toast(e.message, true); }
    });
  }
  $("#libOpen").onclick = () => { $("#libDlg").close(); switchLib(lm.id); };
  $("#libDelete").onclick = async () => {
    const lib = libById(lm.id); if (!lib) return;
    if (!await confirmDeleteLibrary(lib)) return;
    try {
      await api("DELETE", `/api/libraries/${lib.id}`);
      if (lib.id === state.libId) {
        state.libId = null; state.focus = null;
        await loadLibs(); await loadImages(); syncHash("replace");
      } else await loadLibs();
      lm.id = state.libId;
    } catch (e) { toast(e.message, true); }
    renderLibManager();
  };
}

/* ---------- library dropdown ---------- */
function renderLibButton() {
  const cur = libById(state.libId);
  $("#libBtnName").textContent = cur ? cur.name : "No library";
  $("#libBtnCount").textContent = cur ? cur.count : "";
  if (!$("#libMenu").hidden) renderLibMenuList();
}
function renderLibMenuList() {
  const raw = $("#libMenuSearch").value.trim(), q = raw.toLowerCase();
  const shown = state.libs.filter(l => l.name.toLowerCase().includes(q));
  $("#libMenuList").innerHTML = shown.length
    ? shown.map(l => `<button class="ctxItem${l.id === state.libId ? " cur" : ""}" role="option" data-id="${l.id}" title="${esc(l.name)}"><span class="n">${esc(l.name)}</span><kbd>${l.count}</kbd></button>`).join("")
    : `<div class="none">No libraries match "${esc(raw)}".</div>`;
}
function openLibMenu() {
  closeContextMenu();
  const btn = $("#libBtn"), menu = $("#libMenu"), r = btn.getBoundingClientRect();
  $("#libMenuSearch").value = "";
  renderLibMenuList();
  menu.hidden = false;
  menu.style.minWidth = Math.max(280, r.width) + "px";
  menu.style.left = Math.max(6, Math.min(r.left, innerWidth - menu.offsetWidth - 6)) + "px";
  menu.style.top = r.bottom + 6 + "px";
  btn.classList.add("open"); btn.setAttribute("aria-expanded", "true");
  $("#libMenuSearch").focus();
  $("#libMenuList .ctxItem.cur")?.scrollIntoView({ block: "nearest" });
}
function closeLibMenu(refocus = false) {
  const menu = $("#libMenu"); if (menu.hidden) return;
  menu.hidden = true;
  $("#libBtn").classList.remove("open"); $("#libBtn").setAttribute("aria-expanded", "false");
  if (refocus) $("#libBtn").focus();
}
function wireLibMenu() {
  const btn = $("#libBtn"), menu = $("#libMenu"), search = $("#libMenuSearch");
  btn.onclick = () => menu.hidden ? openLibMenu() : closeLibMenu(true);
  search.addEventListener("input", renderLibMenuList);
  menu.addEventListener("click", e => {
    const item = e.target.closest(".ctxItem"); if (!item) return;
    const id = +item.dataset.id;
    closeLibMenu(true);
    if (id !== state.libId) switchLib(id);
  });
  menu.addEventListener("keydown", e => {
    e.stopPropagation();  // keep the app's single-key shortcuts and arrow-key image navigation out of the menu
    const items = $$("#libMenuList .ctxItem"), i = items.indexOf(document.activeElement);
    if (e.key === "Escape") { e.preventDefault(); closeLibMenu(true); }
    else if (e.key === "ArrowDown") { e.preventDefault(); (items[i + 1] ?? items[i < 0 ? 0 : i])?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); if (i <= 0) search.focus(); else items[i - 1].focus(); }
    else if (e.key === "Enter" && e.target === search) { e.preventDefault(); items[0]?.click(); }  // first match
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && e.target !== search) search.focus();  // typing anywhere searches
  });
  document.addEventListener("pointerdown", e => { if (!menu.hidden && !e.target.closest("#libMenu, #libBtn")) closeLibMenu(); }, true);
  window.addEventListener("blur", () => closeLibMenu());
  window.addEventListener("resize", () => closeLibMenu());
}

/* ---------- presets ---------- */
async function loadPresets() {
  try { state.presets = await api("GET", "/api/presets"); } catch { state.presets = []; }
  if (!$("#presetMenu").hidden) renderPresetMenu();
}
async function saveAsPreset() {
  const im = focusImage();
  if (!im) return toast("Open an image to save its settings as a preset", true);
  flushAllSaves();
  let n = state.presets.length + 1;
  while (state.presets.some(p => p.name.toLowerCase() === `preset ${n}`)) n++;
  const name = (await promptModal({ title: "Save as preset", message: "Name for this preset:", value: `Preset ${n}`, okText: "Save" }))?.trim();
  if (!name) return;
  const exists = state.presets.some(p => p.name.toLowerCase() === name.toLowerCase());
  if (exists && !await confirmModal({ title: `Replace preset "${name}"?`, message: "A preset with this name exists. Its settings will be replaced.", okText: "Replace", danger: true })) return;
  try {
    state.presets = await api("POST", "/api/presets", { name, settings: im.settings, overwrite: exists });
    toast(`Saved preset "${name}"`);
  } catch (e) { toast("Could not save preset: " + e.message, true); }
}
function renderPresetMenu() {
  $("#presetList").innerHTML = state.presets.length
    ? state.presets.map(p => `<button class="ctxItem" role="menuitem" data-id="${p.id}" title="Apply to the selected images"><span class="n">${esc(p.name)}</span><span class="x" data-del="${p.id}" title="Delete preset">✕</span></button>`).join("")
    : `<div class="none">No presets yet. Use <b>Save as preset</b> in the panel on the right.</div>`;
}
function openPresetMenu() {
  closeContextMenu(); closeLibMenu();
  const btn = $("#presetsBtn"), menu = $("#presetMenu"), r = btn.getBoundingClientRect();
  renderPresetMenu();
  menu.hidden = false;
  menu.style.minWidth = Math.max(240, r.width) + "px";
  menu.style.left = Math.max(6, Math.min(r.left, innerWidth - menu.offsetWidth - 6)) + "px";
  menu.style.top = r.bottom + 6 + "px";
  btn.classList.add("open"); btn.setAttribute("aria-expanded", "true");
}
function closePresetMenu() {
  const menu = $("#presetMenu"); if (menu.hidden) return;
  menu.hidden = true;
  $("#presetsBtn").classList.remove("open"); $("#presetsBtn").setAttribute("aria-expanded", "false");
}
function wirePresets() {
  const menu = $("#presetMenu"), btn = $("#presetsBtn");
  btn.onclick = () => menu.hidden ? openPresetMenu() : closePresetMenu();
  $("#savePreset").onclick = saveAsPreset;
  menu.addEventListener("click", async e => {
    const del = e.target.closest("[data-del]");
    const p = state.presets.find(x => x.id === +(del ?? e.target.closest(".ctxItem") ?? {}).dataset?.[del ? "del" : "id"]);
    if (!p) return;
    closePresetMenu();
    if (del) {
      if (!await confirmModal({ title: `Delete preset "${p.name}"?`, message: "Images already using these settings are not changed.", okText: "Delete", danger: true })) return;
      try { state.presets = await api("DELETE", `/api/presets/${p.id}`); toast(`Deleted preset "${p.name}"`); }
      catch (err) { toast("Could not delete: " + err.message, true); }
    } else applySettingsToSelection(p.settings, `Applied "${p.name}" to`);
  });
  menu.addEventListener("keydown", e => { if (e.key === "Escape") { closePresetMenu(); btn.focus(); } });
  document.addEventListener("pointerdown", e => { if (!menu.hidden && !e.target.closest("#presetMenu, #presetsBtn")) closePresetMenu(); }, true);
  window.addEventListener("blur", closePresetMenu);
  window.addEventListener("resize", closePresetMenu);
}

/* ---------- right-click menu ---------- */
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");
const ctx = { open: false, ids: [] };

/* Featured: if every selected image is already featured the menu offers to remove it, otherwise it marks them all. */
const selectionAllFeatured = () => {
  const ims = [...state.sel].map(byId).filter(Boolean);
  return ims.length > 0 && ims.every(i => i.featured);
};
async function toggleFeatured() {
  const ims = [...state.sel].map(byId).filter(Boolean);
  if (!ims.length) return;
  const featured = !selectionAllFeatured();
  try {
    await api("POST", "/api/images/featured", { ids: ims.map(i => i.id), featured });
    ims.forEach(i => { i.featured = featured; refreshThumb(i); });
    toast(featured ? `Marked ${plural(ims.length, "image", "images")} as featured` : `Removed featured from ${plural(ims.length, "image", "images")}`);
  } catch (e) { toast("Could not update featured: " + e.message, true); }
}
async function removeSelected() {
  if (!state.sel.size) return;
  const n = state.sel.size;
  if (!await confirmModal({ title: `Remove ${plural(n, "image", "images")} from this library?`,
    message: "Their settings and cached previews are deleted. Anything also used by another library is kept for it. The image files on disk are not deleted.", okText: "Remove", danger: true })) return;
  try {
    await api("POST", "/api/images/remove", { ids: [...state.sel] });
    state.focus = null; await loadLibs(); await loadImages(); syncHash("replace");
  } catch (e) { toast("Could not remove: " + e.message, true); }
}
/* Permanently delete the selected images' files from disk (and every catalog entry for them). */
async function deleteSelectedFiles() {
  const ids = [...state.sel]; if (!ids.length) return;
  const files = [...new Set(ids.map(id => byId(id)?.path).filter(Boolean))];
  const first = byId(ids[0])?.name ?? "this file";
  const ok = await confirmModal({
    title: `Delete ${files.length === 1 ? `"${first}"` : plural(files.length, "file", "files")} from disk?`,
    message: `${files.length === 1 ? "The file" : "These files"} will be permanently deleted from your computer. This cannot be undone.${NL}${NL}` +
      "Every library entry that uses them is removed too, including in other libraries.",
    okText: "Delete from disk", danger: true });
  if (!ok) return;
  try {
    ids.forEach(id => { pending.clear(id); clearTimeout(saveTimers.get(id)); saveTimers.delete(id); });  // nothing left to save for them
    const r = await api("POST", "/api/images/delete-files", { ids });
    state.focus = null; await loadLibs(); await loadImages(); syncHash("replace");
    if (r.failed.length) infoModal({ title: `Deleted ${plural(r.deleted, "file", "files")}; ${r.failed.length} could not be deleted`, message: r.failed.join(NL) });
    else toast(`Deleted ${plural(r.deleted, "file", "files")} from disk`);
  } catch (e) { toast("Could not delete: " + e.message, true); }
}
function openContextMenu(x, y,{ alignRight = false, fromButton = false } = {}) {
  const menu = $("#ctxMenu"), n = state.sel.size;
  const only = n === 1 ? byId([...state.sel][0]) : null;
  $("#ctxHead").textContent = n > 1 ? `${n} images selected` : only ? only.name : "No image selected";
  $("#kCopy").textContent = IS_MAC ? "⌘C" : "Ctrl+C"; $("#kPaste").textContent = IS_MAC ? "⌘V" : "Ctrl+V";
  $('#ctxMenu [data-act="copy"]').disabled = !(focusImage() ?? only);
  $('#ctxMenu [data-act="paste"]').disabled = n === 0;
  $('#ctxMenu [data-act="clip"]').disabled = n === 0;
  $('#ctxMenu [data-act="addlib"]').disabled = n === 0;
  $('#ctxMenu [data-act="feature"]').disabled = n === 0;
  $('#ctxMenu [data-act="remove"]').disabled = n === 0;
  $('#ctxMenu [data-act="delete"]').disabled = n === 0;
  $("#ctxFeatureLbl").textContent = selectionAllFeatured() ? "Remove featured" : "Mark as featured";
  menu.hidden = false; ctx.open = true;
  const w = menu.offsetWidth, h = menu.offsetHeight;  // keep it on screen, flipping up/left near the edges
  const left = alignRight ? x - w : x;
  menu.style.left = Math.max(6, Math.min(left, innerWidth - w - 6)) + "px";
  menu.style.top = Math.max(6, y + h + 6 > innerHeight ? y - h : y) + "px";
  ctx.fromButton = fromButton;
  $("#actionsBtn").classList.toggle("open", fromButton);
  $("#actionsBtn").setAttribute("aria-expanded", String(fromButton));
}
function closeContextMenu() {
  if (!ctx.open) return;
  $("#ctxMenu").hidden = true; ctx.open = false;
  $("#actionsBtn").classList.remove("open"); $("#actionsBtn").setAttribute("aria-expanded", "false");
}
/* The header's Actions button shows the same menu as a right-click, directly below the button. */
function toggleActionsMenu() {
  if (ctx.reopenBlocked) { ctx.reopenBlocked = false; return; }  // this click is the one that just closed it
  closeLibMenu();
  const r = $("#actionsBtn").getBoundingClientRect();
  openContextMenu(r.right, r.bottom + 6, { alignRight: true, fromButton: true });
}

async function openAddToLibrary() {
  ctx.ids = [...state.sel]; ctx.dst = null;
  if (!ctx.ids.length) return;
  await loadLibs();  // fresh counts
  const cur = libById(state.libId), others = state.libs.filter(l => l.id !== state.libId);
  $("#addLibInfo").textContent = `${plural(ctx.ids.length, "image", "images")} from "${cur.name}" will be copied with their settings. Choose a library, then press OK.`;
  ctx.others = others;
  $("#addLibSearch").value = ""; $("#addLibSearch").hidden = others.length === 0;
  renderAddList();
  chooseAddTarget(others.length === 1 ? others[0].id : null);  // a lone choice is pre-selected, but still needs OK
  $("#addLibDlg").showModal();
  $("#addLibSearch").focus();
}
/* Rebuild the list for the current search text. A chosen library that gets filtered out is un-chosen. */
function renderAddList() {
  const q = $("#addLibSearch").value.trim().toLowerCase();
  const shown = ctx.others.filter(l => l.name.toLowerCase().includes(q));
  $("#addLibList").innerHTML = !ctx.others.length
    ? `<div class="none">There are no other libraries yet. Use Manage libraries to create one.</div>`
    : shown.length
      ? shown.map(l => `<div class="libItem" data-id="${l.id}"><span class="n">${esc(l.name)}</span><span class="c">${l.count}</span></div>`).join("")
      : `<div class="none">No libraries match "${esc($("#addLibSearch").value.trim())}".</div>`;
  chooseAddTarget(shown.some(l => l.id === ctx.dst) ? ctx.dst : null);
  return shown;
}
function chooseAddTarget(id) {
  ctx.dst = id;
  $$("#addLibList .libItem").forEach(r => r.classList.toggle("on", +r.dataset.id === id));
  $("#addLibOk").disabled = id === null;
}
async function addSelectionToLibrary(ids, dst) {
  toast(`Copying ${plural(ids.length, "image", "images")} to "${dst.name}"…`);
  try { toast(await copyIds(ids, dst)); }
  catch (e) { toast("Copy failed: " + e.message, true); }
}

function wireContextMenu() {
  document.addEventListener("contextmenu", e => {
    const t = e.target;
    // Text fields keep the native menu so a path can still be pasted into them.
    if (t.closest && t.closest("input[type=text], input[type=number], textarea")) { closeContextMenu(); return; }
    e.preventDefault();
    if (t.closest("#ctxMenu, #libMenu")) return;
    closeLibMenu();
    if (anyDialogOpen()) { closeContextMenu(); return; }
    const thumb = t.closest(".thumb");
    if (thumb) {  // like most photo apps: right-clicking outside the selection selects that image first
      const id = +thumb.dataset.id;
      if (!state.sel.has(id)) { state.sel = new Set([id]); state.anchor = id; }
      setFocus(id, false); refreshSelectionUI();
    }
    openContextMenu(e.clientX, e.clientY);
  });
  document.addEventListener("pointerdown", e => {
    if (!ctx.open || e.target.closest("#ctxMenu")) return;
    ctx.reopenBlocked = !!e.target.closest("#actionsBtn");  // pressing Actions while its menu is open should just close it
    if (ctx.reopenBlocked) setTimeout(() => { ctx.reopenBlocked = false; }, 400);  // in case no click follows
    closeContextMenu();
  }, true);
  $("#actionsBtn").addEventListener("click", toggleActionsMenu);
  window.addEventListener("blur", closeContextMenu);
  window.addEventListener("resize", closeContextMenu);
  document.addEventListener("wheel", closeContextMenu, { passive: true });
  document.addEventListener("keydown", e => {
    if (!ctx.open) return;
    const items = $$("#ctxMenu .ctxItem").filter(b => !b.disabled);
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeContextMenu(); if (ctx.fromButton) $("#actionsBtn").focus(); }
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault(); e.stopPropagation();
      const i = items.indexOf(document.activeElement), d = e.key === "ArrowDown" ? 1 : -1;
      items[i < 0 ? (d > 0 ? 0 : items.length - 1) : (i + d + items.length) % items.length]?.focus();
    } else if (e.key !== "Enter" && e.key !== " ") closeContextMenu();  // anything else (e.g. Ctrl+C) just dismisses it
  }, true);
  $("#ctxMenu").addEventListener("click", e => {
    const b = e.target.closest(".ctxItem"); if (!b || b.disabled) return;
    closeContextMenu();
    if (b.dataset.act === "copy") copySettings(null);
    else if (b.dataset.act === "paste") pasteSettings();
    else if (b.dataset.act === "clip") copyImageToClipboard();
    else if (b.dataset.act === "addlib") openAddToLibrary();
    else if (b.dataset.act === "feature") toggleFeatured();
    else if (b.dataset.act === "remove") removeSelected();
    else if (b.dataset.act === "delete") deleteSelectedFiles();
  });
  $("#addLibCancel").onclick = () => $("#addLibDlg").close();
  $("#addLibSearch").addEventListener("input", renderAddList);
  $("#addLibSearch").addEventListener("keydown", e => {  // Enter picks the only match; it still needs OK
    if (e.key !== "Enter") return;
    e.preventDefault();
    const shown = renderAddList();
    if (shown.length === 1) chooseAddTarget(shown[0].id);
    else if (!$("#addLibOk").disabled) $("#addLibOk").click();
  });
  // Clicking a library only chooses it; nothing is copied until OK is pressed.
  $("#addLibList").addEventListener("click", e => {
    const row = e.target.closest(".libItem"); if (!row) return;
    chooseAddTarget(+row.dataset.id);
  });
  $("#addLibOk").onclick = () => {
    const dst = libById(ctx.dst); if (!dst) return;
    $("#addLibDlg").close();
    addSelectionToLibrary(ctx.ids, dst);
  };
}

/* ---------- About window (logo + details from info/application_info.html) ---------- */
// The details are shown inside a shadow root so any <style> in the file can't leak into the app (or the app's into it).
const ABOUT_CSS = `
  :host { display: block; line-height: 1.6; font-size: 14px; color: inherit; }
  * { box-sizing: border-box; }
  h1, h2, h3, h4 { margin: .2em 0 .45em; color: #fff; line-height: 1.25; }
  h1 { font-size: 24px; } h2 { font-size: 19px; } h3 { font-size: 16px; } h4 { font-size: 14px; }
  p { margin: .6em 0; } b, strong { color: #fff; }
  a { color: #7cc0ff; text-decoration: none; } a:hover { color: #a9d6ff; text-decoration: none; }
  /* <a class="btn-info-green">Label</a> in application_info.html renders as a dark green button (same green as Add files). */
  .btn-info-green { display: inline-block; padding: 7px 16px; margin: 2px 0; line-height: 1.3; font-weight: 600; cursor: pointer; user-select: none;
    color: #e3f7e8; background: #1e5a2d; border: 1px solid #2e7d42; border-radius: 6px; text-decoration: none; }
  .btn-info-green:hover { color: #fff; background: #26703a; border-color: #3c9654; text-decoration: none; }
  .btn-info-green:active { background: #194c26; }
  .btn-info-green:focus-visible { outline: 2px solid #4aa3ff; outline-offset: 2px; }
  ul, ol { padding-left: 1.4em; margin: .6em 0; } li { margin: .2em 0; }
  code, kbd, pre { font-family: Consolas, "SF Mono", Menlo, monospace; font-size: 12.5px; background: #111113; border-radius: 4px; }
  code, kbd { padding: 1px 5px; } pre { padding: 10px 12px; overflow-x: auto; }
  hr { border: 0; border-top: 1px solid #34343a; margin: 1em 0; }
  img { max-width: 100%; height: auto; }
  table { border-collapse: collapse; } th, td { border: 1px solid #34343a; padding: 4px 9px; text-align: left; }
  blockquote { margin: .6em 0; padding-left: 12px; border-left: 3px solid #34343a; color: #b8b8c0; }
`;

/* Turn the file's HTML into something safe to show: no scripts, frames, forms or inline event handlers. */
function safeInfoHtml(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script, iframe, frame, object, embed, applet, form, link, meta, base, noscript").forEach(n => n.remove());
  doc.querySelectorAll("*").forEach(el => {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase(), value = attr.value.trim().toLowerCase();
      if (name.startsWith("on") || ((name === "href" || name === "src" || name === "xlink:href" || name === "action") && value.startsWith("javascript:"))) {
        el.removeAttribute(attr.name);
      }
    }
    if (el.tagName === "A" && /^https?:/i.test(el.getAttribute("href") || "")) { el.target = "_blank"; el.rel = "noopener noreferrer"; }  // web links only (not mailto:)
    if (el.classList.contains("btn-info-green")) { el.setAttribute("role", "button"); if (!el.hasAttribute("tabindex")) el.tabIndex = 0; }
  });
  const styles = [...doc.head.querySelectorAll("style")].map(s => s.outerHTML).join("");
  return styles + doc.body.innerHTML;
}
async function openAbout() {
  const host = $("#aboutInfo"), root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  const show = html => { root.innerHTML = `<style>${ABOUT_CSS}</style>${html}`; };
  show("<p>Loading…</p>");
  $("#aboutDlg").showModal();
  $("#aboutClose").focus();
  try {
    const r = await fetch("/api/app-info", { cache: "no-store" });
    if (!r.ok) throw new Error("not found");
    show(safeInfoHtml(await r.text()));
  } catch {
    show("<p>No details found. Add some to <code>info/application_info.html</code>.</p>");
  }
}
function wireAbout() {
  $("#brandBtn").onclick = openAbout;
  $("#aboutClose").onclick = () => $("#aboutDlg").close();
}

/* ---------- interface settings dialog ---------- */
function openUiSettings() {
  const dlg = $("#uiDlg");
  const rows = [["panVelocity", "#uiVel", "#uiVelNum", 3], ["panDamping", "#uiDamp", "#uiDampNum", 100], ["panUpdate", "#uiUpd", "#uiUpdNum", 2], ["panThreshold", "#uiThr", "#uiThrNum", 300]];
  const show = () => { const u = uiSettings(); for (const [k, r, n] of rows) { $(r).value = u[k]; $(n).value = u[k]; } };
  const save = (k, v, max) => { const o = store.get("ui", {}); o[k] = Math.min(max, Math.max(0, Math.round((+v || 0) * 100) / 100)); store.set("ui", o); show(); };
  for (const [k, r, n, max] of rows) {
    $(r).oninput = () => save(k, $(r).value, max);
    $(n).onchange = () => save(k, $(n).value, max);
  }
  $("#uiReset").onclick = () => { store.set("ui", {}); show(); };
  $("#uiClose").onclick = () => dlg.close();
  show(); dlg.showModal();
}

/* ---------- movie frame extraction runs in the background ---------- */
let movieTimer = null, movieAdded = -1;
/* Add images the library gained since the last look, without rebuilding the grid or touching the open image. */
async function appendNewImages() {
  const list = await api("GET", `/api/libraries/${state.libId}/images`);
  const have = new Set(state.images.map(i => i.id));
  const fresh = list.filter(i => !have.has(i.id));
  if (!fresh.length) return;
  for (const im of fresh) { state.images.push(im); $("#grid").append(makeThumb(im)); $("#filmstrip").append(makeThumb(im)); }
  $("#emptyMsg").hidden = true;
  refreshSelectionUI();
}
async function pollMovie() {
  clearTimeout(movieTimer); movieTimer = null;
  let s; try { s = await api("GET", "/api/movies/status"); } catch { movieTimer = setTimeout(pollMovie, 1500); return; }
  const bar = $("#movieQueue");
  if (s.running) {
    bar.hidden = false;
    $("#mqLbl").textContent = `Extracting frame ${Math.min(s.saved + 1, s.expected || Infinity).toLocaleString()}${s.expected ? ` of ${s.expected.toLocaleString()}` : ""}`;
    const b = $("#mqBar"); if (s.total > 0) { b.max = s.total; b.value = s.done; } else b.removeAttribute("value");
    if (s.added !== movieAdded) {
      movieAdded = s.added;
      if (s.lib === state.libId) { try { await appendNewImages(); await loadLibs(); } catch { /* try again next tick */ } }
    }
    movieTimer = setTimeout(pollMovie, 700);
    return;
  }
  const wasShowing = !bar.hidden || movieAdded >= 0;
  bar.hidden = true; movieAdded = -1;
  if (!wasShowing || !s.finished) return;
  try { await loadLibs(); if (s.lib === state.libId) await appendNewImages(); } catch { /* ignore */ }
  if (s.error) toast(`Movie import: ${s.error}`, true);
  else if (s.cancelled) toast(`Stopped extracting frames — ${s.added.toLocaleString()} added to the library`);
  else toast(`Added ${s.added.toLocaleString()} frame${s.added === 1 ? "" : "s"} from ${s.name}`);
}

/* ---------- import movie frames ---------- */
async function openMovieImport() {
  if (!state.libId) return toast("Create or choose a library first", true);
  const dlg = $("#movieDlg");
  const m = { path: "", info: null, dest: store.get("movieDest", state.meta.movie_dir), running: false };
  const fmtTime = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const every = () => $("#mvMode").value === "interval";
  const estimate = () => {
    const i = m.info; if (!i || !i.frames) return null;
    if (!every()) return i.frames;
    const step = Math.max(1, Math.round((i.fps || 25) * (+$("#mvSec").value || 0)));
    return Math.floor((i.frames - 1) / step) + 1;
  };
  const refresh = () => {
    $("#mvSecRow").hidden = !every();
    $("#mvPath").value = m.path; $("#mvDest").value = m.dest;
    const i = m.info;
    $("#mvInfo").textContent = !m.path ? "No movie chosen" : !i ? "Reading movie…" :
      `${i.width}×${i.height} · ${i.fps} fps · ${i.duration ? fmtTime(i.duration) : "unknown length"}${i.frames ? ` · ${i.frames.toLocaleString()} frames` : ""}`;
    const n = estimate();
    $("#mvEst").textContent = n === null ? "" : `About ${n.toLocaleString()} image${n === 1 ? "" : "s"} will be added to this library.`;
    $("#mvGo").disabled = m.running || !i || (every() && !(+$("#mvSec").value > 0));
  };
  $("#mvErr").hidden = true;
  $("#mvMode").value = "interval"; $("#mvSec").value = store.get("movieSec", 1); $("#mvFmt").value = "jpeg";
  m.path = ""; refresh();

  $("#mvChoose").onclick = async () => {
    const r = await pickFs({ mode: "files", title: "Choose a movie file", types: "video", okText: "Choose", start: store.get("movieDir") });
    if (!r?.paths.length) return;
    m.path = r.paths[0]; m.info = null; store.set("movieDir", m.path); refresh();
    try { m.info = await api("POST", "/api/movies/probe", { path: m.path }); }
    catch (e) { m.path = ""; $("#mvErr").textContent = e.message; $("#mvErr").hidden = false; }
    refresh();
  };
  $("#mvDestBtn").onclick = async () => {
    const r = await pickFs({ mode: "dir", title: "Choose where to save the frames", start: m.dest });
    if (r?.paths.length) { m.dest = r.paths[0]; store.set("movieDest", m.dest); refresh(); }
  };
  $("#mvMode").onchange = $("#mvSec").oninput = () => { if (+$("#mvSec").value > 0) store.set("movieSec", +$("#mvSec").value); refresh(); };

  $("#mvGo").onclick = async () => {
    const n = estimate();
    if (!every() && n && n > 500 && !await confirmModal({ title: `Extract ${n.toLocaleString()} frames?`,
      message: "That is a lot of images. It will take a while and use plenty of disk space. Consider extracting a frame every few seconds instead.", okText: "Extract all" })) return;
    $("#mvErr").hidden = true; $("#mvGo").disabled = true;
    try {
      await api("POST", "/api/movies/extract", { path: m.path, mode: every() ? "interval" : "all", seconds: +$("#mvSec").value,
        format: $("#mvFmt").value, dest: m.dest, lib: state.libId });
    } catch (e) { $("#mvErr").textContent = e.message; $("#mvErr").hidden = false; $("#mvGo").disabled = false; return; }
    dlg.close();
    movieAdded = 0; pollMovie();  // from now on, report when it finishes
  };
  $("#mvCancel").onclick = () => dlg.close();
  dlg.showModal();
}

/* ---------- wiring ---------- */
function wire() {
  // Tabs must sit on the header's bottom edge, so when the header wraps (narrow window, export bar showing) they drop to the last row.
  const top = $("#top");
  new ResizeObserver(() => top.classList.toggle("wrapped", top.offsetHeight > 75)).observe(top);
  wireAbout();
  wireLibMenu();
  wirePresets();
  wireLibManager();
  wireContextMenu();
  $("#addFiles").onclick = async () => addPaths(await pickFs({ mode: "files", title: "Add files — from any folder on this computer" }));
  $("#addFolder").onclick = async () => addPaths(await pickFs({ mode: "folder", title: "Add folder" }));
  $("#tabLib").onclick = () => setView("library");
  $("#tabDev").onclick = () => setView("develop");
  $("#importMovie").onclick = openMovieImport;
  $("#mqStop").onclick = async () => { try { await api("POST", "/api/movies/cancel", {}); } catch (e) { toast(e.message, true); } };
  $("#selAll").onclick = () => { state.sel = new Set(state.images.map(i => i.id)); refreshSelectionUI(); };
  $("#removeSel").onclick = removeSelected;
  $("#thumbSize").oninput = e => { $("#grid").style.setProperty("--ts", e.target.value + "px"); store.set("ts", +e.target.value); };
  $("#copyCancel").onclick = () => $("#copyDlg").close();
  $("#copyOk").onclick = () => { copySettings($$("#copyGroups input:checked").map(i => i.value)); $("#copyDlg").close(); };
  $("#exportBtn").onclick = openExport;
  $("#expClose").onclick = () => $("#expDlg").close();
  $("#expGo").onclick = runExport;
  $("#qCancel").onclick = cancelQueue;
  $("#qClose").onclick = () => $("#queue").hidden = true;
  $("#qLbl").onclick = () => { if ($("#queue").classList.contains("bad")) infoModal({ title: "Export errors", message: qErrors.join(NL) }); };
  $("#expFmt").onchange = $("#expQ").oninput = $("#expResizeOn").onchange = syncExportForm;
  $("#expBrowse").onclick = async () => {
    const r = await pickFs({ mode: "dir", title: "Choose export folder", start: $("#expDest").value });
    if (r) $("#expDest").value = r.paths[0];
  };
  $("#cacheBtn").onclick = openCache;
  $("#settingsBtn").onclick = openUiSettings;
  $("#cacheClose").onclick = () => $("#cacheDlg").close();
  $("#cacheClear").onclick = async () => {
    const c = await api("POST", "/api/cache/clear");
    $("#cacheInfo").textContent = `${c.files} files · ${fmtBytes(c.bytes)}`; toast("Temp data cleared");
    $("#cacheDlg").close();
    thumbBust = Date.now(); buildLists();  // thumbnails go black with a spinner, then reload
  };
  $("#resetAll").onclick = () => resetKeys(state.meta.schema.map(p => p.key));
  window.addEventListener("resize", () => { if (state.view !== "develop") return; layoutImage(); updateZoomUI(); scheduleRender(150); });

  window.addEventListener("hashchange", applyRoute);

  // Drag the filmstrip sideways to scroll it. A real drag must not also count as a click on a thumbnail.
  const film = $("#filmstrip");
  let fd = null, filmMoved = false;
  const fvt = velocityTracker();
  film.addEventListener("pointerdown", e => {
    if (e.button !== 0 || e.pointerType === "touch") return;  // touch already scrolls natively
    stopGlide();
    fd = { x: e.clientX, left: film.scrollLeft, id: e.pointerId }; filmMoved = false; fvt.add(e);
  });
  film.addEventListener("pointermove", e => {
    if (!fd) return;
    const dx = e.clientX - fd.x; fvt.add(e);
    if (!filmMoved && Math.abs(dx) > 5) { filmMoved = true; film.setPointerCapture(fd.id); film.classList.add("dragging"); }
    if (filmMoved) film.scrollLeft = fd.left - dx;
  });
  const endFilmDrag = (e, cancelled) => {
    const was = fd && filmMoved; fd = null; film.classList.remove("dragging");
    const [vx] = fvt.release();
    if (!was || cancelled) return;
    glide(vx, 0, dx => { const l0 = film.scrollLeft; film.scrollLeft = l0 - dx; return [film.scrollLeft !== l0, true]; });
  };
  film.addEventListener("pointerup", endFilmDrag); film.addEventListener("pointercancel", e => endFilmDrag(e, true));
  film.addEventListener("click", e => { if (filmMoved) { e.stopPropagation(); e.preventDefault(); filmMoved = false; } }, true);

  // Zoom & pan on the stage.
  const stage = $("#stage");
  stage.addEventListener("wheel", e => {
    if (!view.iw) return;
    e.preventDefault(); stopGlide();
    const r = stage.getBoundingClientRect();
    zoomTo(curZ() * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018)), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  let drag = null;
  const vt = velocityTracker();
  stage.addEventListener("pointerdown", e => {
    if (e.button !== 0 || e.target.closest("#zoomBar, #splitLine, #abBtn")) return;
    stopGlide();  // grabbing the image stops any glide
    if (view.fit || !view.iw) return;
    drag = { x: e.clientX, y: e.clientY }; vt.add(e); stage.setPointerCapture(e.pointerId); stage.classList.add("panning");
  });
  stage.addEventListener("pointermove", e => {
    if (!drag) return;
    const k = dpr() / curZ();
    view.cx -= (e.clientX - drag.x) * k; view.cy -= (e.clientY - drag.y) * k;
    drag.x = e.clientX; drag.y = e.clientY; vt.add(e);
    clampCenter(); layoutImage(); liveRender();
  });
  const endDrag = (e, cancelled) => {
    if (!drag) return; drag = null; stage.classList.remove("panning");
    const [vx, vy] = vt.release();
    if (cancelled) return settleRender();
    glide(vx, vy, (dx, dy) => {
      const k = dpr() / curZ(), x0 = view.cx, y0 = view.cy;
      view.cx -= dx * k; view.cy -= dy * k; clampCenter(); layoutImage(); liveRender();
      return [view.cx !== x0 || dx === 0, view.cy !== y0 || dy === 0];
    }, settleRender);
    if (!glideId) settleRender();
  };
  stage.addEventListener("pointerup", endDrag); stage.addEventListener("pointercancel", e => endDrag(e, true));
  stage.addEventListener("dblclick", e => {
    if (e.target.closest("#zoomBar, #splitLine, #abBtn")) return;
    const r = stage.getBoundingClientRect();
    if (view.fit || Math.abs(curZ() - 1) > 0.005) zoomTo(1, e.clientX - r.left, e.clientY - r.top); else resetView(), scheduleRender(0);
  });
  $("#abBtn").onclick = () => setSplit(!state.split);
  // The split line only moves horizontally.
  const line = $("#splitLine");
  line.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    e.preventDefault(); line.setPointerCapture(e.pointerId); line.classList.add("dragging");
  });
  line.addEventListener("pointermove", e => {
    if (!line.classList.contains("dragging")) return;
    const r = stage.getBoundingClientRect();
    state.splitFrac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); updateSplit();
  });
  const endLine = () => line.classList.remove("dragging");
  line.addEventListener("pointerup", endLine); line.addEventListener("pointercancel", endLine);
  $("#zoomFit").onclick = () => { resetView(); scheduleRender(0); };
  $("#zoom100").onclick = () => zoomTo(1);
  $("#zoomIn").onclick = () => zoomTo(curZ() * 1.5);
  $("#zoomOut").onclick = () => zoomTo(curZ() / 1.5);

  document.addEventListener("keydown", e => {
    if (anyDialogOpen()) return;
    const t = e.target;
    const typing = t.tagName === "TEXTAREA" || t.tagName === "SELECT" || (t.tagName === "INPUT" && ["text", "number"].includes(t.type));
    if (typing) return;
    const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (mod && k === "c") { e.preventDefault(); e.shiftKey ? openCopyDialog() : copySettings(null); }
    else if (mod && k === "v") { e.preventDefault(); pasteSettings(); }
    else if (mod && k === "a") { e.preventDefault(); state.sel = new Set(state.images.map(i => i.id)); refreshSelectionUI(); }
    else if (mod && k === "e") { e.preventDefault(); openExport(); }
    else if (e.key === "\\" && !e.repeat) setBefore(true);
    else if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); moveFocus(e.key === "ArrowRight" ? 1 : -1); }
    else if (state.view === "develop" && !mod && k === "a") setSplit(!state.split);
    else if (state.view === "develop" && !mod && k === "z") (view.fit ? zoomTo(1) : (resetView(), scheduleRender(0)));
    else if (state.view === "develop" && !mod && (k === "+" || k === "=")) zoomTo(curZ() * 1.5);
    else if (state.view === "develop" && !mod && k === "-") zoomTo(curZ() / 1.5);
    else if (state.view === "develop" && !mod && k === "0") { resetView(); scheduleRender(0); }
    else if (!mod && k === "d") setView("develop");
    else if (!mod && k === "g") setView("library");
  });
  document.addEventListener("keyup", e => { if (e.key === "\\") setBefore(false); });
}

/* ---------- boot ---------- */
(async function boot() {
  try {
    state.meta = await api("GET", "/api/meta");
    if (!state.meta.raw_available) toast("rawpy is not installed — RAW files are unavailable", true);
    const ts = store.get("ts", 190); $("#thumbSize").value = ts; $("#grid").style.setProperty("--ts", ts + "px");
    buildPanel(); wire(); loadPresets();
    const route = parseHash();
    await pending.flush();                 // settings that were still waiting to be saved when the page closed
    if (route) state.focus = route.img;
    await loadLibs(route?.lib); await loadImages();
    routing = true;
    if (route?.view === "develop") setView("develop");
    routing = false;
    syncHash("replace");
    pollQueue();  // pick up an export that is already running
    pollMovie();  // ...and a movie import
  } catch (e) { toast("Failed to start: " + e.message, true); }
})();
