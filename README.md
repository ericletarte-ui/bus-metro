# Bus Métro

Petite app web (PWA) qui affiche les prochains passages des bus et du métro de la STM autour de toi, pensée pour un téléphone Android.

- **Autour de moi** : les lignes de bus proches, une carte par ligne, avec le sens choisi retenu sur le téléphone.
- **Mes lignes** : tes lignes favorites (au départ 80, 480 et 129), à l'arrêt le plus proche.
- **Métro** : stations proches et fréquence approximative. Pas d'heures exactes : la licence de la STM ne le permet pas pour le métro.

## Comment ça marche

- `site/` : l'app elle-même (HTML, CSS, JavaScript, service worker pour l'usage hors ligne).
- `outils/construire_donnees.py` : transforme le GTFS de la STM en petits fichiers JSON (`site/donnees/`).
- `.github/workflows/publier.yml` : chaque nuit, télécharge le GTFS à jour, refait les données et publie le site sur GitHub Pages.

Pour essayer à un autre moment : ajouter `?date=AAAAMMJJ&heure=HH:MM` à l'adresse.

## Temps réel

Le temps réel des bus passera par un petit relais côté serveur qui garde la clé de la STM secrète. Aucune clé ne doit être mise dans ce dépôt public. L.adresse du relais se règle dans `site/config.js`. Le code du relais est dans `relais/worker.js` (Cloudflare Worker, secret `STM_CLE`).

Données : Société de transport de Montréal, données ouvertes, licence CC BY 4.0.
