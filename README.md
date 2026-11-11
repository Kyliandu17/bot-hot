# Bot Host

Panel pour héberger tes bots Discord : envoi (.js ou .zip), démarrage/arrêt, variables d'environnement (TOKEN…), logs en direct.

## Déploiement sur Render (gratuit)
1. Mets ce dossier sur GitHub.
2. Render → New → Web Service → ton dépôt.
3. Build : `npm install` — Start : `npm start`.
4. Variable d'environnement : `ADMIN_PASSWORD` = ton mot de passe.
5. Ouvre l'URL du service et connecte-toi.

## Limites du plan gratuit
- Le service s'endort après ~15 min sans visite : les bots se coupent.
  Solution : un ping toutes les 5 min sur `https://TON-URL/health` (ex. UptimeRobot).
- Pas de disque persistant : les bots envoyés sont perdus à chaque redéploiement/redémarrage de Render. Garde tes fichiers pour les renvoyer, ou ajoute un disque payant (`DATA_DIR`).

## Utilisation
- Un `.js` seul devient `index.js`. Un `.zip` est extrait (avec `package.json`, `npm install` est lancé automatiquement).
- Mets `TOKEN=xxxx` dans Variables, et lis-le avec `process.env.TOKEN` dans ton bot.
