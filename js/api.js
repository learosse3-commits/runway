// Accès aux services externes. Tous sans clé, sauf openrouteservice (via ton proxy).
//  - Routage piéton : OSRM "foot" de FOSSGIS (routing.openstreetmap.de), données OpenStreetMap
//  - Routage avancé (option) : openrouteservice foot-walking, via un proxy qui garde la clé
//  - Adresses : Photon (Komoot), données OpenStreetMap
//  - Altitude : Open-Meteo Elevation (MNT Copernicus 90 m)
//  - Attributs des chemins (éclairage, revêtement, parcs…) : Overpass API

export class ApiError extends Error {
  constructor(service, message, cause) {
    super(message);
    this.service = service;
    this.cause = cause;
  }
}

async function fetchJson(service, url, opts = {}, timeout = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    if (res.status === 429) throw new ApiError(service, `${service} limite le nombre de requêtes. Réessaie dans une minute.`);
    if (!res.ok) throw new ApiError(service, `${service} a répondu avec une erreur (${res.status}).`);
    return await res.json();
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (e.name === "AbortError") throw new ApiError(service, `${service} ne répond pas (délai dépassé).`, e);
    throw new ApiError(service, `Impossible de joindre ${service}. Vérifie ta connexion.`, e);
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- Routage : OSRM piéton ---------------- */

const OSRM_FOOT = "https://routing.openstreetmap.de/routed-foot/route/v1/driving/";

// waypoints : [[lat,lon], ...]. allowUturn : vrai pour un aller-retour.
// Le serveur FOSSGIS demande au plus 1 requête par seconde : toutes les requêtes passent par cette file.
let osrmNext = 0;
async function osrmSlot() {
  const now = Date.now();
  const wait = Math.max(0, osrmNext - now);
  osrmNext = Math.max(now, osrmNext) + 1100;
  if (wait) await new Promise((r) => setTimeout(r, wait));
}

export async function routeOSRM(waypoints, { allowUturn = false } = {}) {
  await osrmSlot();
  const coords = waypoints.map((p) => `${p[1].toFixed(6)},${p[0].toFixed(6)}`).join(";");
  const url =
    OSRM_FOOT + coords +
    `?overview=full&geometries=geojson&steps=true&continue_straight=${allowUturn ? "false" : "true"}`;
  const data = await fetchJson("Le service de calcul d'itinéraire", url);
  if (data.code !== "Ok" || !data.routes?.length)
    throw new ApiError("routage", data.code === "NoRoute" ? "Aucun chemin piéton trouvé entre ces points." : `Calcul impossible (${data.code}).`);
  const r = data.routes[0];
  const steps = [];
  for (const leg of r.legs) {
    for (const s of leg.steps) {
      steps.push({
        type: s.maneuver.type,
        modifier: s.maneuver.modifier || "",
        name: s.name || "",
        ref: s.ref || "",
        distance: s.distance,
        location: [s.maneuver.location[1], s.maneuver.location[0]],
      });
    }
  }
  return {
    engine: "osrm",
    coords: r.geometry.coordinates.map((c) => [c[1], c[0]]),
    distance: r.distance,
    steps: mergeSteps(steps),
    elevations: null,
  };
}

// OSRM découpe le trajet à chaque point de passage : on fusionne ces arrivées/départs intermédiaires.
function mergeSteps(steps) {
  const out = [];
  steps.forEach((s, i) => {
    const isFirst = i === 0;
    const isLast = i === steps.length - 1;
    if (!isFirst && s.type === "depart") return;
    if (!isLast && s.type === "arrive") {
      // Le prochain "depart" porte le changement de direction réel : on le transforme en virage.
      const next = steps[i + 1];
      if (next && next.type === "depart" && out.length) {
        out.push({ ...next, type: "waypoint", modifier: next.modifier || "straight" });
      }
      return;
    }
    out.push(s);
  });
  // Regroupe les "continuer" successifs sur la même voie.
  const merged = [];
  for (const s of out) {
    const prev = merged[merged.length - 1];
    if (prev && (s.type === "new name" || s.type === "continue" || s.type === "waypoint") &&
        (s.modifier === "straight" || s.modifier === "") && s.name === prev.name && prev.type !== "depart") {
      prev.distance += s.distance;
      continue;
    }
    merged.push({ ...s });
  }
  return merged;
}

/* ---------------- Routage : openrouteservice (option) ---------------- */

// proxyUrl : URL de ton proxy (ex. Cloudflare Worker) qui ajoute la clé ORS côté serveur.
export async function routeORS(proxyUrl, body) {
  const url = proxyUrl.replace(/\/$/, "") + "/v2/directions/foot-walking/geojson";
  const data = await fetchJson("openrouteservice", url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ elevation: true, instructions: true, language: "fr", units: "m", ...body }),
  }, 30000);
  const f = data.features?.[0];
  if (!f) throw new ApiError("openrouteservice", "openrouteservice n'a renvoyé aucun itinéraire.");
  const coords = f.geometry.coordinates.map((c) => [c[1], c[0]]);
  const elevations = f.geometry.coordinates.map((c) => c[2] ?? null);
  const steps = [];
  for (const seg of f.properties.segments || []) {
    for (const s of seg.steps || []) {
      const loc = coords[s.way_points[0]];
      steps.push({ type: "ors", orsType: s.type, text: s.instruction, name: s.name === "-" ? "" : s.name, distance: s.distance, location: loc });
    }
  }
  return { engine: "ors", coords, distance: f.properties.summary.distance, steps, elevations };
}

/* ---------------- Adresses : Photon ---------------- */

export async function searchAddress(q, near) {
  let url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&lang=fr&limit=6`;
  if (near) url += `&lat=${near[0].toFixed(4)}&lon=${near[1].toFixed(4)}`;
  const data = await fetchJson("La recherche d'adresse", url, {}, 10000);
  return (data.features || []).map((f) => ({
    point: [f.geometry.coordinates[1], f.geometry.coordinates[0]],
    label: photonLabel(f.properties),
    sub: [f.properties.postcode, f.properties.city || f.properties.county].filter(Boolean).join(" "),
  }));
}

export async function reverseGeocode(p) {
  try {
    const data = await fetchJson("La recherche d'adresse", `https://photon.komoot.io/reverse?lat=${p[0]}&lon=${p[1]}&lang=fr`, {}, 8000);
    const f = data.features?.[0];
    return f ? photonLabel(f.properties) : null;
  } catch {
    return null;
  }
}

function photonLabel(pr) {
  const street = [pr.housenumber, pr.street].filter(Boolean).join(" ");
  const main = pr.name && pr.name !== pr.street ? pr.name : street || pr.name || "";
  const city = pr.city || pr.town || pr.village || "";
  return [main, city && city !== main ? city : ""].filter(Boolean).join(", ") || "Point sans nom";
}

/* ---------------- Altitude : Open-Meteo ---------------- */

export async function elevations(points) {
  const out = [];
  for (let i = 0; i < points.length; i += 100) {
    const chunk = points.slice(i, i + 100);
    const lat = chunk.map((p) => p[0].toFixed(5)).join(",");
    const lon = chunk.map((p) => p[1].toFixed(5)).join(",");
    const data = await fetchJson("Le service d'altitude", `https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`, {}, 15000);
    if (!Array.isArray(data.elevation)) throw new ApiError("altitude", "Réponse d'altitude invalide.");
    out.push(...data.elevation);
  }
  return out;
}

/* ---------------- Attributs OSM : Overpass ---------------- */

const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];

// line : polyligne [[lat,lon]] (déjà simplifiée). Renvoie voies, espaces verts, eau et feux/traversées à proximité.
export async function overpassAround(line) {
  const ll = line.map((p) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`).join(",");
  const q = `[out:json][timeout:40];
(way(around:18,${ll})[highway];)->.ways;
.ways out tags geom;
(
  way(around:50,${ll})[leisure~"^(park|garden|nature_reserve|recreation_ground)$"];
  relation(around:50,${ll})[leisure~"^(park|garden|nature_reserve)$"];
  way(around:50,${ll})[landuse~"^(forest|grass|meadow|recreation_ground|village_green|allotments)$"];
  way(around:50,${ll})[natural~"^(wood|scrub|grassland|heath)$"];
)->.green;
.green out tags geom;
(
  way(around:90,${ll})[waterway~"^(river|canal|stream)$"];
  way(around:90,${ll})[natural=water];
  relation(around:90,${ll})[natural=water];
)->.water;
.water out tags geom;
node(around:10,${ll})[highway~"^(traffic_signals|crossing)$"];
out;`;
  let lastErr;
  for (const endpoint of OVERPASS) {
    try {
      return await fetchJson("Overpass (données OpenStreetMap)", endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(q),
      }, 45000);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}
