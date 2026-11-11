// Carte Leaflet : fond OSM (rendu CARTO), tracé, flèches de sens, bornes kilométriques, virages.
/* global L */
import { cumulative, bearing, resample } from "./geo.js";

// Tuiles OpenStreetMap officielles (sans clé, usage léger, attribution obligatoire).
const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const ATTRIB = '&copy; <a href="https://www.openstreetmap.org/copyright">contributeurs OpenStreetMap</a>';

export class MapView {
  constructor(el) {
    this.map = L.map(el, { zoomControl: false, attributionControl: true, tap: true }).setView([45.764, 4.8357], 13);
    this.tiles = null;
    this.layers = L.layerGroup().addTo(this.map);
    this.ghosts = L.layerGroup().addTo(this.map);
    this.progress = L.layerGroup().addTo(this.map);
    this.userLayer = L.layerGroup().addTo(this.map);
    this.pinLayer = L.layerGroup().addTo(this.map);
    this.map.attributionControl.setPrefix(false);
    this.setTheme("light");
    this.pickHandler = null;
    this.map.on("click", (e) => {
      if (this.pickHandler) this.pickHandler([e.latlng.lat, e.latlng.lng]);
    });
  }

  setTheme(mode) {
    if (!this.tiles) this.tiles = L.tileLayer(TILE_URL, { maxZoom: 19, attribution: ATTRIB }).addTo(this.map);
    // Mode sombre : la carte claire est assombrie par un filtre CSS.
    this.map.getContainer().classList.toggle("map-dark", mode === "dark");
  }

  invalidate() { setTimeout(() => this.map.invalidateSize(), 60); }

  setView(p, z = 15) { this.map.setView(p, z, { animate: true }); }

  setUser(p, accuracy) {
    this.userLayer.clearLayers();
    if (!p) return;
    if (accuracy) L.circle(p, { radius: accuracy, className: "acc-circle", interactive: false }).addTo(this.userLayer);
    L.marker(p, { icon: L.divIcon({ className: "user-dot", iconSize: [18, 18] }), interactive: false, zIndexOffset: 1000 }).addTo(this.userLayer);
  }

  setPins(start, end) {
    this.pinLayer.clearLayers();
    if (start) L.marker(start, { icon: pin("D", "pin-start"), zIndexOffset: 800 }).addTo(this.pinLayer);
    if (end) L.marker(end, { icon: pin("A", "pin-end"), zIndexOffset: 800 }).addTo(this.pinLayer);
  }

  startPicking(cb) {
    this.pickHandler = cb;
    this.map.getContainer().classList.add("picking");
  }
  stopPicking() {
    this.pickHandler = null;
    this.map.getContainer().classList.remove("picking");
  }

  showGhosts(routes) {
    this.ghosts.clearLayers();
    for (const r of routes) L.polyline(r.coords, { className: "route-ghost", weight: 4, interactive: false }).addTo(this.ghosts);
  }

  clearRoute() {
    this.layers.clearLayers();
    this.ghosts.clearLayers();
    this.progress.clearLayers();
  }

  // Affiche le tracé complet. padBottom : hauteur du panneau qui recouvre la carte.
  showRoute(route, { padBottom = 0, fit = true, instructions = true } = {}) {
    this.layers.clearLayers();
    const c = route.coords;
    L.polyline(c, { className: "route-casing", weight: 9, interactive: false }).addTo(this.layers);
    L.polyline(c, { className: "route-line", weight: 5, interactive: false }).addTo(this.layers);

    // Flèches de sens tous les ~300 m.
    const cum = cumulative(c);
    const total = cum[cum.length - 1];
    const spacing = total > 8000 ? 500 : 300;
    for (let d = spacing / 2; d < total; d += spacing) {
      const i = cum.findIndex((x) => x >= d);
      if (i <= 0) continue;
      const b = bearing(c[i - 1], c[i]);
      L.marker(c[i], {
        icon: L.divIcon({ className: "arrow-icon", html: `<span style="transform:rotate(${b}deg)">➤</span>`.replace("➤", arrowSvg()), iconSize: [16, 16] }),
        interactive: false,
      }).addTo(this.layers);
    }
    // Bornes kilométriques.
    const { pts, at } = resample(c, 1000);
    pts.forEach((p, k) => {
      if (k === 0 || at[k] >= total - 150) return;
      L.marker(p, { icon: L.divIcon({ className: "km-icon", html: `<span>${Math.round(at[k] / 1000)}</span>`, iconSize: [22, 22] }), interactive: false }).addTo(this.layers);
    });
    // Changements de direction.
    if (instructions && route.instructions) {
      route.instructions.forEach((s, k) => {
        if (s.type === "depart" || s.type === "arrive" || k === 0) return;
        if (s.modifier === "straight" || s.type === "new name") return;
        L.circleMarker(s.location, { radius: 4, className: "turn-dot" })
          .bindPopup(`<b>${escapeHtml(s.text)}</b><br><small>km ${(s.at / 1000).toFixed(2)}</small>`)
          .addTo(this.layers);
      });
    }
    const loop = route.shape !== "ab";
    L.marker(c[0], { icon: pin(loop ? "D/A" : "D", "pin-start"), zIndexOffset: 900 }).addTo(this.layers);
    if (!loop) L.marker(c[c.length - 1], { icon: pin("A", "pin-end"), zIndexOffset: 900 }).addTo(this.layers);
    if (fit) this.fit(c, padBottom);
  }

  fit(coords, padBottom = 0) {
    this.map.fitBounds(L.latLngBounds(coords), { paddingTopLeft: [24, 80], paddingBottomRight: [24, padBottom + 24], animate: true });
  }

  setProgress(coords, cum, along) {
    this.progress.clearLayers();
    if (!coords) return;
    const done = [coords[0]];
    for (let i = 1; i < coords.length && cum[i] <= along; i++) done.push(coords[i]);
    if (done.length > 1) L.polyline(done, { className: "route-done", weight: 5, interactive: false }).addTo(this.progress);
  }
}

function pin(label, cls) {
  return L.divIcon({ className: "pin " + cls, html: `<span>${label}</span>`, iconSize: [34, 34], iconAnchor: [17, 17] });
}

function arrowSvg() {
  return '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 2 L13 11 L8 8.6 L3 11 Z" fill="currentColor"/></svg>';
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}
