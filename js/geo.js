// Outils géographiques purs (aucune dépendance réseau).
// Convention : points = [lat, lon] en degrés, distances en mètres.

const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

export function haversine(a, b) {
  const dLat = rad(b[0] - a[0]);
  const dLon = rad(b[1] - a[1]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// Point situé à `dist` mètres de `p` dans la direction `bearingDeg` (0 = nord).
export function destination(p, bearingDeg, dist) {
  const d = dist / R;
  const b = rad(bearingDeg);
  const lat1 = rad(p[0]);
  const lon1 = rad(p[1]);
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b)
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(b) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
    );
  return [deg(lat2), ((deg(lon2) + 540) % 360) - 180];
}

export function bearing(a, b) {
  const y = Math.sin(rad(b[1] - a[1])) * Math.cos(rad(b[0]));
  const x =
    Math.cos(rad(a[0])) * Math.sin(rad(b[0])) -
    Math.sin(rad(a[0])) * Math.cos(rad(b[0])) * Math.cos(rad(b[1] - a[1]));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

export function cumulative(coords) {
  const out = [0];
  for (let i = 1; i < coords.length; i++) out.push(out[i - 1] + haversine(coords[i - 1], coords[i]));
  return out;
}

export function lineLength(coords) {
  const c = cumulative(coords);
  return c[c.length - 1] || 0;
}

// Ré-échantillonne une polyligne tous les `step` mètres (renvoie aussi la distance de chaque point).
export function resample(coords, step) {
  if (coords.length < 2) return { pts: coords.slice(), at: [0] };
  const cum = cumulative(coords);
  const total = cum[cum.length - 1];
  const pts = [];
  const at = [];
  let j = 0;
  for (let d = 0; d <= total + 0.01; d += step) {
    while (j < cum.length - 2 && cum[j + 1] < d) j++;
    const seg = cum[j + 1] - cum[j] || 1;
    const t = Math.min(1, Math.max(0, (d - cum[j]) / seg));
    pts.push([
      coords[j][0] + (coords[j + 1][0] - coords[j][0]) * t,
      coords[j][1] + (coords[j + 1][1] - coords[j][1]) * t,
    ]);
    at.push(d);
  }
  if (at[at.length - 1] < total - 1) {
    pts.push(coords[coords.length - 1]);
    at.push(total);
  }
  return { pts, at };
}

// Projection locale équirectangulaire autour d'une latitude de référence (précise à l'échelle d'une ville).
export function makeProjector(lat0) {
  const kx = (Math.PI / 180) * R * Math.cos(rad(lat0));
  const ky = (Math.PI / 180) * R;
  return {
    fwd: (p) => [p[1] * kx, p[0] * ky],
    inv: (xy) => [xy[1] / ky, xy[0] / kx],
  };
}

// Distance d'un point à un segment, en mètres, dans le repère projeté. Renvoie aussi t ∈ [0,1].
export function pointSegment(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = a[0] + t * dx;
  const y = a[1] + t * dy;
  return { d: Math.hypot(p[0] - x, p[1] - y), t };
}

// Point le plus proche d'une polyligne. `cum` = distances cumulées de la polyligne.
// `from`/`to` limitent la recherche à une fenêtre d'indices (utile pendant la course).
export function nearestOnLine(p, coords, cum, proj, from = 0, to = coords.length - 1) {
  const P = proj.fwd(p);
  let best = { d: Infinity, along: 0, idx: 0 };
  for (let i = Math.max(0, from); i < Math.min(to, coords.length - 1); i++) {
    const A = proj.fwd(coords[i]);
    const B = proj.fwd(coords[i + 1]);
    const r = pointSegment(P, A, B);
    if (r.d < best.d) best = { d: r.d, along: cum[i] + (cum[i + 1] - cum[i]) * r.t, idx: i };
  }
  return best;
}

export function pointInRing(pt, ring) {
  // pt et ring en [lat, lon]
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i][0], xi = ring[i][1];
    const yj = ring[j][0], xj = ring[j][1];
    if (yi > pt[0] !== yj > pt[0] && pt[1] < ((xj - xi) * (pt[0] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function bbox(coords) {
  let s = 90, w = 180, n = -90, e = -180;
  for (const [la, lo] of coords) {
    if (la < s) s = la;
    if (la > n) n = la;
    if (lo < w) w = lo;
    if (lo > e) e = lo;
  }
  return [s, w, n, e];
}

// Part de la longueur d'un tracé A qui recouvre un tracé B (à `tol` mètres près). 0..1
export function overlapShare(a, b, tol = 25) {
  const proj = makeProjector(a[0][0]);
  const sa = resample(a, 40).pts;
  const grid = new SegmentGrid(b, proj, 60);
  let hit = 0;
  for (const p of sa) if (grid.nearest(p, tol).d <= tol) hit++;
  return sa.length ? hit / sa.length : 0;
}

// Part d'un tracé parcourue deux fois (aller-retour local, cul-de-sac). 0..1
export function selfRepeatShare(coords, tol = 15) {
  const proj = makeProjector(coords[0][0]);
  const { pts, at } = resample(coords, 30);
  const P = pts.map(proj.fwd);
  let rep = 0;
  for (let i = 0; i < P.length; i++) {
    for (let j = 0; j < P.length; j++) {
      if (Math.abs(at[i] - at[j]) < 150) continue;
      if (Math.hypot(P[i][0] - P[j][0], P[i][1] - P[j][1]) < tol) {
        rep++;
        break;
      }
    }
  }
  return P.length ? rep / P.length : 0;
}

// Index spatial simple : grille de segments, pour trouver vite le segment le plus proche.
export class SegmentGrid {
  constructor(lines, proj, cell = 50) {
    // lines : une polyligne [[lat,lon]...] ou un tableau d'objets {coords, data}
    this.proj = proj;
    this.cell = cell;
    this.map = new Map();
    const list = Array.isArray(lines[0]?.[0]) || typeof lines[0]?.[0] === "number"
      ? [{ coords: lines, data: null }]
      : lines;
    for (const line of list) {
      const P = line.coords.map(proj.fwd);
      for (let i = 0; i < P.length - 1; i++) {
        const seg = { a: P[i], b: P[i + 1], data: line.data };
        const x0 = Math.floor(Math.min(seg.a[0], seg.b[0]) / cell);
        const x1 = Math.floor(Math.max(seg.a[0], seg.b[0]) / cell);
        const y0 = Math.floor(Math.min(seg.a[1], seg.b[1]) / cell);
        const y1 = Math.floor(Math.max(seg.a[1], seg.b[1]) / cell);
        for (let x = x0; x <= x1; x++)
          for (let y = y0; y <= y1; y++) {
            const k = x + ":" + y;
            if (!this.map.has(k)) this.map.set(k, []);
            this.map.get(k).push(seg);
          }
      }
    }
  }
  nearest(p, maxDist = 30) {
    const P = this.proj.fwd(p);
    const r = Math.ceil(maxDist / this.cell);
    const cx = Math.floor(P[0] / this.cell);
    const cy = Math.floor(P[1] / this.cell);
    let best = { d: Infinity, data: null };
    for (let x = cx - r; x <= cx + r; x++)
      for (let y = cy - r; y <= cy + r; y++) {
        const segs = this.map.get(x + ":" + y);
        if (!segs) continue;
        for (const s of segs) {
          const { d } = pointSegment(P, s.a, s.b);
          if (d < best.d) best = { d, data: s.data };
        }
      }
    return best;
  }
}

// Encodage polyline (précision 5) — compact pour le stockage local.
export function encodePolyline(coords) {
  let out = "", pLat = 0, pLon = 0;
  const enc = (v) => {
    v = v < 0 ? ~(v << 1) : v << 1;
    let s = "";
    while (v >= 0x20) {
      s += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    return s + String.fromCharCode(v + 63);
  };
  for (const [la, lo] of coords) {
    const a = Math.round(la * 1e5), o = Math.round(lo * 1e5);
    out += enc(a - pLat) + enc(o - pLon);
    pLat = a; pLon = o;
  }
  return out;
}

export function decodePolyline(str) {
  const out = [];
  let i = 0, lat = 0, lon = 0;
  const dec = () => {
    let r = 0, s = 0, b;
    do {
      b = str.charCodeAt(i++) - 63;
      r |= (b & 0x1f) << s;
      s += 5;
    } while (b >= 0x20);
    return r & 1 ? ~(r >> 1) : r >> 1;
  };
  while (i < str.length) {
    lat += dec();
    lon += dec();
    out.push([lat / 1e5, lon / 1e5]);
  }
  return out;
}

export function fmtKm(m, digits = 1) {
  return (m / 1000).toLocaleString("fr-FR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

export function fmtPace(secPerKm) {
  if (!isFinite(secPerKm) || secPerKm <= 0 || secPerKm > 3600) return "–";
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}'${String(s === 60 ? 59 : s).padStart(2, "0")}"`;
}
