// Runway — interface et orchestration.
import { MapView, escapeHtml } from "./mapview.js";
import { planRuns, TOLERANCE } from "./engine.js";
import { searchAddress, reverseGeocode } from "./api.js";
import { store } from "./store.js";
import { LiveRun } from "./run.js";
import { fmtKm, fmtDuration, fmtPace, decodePolyline, makeProjector } from "./geo.js";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const state = {
  profile: store.profile(),
  settings: store.settings(),
  view: "home",
  pos: null,
  posAcc: null,
  geoDenied: false,
  start: null, // {point, label}
  end: null,
  form: {},
  results: null,
  selected: null,
  detailFrom: "results",
  run: null,
  confirmCb: null,
};

let map;

/* ===================== Démarrage ===================== */

function init() {
  if (!window.L) {
    document.body.innerHTML = '<p style="padding:24px;font-family:system-ui">La bibliothèque de carte n\'a pas pu se charger. Vérifie ta connexion puis recharge la page.</p>';
    return;
  }
  map = new MapView("map");
  applyTheme();
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", applyTheme);
  resetForm();
  bindNav();
  bindForm();
  bindDetail();
  bindRun();
  bindLibrary();
  bindProfile();
  renderHome();
  go("home");
  autoLocate();
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
}

function effectiveTheme() {
  const t = state.settings.theme;
  if (t === "light" || t === "dark") return t;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
function applyTheme() {
  const t = state.settings.theme;
  if (t === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
  map.setTheme(effectiveTheme());
}

/* ===================== Navigation ===================== */

const SHEET = { home: "mid", create: "full", results: "mid", detail: "mid", library: "full", profile: "full" };

function go(view) {
  if (state.run) return;
  state.view = view;
  for (const v of $$(".view")) v.hidden = v.id !== "view-" + view;
  $("#sheet").dataset.size = SHEET[view];
  $("#sheet-body").scrollTop = 0;
  for (const b of $$(".tabbar button")) b.classList.toggle("active", b.dataset.go === view || (view === "results" && b.dataset.go === "create") || (view === "detail" && b.dataset.go === state.detailTab));
  if (view === "home") { renderHome(); map.clearRoute(); $("#btn-layers-fit").hidden = true; }
  if (view !== "results" && view !== "detail") $("#btn-layers-fit").hidden = true;
  if (view === "library") renderLibrary();
  if (view === "profile") loadProfileForm();
  if (view === "create") { map.clearRoute(); $("#btn-layers-fit").hidden = true; map.setPins(state.start?.point, state.form.mode === "ab" ? state.end?.point : null); }
  map.invalidate();
}

function bindNav() {
  document.addEventListener("click", (e) => {
    const g = e.target.closest("[data-go]");
    if (g) go(g.dataset.go);
  });
  $("#sheet-handle").addEventListener("click", () => {
    const s = $("#sheet");
    s.dataset.size = s.dataset.size === "full" ? "peek" : s.dataset.size === "peek" ? "mid" : "full";
    map.invalidate();
  });
  $("#btn-create").addEventListener("click", () => go("create"));
  $("#btn-locate").addEventListener("click", () => locate(false));
  $("#btn-layers-fit").addEventListener("click", () => {
    if (state.selected) map.fit(state.selected.coords, sheetHeight());
  });
}

function sheetHeight() {
  return $("#sheet").getBoundingClientRect().height;
}

function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), ms);
}

function confirmModal(text, cb, yes = "Supprimer") {
  $("#confirm-text").textContent = text;
  $("#confirm-yes").textContent = yes;
  state.confirmCb = cb;
  $("#confirm-modal").hidden = false;
}
$("#confirm-no").addEventListener("click", () => ($("#confirm-modal").hidden = true));
$("#confirm-yes").addEventListener("click", () => {
  $("#confirm-modal").hidden = true;
  state.confirmCb?.();
});

/* ===================== Géolocalisation ===================== */

async function autoLocate() {
  try {
    const st = await navigator.permissions?.query({ name: "geolocation" });
    if (st?.state === "granted") return locate(true);
    if (st?.state === "denied") { state.geoDenied = true; renderLocStatus(); return; }
  } catch { /* Safari ancien : pas d'API permissions */ }
  renderLocStatus();
}

function locate(silent) {
  if (!("geolocation" in navigator)) {
    state.geoDenied = true;
    renderLocStatus();
    if (!silent) toast("Ce navigateur ne donne pas accès à la position.");
    return Promise.resolve(null);
  }
  $("#btn-locate").classList.add("active");
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        $("#btn-locate").classList.remove("active");
        state.pos = [pos.coords.latitude, pos.coords.longitude];
        state.posAcc = pos.coords.accuracy;
        state.geoDenied = false;
        map.setUser(state.pos, state.posAcc);
        if (!state.selected || state.view === "home" || state.view === "create") map.setView(state.pos, 15);
        if (state.form.startMode === "gps" || !state.start) {
          state.form.startMode = "gps";
          setStart(state.pos, "Ma position");
          syncSeg("startMode");
          reverseGeocode(state.pos).then((label) => { if (label && state.form.startMode === "gps") setStart(state.pos, "Ma position · " + label); });
        }
        renderLocStatus();
        resolve(state.pos);
      },
      (err) => {
        $("#btn-locate").classList.remove("active");
        if (err.code === 1) {
          state.geoDenied = true;
          if (!silent) toast("Position refusée. Tu peux saisir une adresse de départ.");
          if (state.form.startMode === "gps") { state.form.startMode = "search"; syncSeg("startMode"); updateStartUI(); }
        } else if (!silent) toast("Position introuvable pour l'instant. Réessaie dehors ou saisis une adresse.");
        renderLocStatus();
        resolve(null);
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 }
    );
  });
}

function renderLocStatus() {
  const el = $("#loc-status");
  if (state.pos) el.innerHTML = `<span class="dot ok"></span>Position trouvée (± ${Math.round(state.posAcc)} m)`;
  else if (state.geoDenied) el.innerHTML = `<span class="dot off"></span>Position non autorisée. Choisis une adresse de départ dans «&nbsp;Créer&nbsp;», ou réautorise Runway dans Réglages › Safari › Position.`;
  else el.innerHTML = `<span class="dot"></span>Position non activée. <button class="btn-text" id="loc-enable">Activer</button>`;
  $("#loc-enable")?.addEventListener("click", () => locate(false));
}

/* ===================== Accueil ===================== */

function renderHome() {
  const p = state.profile;
  const d = new Date();
  $("#home-date").textContent = d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
  const h = d.getHours();
  $("#home-hello").textContent = (h < 18 && h >= 5 ? "Bonjour" : "Bonsoir") + (p.name ? " " + p.name : "");
  renderLocStatus();
  $("#quick-distances").innerHTML = (p.favDistances || []).map((km) => `<button data-km="${km}">${String(km).replace(".", ",")} km en boucle</button>`).join("");
  $$("#quick-distances button").forEach((b) => b.addEventListener("click", () => {
    resetForm();
    setDistance(parseFloat(b.dataset.km));
    state.form.mode = "loop";
    syncAllSegs();
    go("create");
  }));
  const favs = store.favorites().slice(0, 3);
  $("#home-favs").innerHTML = favs.length ? `<div class="list">${favs.map(favItem).join("")}</div>` : `<p class="empty">Enregistre un parcours pour le retrouver ici.</p>`;
  bindFavItems($("#home-favs"));
  const runs = store.runs().slice(0, 3);
  $("#home-runs").innerHTML = runs.length ? `<div class="list">${runs.map(runItem).join("")}</div>` : `<p class="empty">Tes courses terminées apparaîtront ici.</p>`;
}

/* ===================== Formulaire ===================== */

function defaultMoment() {
  const h = new Date().getHours();
  return h >= 5 && h < 10 ? "morning" : h < 18 && h >= 10 ? "day" : h >= 18 && h < 21 ? "evening" : "night";
}

function resetForm() {
  const p = state.profile;
  state.form = {
    distance: (p.favDistances?.[0] || 5) * 1000,
    startMode: state.pos ? "gps" : p.home ? "home" : "search",
    mode: "loop",
    endMode: "search",
    elevation: p.joints && p.elevation === "any" ? "low" : p.elevation,
    env: new Set(["any"]),
    calm: p.calm,
    surface: p.surface,
    moment: defaultMoment(),
    opts: {
      avoidStairs: p.joints, avoidSteepDown: p.joints, avoidBusyRoads: p.calm !== "any", avoidIsolated: p.calm === "busy" || p.calm === "calm",
      minLights: false, minCrossings: false, preferPaths: false, avoidRough: p.joints, shortenable: false,
    },
  };
  if (state.form.startMode === "gps" && state.pos) setStart(state.pos, "Ma position");
  else if (state.form.startMode === "home" && p.home) setStart(p.home.point, "Domicile · " + p.home.label);
  setDistance(state.form.distance / 1000);
  syncAllSegs();
  for (const [k, v] of Object.entries(state.form.opts)) { const el = $("#opt-" + k); if (el) el.checked = !!v; }
  updateStartUI();
}

function setDistance(km) {
  km = Math.min(30, Math.max(1, Math.round(km * 10) / 10));
  state.form.distance = km * 1000;
  $("#dist-range").value = km;
  $("#dist-num").value = km.toFixed(1);
}

function syncSeg(name) {
  const box = document.querySelector(`[data-name="${name}"]`);
  if (!box) return;
  const val = name === "theme" || name === "engine" ? state.settings[name] : name === "libTab" ? state.libTab || "favs" : state.form[name];
  for (const b of box.querySelectorAll("button")) {
    b.classList.toggle("on", val instanceof Set ? val.has(b.dataset.v) : b.dataset.v === val);
  }
}
function syncAllSegs() {
  ["startMode", "mode", "endMode", "elevation", "env", "calm", "surface", "moment"].forEach(syncSeg);
  $("#end-block").hidden = state.form.mode !== "ab";
}

function setStart(point, label) {
  state.start = point ? { point, label } : null;
  const el = $("#start-label");
  el.textContent = point ? "Départ : " + label : "Aucun point de départ";
  el.classList.toggle("none", !point);
  if (state.view === "create") map.setPins(state.start?.point, state.form.mode === "ab" ? state.end?.point : null);
}
function setEnd(point, label) {
  state.end = point ? { point, label } : null;
  const el = $("#end-label");
  el.textContent = point ? "Arrivée : " + label : "Aucun point d'arrivée";
  el.classList.toggle("none", !point);
  map.setPins(state.start?.point, state.end?.point);
}

function updateStartUI() {
  const m = state.form.startMode;
  $("#start-search").hidden = m !== "search";
  if (m === "map") startPick("start");
}

function bindForm() {
  // Contrôles segmentés et puces.
  document.addEventListener("click", (e) => {
    const b = e.target.closest(".seg button, .chips button");
    if (!b) return;
    const box = b.parentElement;
    const name = box.dataset.name;
    const v = b.dataset.v;
    if (name === "env") {
      const s = state.form.env;
      if (v === "any") { s.clear(); s.add("any"); }
      else { s.delete("any"); s.has(v) ? s.delete(v) : s.add(v); if (!s.size) s.add("any"); }
      syncSeg("env");
      return;
    }
    if (name === "theme" || name === "engine") {
      state.settings[name] = v;
      syncSeg(name);
      if (name === "theme") { applyTheme(); store.saveSettings(state.settings); }
      if (name === "engine") $("#s-ors").hidden = v !== "ors";
      return;
    }
    if (name === "libTab") { state.libTab = v; syncSeg("libTab"); renderLibrary(); return; }
    state.form[name] = v;
    syncSeg(name);
    if (name === "startMode") onStartMode(v);
    if (name === "mode") { $("#end-block").hidden = v !== "ab"; map.setPins(state.start?.point, v === "ab" ? state.end?.point : null); }
    if (name === "endMode" && v === "map") startPick("end");
  });

  $("#dist-range").addEventListener("input", (e) => setDistance(parseFloat(e.target.value)));
  $("#dist-num").addEventListener("change", (e) => setDistance(parseFloat(e.target.value.replace(",", ".")) || 5));
  for (const k of Object.keys(state.form.opts)) $("#opt-" + k).addEventListener("change", (e) => (state.form.opts[k] = e.target.checked));

  bindSearch("#start-q", "#start-results", (r) => setStart(r.point, r.label));
  bindSearch("#end-q", "#end-results", (r) => setEnd(r.point, r.label));

  $("#pick-cancel").addEventListener("click", stopPick);
  $("#nl-apply").addEventListener("click", applyNaturalLanguage);
  $("#nl-input").addEventListener("keydown", (e) => { if (e.key === "Enter") applyNaturalLanguage(); });
  $("#btn-generate").addEventListener("click", generate);
}

async function onStartMode(v) {
  $("#start-search").hidden = v !== "search";
  if (v === "gps") {
    if (state.pos) setStart(state.pos, "Ma position");
    else { setStart(null); const p = await locate(false); if (!p) { $("#start-search").hidden = false; } }
  } else if (v === "home") {
    const h = state.profile.home;
    if (h) setStart(h.point, "Domicile · " + h.label);
    else { setStart(null); toast("Ajoute ton domicile dans Profil."); }
  } else if (v === "map") {
    startPick("start");
  } else if (v === "search") {
    setTimeout(() => $("#start-q").focus(), 50);
  }
}

function startPick(which) {
  $("#pick-text").textContent = which === "start" ? "Touche la carte pour placer le départ" : "Touche la carte pour placer l'arrivée";
  $("#pick-banner").hidden = false;
  $("#sheet").dataset.size = "peek";
  map.invalidate();
  map.startPicking(async (p) => {
    stopPick();
    const label = (await reverseGeocode(p)) || `${p[0].toFixed(5)}, ${p[1].toFixed(5)}`;
    if (which === "start") setStart(p, "Point choisi · " + label);
    else setEnd(p, label);
  });
}
function stopPick() {
  map.stopPicking();
  $("#pick-banner").hidden = true;
  if (state.view === "create") { $("#sheet").dataset.size = "full"; map.invalidate(); }
}

function bindSearch(inputSel, listSel, onPick) {
  const input = $(inputSel), list = $(listSel);
  let timer, seq = 0;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 3) { list.innerHTML = ""; return; }
    timer = setTimeout(async () => {
      const my = ++seq;
      try {
        const res = await searchAddress(q, state.pos || state.start?.point || state.profile.home?.point);
        if (my !== seq) return;
        list.innerHTML = res.length
          ? res.map((r, i) => `<li><button data-i="${i}">${escapeHtml(r.label)}<small>${escapeHtml(r.sub)}</small></button></li>`).join("")
          : `<li class="hint">Aucun résultat.</li>`;
        list.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
          const r = res[+b.dataset.i];
          onPick(r);
          list.innerHTML = "";
          input.value = r.label;
          input.blur();
          map.setView(r.point, 15);
        }));
      } catch (e) {
        if (my === seq) list.innerHTML = `<li class="hint">${escapeHtml(e.message)}</li>`;
      }
    }, 400);
  });
}

// "Je veux courir 4 km sur du plat, dans un endroit tranquille, avec une boucle depuis mon point de départ"
function applyNaturalLanguage() {
  const t = $("#nl-input").value.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (!t.trim()) return;
  const found = [];
  const km = t.match(/(\d+(?:[.,]\d+)?)\s*(km|kilometre|k\b)/);
  if (km) { setDistance(parseFloat(km[1].replace(",", "."))); found.push(`${state.form.distance / 1000} km`); }
  if (/aller[- ]retour/.test(t)) { state.form.mode = "outback"; found.push("aller-retour"); }
  else if (/boucle|retour au depart|tour/.test(t)) { state.form.mode = "loop"; found.push("boucle"); }
  if (/plat|sans (cote|denivele)/.test(t)) { state.form.elevation = "flat"; found.push("plat"); }
  else if (/(peu|faible) (de )?denivele|vallonne leger/.test(t)) { state.form.elevation = "low"; found.push("faible dénivelé"); }
  else if (/denivele|cote|colline/.test(t)) { state.form.elevation = "moderate"; found.push("dénivelé modéré"); }
  if (/tres (calme|tranquille)|isole|desert/.test(t)) { state.form.calm = "veryquiet"; found.push("très tranquille"); }
  else if (/tranquille|calme/.test(t)) { state.form.calm = "calm"; state.form.opts.avoidBusyRoads = true; found.push("calme"); }
  else if (/frequente|rassurant|anime/.test(t)) { state.form.calm = "busy"; found.push("fréquenté"); }
  const env = [];
  if (/parc|verdure|vert\b|nature/.test(t)) env.push("park");
  if (/riviere|fleuve|lac|quai|eau|rhone|saone|berge/.test(t)) env.push("water");
  if (/voie verte/.test(t)) env.push("greenway");
  if (/sentier|chemin|foret|bois/.test(t)) env.push("natural");
  if (/ville|urbain|centre/.test(t)) env.push("city");
  if (env.length) { state.form.env = new Set(env); found.push(env.length + " environnement(s)"); }
  if (/nuit/.test(t)) state.form.moment = "night";
  else if (/soir/.test(t)) state.form.moment = "evening";
  else if (/matin/.test(t)) state.form.moment = "morning";
  if (/escalier/.test(t)) state.form.opts.avoidStairs = true;
  if (/goudron|bitume|route/.test(t)) state.form.surface = "asphalt";
  else if (/terre|sentier/.test(t)) state.form.surface = "natural";
  if (/ma position|ici|point de depart|d'ici|depuis chez|maison|domicile/.test(t)) {
    if (/maison|domicile|chez moi/.test(t) && state.profile.home) { state.form.startMode = "home"; onStartMode("home"); }
    else { state.form.startMode = "gps"; onStartMode("gps"); }
  }
  syncAllSegs();
  for (const [k, v] of Object.entries(state.form.opts)) { const el = $("#opt-" + k); if (el) el.checked = !!v; }
  $("#nl-feedback").textContent = found.length ? "Compris : " + found.join(", ") + ". Vérifie puis génère." : "Je n'ai rien reconnu. Essaie « 5 km en boucle sur du plat ».";
}

function criteria() {
  return {
    distance: state.form.distance,
    mode: state.form.mode,
    start: state.start?.point,
    end: state.end?.point,
    elevation: state.form.elevation,
    env: state.form.env,
    calm: state.form.calm,
    surface: state.form.surface,
    moment: state.form.moment,
    opts: { ...state.form.opts },
    pace: state.profile.pace,
  };
}

/* ===================== Génération ===================== */

async function generate() {
  const err = $("#create-error");
  err.hidden = true;
  if (!state.start) { err.textContent = "Choisis un point de départ."; err.hidden = false; return; }
  if (state.form.mode === "ab" && !state.end) { err.textContent = "Choisis un point d'arrivée."; err.hidden = false; return; }
  const c = criteria();
  state.lastCriteria = c;
  go("results");
  $("#results-list").innerHTML = "";
  $("#results-notes").innerHTML = "";
  $("#progress").hidden = false;
  map.clearRoute();
  map.setPins(c.start, c.mode === "ab" ? c.end : null);
  const btn = $("#btn-generate");
  btn.disabled = true;
  try {
    const res = await planRuns(c, state.settings, (text, f) => {
      $("#progress-text").textContent = text;
      $("#progress-bar").style.width = Math.round(f * 100) + "%";
    });
    state.results = res;
    renderResults();
  } catch (e) {
    console.error(e);
    $("#results-list").innerHTML = `<div class="err-box"><b>Le calcul n'a pas abouti.</b><br>${escapeHtml(e.message || String(e))}<br><br>Aucun tracé de remplacement n'est affiché. <button class="btn-text" id="retry">Réessayer</button></div>`;
    $("#retry").addEventListener("click", generate);
  } finally {
    $("#progress").hidden = true;
    btn.disabled = false;
  }
}

function thumbSvg(coords, size = 64) {
  const proj = makeProjector(coords[0][0]);
  const P = coords.filter((_, i) => i % Math.max(1, Math.floor(coords.length / 150)) === 0).map(proj.fwd);
  P.push(proj.fwd(coords[coords.length - 1]));
  const xs = P.map((p) => p[0]), ys = P.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const s = (size - 12) / Math.max(maxX - minX, maxY - minY, 1);
  const ox = (size - (maxX - minX) * s) / 2, oy = (size - (maxY - minY) * s) / 2;
  const pts = P.map((p) => `${(ox + (p[0] - minX) * s).toFixed(1)},${(size - oy - (p[1] - minY) * s).toFixed(1)}`).join(" ");
  const [sx, sy] = pts.split(" ")[0].split(",");
  return `<svg class="thumb" viewBox="0 0 ${size} ${size}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="var(--route)" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${sx}" cy="${sy}" r="3.6" fill="var(--forest)" stroke="var(--surface)" stroke-width="1.5"/></svg>`;
}

function renderResults() {
  const { picks, notes, candidates } = state.results;
  const c = state.lastCriteria;
  $("#results-list").innerHTML = picks.map((p, i) => {
    const r = p.route;
    const el = r.elevation;
    const tol = r.withinTolerance
      ? `<span class="tag">± 3 % respecté</span>`
      : `<span class="tag warn">Écart ${(r.err * 100).toFixed(1)} % : tolérance ± 3 % non atteinte</span>`;
    return `<article class="card" data-i="${i}">
      <div class="card-top">
        ${thumbSvg(r.coords)}
        <div class="meta"><h3>${p.title}</h3><p>Choisi pour ${p.why}, parmi ${p.of} tracés calculés.</p></div>
        <div class="score" style="--p:${r.score.total}" title="Correspondance à tes critères"><span>${r.score.total}</span></div>
      </div>
      <div class="kv">
        <div><b>${fmtKm(r.distance, 2)} km</b><span>distance réelle</span></div>
        <div><b>${el ? "+" + Math.round(el.gain) + " / −" + Math.round(el.loss) : "–"}</b><span>dénivelé (m)</span></div>
        <div><b>${fmtDuration(r.estTime)}</b><span>à ${fmtPace(c.pace)}/km</span></div>
      </div>
      <div>${tol} <span class="tag">Surface : ${escapeHtml(r.surfaceLabel)}</span></div>
      ${r.attention.length ? `<ul class="attn">${r.attention.slice(0, 4).map((a) => `<li>${escapeHtml(a)}</li>`).join("")}</ul>` : ""}
      <details><summary>Détail du score (${r.score.total}/100)</summary>
        <ul class="score-items">${r.score.items.map((it) => `<li><span>${it.label} <small style="display:inline">×${it.weight}</small></span><b>${it.value == null ? "non évalué" : Math.round(it.value * 100)}</b><span class="bar"><span style="width:${it.value == null ? 0 : it.value * 100}%"></span></span><small>${escapeHtml(it.detail)}</small></li>`).join("")}</ul>
        <p class="hint" style="margin-top:8px">Score = moyenne pondérée des critères évalués. Les critères «&nbsp;non évalués&nbsp;» sont exclus du calcul.</p>
      </details>
      <div class="row-actions"><button class="btn btn-soft" data-show="${i}">Voir sur la carte</button><button class="btn btn-primary" data-open="${i}">Choisir</button></div>
    </article>`;
  }).join("");
  const engine = state.settings.engine === "ors" && state.settings.orsProxy ? "openrouteservice" : "OSRM piéton (FOSSGIS)";
  $("#results-notes").innerHTML =
    notes.map((n) => `<p class="note">${escapeHtml(n)}</p>`).join("") +
    (picks.length < 3 ? `<p class="note">${picks.length} proposition(s) seulement : les autres tracés calculés étaient trop proches ou n'ont pas pu être analysés.</p>` : "") +
    `<p class="note">Calculé avec ${engine} sur les données OpenStreetMap. ${candidates} tracés comparés. Éclairage, surface et escaliers dépendent de ce qui est renseigné dans OSM.</p>`;
  $$("#results-list [data-show]").forEach((b) => b.addEventListener("click", () => selectPick(+b.dataset.show)));
  $$("#results-list [data-open]").forEach((b) => b.addEventListener("click", () => { selectPick(+b.dataset.open); state.detailFrom = "results"; openDetail(state.selected); }));
  if (picks.length) selectPick(0);
}

function selectPick(i) {
  const picks = state.results.picks;
  state.selected = { ...picks[i].route, name: picks[i].title };
  $$("#results-list .card").forEach((c) => c.classList.toggle("sel", +c.dataset.i === i));
  map.showGhosts(picks.filter((_, k) => k !== i).map((p) => p.route));
  map.showRoute(picks[i].route, { padBottom: sheetHeight() });
  $("#btn-layers-fit").hidden = false;
}

/* ===================== Détail ===================== */

function profileSvg(profile) {
  if (!profile || profile.length < 2) return `<p class="note">Profil altimétrique indisponible.</p>`;
  const W = 320, H = 110, pl = 30, pb = 18, pt = 8;
  const dMax = profile[profile.length - 1].d;
  let zMin = Math.min(...profile.map((p) => p.z)), zMax = Math.max(...profile.map((p) => p.z));
  if (zMax - zMin < 20) { const m = (zMax + zMin) / 2; zMin = m - 10; zMax = m + 10; }
  const x = (d) => pl + (d / dMax) * (W - pl - 6);
  const y = (z) => pt + (1 - (z - zMin) / (zMax - zMin)) * (H - pt - pb);
  const line = profile.map((p) => `${x(p.d).toFixed(1)},${y(p.z).toFixed(1)}`).join(" ");
  const area = `${x(0)},${H - pb} ${line} ${x(dMax)},${H - pb}`;
  const ticks = [];
  const stepKm = dMax > 12000 ? 5000 : dMax > 5000 ? 2000 : 1000;
  for (let d = 0; d <= dMax; d += stepKm) ticks.push(`<text x="${x(d)}" y="${H - 4}" text-anchor="middle">${d / 1000}</text>`);
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Profil altimétrique">
    <line class="grid" x1="${pl}" x2="${W - 6}" y1="${y(zMax)}" y2="${y(zMax)}"/><line class="grid" x1="${pl}" x2="${W - 6}" y1="${y(zMin)}" y2="${y(zMin)}"/>
    <text x="${pl - 4}" y="${y(zMax) + 3}" text-anchor="end">${Math.round(zMax)}</text><text x="${pl - 4}" y="${y(zMin) + 3}" text-anchor="end">${Math.round(zMin)}</text>
    <polygon class="area" points="${area}"/><polyline class="line" points="${line}"/>${ticks.join("")}
    <text x="${W - 6}" y="${H - 4}" text-anchor="end">km</text></svg>`;
}

function turnIcon(s) {
  const m = s.modifier || "";
  if (s.type === "depart") return `<svg viewBox="0 0 24 24" width="20" height="20"><circle cx="12" cy="12" r="5" fill="currentColor"/></svg>`;
  if (s.type === "arrive") return `<svg viewBox="0 0 24 24" width="20" height="20"><path d="M6 21V4h10l-2 4 2 4H6" fill="currentColor"/></svg>`;
  let rot = 0;
  const ors = s.orsType;
  if (m === "left" || ors === 0) rot = -90;
  else if (m === "right" || ors === 1) rot = 90;
  else if (m === "slight left" || ors === 4 || ors === 12) rot = -45;
  else if (m === "slight right" || ors === 5 || ors === 13) rot = 45;
  else if (m === "sharp left" || ors === 2) rot = -135;
  else if (m === "sharp right" || ors === 3) rot = 135;
  else if (m === "uturn" || ors === 9) rot = 180;
  return `<svg viewBox="0 0 24 24" width="20" height="20" style="transform:rotate(${rot}deg)"><path d="M12 20V6M6 11l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function openDetail(route) {
  state.selected = route;
  $("#detail-title").textContent = route.name || "Parcours";
  const el = route.elevation;
  const pace = state.profile.pace;
  const est = route.estTime || (route.distance / 1000) * pace + (el?.gain || 0) * 4;
  $("#detail-stats").innerHTML = `
    <div><b>${fmtKm(route.distance, 2)} km</b><span>${route.shape === "loop" ? "boucle" : route.shape === "outback" ? "aller-retour" : "A → B"}</span></div>
    <div><b>${fmtDuration(est)}</b><span>estimé à ${fmtPace(pace)}/km</span></div>
    <div><b>${el ? "+" + Math.round(el.gain) + " m" : "–"}</b><span>dénivelé positif</span></div>
    <div><b>${el ? "−" + Math.round(el.loss) + " m" : "–"}</b><span>dénivelé négatif</span></div>`;
  $("#detail-profile").innerHTML = profileSvg(el?.profile) + (el ? `<p class="hint">Altitudes ${el.source ? "issues de " + el.source : "enregistrées"} : profil indicatif, précis à quelques mètres près.</p>` : "");
  $("#detail-attention").innerHTML = route.attention?.length ? `<h2 class="h2">Points d'attention</h2><ul class="attn">${route.attention.map((a) => `<li>${escapeHtml(a)}</li>`).join("")}</ul>` : "";
  const steps = route.instructions || [];
  $("#detail-steps").innerHTML = steps.length
    ? steps.map((s, i) => `<li><button data-step="${i}"><span class="ico">${turnIcon(s)}</span><span class="txt">${escapeHtml(s.text)}</span><span class="d">${s.type === "arrive" ? "km " + fmtKm(route.distance, 2) : s.distance ? Math.round(s.distance) + " m" : ""}</span></button></li>`).join("")
    : `<li class="note">Pas d'instructions pour ce parcours.</li>`;
  $$("#detail-steps [data-step]").forEach((b) => b.addEventListener("click", () => {
    const s = steps[+b.dataset.step];
    map.setView(s.location, 18);
    $("#sheet").dataset.size = "peek";
    map.invalidate();
  }));
  $("#save-box").hidden = true;
  $("#detail-msg").hidden = true;
  $("#btn-save").textContent = route.id ? "Enregistré" : "Enregistrer";
  $("#btn-save").disabled = !!route.id;
  go("detail");
  map.showRoute(route, { padBottom: sheetHeight() });
  $("#btn-layers-fit").hidden = false;
}

function bindDetail() {
  $("#detail-back").addEventListener("click", () => {
    if (state.detailFrom === "results" && state.results) { go("results"); renderResults(); }
    else go(state.detailFrom || "library");
  });
  $("#btn-save").addEventListener("click", () => {
    $("#save-box").hidden = false;
    const r = state.selected;
    $("#save-name").value = `${r.name || "Parcours"} · ${fmtKm(r.distance)} km`;
    $("#save-name").focus();
  });
  $("#save-confirm").addEventListener("click", () => {
    const name = $("#save-name").value.trim() || "Parcours";
    const fav = store.saveFavorite(state.selected, name);
    $("#save-box").hidden = true;
    const msg = $("#detail-msg");
    msg.hidden = false;
    if (fav) {
      msg.textContent = "Enregistré dans tes favoris.";
      state.selected = { ...state.selected, id: fav.id, name };
      $("#btn-save").textContent = "Enregistré";
      $("#btn-save").disabled = true;
      $("#detail-title").textContent = name;
    } else msg.textContent = "Stockage plein ou indisponible : parcours non enregistré.";
  });
  $("#btn-gpx").addEventListener("click", exportGpx);
  $("#btn-start-run").addEventListener("click", () => ($("#prerun").hidden = false));
  $("#prerun-cancel").addEventListener("click", () => ($("#prerun").hidden = true));
  $("#prerun-go").addEventListener("click", startRun);
}

function gpxString(route) {
  const name = escapeHtml(route.name || "Parcours Runway");
  const prof = route.elevation?.profile;
  let k = 0;
  const pts = route.coords.map((p, i) => {
    let ele = "";
    if (prof && prof.length > 1) {
      // altitude du point de profil le plus proche en distance
      const d = i === 0 ? 0 : (route._cum || (route._cum = cumulativeLocal(route.coords)))[i];
      while (k < prof.length - 1 && prof[k + 1].d <= d) k++;
      ele = `<ele>${prof[k].z.toFixed(1)}</ele>`;
    }
    return `<trkpt lat="${p[0].toFixed(6)}" lon="${p[1].toFixed(6)}">${ele}</trkpt>`;
  }).join("\n      ");
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Runway" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${name}</name><copyright author="OpenStreetMap contributors"><license>https://opendatacommons.org/licenses/odbl/</license></copyright></metadata>
  <trk><name>${name}</name><type>running</type><trkseg>
      ${pts}
  </trkseg></trk>
</gpx>`;
}
function cumulativeLocal(c) {
  const out = [0];
  for (let i = 1; i < c.length; i++) {
    const a = c[i - 1], b = c[i];
    const dLat = (b[0] - a[0]) * Math.PI / 180, dLon = (b[1] - a[1]) * Math.PI / 180;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * Math.PI / 180) * Math.cos(b[0] * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    out.push(out[i - 1] + 2 * 6371008.8 * Math.asin(Math.sqrt(s)));
  }
  return out;
}

async function exportGpx() {
  const r = state.selected;
  const xml = gpxString(r);
  const fname = (r.name || "parcours").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").toLowerCase() + ".gpx";
  const file = new File([xml], fname, { type: "application/gpx+xml" });
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: r.name || "Parcours Runway" });
      return;
    }
  } catch (e) {
    if (e.name === "AbortError") return;
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = fname;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast("Fichier GPX généré.");
}

/* ===================== Course en direct ===================== */

function bindRun() {
  $("#run-pause").addEventListener("click", () => {
    const r = state.run;
    if (!r) return;
    if (r.state === "running") r.pause(); else r.resume();
  });
  $("#run-stop").addEventListener("click", () => { $("#run-actions").hidden = true; $("#run-confirm").hidden = false; });
  $("#run-confirm-no").addEventListener("click", () => { $("#run-actions").hidden = false; $("#run-confirm").hidden = true; });
  $("#run-confirm-yes").addEventListener("click", stopRun);
}

async function startRun() {
  $("#prerun").hidden = true;
  const route = state.selected;
  document.body.classList.add("running");
  $("#run").hidden = false;
  $("#run-alert").hidden = true;
  $("#run-actions").hidden = false;
  $("#run-confirm").hidden = true;
  map.fit(route.coords, 330);
  const run = new LiveRun(route, {
    voice: state.settings.voice,
    onUpdate: renderRun,
    onAlert: (msg) => {
      const a = $("#run-alert");
      a.textContent = msg;
      a.hidden = false;
      clearTimeout(startRun.t);
      startRun.t = setTimeout(() => { if (!state.run?.offRoute) a.hidden = true; }, 6000);
    },
  });
  state.run = run;
  try {
    await run.start();
    if (!("wakeLock" in navigator)) run.onAlert("Ce navigateur ne peut pas garder l'écran allumé : règle le verrouillage auto sur « Jamais » pendant la course.");
  } catch (e) {
    run.onAlert(e.message);
  }
}

let followMap = true;
function renderRun(s) {
  $("#run-chrono").textContent = fmtDuration(s.elapsed);
  $("#run-dist").textContent = fmtKm(s.runDist, 2);
  $("#run-rem").textContent = fmtKm(s.remaining, 2);
  $("#run-pace").textContent = fmtPace(s.pace);
  $("#run-speed").textContent = isFinite(s.speedKmh) ? s.speedKmh.toFixed(1).replace(".", ",") : "–";
  $("#run-bar").style.width = Math.round(s.progress * 100) + "%";
  $("#run-pause").textContent = s.state === "paused" ? "Reprendre" : "Pause";
  $("#run-gps").textContent = s.accuracy == null ? "GPS : recherche du signal…" : `GPS : précision ± ${Math.round(s.accuracy)} m${s.accuracy > 30 ? " (faible)" : ""}`;
  if (s.next) {
    $("#run-next-dist").textContent = Math.max(0, Math.round((s.next.at - s.along) / 10) * 10) + " m";
    $("#run-next-text").textContent = s.next.text;
    $("#run-turn").innerHTML = turnIcon(s.next);
  } else {
    $("#run-next-dist").textContent = fmtKm(s.remaining, 2) + " km";
    $("#run-next-text").textContent = state.selected.shape === "ab" ? "Jusqu'à l'arrivée" : "Jusqu'au point de départ";
    $("#run-turn").innerHTML = turnIcon({ type: "arrive" });
  }
  if (s.offRoute) { $("#run-alert").textContent = `Hors parcours (≈ ${Math.round(s.offDist)} m). Rejoins le tracé vert.`; $("#run-alert").hidden = false; }
  if (s.position) {
    map.setUser(s.position, s.accuracy);
    if (followMap && s.state === "running") map.map.panTo(s.position, { animate: true });
  }
  if (state.run) map.setProgress(state.run.coords, state.run.cum, s.along);
}

function stopRun() {
  const run = state.run;
  if (!run) return;
  const summary = run.finish();
  summary.name = state.selected.name || "Course";
  state.run = null;
  document.body.classList.remove("running");
  $("#run").hidden = true;
  map.setProgress(null);
  if (summary.distance > 50) {
    store.saveRun(summary);
    toast(`Course enregistrée : ${fmtKm(summary.distance, 2)} km en ${fmtDuration(summary.duration)}.`, 4000);
  } else toast("Course trop courte pour être enregistrée.");
  state.libTab = "runs";
  go("library");
}

/* ===================== Bibliothèque ===================== */

function favItem(f) {
  return `<div class="item" data-fav="${f.id}">
    ${thumbSvg(f.coords, 52)}
    <div class="meta"><div class="t">${escapeHtml(f.name)}</div><div class="s">${fmtKm(f.distance)} km${f.gain != null ? " · +" + Math.round(f.gain) + " m" : ""} · ${new Date(f.created).toLocaleDateString("fr-FR")}</div></div>
    <div class="acts"><button class="btn-text" data-act="open">Ouvrir</button></div>
  </div>`;
}
function runItem(r) {
  return `<div class="item" data-run="${r.id}">
    ${r.track ? thumbSvg(decodePolyline(r.track), 52) : '<div class="thumb"></div>'}
    <div class="meta"><div class="t">${escapeHtml(r.name)}</div><div class="s">${new Date(r.date).toLocaleDateString("fr-FR", { day: "numeric", month: "short" })} · ${fmtKm(r.distance, 2)} km · ${fmtDuration(r.duration)} · ${fmtPace(r.pace)}/km</div></div>
  </div>`;
}

function bindFavItems(root) {
  root.querySelectorAll("[data-fav] [data-act='open']").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    const id = b.closest("[data-fav]").dataset.fav;
    const f = store.favorites().find((x) => x.id === id);
    if (f) { state.detailFrom = state.view; openDetail(f); }
  }));
}

function renderLibrary() {
  const tab = state.libTab || "favs";
  syncSeg("libTab");
  $("#lib-favs").hidden = tab !== "favs";
  $("#lib-runs").hidden = tab !== "runs";
  const favs = store.favorites();
  $("#lib-favs").innerHTML = favs.length
    ? `<div class="list">${favs.map((f) => favItem(f).replace('<div class="acts">', `<div class="acts"><button class="btn-text" data-act="rename">Renommer</button><button class="btn-text" data-act="del" style="color:var(--danger)">Suppr.</button>`)).join("")}</div>`
    : `<p class="empty">Aucun favori. Après avoir généré un parcours, touche «&nbsp;Enregistrer&nbsp;».</p>`;
  bindFavItems($("#lib-favs"));
  $$("#lib-favs [data-act='rename']").forEach((b) => b.addEventListener("click", () => {
    const item = b.closest("[data-fav]");
    const id = item.dataset.fav;
    const f = favs.find((x) => x.id === id);
    item.querySelector(".meta").innerHTML = `<input type="text" value="${escapeHtml(f.name)}" maxlength="60" aria-label="Nouveau nom">`;
    const input = item.querySelector("input");
    input.focus();
    input.select();
    b.textContent = "OK";
    b.onclick = () => { store.renameFavorite(id, input.value.trim() || f.name); renderLibrary(); };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") b.onclick(); });
  }));
  $$("#lib-favs [data-act='del']").forEach((b) => b.addEventListener("click", () => {
    const id = b.closest("[data-fav]").dataset.fav;
    const f = favs.find((x) => x.id === id);
    confirmModal(`Supprimer « ${f.name} » ?`, () => { store.deleteFavorite(id); renderLibrary(); });
  }));

  const runs = store.runs();
  const total = runs.reduce((s, r) => s + r.distance, 0);
  const month = runs.filter((r) => new Date(r.date).getMonth() === new Date().getMonth() && new Date(r.date).getFullYear() === new Date().getFullYear());
  $("#lib-runs").innerHTML = runs.length
    ? `<div class="totals"><div><b>${fmtKm(month.reduce((s, r) => s + r.distance, 0))} km</b><span>ce mois-ci</span></div><div><b>${fmtKm(total)} km</b><span>au total · ${runs.length} course(s)</span></div></div>
       <div class="list" style="margin-top:10px">${runs.map((r) => runItem(r).replace("</div>\n  </div>", `</div><div class="acts"><button class="btn-text" data-del-run="${r.id}" style="color:var(--danger)">Suppr.</button></div>\n  </div>`)).join("")}</div>
       ${runs.some((r) => r.gaps) ? '<p class="hint">Certaines courses ont eu des interruptions de suivi (écran verrouillé) : leur distance peut être sous-estimée.</p>' : ""}`
    : `<p class="empty">Aucune course enregistrée pour l'instant.</p>`;
  $$("#lib-runs [data-del-run]").forEach((b) => b.addEventListener("click", () => {
    confirmModal("Supprimer cette course de l'historique ?", () => { store.deleteRun(b.dataset.delRun); renderLibrary(); });
  }));
}

function bindLibrary() { /* rendu à la demande dans renderLibrary */ }

/* ===================== Profil ===================== */

function loadProfileForm() {
  const p = state.profile;
  $("#p-name").value = p.name;
  $("#p-level").value = p.level;
  $("#p-pace-min").value = Math.floor(p.pace / 60);
  $("#p-pace-sec").value = String(p.pace % 60).padStart(2, "0");
  $("#p-dists").value = (p.favDistances || []).map((d) => String(d).replace(".", ",")).join(" ; ");
  $("#p-home-label").textContent = p.home ? p.home.label : "Non renseigné";
  $("#p-home-label").classList.toggle("none", !p.home);
  $("#p-surface").value = p.surface;
  $("#p-elev").value = p.elevation;
  $("#p-calm").value = p.calm;
  $("#p-joints").checked = p.joints;
  $("#s-voice").checked = state.settings.voice;
  $("#s-ors").value = state.settings.orsProxy;
  $("#s-ors").hidden = state.settings.engine !== "ors";
  syncSeg("theme");
  syncSeg("engine");
  $("#profile-msg").hidden = true;
}

function bindProfile() {
  let pendingHome = null;
  bindSearch("#p-home-q", "#p-home-results", (r) => {
    pendingHome = { point: r.point, label: r.label };
    $("#p-home-label").textContent = r.label + " (à enregistrer)";
    $("#p-home-label").classList.remove("none");
  });
  $("#btn-save-profile").addEventListener("click", () => {
    const p = state.profile;
    p.name = $("#p-name").value.trim();
    p.level = $("#p-level").value;
    const pace = (parseInt($("#p-pace-min").value, 10) || 6) * 60 + (parseInt($("#p-pace-sec").value, 10) || 0);
    p.pace = Math.min(15 * 60, Math.max(150, pace));
    const dists = $("#p-dists").value.split(/[;\s]+/).map((x) => parseFloat(x.replace(",", "."))).filter((x) => x >= 1 && x <= 30);
    p.favDistances = dists.length ? dists.slice(0, 5) : [5];
    if (pendingHome) { p.home = pendingHome; pendingHome = null; }
    p.surface = $("#p-surface").value;
    p.elevation = $("#p-elev").value;
    p.calm = $("#p-calm").value;
    p.joints = $("#p-joints").checked;
    state.settings.voice = $("#s-voice").checked;
    state.settings.orsProxy = $("#s-ors").value.trim();
    if (state.settings.engine === "ors" && !/^https:\/\//.test(state.settings.orsProxy)) {
      state.settings.engine = "osrm";
      syncSeg("engine");
      $("#s-ors").hidden = true;
      toast("Proxy openrouteservice manquant : retour au moteur OSRM.");
    }
    const ok = store.saveProfile(p) && store.saveSettings(state.settings);
    resetForm();
    const msg = $("#profile-msg");
    msg.hidden = false;
    msg.textContent = ok ? "Profil enregistré sur ce téléphone." : "Impossible d'enregistrer (stockage bloqué, navigation privée ?).";
    loadProfileForm();
    msg.hidden = false;
  });
}

init();
