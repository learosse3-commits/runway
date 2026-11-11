// Moteur Runway : génération d'itinéraires, analyse (dénivelé + attributs OSM) et score transparent.
import { routeOSRM, routeORS, elevations, overpassAround, ApiError } from "./api.js?v=3";
import {
  haversine, destination, bearing, resample, cumulative, makeProjector, SegmentGrid,
  pointInRing, overlapShare, selfRepeatShare, nearestOnLine,
} from "./geo.js?v=3";

export const TOLERANCE = 0.03;

/* =========================================================================
   1. GÉNÉRATION DE CANDIDATS
   ========================================================================= */

// Lance des tâches asynchrones avec au plus `n` en parallèle (respect des services gratuits).
async function pool(tasks, n) {
  const results = new Array(tasks.length);
  let i = 0;
  const worker = async () => {
    while (i < tasks.length) {
      const k = i++;
      try { results[k] = await tasks[k](); } catch (e) { results[k] = { error: e }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, worker));
  return results;
}

// Ajuste un paramètre d'échelle jusqu'à atteindre la distance cible (optimisation itérative).
async function converge(target, initialScale, build, route, maxIter = 6) {
  let scale = initialScale;
  let best = null;
  const tried = [];
  for (let it = 0; it < maxIter; it++) {
    const r = await route(build(scale));
    const err = (r.distance - target) / target;
    tried.push({ scale, distance: r.distance });
    if (!best || Math.abs(err) < Math.abs(best.err)) best = { ...r, err, iterations: it + 1 };
    if (Math.abs(err) <= TOLERANCE * 0.8) break;
    // Distance quasi proportionnelle à l'échelle : correction amortie, bornée.
    let factor = Math.pow(target / r.distance, 0.9);
    factor = Math.min(1.8, Math.max(0.55, factor));
    // Si deux essais encadrent la cible, interpolation linéaire entre eux.
    const lo = tried.filter((t) => t.distance < target).sort((a, b) => b.distance - a.distance)[0];
    const hi = tried.filter((t) => t.distance > target).sort((a, b) => a.distance - b.distance)[0];
    if (lo && hi && hi.scale !== lo.scale) {
      scale = lo.scale + ((target - lo.distance) * (hi.scale - lo.scale)) / (hi.distance - lo.distance);
    } else {
      scale *= factor;
    }
  }
  best.withinTolerance = Math.abs(best.err) <= TOLERANCE;
  return best;
}

function loopWaypoints(start, theta, r, n) {
  const center = destination(start, theta, r);
  const pts = [start];
  for (let k = 1; k <= n; k++) pts.push(destination(center, theta + 180 + (k * 360) / (n + 1), r));
  pts.push(start);
  return pts;
}

// Génère des candidats pour les critères donnés. onProgress(texte, fraction).
export async function generateCandidates(c, engineCfg, onProgress = () => {}) {
  const D = c.distance;
  const useORS = engineCfg.engine === "ors" && engineCfg.orsProxy;
  const osrm = (allowUturn) => (wps) => routeOSRM(wps, { allowUturn });
  const orsBody = (variant) => {
    const options = {};
    if (c.opts.avoidStairs) options.avoid_features = ["steps"];
    const weightings = {};
    if (variant === "green") weightings.green = { factor: 1 };
    if (variant === "quiet") weightings.quiet = { factor: 1 };
    if (Object.keys(weightings).length) options.profile_params = { weightings };
    return options;
  };
  const ors = (variant) => (wps) =>
    routeORS(engineCfg.orsProxy, { coordinates: wps.map((p) => [p[1], p[0]]), options: orsBody(variant) });

  const tasks = [];
  const base = Math.random() * 360;
  let done = 0;
  const tick = (label) => onProgress(label, ++done / tasks.length);

  if (c.mode === "loop") {
    const K = 6;
    for (let i = 0; i < K; i++) {
      const theta = base + (i * 360) / K;
      const n = i % 2 ? 3 : 4;
      const variant = ["", "green", "quiet"][i % 3];
      if (useORS) {
        tasks.push(async () => {
          const r = await converge(D, D, (L) => L, (L) => routeORS(engineCfg.orsProxy, {
            coordinates: [[c.start[1], c.start[0]]],
            options: { ...orsBody(variant), round_trip: { length: Math.round(L), points: n, seed: i * 7 + 1 } },
          }));
          tick("Boucle " + (i + 1));
          return { ...r, shape: "loop" };
        });
      } else {
        tasks.push(async () => {
          const r = await converge(D, D / (2 * Math.PI * 1.3), (rad) => loopWaypoints(c.start, theta, rad, n), osrm(false));
          tick("Boucle " + (i + 1));
          return { ...r, shape: "loop" };
        });
      }
    }
  } else if (c.mode === "outback") {
    const K = 6;
    for (let i = 0; i < K; i++) {
      const theta = base + (i * 360) / K;
      const router = useORS ? ors(["", "green", "quiet"][i % 3]) : osrm(true);
      tasks.push(async () => {
        const r = await converge(D, D / 2 / 1.25, (rad) => [c.start, destination(c.start, theta, rad), c.start], router);
        tick("Aller-retour " + (i + 1));
        return { ...r, shape: "outback" };
      });
    }
  } else {
    if (!c.end) throw new ApiError("critères", "Choisis un point d'arrivée pour un parcours A → B.");
    const router = useORS ? ors("") : osrm(false);
    const direct = await router([c.start, c.end]);
    direct.err = (direct.distance - D) / D;
    direct.withinTolerance = Math.abs(direct.err) <= TOLERANCE;
    direct.iterations = 1;
    if (direct.distance >= D * (1 - TOLERANCE)) {
      onProgress("Trajet direct", 1);
      return [{ ...direct, shape: "ab" }];
    }
    const AB = haversine(c.start, c.end);
    const brg = bearing(c.start, c.end);
    const variants = [[0.5, 90], [0.5, -90], [0.3, 90], [0.7, -90]];
    for (const [pos, side] of variants) {
      tasks.push(async () => {
        const mid = destination(c.start, brg, AB * pos);
        const r = await converge(D, Math.max(150, (D - direct.distance) / 2.4),
          (h) => [c.start, destination(mid, brg + side, h), c.end], router);
        tick("Variante");
        return { ...r, shape: "ab" };
      });
    }
  }

  const res = await pool(tasks, 3);
  const ok = res.filter((r) => r && !r.error);
  if (!ok.length) {
    const err = res.find((r) => r?.error)?.error;
    throw err || new ApiError("routage", "Aucun itinéraire n'a pu être calculé.");
  }
  // Élimine les quasi-doublons.
  const unique = [];
  for (const r of ok) {
    if (unique.some((u) => Math.abs(u.distance - r.distance) < 60 && overlapShare(r.coords, u.coords) > 0.9)) continue;
    unique.push(r);
  }
  return unique;
}

/* =========================================================================
   2. ANALYSE : DÉNIVELÉ
   ========================================================================= */

export async function analyzeElevation(route) {
  const total = route.distance;
  let profile;
  if (route.elevations && route.elevations.every((e) => e != null)) {
    const cum = cumulative(route.coords);
    profile = route.coords.map((p, i) => ({ d: cum[i], z: route.elevations[i] }));
  } else {
    const step = Math.max(40, total / 280);
    const { pts, at } = resample(route.coords, step);
    const z = await elevations(pts);
    profile = pts.map((p, i) => ({ d: at[i], z: z[i] }));
  }
  // Lissage léger (bruit du modèle numérique de terrain).
  const zs = profile.map((p, i) => {
    const a = profile[Math.max(0, i - 1)].z, b = p.z, c = profile[Math.min(profile.length - 1, i + 1)].z;
    return (a + 2 * b + c) / 4;
  });
  let gain = 0, loss = 0, ref = zs[0];
  for (const z of zs) {
    // Hystérésis de 2 m : on ne compte que les variations franches.
    if (z - ref >= 2) { gain += z - ref; ref = z; }
    else if (ref - z >= 2) { loss += ref - z; ref = z; }
  }
  // Pente maximale sur des fenêtres de 100 m.
  let maxUp = 0, maxDown = 0;
  for (let i = 0; i < profile.length; i++) {
    let j = i;
    while (j < profile.length - 1 && profile[j].d - profile[i].d < 100) j++;
    const dd = profile[j].d - profile[i].d;
    if (dd < 60) continue;
    const g = ((zs[j] - zs[i]) / dd) * 100;
    if (g > maxUp) maxUp = g;
    if (-g > maxDown) maxDown = -g;
  }
  return {
    profile: profile.map((p, i) => ({ d: p.d, z: zs[i] })),
    gain, loss, maxUp, maxDown,
    min: Math.min(...zs), max: Math.max(...zs),
    source: route.elevations ? "openrouteservice" : "Open-Meteo (MNT 90 m)",
  };
}

/* =========================================================================
   3. ANALYSE : ATTRIBUTS OPENSTREETMAP
   ========================================================================= */

const PEDESTRIAN = new Set(["footway", "pedestrian", "path", "cycleway", "track", "bridleway", "living_street", "corridor", "steps"]);
const BUSY = new Set(["primary", "primary_link", "secondary", "secondary_link", "tertiary", "tertiary_link", "trunk", "trunk_link"]);
const QUIET_ROAD = new Set(["residential", "service", "unclassified", "living_street", "road"]);
const PAVED = new Set(["asphalt", "paved", "concrete", "concrete:plates", "concrete:lanes", "paving_stones", "metal", "wood"]);
const IRREGULAR = new Set(["cobblestone", "sett", "unhewn_cobblestone", "rock", "stone", "pebblestone", "mud", "sand", "grass_paver", "rocks"]);
const STABILIZED = new Set(["compacted", "fine_gravel", "gravel"]);
const NATURAL = new Set(["dirt", "earth", "ground", "grass", "unpaved", "woodchips", "mud", "sand"]);

export function classifySurface(tags) {
  const s = tags.surface;
  const bad = ["bad", "very_bad", "horrible", "very_horrible", "impassable"].includes(tags.smoothness);
  if (s) {
    if (IRREGULAR.has(s) || bad) return { kind: PAVED.has(s) || s === "sett" || s === "cobblestone" ? "paved" : "natural", irregular: true, known: true };
    if (PAVED.has(s)) return { kind: "paved", irregular: false, known: true };
    if (STABILIZED.has(s)) return { kind: "stabilized", irregular: s === "gravel", known: true };
    if (NATURAL.has(s)) return { kind: "natural", irregular: false, known: true };
    return { kind: "paved", irregular: bad, known: true };
  }
  const h = tags.highway;
  // Sans balise "surface" : déduction prudente, signalée comme telle.
  if (BUSY.has(h) || QUIET_ROAD.has(h) || h === "pedestrian") return { kind: "paved", irregular: bad, known: false };
  if (h === "footway" || h === "cycleway") return { kind: "paved", irregular: bad, known: false };
  if (h === "track") return { kind: tags.tracktype === "grade1" ? "paved" : "stabilized", irregular: ["grade4", "grade5"].includes(tags.tracktype), known: false };
  if (h === "path") return { kind: "natural", irregular: bad, known: false };
  return { kind: "paved", irregular: bad, known: false };
}

function wayLabel(tags) {
  if (tags.name) return tags.name;
  switch (tags.highway) {
    case "footway": return tags.footway === "sidewalk" ? "le trottoir" : tags.footway === "crossing" ? "le passage piéton" : "le chemin piéton";
    case "pedestrian": return "la zone piétonne";
    case "path": return "le sentier";
    case "cycleway": return "la piste cyclable";
    case "track": return "le chemin";
    case "steps": return "les escaliers";
    case "service": return "la voie de desserte";
    case "living_street": return "la zone de rencontre";
    default: return "";
  }
}

// Construit les index spatiaux à partir de la réponse Overpass.
export function buildOsmIndex(osm, lat0) {
  const proj = makeProjector(lat0);
  const ways = [], green = [], water = [], rings = [], nodes = [];
  const geomOf = (el) => (el.geometry || []).map((g) => [g.lat, g.lon]);
  for (const el of osm.elements || []) {
    const t = el.tags || {};
    if (el.type === "node") { nodes.push({ id: el.id, p: [el.lat, el.lon], signals: t.highway === "traffic_signals" }); continue; }
    const isWater = t.waterway || t.natural === "water";
    const isGreen = t.leisure || t.landuse || (t.natural && t.natural !== "water");
    const parts = el.type === "relation"
      ? (el.members || []).filter((m) => m.geometry && m.role !== "inner").map((m) => m.geometry.map((g) => [g.lat, g.lon]))
      : [geomOf(el)];
    for (const coords of parts) {
      if (coords.length < 2) continue;
      if (t.highway && el.type === "way" && !isGreen) ways.push({ coords, data: t });
      else if (isWater) water.push({ coords, data: t });
      else if (isGreen) {
        green.push({ coords, data: t });
        const closed = haversine(coords[0], coords[coords.length - 1]) < 1;
        if (closed) {
          let s = 90, w = 180, n = -90, e = -180;
          for (const [a, b] of coords) { s = Math.min(s, a); n = Math.max(n, a); w = Math.min(w, b); e = Math.max(e, b); }
          rings.push({ ring: coords, bbox: [s, w, n, e], tags: t });
        }
      }
    }
  }
  return {
    proj,
    ways: new SegmentGrid(ways.length ? ways : [{ coords: [[0, 0], [0, 0]], data: null }], proj, 40),
    green: new SegmentGrid(green.length ? green : [{ coords: [[0, 0], [0, 0]], data: null }], proj, 60),
    water: new SegmentGrid(water.length ? water : [{ coords: [[0, 0], [0, 0]], data: null }], proj, 80),
    rings, nodes,
    counts: { ways: ways.length, green: green.length, water: water.length },
  };
}

function inGreenArea(p, idx) {
  for (const r of idx.rings) {
    const [s, w, n, e] = r.bbox;
    if (p[0] < s || p[0] > n || p[1] < w || p[1] > e) continue;
    if (pointInRing(p, r.ring)) return r;
  }
  return null;
}

export function analyzeOsm(route, idx) {
  const step = 25;
  const { pts } = resample(route.coords, step);
  const acc = {
    samples: 0, matched: 0, pedestrian: 0, busy: 0, quietRoad: 0, residential: 0, greenway: 0,
    lit: 0, unlit: 0, litUnknown: 0, paved: 0, stabilized: 0, natural: 0, irregular: 0, surfaceKnown: 0,
    green: 0, water: 0, isolated: 0, busySidewalkMissing: 0,
  };
  const busyNames = new Map();
  const parks = new Map();
  let stairs = 0, onStairs = false;
  for (const p of pts) {
    acc.samples++;
    const m = idx.ways.nearest(p, 20);
    const t = m.d <= 20 ? m.data : null;
    const greenRing = inGreenArea(p, idx);
    const nearGreen = greenRing || idx.green.nearest(p, 30).d <= 30;
    if (nearGreen) acc.green++;
    if (idx.water.nearest(p, 80).d <= 80) acc.water++;
    if (greenRing && (greenRing.tags.leisure === "park" || greenRing.tags.leisure === "garden")) {
      const key = greenRing.tags.name || "Parc sans nom";
      if (!parks.has(key)) parks.set(key, greenRing.tags.opening_hours || null);
    }
    if (!t) { onStairs = false; continue; }
    acc.matched++;
    const h = t.highway;
    if (h === "steps") { if (!onStairs) stairs++; onStairs = true; } else onStairs = false;
    if (PEDESTRIAN.has(h) || (h === "footway")) acc.pedestrian++;
    if (BUSY.has(h)) {
      acc.busy++;
      const n = t.name || t.ref || "voie importante";
      busyNames.set(n, (busyNames.get(n) || 0) + step);
      if (t.sidewalk === "no" || t.sidewalk === "none") acc.busySidewalkMissing++;
    }
    if (QUIET_ROAD.has(h)) acc.quietRoad++;
    if (h === "residential" || h === "living_street") acc.residential++;
    if (h === "cycleway" || (h === "path" && t.bicycle === "designated" && (t.foot === "designated" || t.foot === "yes"))) acc.greenway++;
    if (t.lit === "yes" || t.lit === "24/7" || t.lit === "automatic") acc.lit++;
    else if (t.lit === "no") acc.unlit++;
    else acc.litUnknown++;
    const s = classifySurface(t);
    acc[s.kind]++;
    if (s.irregular) acc.irregular++;
    if (s.known) acc.surfaceKnown++;
    // Indicateur d'isolement : sentier / chemin non éclairé, en espace vert, loin d'une rue.
    if ((h === "path" || h === "track" || h === "bridleway") && t.lit !== "yes" && nearGreen) acc.isolated++;
  }
  const N = Math.max(1, acc.samples), M = Math.max(1, acc.matched);
  // Traversées et feux à moins de 10 m du tracé.
  const cum = cumulative(route.coords);
  const proj = idx.proj;
  let crossings = 0, signals = 0;
  for (const n of idx.nodes) {
    const r = nearestOnLine(n.p, route.coords, cum, proj);
    if (r.d <= 10) { if (n.signals) signals++; else crossings++; }
  }
  return {
    matchedShare: acc.matched / N,
    pedestrian: acc.pedestrian / M, busy: acc.busy / M, quietRoad: acc.quietRoad / M,
    residential: acc.residential / M, greenway: acc.greenway / M,
    lit: acc.lit / M, unlit: acc.unlit / M, litUnknown: acc.litUnknown / M,
    paved: acc.paved / M, stabilized: acc.stabilized / M, natural: acc.natural / M,
    irregular: acc.irregular / M, surfaceKnown: acc.surfaceKnown / M,
    green: acc.green / N, water: acc.water / N, isolated: acc.isolated / M,
    busySidewalkMissing: acc.busySidewalkMissing / M,
    stairs, crossings, signals,
    busyNames: [...busyNames.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, m]) => ({ name: n, meters: m })),
    parks: [...parks.entries()].map(([name, hours]) => ({ name, hours })),
  };
}

// Simplifie les tracés de tous les candidats en une seule polyligne pour UNE requête Overpass.
export function overpassLine(routes) {
  const total = routes.reduce((s, r) => s + r.distance, 0);
  const step = Math.max(80, total / 450);
  const line = [];
  for (const r of routes) line.push(...resample(r.coords, step).pts);
  return line;
}

/* =========================================================================
   4. INSTRUCTIONS DE NAVIGATION (calculées à partir des manœuvres du moteur)
   ========================================================================= */

const DIR = {
  left: "tourne à gauche", right: "tourne à droite",
  "slight left": "prends légèrement à gauche", "slight right": "prends légèrement à droite",
  "sharp left": "tourne franchement à gauche", "sharp right": "tourne franchement à droite",
  straight: "continue tout droit", uturn: "fais demi-tour",
};

export function buildInstructions(route, idx, shape) {
  const cum = cumulative(route.coords);
  const steps = route.steps || [];
  const list = [];
  // Position de chaque manœuvre le long du tracé = somme des distances des étapes précédentes
  // (exact, et sans ambiguïté sur une boucle où départ et arrivée coïncident).
  const sumSteps = steps.reduce((s, x) => s + (x.distance || 0), 0) || 1;
  const k = cum[cum.length - 1] / sumSteps;
  let acc = 0;
  steps.forEach((s, i) => {
    const at = s.type === "arrive" ? cum[cum.length - 1] : acc * k;
    acc += s.distance || 0;
    // Nom de la voie empruntée après la manœuvre : nom OSM, sinon type de voie.
    let label = s.name;
    let crossing = false;
    if (idx) {
      const ahead = pointAlong(route.coords, cum, Math.min(cum[cum.length - 1], at + 15));
      const w = idx.ways.nearest(ahead, 15);
      if (!label && w.d <= 15 && w.data) label = wayLabel(w.data);
      crossing = idx.nodes.some((n) => !n.signals && haversine(n.p, s.location) < 15);
    }
    let text;
    if (s.type === "ors") {
      text = s.text;
    } else if (s.type === "depart") {
      text = label ? `Départ : pars sur ${label}` : "Départ";
    } else if (s.type === "arrive") {
      text = shape === "ab" ? "Arrivée" : "Retour au point de départ";
    } else if (s.type === "roundabout" || s.type === "rotary" || s.type === "roundabout turn") {
      text = `Au rond-point, ${DIR[s.modifier] || "continue"}${label ? " vers " + label : ""}`;
    } else if (s.type === "fork") {
      text = `À la bifurcation, garde la ${s.modifier.includes("left") ? "gauche" : "droite"}${label ? " sur " + label : ""}`;
    } else if (s.type === "end of road") {
      text = `Au bout, ${DIR[s.modifier] || "continue"}${label ? " sur " + label : ""}`;
    } else if (s.type === "new name" || s.type === "continue" && (s.modifier === "straight" || !s.modifier)) {
      text = `Continue${label ? " sur " + label : " tout droit"}`;
    } else {
      const d = DIR[s.modifier] || "continue";
      text = d.charAt(0).toUpperCase() + d.slice(1) + (label ? (s.modifier === "uturn" ? "" : " sur " + label) : "");
    }
    text = text.charAt(0).toUpperCase() + text.slice(1);
    if (crossing && s.type !== "arrive" && s.type !== "depart") text += " (passage piéton)";
    list.push({ text, distance: s.distance, at, location: s.location, modifier: s.modifier || "", type: s.type, orsType: s.orsType });
  });
  return list;
}

function pointAlong(coords, cum, d) {
  let i = 0;
  while (i < cum.length - 2 && cum[i + 1] < d) i++;
  const t = (d - cum[i]) / (cum[i + 1] - cum[i] || 1);
  return [coords[i][0] + (coords[i + 1][0] - coords[i][0]) * t, coords[i][1] + (coords[i + 1][1] - coords[i][1]) * t];
}

/* =========================================================================
   5. SCORE TRANSPARENT
   ========================================================================= */

const clamp = (x) => Math.max(0, Math.min(1, x));
const pct = (x) => Math.round(x * 100) + " %";

export function scoreRoute(route, c) {
  const items = [];
  const add = (label, weight, value, detail) => { if (weight > 0) items.push({ label, weight, value: value == null ? null : clamp(value), detail }); };
  const el = route.elevation;
  const o = route.osm;
  const km = route.distance / 1000;

  const errAbs = Math.abs(route.err);
  add("Distance", 3, errAbs <= TOLERANCE ? 1 : 1 - (errAbs - TOLERANCE) / 0.12,
    `${(route.distance / 1000).toFixed(2)} km pour ${(c.distance / 1000).toFixed(1)} km demandés (écart ${(route.err * 100).toFixed(1)} %)`);

  if (el) {
    const perKm = el.gain / km;
    const target = { flat: 4, low: 10, moderate: 22, any: null }[c.elevation];
    const w = { flat: 3, low: 2, moderate: 1, any: 0 }[c.elevation];
    if (target) add("Dénivelé", w, 1 - (perKm - target) / (target * 1.5), `${Math.round(el.gain)} m D+ (${perKm.toFixed(1)} m/km, cible ≤ ${target} m/km)`);
    if (c.opts.avoidSteepDown || c.elevation === "flat")
      add("Descentes", c.elevation === "flat" ? 3 : 2, 1 - (el.maxDown - 3) / 6, `pente descendante max ≈ ${el.maxDown.toFixed(1)} % sur 100 m`);
  } else {
    add("Dénivelé", c.elevation === "any" ? 0 : 2, null, "altitude indisponible");
  }

  if (o) {
    if (c.opts.avoidStairs) add("Escaliers", 3, o.stairs === 0 ? 1 : 0, o.stairs === 0 ? "aucun escalier repéré dans OSM" : `${o.stairs} passage(s) en escalier`);
    const env = [...c.env].filter((e) => e !== "any");
    if (env.length) {
      const shares = {
        park: o.green, water: o.water, greenway: o.greenway, natural: o.natural + o.stabilized * 0.5,
        residential: o.residential, city: Math.max(0, 1 - o.green) * (1 - o.natural),
      };
      const names = { park: "verdure", water: "bord d'eau", greenway: "voies vertes", natural: "chemins naturels", residential: "résidentiel", city: "ville" };
      const v = env.reduce((s, e) => s + clamp(shares[e] / 0.4), 0) / env.length;
      add("Environnement", 2, v, env.map((e) => `${names[e]} ${pct(shares[e])}`).join(" · "));
    }
    const night = c.moment === "night", evening = c.moment === "evening";
    const calmW = { busy: 2, calm: 2, veryquiet: 2.5, any: 0 }[c.calm];
    if (c.calm === "busy") add("Tranquillité", calmW, 1 - o.isolated * 2.5 + o.residential * 0.3, `isolement ${pct(o.isolated)} · rues résidentielles ${pct(o.residential)}`);
    if (c.calm === "calm") add("Tranquillité", calmW, (1 - o.busy * 2) * 0.6 + (1 - o.isolated * 2.5) * 0.4, `axes fréquentés ${pct(o.busy)} · isolement ${pct(o.isolated)}`);
    if (c.calm === "veryquiet") add("Tranquillité", calmW, 1 - o.busy * 3, `axes fréquentés ${pct(o.busy)}`);
    if (night || evening || c.opts.avoidIsolated)
      add("Éclairage", night ? 3 : evening ? 2 : 1, o.lit + o.litUnknown * 0.4, `éclairé ${pct(o.lit)} · non éclairé ${pct(o.unlit)} · inconnu ${pct(o.litUnknown)}`);
    if (c.opts.avoidIsolated) add("Isolement", night ? 3 : 2, 1 - o.isolated * 3, `sentiers isolés non éclairés ${pct(o.isolated)}`);
    if (c.opts.avoidBusyRoads) add("Circulation", 2, 1 - o.busy * 2.5, `${pct(o.busy)} sur axes fréquentés`);
    if (c.opts.minCrossings) add("Traversées", 1.5, 1 - o.crossings / km / 6, `${o.crossings} passages piétons (${(o.crossings / km).toFixed(1)}/km)`);
    if (c.opts.minLights) add("Feux", 1.5, 1 - o.signals / km / 3, `${o.signals} feux (${(o.signals / km).toFixed(1)}/km)`);
    if (c.opts.preferPaths) add("Chemins piétons", 1.5, o.pedestrian / 0.6, `${pct(o.pedestrian)} sur cheminements piétons`);
    if (c.opts.avoidBusyRoads || c.calm !== "any")
      add("Trottoirs", 1, 1 - o.busySidewalkMissing * 5, o.busySidewalkMissing ? `${pct(o.busySidewalkMissing)} sur axe sans trottoir (selon OSM)` : "pas d'axe sans trottoir signalé");
    const surf = { asphalt: o.paved, stabilized: o.stabilized + o.paved * 0.3, natural: o.natural + o.stabilized * 0.5, mixed: null }[c.surface];
    if (surf != null) add("Surface", 1.5, surf / 0.7, `goudron ${pct(o.paved)} · stabilisé ${pct(o.stabilized)} · naturel ${pct(o.natural)} (balisé dans OSM : ${pct(o.surfaceKnown)})`);
    if (c.opts.avoidRough) add("Régularité", 2, 1 - o.irregular * 4, `${pct(o.irregular)} sur revêtement irrégulier (pavés, cailloux…)`);
  } else {
    add("Attributs OSM", 2, null, "données Overpass indisponibles : environnement, éclairage et surface non évalués");
  }
  if (route.shape === "loop") add("Sans répétition", 1, 1 - route.repeat * 2, `${pct(route.repeat)} du tracé emprunté deux fois`);
  if (c.opts.shortenable) add("Raccourcissable", 1.5, route.shortcut ? 1 : 0, route.shortcut ? `repasse à ${Math.round(route.shortcut.dist)} m du départ au km ${(route.shortcut.at / 1000).toFixed(1)}` : "ne repasse pas près du départ à mi-parcours");

  const scored = items.filter((i) => i.value != null);
  const total = scored.reduce((s, i) => s + i.weight * i.value, 0) / Math.max(1e-9, scored.reduce((s, i) => s + i.weight, 0));
  return { total: Math.round(total * 100), items };
}

function shortcutInfo(route, start) {
  const { pts, at } = resample(route.coords, 50);
  const D = route.distance;
  let best = null;
  pts.forEach((p, i) => {
    if (at[i] < D * 0.3 || at[i] > D * 0.7) return;
    const d = haversine(p, start);
    if (!best || d < best.dist) best = { dist: d, at: at[i] };
  });
  return best && best.dist <= Math.max(350, D * 0.12) ? best : null;
}

/* =========================================================================
   6. POINTS D'ATTENTION
   ========================================================================= */

function attentionPoints(r, c) {
  const pts = [];
  if (!r.withinTolerance) pts.push(`Distance hors tolérance ± 3 % : ${(r.distance / 1000).toFixed(2)} km obtenus.`);
  if (r.elevation) {
    if (r.elevation.maxDown >= 6) pts.push(`Descente marquée ≈ ${r.elevation.maxDown.toFixed(0)} % sur une portion.`);
    if (r.elevation.maxUp >= 6) pts.push(`Montée marquée ≈ ${r.elevation.maxUp.toFixed(0)} % sur une portion.`);
  } else pts.push("Altitude indisponible : dénivelé non vérifié.");
  const o = r.osm;
  if (o) {
    if (o.stairs) pts.push(`${o.stairs} passage(s) en escalier.`);
    if (o.busy > 0.08) pts.push(`Longe ${o.busyNames.map((b) => b.name).join(", ")} (${Math.round(o.busy * 100)} % du tracé).`);
    if (o.irregular > 0.05) pts.push(`${Math.round(o.irregular * 100)} % sur revêtement irrégulier.`);
    if ((c.moment === "night" || c.moment === "evening") && o.unlit > 0.1) pts.push(`${Math.round(o.unlit * 100)} % signalé non éclairé.`);
    if ((c.moment === "night" || c.moment === "evening") && o.litUnknown > 0.4) pts.push("Éclairage non renseigné sur une grande partie du tracé.");
    for (const p of o.parks) {
      if (p.hours) pts.push(`Traverse ${p.name} : horaires ${p.hours}.`);
      else if (c.moment === "night" || c.moment === "evening") pts.push(`Traverse ${p.name} : horaires non renseignés, vérifie sur place.`);
    }
    if (o.matchedShare < 0.85) pts.push("Données OSM partielles sur ce secteur.");
  } else pts.push("Éclairage, surface et environnement non vérifiés (Overpass indisponible).");
  if (r.repeat > 0.15) pts.push(`${Math.round(r.repeat * 100)} % du tracé emprunté deux fois.`);
  return pts;
}

/* =========================================================================
   7. PIPELINE COMPLET
   ========================================================================= */

export async function planRuns(c, engineCfg, onProgress = () => {}) {
  onProgress("Calcul des itinéraires sur le réseau piéton…", 0.05);
  const cands = await generateCandidates(c, engineCfg, (label, f) => onProgress(`Calcul des itinéraires (${label})…`, 0.05 + f * 0.55));
  const notes = [];

  onProgress("Analyse du dénivelé…", 0.62);
  await pool(cands.map((r) => async () => {
    try { r.elevation = await analyzeElevation(r); }
    catch (e) { r.elevation = null; r.elevationError = e.message; }
  }), 2);
  if (cands.every((r) => !r.elevation)) notes.push("Le service d'altitude n'a pas répondu : le dénivelé n'est pas pris en compte.");

  onProgress("Lecture des chemins OpenStreetMap (éclairage, surface, parcs)…", 0.78);
  let idx = null;
  try {
    const osm = await overpassAround(overpassLine(cands));
    idx = buildOsmIndex(osm, c.start[0]);
  } catch (e) {
    notes.push(`Données détaillées OSM indisponibles (${e.message}). Environnement, éclairage et surface ne sont pas évalués.`);
  }

  onProgress("Comparaison des tracés…", 0.93);
  for (const r of cands) {
    r.osm = idx ? analyzeOsm(r, idx) : null;
    r.repeat = r.shape === "loop" ? selfRepeatShare(r.coords) : 0;
    r.shortcut = r.shape === "loop" ? shortcutInfo(r, c.start) : null;
    r.instructions = buildInstructions(r, idx, r.shape);
    r.score = scoreRoute(r, c);
    r.attention = attentionPoints(r, c);
    const gain = r.elevation ? r.elevation.gain : 0;
    r.estTime = (r.distance / 1000) * c.pace + gain * 4; // ~4 s par mètre de montée
    r.surfaceLabel = r.osm ? dominantSurface(r.osm) : "non évaluée";
  }

  // Sélection des trois profils, réellement distincts.
  const o = (r, k, dflt = 0) => (r.osm ? r.osm[k] : dflt);
  const cat = {
    flat: (r) => (r.elevation ? -(r.elevation.gain / (r.distance / 1000)) - r.elevation.maxDown * 0.8 - o(r, "irregular") * 20 - o(r, "stairs") * 3 : -o(r, "stairs") * 3),
    nice: (r) => o(r, "green") * 2 + o(r, "water") * 1.5 + o(r, "greenway") + o(r, "pedestrian") * 0.5 - r.repeat,
    quiet: (r) => o(r, "pedestrian") * 1.5 - o(r, "busy") * 3 - (o(r, "crossings") + o(r, "signals")) / (r.distance / 1000) * 0.1 - o(r, "isolated") * 1.5,
  };
  const meta = {
    flat: { title: "Le plus plat", why: "le moins de dénivelé et de descentes" },
    nice: { title: "Le plus agréable", why: "le plus de verdure, d'eau et de voies vertes" },
    quiet: { title: "Le plus tranquille", why: "le moins d'axes fréquentés et de traversées" },
  };
  const canRankNice = !!idx, canRankFlat = cands.some((r) => r.elevation);
  const order = ["flat", "nice", "quiet"].filter((k) => (k === "flat" ? canRankFlat || idx : k === "nice" ? canRankNice : !!idx));
  const picks = [];
  for (const k of order) {
    const sorted = [...cands].sort((a, b) => (b.withinTolerance - a.withinTolerance) || (cat[k](b) - cat[k](a)));
    const choice = sorted.find((r) => !picks.some((p) => p.route === r || overlapShare(r.coords, p.route.coords) > 0.65));
    if (choice) picks.push({ key: k, ...meta[k], route: choice, of: cands.length });
  }
  if (!picks.length) {
    // Aucun classement possible (services d'analyse indisponibles) : on montre le tracé le plus juste en distance.
    const best = [...cands].sort((a, b) => Math.abs(a.err) - Math.abs(b.err))[0];
    picks.push({ key: "dist", title: "Le plus proche de ta distance", why: "seul critère vérifiable sans données d'analyse", route: best, of: cands.length });
  }
  onProgress("Terminé", 1);
  return { picks, notes, candidates: cands.length };
}

function dominantSurface(o) {
  const arr = [["goudron", o.paved], ["stabilisé", o.stabilized], ["naturel", o.natural]].sort((a, b) => b[1] - a[1]);
  if (arr[0][1] > 0.75) return arr[0][0];
  return `mixte (${arr[0][0]} ${Math.round(arr[0][1] * 100)} %, ${arr[1][0]} ${Math.round(arr[1][1] * 100)} %)`;
}
