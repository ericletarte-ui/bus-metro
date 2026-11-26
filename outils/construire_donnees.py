#!/usr/bin/env python3
"""Transforme le GTFS de la STM en petits fichiers JSON pour l'app.

Utilisation : python3 outils/construire_donnees.py gtfs_stm.zip site/donnees [nb_jours]

Fichiers produits dans le dossier de sortie :
  reseau.json            lignes de bus, arrêts, stations de métro
  jours.json             pour chaque date de service (AAAAMMJJ), le fichier d'horaires à lire
  parcours.json          pour chaque sens de ligne, les suites d'arrêts et leurs temps de parcours
  passages-<clé>.json    pour chaque arrêt, les passages prévus par ligne

Format d'un fichier de passages : une liste alignée sur reseau.stops.
Chaque arrêt contient une liste [indice_ligne, première_minute, écart, écart, ...]
où les minutes comptent depuis minuit du jour de service (peuvent dépasser 1440).
"""
import csv
import datetime as dt
import hashlib
import io
import json
import os
import re
import sys
import zipfile
from zoneinfo import ZoneInfo
from collections import defaultdict

FUSEAU_JOURS = 14  # nombre de jours couverts par défaut


def lire(z, nom):
    """Lit un fichier CSV du zip, ligne par ligne, sous forme de dictionnaires."""
    if nom not in z.namelist():
        return
    with z.open(nom) as f:
        texte = io.TextIOWrapper(f, encoding="utf-8-sig", newline="")
        yield from csv.DictReader(texte)


def minutes(hms):
    h, m, *_ = hms.strip().split(":")
    return int(h) * 60 + int(m)


def services_par_date(z, debut, nb):
    dates = [debut + dt.timedelta(days=i) for i in range(nb)]
    actifs = {d: set() for d in dates}
    for r in lire(z, "calendar.txt"):
        d0 = dt.datetime.strptime(r["start_date"], "%Y%m%d").date()
        d1 = dt.datetime.strptime(r["end_date"], "%Y%m%d").date()
        jours = [r[k] == "1" for k in ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")]
        for d in dates:
            if d0 <= d <= d1 and jours[d.weekday()]:
                actifs[d].add(r["service_id"])
    for r in lire(z, "calendar_dates.txt"):
        d = dt.datetime.strptime(r["date"], "%Y%m%d").date()
        if d in actifs:
            if r["exception_type"] == "1":
                actifs[d].add(r["service_id"])
            elif r["exception_type"] == "2":
                actifs[d].discard(r["service_id"])
    return actifs


def nom_station(n):
    n = n.strip()
    if n.lower().startswith("station "):
        n = n[8:]
    return " ".join(n.split())


def nom_arret(s):
    """Nom lisible d'un arrêt. Le RTC nomme ses arrêts « Champlain/1006 » : on prend alors la description."""
    n = s["stop_name"].strip()
    if re.search(r"/\s*\d+$", n):
        n = (s.get("stop_desc") or "").strip() or re.sub(r"/\s*\d+$", "", n)
    return " ".join(n.split())


def sens_affiche(h):
    """« Gare fluviale (Sud) » devient « Sud Gare fluviale » : l'app regroupe les sens par le premier mot."""
    m = re.match(r"^(.*?)\s*\((Nord|Sud|Est|Ouest)\)\s*$", h)
    return m.group(2) + " " + m.group(1) if m else h


def construire(chemin_zip, sortie, nb_jours=FUSEAU_JOURS, debut=None):
    os.makedirs(sortie, exist_ok=True)
    z = zipfile.ZipFile(chemin_zip)

    routes = {r["route_id"]: r for r in lire(z, "routes.txt")}
    bus = {rid for rid, r in routes.items() if r.get("route_type") == "3"}
    metro = {rid for rid, r in routes.items() if r.get("route_type") == "1"}

    trips = {}
    for t in lire(z, "trips.txt"):
        if t["route_id"] in bus or t["route_id"] in metro:
            trips[t["trip_id"]] = t

    # Lignes : une entrée par (numéro, sens affiché)
    lignes, idx_ligne = [], {}
    trip_ligne = {}
    for tid, t in trips.items():
        if t["route_id"] not in bus:
            continue
        r = routes[t["route_id"]]
        num = (r.get("route_short_name") or r["route_id"]).strip()
        sens = sens_affiche((t.get("trip_headsign") or "").strip()) or "Direction " + (t.get("direction_id") or "0")
        cle = (num, sens)
        if cle not in idx_ligne:
            idx_ligne[cle] = len(lignes)
            lignes.append([num, sens, (r.get("route_long_name") or r.get("route_desc") or "").strip()])
        trip_ligne[tid] = idx_ligne[cle]

    arrets = {s["stop_id"]: s for s in lire(z, "stops.txt")}

    # Passages par voyage : [(séquence, arrêt, minute, montée permise)]
    par_voyage = defaultdict(list)
    lignes_station = defaultdict(set)
    nom_quai = {}  # le nom du quai est en casse normale, celui de la station en majuscules
    for st in lire(z, "stop_times.txt"):
        tid = st["trip_id"]
        t = trips.get(tid)
        if t is None:
            continue
        if t["route_id"] in metro:
            s = arrets.get(st["stop_id"])
            if s:
                parent = s.get("parent_station") or s["stop_id"]
                lignes_station[parent].add(routes[t["route_id"]].get("route_short_name", "").strip())
                nom_quai[parent] = s["stop_name"]
            continue
        h = st.get("departure_time") or st.get("arrival_time")
        if not h:
            continue
        pick = st.get("pickup_type", st.get(" pickup_type")) or "0"
        par_voyage[tid].append((int(st["stop_sequence"]), st["stop_id"], minutes(h), pick.strip() != "1"))

    # Arrêts de bus réellement desservis
    ids_arrets = sorted({p[1] for v in par_voyage.values() for p in v})
    idx_arret = {sid: i for i, sid in enumerate(ids_arrets)}
    stops_out = []
    for sid in ids_arrets:
        s = arrets[sid]
        stops_out.append([(s.get("stop_code") or sid).strip(), nom_arret(s), round(float(s["stop_lat"]), 5), round(float(s["stop_lon"]), 5)])

    # Voyages compactés : on retire le terminus (on n'y monte pas) et les arrêts sans montée
    # Parcours : pour chaque sens de ligne, les suites d'arrêts les plus courantes
    # avec le temps médian depuis le premier arrêt (pour « les arrêts suivants »).
    motifs = defaultdict(lambda: defaultdict(list))
    for tid, v in par_voyage.items():
        v.sort()
        seq = tuple(idx_arret[x[1]] for x in v)
        t0 = v[0][2]
        motifs[trip_ligne[tid]][seq].append([x[2] - t0 for x in v])
    parcours = []
    for li in range(len(lignes)):
        par_seq = motifs.get(li, {})
        top = sorted(par_seq.items(), key=lambda kv: -len(kv[1]))
        garde = []
        for seq, offs in top[:4]:
            if garde and len(offs) < 0.1 * len(top[0][1]):
                break
            med = [sorted(o[j] for o in offs)[len(offs) // 2] for j in range(len(seq))]
            garde.append([list(seq), med, len(offs)])
        parcours.append(garde)
    del motifs

    compacts = {}
    for tid, v in par_voyage.items():
        v.sort()
        compacts[tid] = [(idx_arret[s], m) for (_, s, m, monte) in v[:-1] if monte]
    del par_voyage

    voyages_par_service = defaultdict(list)
    for tid in compacts:
        voyages_par_service[trips[tid]["service_id"]].append(tid)

    # Stations de métro
    metro_out = []
    for sid, lns in lignes_station.items():
        s = arrets.get(sid)
        if not s:
            continue
        nums = sorted(int(x) for x in lns if x.isdigit())
        metro_out.append([nom_station(nom_quai.get(sid) or s["stop_name"]), round(float(s["stop_lat"]), 5), round(float(s["stop_lon"]), 5), nums])
    metro_out.sort(key=lambda m: m[0])

    # Horaires par date, en regroupant les dates qui ont exactement le même service
    if debut is None:
        debut = dt.datetime.now(ZoneInfo("America/Montreal")).date() - dt.timedelta(days=1)
    actifs = services_par_date(z, debut, nb_jours)
    jours, faits = {}, {}
    for d, servs in sorted(actifs.items()):
        servs = frozenset(s for s in servs if s in voyages_par_service)
        if not servs:
            continue
        if servs not in faits:
            cle = hashlib.sha1("|".join(sorted(servs)).encode()).hexdigest()[:10]
            grille = [defaultdict(set) for _ in stops_out]
            for s in servs:
                for tid in voyages_par_service[s]:
                    li = trip_ligne[tid]
                    for ia, m in compacts[tid]:
                        grille[ia][li].add(m)
            out = []
            for g in grille:
                lst = []
                for li in sorted(g):
                    ts = sorted(g[li])
                    lst.append([li, ts[0]] + [b - a for a, b in zip(ts, ts[1:])])
                out.append(lst)
            with open(os.path.join(sortie, f"passages-{cle}.json"), "w", encoding="utf-8") as f:
                json.dump(out, f, separators=(",", ":"))
            faits[servs] = cle
        jours[d.strftime("%Y%m%d")] = faits[servs]

    version = ""
    for r in lire(z, "feed_info.txt"):
        version = r.get("feed_version", "") or r.get("feed_start_date", "")
    reseau = {
        "lines": lignes,
        "stops": stops_out,
        "metro": metro_out,
        "feed": version,
        "genere": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
    }
    with open(os.path.join(sortie, "reseau.json"), "w", encoding="utf-8") as f:
        json.dump(reseau, f, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(sortie, "parcours.json"), "w", encoding="utf-8") as f:
        json.dump(parcours, f, separators=(",", ":"))
    with open(os.path.join(sortie, "jours.json"), "w", encoding="utf-8") as f:
        json.dump(jours, f, separators=(",", ":"))

    print(f"{len(lignes)} sens de ligne, {len(stops_out)} arrêts, {len(metro_out)} stations, "
          f"{len(jours)} jours, {len(faits)} grilles d'horaires, version {version}")
    if not lignes or not stops_out or not jours:
        sys.exit("Données incomplètes : arrêt.")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    construire(sys.argv[1], sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else FUSEAU_JOURS)
