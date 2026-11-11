// Proxy Cloudflare Worker pour openrouteservice (optionnel).
// La clé API reste côté serveur (variable secrète ORS_KEY) : elle n'apparaît jamais dans le navigateur.
//
// Variables à définir dans Cloudflare (Settings › Variables) :
//   ORS_KEY         (secret)  ta clé openrouteservice
//   ALLOWED_ORIGIN  (texte)   l'adresse de ton app, ex. https://runway-lea.netlify.app

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = env.ALLOWED_ORIGIN || "";
    const cors = {
      "Access-Control-Allow-Origin": allowed,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (origin !== allowed) return new Response("Origine non autorisée", { status: 403, headers: cors });

    const url = new URL(request.url);
    // Seul le calcul d'itinéraire piéton est relayé.
    if (request.method !== "POST" || url.pathname !== "/v2/directions/foot-walking/geojson") {
      return new Response("Route non autorisée", { status: 404, headers: cors });
    }
    const body = await request.text();
    if (body.length > 50_000) return new Response("Requête trop volumineuse", { status: 413, headers: cors });

    const upstream = await fetch("https://api.openrouteservice.org" + url.pathname, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: env.ORS_KEY, Accept: "application/geo+json" },
      body,
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { ...cors, "Content-Type": upstream.headers.get("Content-Type") || "application/json" },
    });
  },
};
