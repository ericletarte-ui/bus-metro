/*
 * Relais temps réel pour l'app Bus Métro (Cloudflare Worker).
 *
 * Il garde la clé de la STM secrète : la clé est un « secret » du Worker (STM_CLE),
 * jamais dans ce fichier ni dans l'app.
 *
 * GET /passages?arrets=51880,52105
 *   -> { maj: <epoch s>, passages: { "51880|80": [{ t: <epoch s> }, ...], ... } }
 *
 * GET /voyage?arret=51880&ligne=80&t=<epoch s>
 *   -> { maj, arrets: [["51880", <epoch s>], ["51881", ...], ...] }  (le bus le plus proche de t, à partir de cet arrêt)
 *
 * Le flux GTFS-realtime de la STM est lu au plus une fois toutes les 25 secondes,
 * pour rester loin du quota (10 000 requêtes par jour).
 */

const FLUX = "https://api.stm.info/pub/od/gtfs-rt/ic/v2/tripUpdates";
const DUREE_CACHE = 25; // secondes
const ORIGINES = ["https://ericletarte-ui.github.io", "http://localhost:8123"];

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const origine = req.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ORIGINES.includes(origine) ? origine : ORIGINES[0],
      "Access-Control-Allow-Methods": "GET",
      "Vary": "Origin",
    };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (url.pathname === "/voyage") {
      // Les arrêts suivants du bus d'une ligne qui passe à un arrêt vers l'heure t
      const arret = url.searchParams.get("arret") || "", ligne = url.searchParams.get("ligne") || "";
      const t = +url.searchParams.get("t") || Math.floor(Date.now() / 1000);
      try {
        const flux = await lireFlux(env, ctx);
        let meilleur = null, ecart = 1e9;
        for (const v of flux.voyages) {
          if (v.r !== ligne) continue;
          const j = v.s.findIndex((x) => x[0] === arret);
          if (j < 0) continue;
          const e = Math.abs(v.s[j][1] - t);
          if (e < ecart) { ecart = e; meilleur = v.s.slice(j); }
        }
        if (!meilleur || ecart > 600) return Response.json({ arrets: null }, { headers: { ...cors, "Cache-Control": "no-store" } });
        return Response.json({ maj: flux.maj, arrets: meilleur }, { headers: { ...cors, "Cache-Control": "no-store" } });
      } catch (e) {
        return Response.json({ erreur: "flux STM indisponible" }, { status: 502, headers: cors });
      }
    }
    if (url.pathname !== "/passages") return new Response("Relais Bus Métro", { headers: cors });

    const arrets = (url.searchParams.get("arrets") || "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 60);
    try {
      const flux = await lireFlux(env, ctx);
      const passages = {};
      for (const a of arrets) {
        const parLigne = flux.index[a];
        if (!parLigne) continue;
        for (const [ligne, liste] of Object.entries(parLigne)) passages[a + "|" + ligne] = liste;
      }
      return Response.json({ maj: flux.maj, passages }, { headers: { ...cors, "Cache-Control": "no-store" } });
    } catch (e) {
      return Response.json({ erreur: "flux STM indisponible" }, { status: 502, headers: cors });
    }
  },
};

async function lireFlux(env, ctx) {
  const cache = caches.default;
  const cle = new Request("https://relais.interne/flux-stm");
  const enCache = await cache.match(cle);
  if (enCache) return enCache.json();

  const r = await fetch(FLUX, { headers: { apiKey: env.STM_CLE, Accept: "application/x-protobuf" } });
  if (!r.ok) throw new Error("STM " + r.status);
  const flux = indexer(decoderFeed(new Uint8Array(await r.arrayBuffer())));
  ctx.waitUntil(cache.put(cle, new Response(JSON.stringify(flux), {
    headers: { "Content-Type": "application/json", "Cache-Control": "max-age=" + DUREE_CACHE },
  })));
  return flux;
}

/* Regroupe les prochaines arrivées par arrêt puis par ligne */
function indexer(feed) {
  const maintenant = Math.floor(Date.now() / 1000);
  const index = {}, voyages = [];
  for (const tu of feed.trips) {
    if (!tu.route) continue;
    const suite = [];
    for (const s of tu.stops) {
      const t = s.depart || s.arrivee;
      if (t && s.arret && !s.annule && t >= maintenant - 60) suite.push([s.arret, t]);
    }
    if (suite.length) voyages.push({ r: tu.route, s: suite });
    for (const s of tu.stops) {
      const t = s.depart || s.arrivee;
      if (!t || !s.arret || t < maintenant - 60 || t > maintenant + 3 * 3600 || s.annule) continue;
      const parLigne = (index[s.arret] ||= {});
      (parLigne[tu.route] ||= []).push({ t });
    }
  }
  for (const a in index) for (const l in index[a]) index[a][l] = index[a][l].sort((x, y) => x.t - y.t).slice(0, 4);
  return { maj: feed.temps || maintenant, index, voyages };
}

/* ---------- Lecture minimale du format protobuf GTFS-realtime ---------- */
function lecteur(buf) {
  let i = 0;
  const varint = () => {
    let r = 0, m = 1, b;
    do { b = buf[i++]; r += (b & 0x7f) * m; m *= 128; } while (b & 0x80);
    return r;
  };
  return {
    fin: () => i >= buf.length,
    cle: () => { const k = varint(); return [Math.floor(k / 8), k & 7]; },
    varint,
    octets: () => { const n = varint(); const s = buf.subarray(i, i + n); i += n; return s; },
    sauter: (type) => {
      if (type === 0) varint();
      else if (type === 1) i += 8;
      else if (type === 2) { const n = varint(); i += n; }
      else if (type === 5) i += 4;
      else throw new Error("type protobuf " + type);
    },
  };
}
const texte = (o) => new TextDecoder().decode(o);

function decoderFeed(buf) {
  const L = lecteur(buf), out = { temps: 0, trips: [] };
  while (!L.fin()) {
    const [n, t] = L.cle();
    if (n === 1 && t === 2) { // header
      const H = lecteur(L.octets());
      while (!H.fin()) { const [hn, ht] = H.cle(); if (hn === 3 && ht === 0) out.temps = H.varint(); else H.sauter(ht); }
    } else if (n === 2 && t === 2) { // entity
      const E = lecteur(L.octets());
      while (!E.fin()) {
        const [en, et] = E.cle();
        if (en === 3 && et === 2) out.trips.push(decoderTripUpdate(E.octets()));
        else E.sauter(et);
      }
    } else L.sauter(t);
  }
  return out;
}

function decoderTripUpdate(buf) {
  const L = lecteur(buf), tu = { route: "", stops: [] };
  while (!L.fin()) {
    const [n, t] = L.cle();
    if (n === 1 && t === 2) {
      const T = lecteur(L.octets());
      while (!T.fin()) { const [tn, tt] = T.cle(); if (tn === 5 && tt === 2) tu.route = texte(T.octets()); else T.sauter(tt); }
    } else if (n === 2 && t === 2) {
      const S = lecteur(L.octets()), s = {};
      while (!S.fin()) {
        const [sn, st] = S.cle();
        if ((sn === 2 || sn === 3) && st === 2) {
          const E = lecteur(S.octets());
          while (!E.fin()) { const [xn, xt] = E.cle(); if (xn === 2 && xt === 0) s[sn === 2 ? "arrivee" : "depart"] = E.varint(); else E.sauter(xt); }
        } else if (sn === 4 && st === 2) s.arret = texte(S.octets());
        else if (sn === 5 && st === 0) s.annule = S.varint() === 1; // SKIPPED
        else S.sauter(st);
      }
      tu.stops.push(s);
    } else L.sauter(t);
  }
  return tu;
}
