// Sauvegarde locale (sur ce téléphone uniquement). Rien n'est envoyé à un serveur.
import { encodePolyline, decodePolyline } from "./geo.js";

const K = { profile: "runway.profile", favs: "runway.favorites", runs: "runway.runs", settings: "runway.settings" };

function read(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}
function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export const DEFAULT_PROFILE = {
  name: "",
  level: "intermediaire",
  pace: 360, // s/km
  favDistances: [4, 6, 10],
  home: null, // {point:[lat,lon], label}
  surface: "mixed",
  elevation: "low",
  calm: "calm",
  joints: true, // privilégier terrains réguliers, faibles pentes, sans escaliers
};

export const DEFAULT_SETTINGS = { theme: "auto", engine: "osrm", orsProxy: "", voice: true };

export const store = {
  profile: () => ({ ...DEFAULT_PROFILE, ...read(K.profile, {}) }),
  saveProfile: (p) => write(K.profile, p),
  settings: () => ({ ...DEFAULT_SETTINGS, ...read(K.settings, {}) }),
  saveSettings: (s) => write(K.settings, s),

  favorites: () => read(K.favs, []).map(inflate),
  saveFavorite(route, name) {
    const favs = read(K.favs, []);
    const fav = { id: "f" + Date.now().toString(36), name, created: Date.now(), ...deflate(route) };
    favs.unshift(fav);
    return write(K.favs, favs) ? inflate(fav) : null;
  },
  renameFavorite(id, name) {
    const favs = read(K.favs, []);
    const f = favs.find((x) => x.id === id);
    if (f) f.name = name;
    write(K.favs, favs);
  },
  deleteFavorite(id) {
    write(K.favs, read(K.favs, []).filter((x) => x.id !== id));
  },

  runs: () => read(K.runs, []),
  saveRun(run) {
    const runs = read(K.runs, []);
    runs.unshift(run);
    write(K.runs, runs.slice(0, 200));
  },
  deleteRun(id) {
    write(K.runs, read(K.runs, []).filter((x) => x.id !== id));
  },
};

// Format compact pour tenir dans le stockage local.
function deflate(r) {
  return {
    poly: encodePolyline(r.coords),
    distance: r.distance,
    shape: r.shape,
    gain: r.elevation?.gain ?? null,
    loss: r.elevation?.loss ?? null,
    profile: r.elevation ? r.elevation.profile.filter((_, i, a) => i % Math.ceil(a.length / 120) === 0).map((p) => [Math.round(p.d), Math.round(p.z * 10) / 10]) : null,
    instructions: r.instructions,
    surfaceLabel: r.surfaceLabel,
    attention: r.attention,
    estTime: r.estTime,
  };
}

function inflate(f) {
  return {
    ...f,
    coords: decodePolyline(f.poly),
    elevation: f.profile ? { gain: f.gain, loss: f.loss, profile: f.profile.map(([d, z]) => ({ d, z })) } : null,
    withinTolerance: true,
    err: 0,
  };
}
