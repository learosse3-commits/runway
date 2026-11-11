# Runway

Planificateur de parcours de running. Les itinéraires sont calculés sur le vrai réseau piéton OpenStreetMap, pas dessinés.

## Mettre l'app en ligne (5 minutes, gratuit, sans rien installer)

La géolocalisation d'un iPhone ne fonctionne que sur une adresse **https**. Le plus simple :

1. Sur ton ordinateur, dézippe `runway.zip` : tu obtiens un dossier `runway`.
2. Va sur **https://app.netlify.com/drop** (crée un compte gratuit si demandé).
3. Glisse le dossier `runway` entier dans la zone de dépôt.
4. Netlify te donne une adresse du type `https://nom-au-hasard.netlify.app`. Tu peux la renommer dans *Site configuration › Change site name* (ex. `runway-lea`).

Pour mettre à jour : *Deploys › glisser à nouveau le dossier*.

Alternative : GitHub Pages (dépôt public, *Settings › Pages › Deploy from branch*).

## L'installer sur l'écran d'accueil de l'iPhone

1. Ouvre l'adresse Netlify dans **Safari** (pas Chrome : sur iPhone, l'installation passe par Safari).
2. Touche le bouton **Partager** (carré avec flèche).
3. **Sur l'écran d'accueil** › Ajouter.
4. Lance Runway depuis l'icône. Accepte la demande de position.

Si tu as refusé la position : *Réglages › Confidentialité et sécurité › Service de localisation › Sites Safari* (ou *Réglages › Safari › Position*), puis relance l'app.

## Ce qui fonctionne vraiment

| Fonction | Service utilisé | Clé ? |
|---|---|---|
| Carte (rues, chemins, noms) | Fond OpenStreetMap rendu par CARTO | non |
| Calcul d'itinéraire piéton | OSRM, profil *foot*, serveur FOSSGIS | non |
| Boucle à distance précise | Points de passage + recalcul itératif (± 3 %) | – |
| Dénivelé, pentes, profil | Open-Meteo Elevation (MNT Copernicus 90 m) | non |
| Éclairage, surface, escaliers, parcs, eau, feux, passages piétons | Overpass API (données OSM autour du tracé) | non |
| Recherche d'adresse | Photon (Komoot) | non |
| Instructions pas à pas | Calculées depuis les manœuvres du moteur + type de voie OSM | – |
| Course en direct, voix, chrono | GPS et synthèse vocale du téléphone | – |
| Favoris, historique, profil | Stockage local du téléphone | – |
| Export GPX | Généré dans l'app (feuille de partage iOS) | – |

## Comment Runway choisit les parcours

1. Il calcule 6 tracés réels dans 6 directions différentes. Pour chacun, il ajuste la taille de la boucle jusqu'à tomber à ± 3 % de ta distance (2 à 6 recalculs).
2. Il récupère l'altitude le long de chaque tracé et les attributs OSM des chemins empruntés.
3. Il garde le plus plat, le plus agréable et le plus tranquille, à condition qu'ils ne se recouvrent pas à plus de 65 %.
4. Le score sur 100 est une moyenne pondérée des critères que tu as cochés. Le détail (valeur, poids, mesure) est visible sous chaque proposition. Un critère sans donnée est marqué « non évalué » et sorti du calcul.

Un calcul prend environ 15 à 25 secondes : le serveur de routage gratuit impose au plus une requête par seconde.

## Limites à connaître

- **OSRM ne sait pas éviter les escaliers pendant le calcul.** Runway les détecte ensuite et pénalise les tracés qui en contiennent. Pour un vrai évitement, active openrouteservice (ci-dessous).
- **Éclairage et surface** dépendent de ce que les contributeurs OSM ont renseigné. Quand une info manque, l'app le dit (« inconnu », « déduit »).
- **Altitude** : modèle 90 m. Bon pour comparer des parcours, pas pour une petite rampe de 20 m.
- **Sécurité** : Runway compare des indicateurs (axes fréquentés, sentiers isolés non éclairés). Il ne garantit jamais qu'un parcours est sûr.
- **Horaires des parcs** : affichés quand ils sont dans OSM. Sinon, l'app te demande de vérifier sur place.
- **GPS écran verrouillé** : Safari coupe le GPS des web apps en arrière-plan. Runway garde l'écran allumé quand iOS l'autorise et signale toute interruption. Pour un suivi écran éteint, il faudrait une app native (étape suivante possible).

## Option : openrouteservice (meilleur filtrage)

openrouteservice sait, pendant le calcul : éviter les escaliers, favoriser la verdure (`green`) et le calme (`quiet`), et donne les instructions en français. Il demande une clé gratuite, qui ne doit jamais être dans le navigateur.

1. Crée une clé sur https://openrouteservice.org/dev/#/signup.
2. Crée un compte Cloudflare (gratuit) › *Workers & Pages* › *Create Worker*. Colle le contenu de `proxy/ors-worker.js` et déploie.
3. Dans le Worker › *Settings › Variables* : ajoute `ORS_KEY` (type **Secret**, ta clé) et `ALLOWED_ORIGIN` (ton adresse Netlify, ex. `https://runway-lea.netlify.app`).
4. Dans Runway › Profil › Moteur de calcul › *openrouteservice* : colle l'adresse du Worker (`https://….workers.dev`) puis *Enregistrer mon profil*.

## Structure du code

```
index.html          interface (vues : accueil, créer, propositions, détail, parcours, profil, course)
css/app.css         design, thèmes clair/sombre
js/app.js           interface et navigation
js/engine.js        génération des boucles, analyse dénivelé + OSM, score, instructions
js/api.js           appels aux services (routage, altitude, Overpass, adresses)
js/geo.js           calculs géographiques purs
js/mapview.js       carte Leaflet (tracé, flèches de sens, bornes km, virages)
js/run.js           course en direct (GPS, chrono, hors-parcours, voix)
js/store.js         stockage local
sw.js, manifest     PWA (installation, lancement hors ligne de l'interface)
proxy/              proxy openrouteservice (optionnel)
vendor/leaflet      Leaflet 1.9.4
```

Pas d'étape de compilation : les fichiers sont servis tels quels. C'est volontaire, pour que tu puisses déployer par simple glisser-déposer. Le code est découpé en modules : passer à React + TypeScript plus tard se fait sans toucher au moteur (`engine.js`, `api.js`, `geo.js`).

## Pistes pour la suite

- Partage par lien (nécessite un petit stockage serveur).
- App native (Capacitor) pour le suivi GPS écran verrouillé.
- Serveur GraphHopper perso avec un profil « genoux » (pénalité de pente sur mesure).

Données © contributeurs OpenStreetMap (ODbL). Altitude : Copernicus DEM via Open-Meteo. Fond de carte © CARTO.
