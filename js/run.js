// Mode course en direct : GPS, chrono, progression sur le tracé, alertes, guidage vocal.
import { haversine, cumulative, makeProjector, nearestOnLine, encodePolyline } from "./geo.js?v=3";

export class LiveRun {
  constructor(route, { onUpdate, onAlert, voice = true }) {
    this.route = route;
    this.coords = route.coords;
    this.cum = cumulative(route.coords);
    this.total = this.cum[this.cum.length - 1];
    this.proj = makeProjector(route.coords[0][0]);
    this.onUpdate = onUpdate;
    this.onAlert = onAlert;
    this.voice = voice && "speechSynthesis" in window;
    this.state = "idle";
    this.elapsed = 0; // ms, hors pauses
    this.runDist = 0;
    this.track = [];
    this.along = 0;
    this.idx = 0;
    this.offCount = 0;
    this.offRoute = false;
    this.announced = new Set();
    this.lastFix = null;
    this.accuracy = null;
    this.speed = null;
    this.gaps = 0;
    this.hiddenAt = null;
  }

  async start() {
    if (!("geolocation" in navigator)) throw new Error("Ce navigateur ne donne pas accès au GPS.");
    this.state = "running";
    this.t0 = performance.now();
    this.watch = navigator.geolocation.watchPosition(
      (pos) => this.onFix(pos),
      (err) => this.onAlert?.(err.code === 1 ? "Accès à la position refusé : le suivi est impossible." : "Signal GPS perdu, recherche en cours…"),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
    );
    this.timer = setInterval(() => this.tick(), 1000);
    await this.keepAwake();
    this.onVis = () => {
      if (document.hidden) this.hiddenAt = Date.now();
      else {
        if (this.hiddenAt && Date.now() - this.hiddenAt > 5000) {
          this.gaps++;
          this.onAlert?.(`Suivi interrompu pendant ${Math.round((Date.now() - this.hiddenAt) / 1000)} s (écran verrouillé ou appli en arrière-plan).`);
        }
        this.hiddenAt = null;
        if (this.state === "running") this.keepAwake();
      }
    };
    document.addEventListener("visibilitychange", this.onVis);
    this.say("C'est parti. " + (this.route.instructions?.[0]?.text || ""));
  }

  async keepAwake() {
    try {
      if ("wakeLock" in navigator) this.lock = await navigator.wakeLock.request("screen");
    } catch {
      this.lock = null;
    }
  }

  tick() {
    if (this.state !== "running") return;
    const now = performance.now();
    this.elapsed += now - this.t0;
    this.t0 = now;
    this.emit();
  }

  pause() {
    if (this.state !== "running") return;
    this.tick();
    this.state = "paused";
    this.say("Pause");
    this.emit();
  }

  resume() {
    if (this.state !== "paused") return;
    this.state = "running";
    this.t0 = performance.now();
    this.lastFix = null; // pas de distance comptée pendant la pause
    this.say("Reprise");
    this.emit();
  }

  onFix(pos) {
    const p = [pos.coords.latitude, pos.coords.longitude];
    const acc = pos.coords.accuracy;
    this.accuracy = acc;
    this.position = p;
    if (pos.coords.speed != null && pos.coords.speed >= 0) this.speed = pos.coords.speed;
    if (this.state === "running" && acc <= 40) {
      if (this.lastFix) {
        const d = haversine(this.lastFix.p, p);
        const dt = (pos.timestamp - this.lastFix.t) / 1000;
        // Filtre anti-saut : on ignore les déplacements irréalistes et le bruit à l'arrêt.
        if (d >= 3 && dt > 0 && d / dt < 9) {
          this.runDist += d;
          this.track.push(p);
          this.lastFix = { p, t: pos.timestamp };
          if (pos.coords.speed == null) this.speed = d / dt;
        }
      } else {
        this.lastFix = { p, t: pos.timestamp };
        this.track.push(p);
      }
    }
    // Progression : recherche d'abord vers l'avant (évite de "sauter" à la fin d'une boucle).
    let near = nearestOnLine(p, this.coords, this.cum, this.proj, Math.max(0, this.idx - 15), this.idx + 400);
    if (near.d > 60) {
      const g = nearestOnLine(p, this.coords, this.cum, this.proj);
      if (g.d < near.d - 20) near = g;
    }
    if (near.along >= this.along - 30 || near.d < 15) {
      this.along = near.along;
      this.idx = near.idx;
    }
    const tol = Math.max(35, Math.min(acc, 60));
    if (near.d > tol) this.offCount++;
    else this.offCount = 0;
    const wasOff = this.offRoute;
    this.offRoute = this.offCount >= 3;
    if (this.offRoute && !wasOff) {
      this.onAlert?.("Tu t'éloignes du parcours.");
      this.say("Attention, tu t'éloignes du parcours.");
    }
    if (!this.offRoute && wasOff) this.say("Tu es de retour sur le parcours.");
    this.offDist = near.d;
    this.announce();
    if (this.state === "running" && this.total - this.along < 25 && this.runDist > this.total * 0.6 && !this.announced.has("end")) {
      this.announced.add("end");
      this.say("Tu es arrivée. Bravo !");
    }
    this.emit();
  }

  nextInstruction() {
    const list = this.route.instructions || [];
    return list.find((s, k) => k > 0 && s.at > this.along + 5) || null;
  }

  announce() {
    const next = this.nextInstruction();
    if (!next || this.state !== "running") return;
    const dist = next.at - this.along;
    const key = next.at.toFixed(0);
    if (dist <= 90 && dist > 30 && !this.announced.has(key + "far")) {
      this.announced.add(key + "far");
      this.say(`Dans ${Math.round(dist / 10) * 10} mètres, ${lower(next.text)}`);
    } else if (dist <= 20 && !this.announced.has(key + "now")) {
      this.announced.add(key + "now");
      this.say(next.text);
    }
  }

  say(text) {
    if (!this.voice || !text) return;
    try {
      const u = new SpeechSynthesisUtterance(text.replace(/\(passage piéton\)/, ", passage piéton"));
      u.lang = "fr-FR";
      u.rate = 1.02;
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    } catch { /* voix indisponible */ }
  }

  stats() {
    const sec = this.elapsed / 1000;
    const km = this.runDist / 1000;
    return {
      state: this.state,
      elapsed: sec,
      runDist: this.runDist,
      remaining: Math.max(0, this.total - this.along),
      along: this.along,
      pace: km > 0.05 ? sec / km : NaN,
      speedKmh: this.speed != null ? this.speed * 3.6 : NaN,
      accuracy: this.accuracy,
      position: this.position,
      offRoute: this.offRoute,
      offDist: this.offDist,
      next: this.nextInstruction(),
      progress: this.total ? this.along / this.total : 0,
    };
  }

  emit() { this.onUpdate?.(this.stats()); }

  finish() {
    this.tick();
    this.state = "done";
    navigator.geolocation.clearWatch(this.watch);
    clearInterval(this.timer);
    document.removeEventListener("visibilitychange", this.onVis);
    try { this.lock?.release(); } catch { /* déjà libéré */ }
    try { speechSynthesis.cancel(); } catch { /* rien */ }
    const s = this.stats();
    return {
      id: "r" + Date.now().toString(36),
      date: Date.now(),
      name: this.route.name || "Course",
      planned: this.total,
      distance: s.runDist,
      duration: s.elapsed,
      pace: s.pace,
      gaps: this.gaps,
      track: this.track.length > 1 ? encodePolyline(this.track) : null,
    };
  }
}

function lower(t) { return t.charAt(0).toLowerCase() + t.slice(1); }
