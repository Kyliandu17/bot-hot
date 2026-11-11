const express = require('express');
const multer = require('multer');
const AdmZip = require('adm-zip');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.ADMIN_PASSWORD;
if (!PASSWORD) { console.error('Variable ADMIN_PASSWORD manquante.'); process.exit(1); }

const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const BOTS = path.join(DATA, 'bots');
const DB = path.join(DATA, 'bots.json');
fs.mkdirSync(BOTS, { recursive: true });

let db = fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB, 'utf8')) : {};
const save = () => fs.writeFileSync(DB, JSON.stringify(db, null, 2));
const procs = {};   // id -> processus enfant
const logs = {};    // id -> dernières lignes
const tokens = new Set();

function log(id, text) {
  const arr = (logs[id] = logs[id] || []);
  String(text).split('\n').forEach(l => { if (l.trim()) arr.push(`[${new Date().toLocaleTimeString('fr-FR')}] ${l}`); });
  if (arr.length > 500) arr.splice(0, arr.length - 500);
}
const botDir = id => path.join(BOTS, id);
const parseEnv = txt => Object.fromEntries(String(txt || '').split('\n')
  .map(l => l.trim()).filter(l => l && !l.startsWith('#') && l.includes('='))
  .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));

function run(id, cmd, args, env, onExit) {
  const p = spawn(cmd, args, { cwd: botDir(id), env: { ...process.env, ...env } });
  p.stdout.on('data', d => log(id, d));
  p.stderr.on('data', d => log(id, d));
  p.on('error', e => log(id, 'Erreur : ' + e.message));
  p.on('exit', onExit);
  return p;
}

function startBot(id) {
  const bot = db[id];
  if (!bot || procs[id]) return;
  const dir = botDir(id);
  const env = parseEnv(bot.env);
  bot.autostart = true; save();
  const launch = () => {
    log(id, `Démarrage de ${bot.entry}…`);
    const p = run(id, process.execPath, [bot.entry], env, (code) => {
      log(id, `Processus arrêté (code ${code}).`);
      delete procs[id];
    });
    procs[id] = p;
  };
  procs[id] = { installing: true, kill() { this.cancel = true; } };
  if (fs.existsSync(path.join(dir, 'package.json')) && !fs.existsSync(path.join(dir, 'node_modules'))) {
    log(id, 'Installation des dépendances (npm install)…');
    const placeholder = procs[id];
    run(id, 'npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {}, (code) => {
      if (placeholder.cancel) { delete procs[id]; return; }
      if (code !== 0) { log(id, 'npm install a échoué.'); delete procs[id]; return; }
      delete procs[id]; launch();
    });
  } else { delete procs[id]; launch(); }
}

function stopBot(id, keepAuto) {
  const bot = db[id];
  if (bot && !keepAuto) { bot.autostart = false; save(); }
  const p = procs[id];
  if (p) { p.kill(); log(id, 'Arrêt demandé.'); }
}

function extract(buf, name, id) {
  const dir = botDir(id);
  fs.mkdirSync(dir, { recursive: true });
  if (!/\.zip$/i.test(name)) { fs.writeFileSync(path.join(dir, 'index.js'), buf); return; }
  const entries = new AdmZip(buf).getEntries().filter(e => !e.isDirectory);
  const tops = new Set(entries.map(e => e.entryName.split('/')[0]));
  const strip = tops.size === 1 && entries.every(e => e.entryName.includes('/'));
  for (const e of entries) {
    const rel = strip ? e.entryName.split('/').slice(1).join('/') : e.entryName;
    const dest = path.resolve(dir, rel);
    if (!dest.startsWith(path.resolve(dir) + path.sep)) continue; // anti zip-slip
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, e.getData());
  }
}

const view = id => ({ id, name: db[id].name, entry: db[id].entry, env: db[id].env || '', running: !!procs[id] });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_, res) => res.send('ok'));

app.post('/api/login', (req, res) => {
  const a = crypto.createHash('sha256').update(String(req.body.password || '')).digest();
  const b = crypto.createHash('sha256').update(PASSWORD).digest();
  if (!crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Mot de passe incorrect.' });
  const t = crypto.randomBytes(24).toString('hex');
  tokens.add(t);
  res.json({ token: t });
});

app.use('/api', (req, res, next) => {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  if (!tokens.has(t)) return res.status(401).json({ error: 'Non connecté.' });
  next();
});

const exists = (req, res, next) => db[req.params.id] ? next() : res.status(404).json({ error: 'Bot introuvable.' });

app.get('/api/bots', (_, res) => res.json(Object.keys(db).map(view)));

app.post('/api/bots', upload.single('file'), (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 40);
  if (!name || !req.file) return res.status(400).json({ error: 'Nom et fichier (.js ou .zip) requis.' });
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + crypto.randomBytes(3).toString('hex');
  try { extract(req.file.buffer, req.file.originalname, id); }
  catch (e) { return res.status(400).json({ error: 'Fichier invalide : ' + e.message }); }
  db[id] = { name, entry: 'index.js', env: '', autostart: false };
  save();
  res.json(view(id));
});

app.post('/api/bots/:id/files', exists, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Fichier requis.' });
  try { extract(req.file.buffer, req.file.originalname, req.params.id); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  log(req.params.id, 'Fichiers mis à jour. Redémarre le bot pour appliquer.');
  res.json(view(req.params.id));
});

app.put('/api/bots/:id/env', exists, (req, res) => {
  db[req.params.id].env = String(req.body.env || '');
  const e = String(req.body.entry || '').trim();
  if (e && !e.includes('..') && !path.isAbsolute(e)) db[req.params.id].entry = e;
  save();
  res.json(view(req.params.id));
});

app.post('/api/bots/:id/start', exists, (req, res) => { startBot(req.params.id); res.json(view(req.params.id)); });
app.post('/api/bots/:id/stop', exists, (req, res) => { stopBot(req.params.id); res.json(view(req.params.id)); });
app.post('/api/bots/:id/restart', exists, (req, res) => {
  const id = req.params.id;
  stopBot(id, true);
  setTimeout(() => startBot(id), 1500);
  res.json(view(id));
});
app.delete('/api/bots/:id', exists, (req, res) => {
  const id = req.params.id;
  stopBot(id);
  setTimeout(() => fs.rmSync(botDir(id), { recursive: true, force: true }), 1000);
  delete db[id]; delete logs[id]; save();
  res.json({ ok: true });
});
app.get('/api/bots/:id/logs', exists, (req, res) => res.json({ running: !!procs[req.params.id], logs: logs[req.params.id] || [] }));

app.listen(PORT, () => {
  console.log('Panel prêt sur le port ' + PORT);
  Object.keys(db).forEach(id => { if (db[id].autostart) startBot(id); });
});
process.on('SIGTERM', () => { Object.keys(procs).forEach(id => stopBot(id, true)); process.exit(0); });
