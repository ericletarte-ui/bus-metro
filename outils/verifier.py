#!/usr/bin/env python3
"""Affiche un résumé d'un GTFS pour vérifier qu'il est à jour.

Utilisation : python3 outils/verifier.py gtfs.zip [code_arrêt ...]
"""
import csv, io, sys, zipfile, datetime as dt
from collections import Counter, defaultdict
from zoneinfo import ZoneInfo

def lire(z, nom):
    if nom in z.namelist():
        with z.open(nom) as f:
            yield from csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig", newline=""))

z = zipfile.ZipFile(sys.argv[1])
codes = sys.argv[2:]
auj = dt.datetime.now(ZoneInfo("America/Montreal")).date()
print("Aujourd'hui :", auj)
for nom in z.infolist():
    print(f"  {nom.filename:22} {nom.file_size:>11} octets  {dt.datetime(*nom.date_time)}")
for r in lire(z, "feed_info.txt"):
    print("feed_info :", dict(r))
dates = defaultdict(set)
for r in lire(z, "calendar.txt"):
    d0 = dt.datetime.strptime(r["start_date"], "%Y%m%d").date(); d1 = dt.datetime.strptime(r["end_date"], "%Y%m%d").date()
    j = [r[k] == "1" for k in ("monday","tuesday","wednesday","thursday","friday","saturday","sunday")]
    d = d0
    while d <= d1:
        if j[d.weekday()]: dates[d].add(r["service_id"])
        d += dt.timedelta(days=1)
for r in lire(z, "calendar_dates.txt"):
    d = dt.datetime.strptime(r["date"], "%Y%m%d").date()
    (dates[d].add if r["exception_type"] == "1" else dates[d].discard)(r["service_id"])
jours = sorted(d for d, s in dates.items() if s)
print("Dates couvertes :", jours[0] if jours else None, "à", jours[-1] if jours else None, f"({len(jours)} jours)")
servs = dates.get(auj, set())
print("Services aujourd'hui :", sorted(servs))
routes = {r["route_id"]: r for r in lire(z, "routes.txt")}
trips = {t["trip_id"]: t for t in lire(z, "trips.txt") if t["service_id"] in servs}
par_ligne = Counter(routes[t["route_id"]]["route_short_name"] for t in trips.values())
print(f"Voyages aujourd'hui : {len(trips)} sur {len(par_ligne)} lignes")
sans = sorted(r["route_short_name"] for rid, r in routes.items() if r["route_short_name"] not in par_ligne)
print("Lignes sans voyage aujourd'hui :", " ".join(sans))
arrets = {s["stop_id"]: s for s in lire(z, "stops.txt")}
ids = {sid for sid, s in arrets.items() if s.get("stop_code") in codes}
if ids:
    vus = defaultdict(list)
    for st in lire(z, "stop_times.txt"):
        t = trips.get(st["trip_id"])
        if t and st["stop_id"] in ids:
            vus[(arrets[st["stop_id"]]["stop_code"], routes[t["route_id"]]["route_short_name"], t["trip_headsign"])].append(st["departure_time"][:5])
    for k in sorted(vus):
        h = sorted(vus[k]); print("  arrêt", k[0], "ligne", k[1], k[2], f": {len(h)} passages, {h[0]} à {h[-1]}")
