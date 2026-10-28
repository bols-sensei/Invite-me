# Invitation & Access Control — MVP MVC

Application web de gestion d'événements, invitations, QR codes et contrôle d'accès.

## Stack
- Backend : Python, FastAPI, SQLAlchemy
- Architecture : MVC (models / views HTML / controllers), avec services métier séparés
- Frontend : HTML, CSS et JavaScript natifs
- Base de données par défaut : SQLite (simple pour démarrer; PostgreSQL recommandé en production)
- Import Excel/CSV : openpyxl / csv
- PDF de référence : ReportLab
- QR codes : qrcode

## Démarrage (Windows PowerShell)
```powershell
cd invitations_mvc
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
Copy-Item .env.example .env
uvicorn app.main:app --reload
```
Ouvrir http://127.0.0.1:8000. Documentation API : http://127.0.0.1:8000/docs

Au premier démarrage, un compte administrateur est créé à partir de `.env` :
- `ADMIN_USERNAME` (défaut `admin`)
- `ADMIN_PASSWORD` (défaut `ChangeMe-123!` — à changer immédiatement)

## Import Excel
La première feuille doit contenir une ligne d'en-tête. Colonnes reconnues (accents/casse tolérés) :
- `nom` ou `invite` (obligatoire)
- `type` (individuelle, couple, groupe; facultatif, déduit du quota)
- `nombre` ou `quota` ou `personnes` (obligatoire, entier >= 1)
- `table` (facultatif)

L'ordre des lignes est conservé. Une fois l'import confirmé, les références sont attribuées dans cet ordre (`INV-0001`, `INV-0002`...). Les références existantes ne sont pas renumérotées lors des ajouts ultérieurs.

## Exports pour le designer
Dans la page d'un événement, utiliser **Générer le dossier designer**. L'archive ZIP contient :
- `manifest_invitations.xlsx` : liste et références dans l'ordre de production
- `reference_invitations.pdf` : liste imprimable avec référence, invité, type, quota, table et QR correspondant
- `QR_CODES/INV-xxxx.png` : image PNG de chaque QR code
- `instructions_designer.txt`

Le QR code contient un jeton aléatoire opaque, pas le nom ou le quota. Le PDF/Excel sont les documents de correspondance. Le jeton est un identifiant de validation et ne remplace pas les contrôles serveur.

## Rôles MVP
- `admin` : créer les événements, importer les invités, créer les comptes agents/superviseurs, affecter les agents, générer les exports.
- `supervisor` : consulter les entrées et agents, vérifier les invitations, enregistrer des exceptions avec motif.
- `agent` : vérifier une invitation et enregistrer des entrées dans un quota autorisé.

## Format d'import exemple
Un fichier `examples/invites_exemple.csv` est fourni. Excel `.xlsx` et CSV sont pris en charge.

## Important avant production
Ce dépôt est un MVP fonctionnel de départ, pas un déploiement de production certifié. Avant un vrai événement :
1. Définir `SECRET_KEY` robuste et modifier le mot de passe admin.
2. Utiliser HTTPS, une base PostgreSQL et des sauvegardes.
3. Ajouter limitation de tentatives de connexion, politique de réinitialisation de mot de passe et tests de sécurité.
4. Le mode hors ligne multi-téléphones n'est pas implémenté ici : deux appareils déconnectés ne peuvent pas garantir la prévention immédiate des doublons.
5. Les exports contiennent des données personnelles; les transmettre uniquement au designer autorisé et les supprimer selon la politique de conservation.


## Sécurité et contrôle mobile (mise à jour)
- Jetons JWT Bearer disponibles via `POST /api/auth/token` avec JSON `{"username":"...","password":"..."}`. Les routes API acceptent JWT Bearer et la session web existante. Les nouveaux contrôles de supervision affichent l’activité des agents et la file d’exceptions.
- Validation des payloads par Pydantic v2.
- Hash des mots de passe via `pwdlib[argon2]` (Argon2id si la dépendance est installée).
- Scan QR avec `BarcodeDetector` natif lorsqu’il est disponible; caméra exige HTTPS ou localhost.
- Lecture NFC via Web NFC sur navigateurs/appareils compatibles, généralement Chrome Android; pas prise en charge universelle sur iPhone/desktop.
- Service worker pour mettre en cache les fichiers statiques et file d’attente IndexedDB pour les scans hors ligne. La synchronisation est idempotente et signale les conflits de quota.
- Supervision : tableau de bord existant, agents affectés, historique des passages, journal d’audit et endpoint de synchronisation des entrées différées.

### Limites importantes du mode hors ligne
Le cache ne permet pas de télécharger automatiquement une liste complète des invités ni de valider sûrement les quotas sans serveur. Un contrôle enregistré hors ligne reste **en attente**, et peut être rejeté ou signalé en conflit à la synchronisation. Deux téléphones déconnectés ne peuvent pas se coordonner pour empêcher instantanément qu’un même QR soit accepté deux fois. Pour une exploitation événementielle, précharger un manifeste signé sur chaque appareil, limiter les zones de contrôle par agent, puis synchroniser avec PostgreSQL et des transactions/contraintes atomiques. La concurrence de production doit être testée.

### Authentification JWT
```http
POST /api/auth/token
Content-Type: application/json

{"username":"admin","password":"votre-mot-de-passe"}
```
Utilisez `Authorization: Bearer <access_token>` pour les requêtes API. Réglez `JWT_SECRET_KEY`, `JWT_EXPIRE_MINUTES` et `SECRET_KEY` dans `.env`.

## Frontend (refonte mobile first)
Interface en HTML/CSS/JS natifs (modules ES), sans build. Thème clair/sombre, polices auto-hébergées, PWA installable.
- `app/views/` : `base.html` (coque), `dashboard.html` et `event.html` (étendent `base`), `login.html`.
- `app/static/js/` : `core.js` (API, composants), `home.js` (événements, équipe, profil), `event.js` (aperçu, invités, suivi, gestion), `scanner.js` (caméra, NFC, saisie, hors ligne), `offline.js` (file IndexedDB, cache), `vendor/jsqr.js` (lecteur QR de secours pour iPhone/Firefox).
- `app/static/sw.js` est servi à la racine par la route `/sw.js` (ajoutée dans `main.py`) pour que le mode hors ligne couvre `/` et `/event/...`.
- Onglets selon le rôle : agent (Aperçu, Scanner, Invités), superviseur (+ Suivi), administrateur (+ Gérer).

## QR codes indépendants par événement
- Contenu du QR : `IA1.<id_evenement>.<jeton>`. Le jeton reste aléatoire et unique ; l'identifiant d'événement le rattache à son événement (`app/services/qr.py`).
- Au contrôle (`/lookup`) et à la synchronisation (`/sync`), un QR d'un autre événement est refusé avec un message explicite (409 / `rejected`). L'interface le détecte aussi hors ligne.
- Dans le dossier designer, les images sont nommées `QR_CODES/E<id événement sur 3 chiffres>_INV-xxxx.png` : deux événements ne peuvent plus se mélanger. L'Excel, le PDF et les instructions indiquent le numéro d'événement.
- Compatibilité : les QR déjà imprimés (jeton seul) restent valides pour leur événement. Régénérer le dossier produit des images au nouveau format.
