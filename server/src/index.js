
import express from 'express';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import mime from 'mime-types';
import dotenv from 'dotenv';
import dayjs from 'dayjs';
import session from 'express-session';
import bcrypt from 'bcryptjs';
import { Telegraf } from 'telegraf';

dotenv.config();

const app = express();
const __dirname = path.resolve();
const DATA_DIR = path.join(__dirname, 'data');
const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const WEBHOOK_DISABLED = (process.env.WEBHOOK_DISABLED || 'true') === 'true';
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || '/api/telegram';
const BOT_TOKEN = process.env.BOT_TOKEN;
const SESSION_SECRET = process.env.SESSION_SECRET || 'change_this_secret';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin12345';

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax' }
}));

// CORS for dev
app.use((req, res, next) => {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,PUT,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Public static
app.use('/data', express.static(DATA_DIR, { fallthrough: true, index: false, maxAge: '1h' }));

// Users file
const USERS_FILE = path.join(__dirname, 'server', 'users.json');
function ensureUsersFile() {
  if (!fs.existsSync(USERS_FILE)) {
    const hash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
    fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true });
    fs.writeFileSync(USERS_FILE, JSON.stringify([{ username: ADMIN_USER, passhash: hash }], null, 2));
  }
}
ensureUsersFile();

function findUser(username) {
  try {
    const arr = JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
    return arr.find(u => u.username === username);
  } catch { return null; }
}

function requireAuth(req, res, next) {
  if (req.path.startsWith('/api/auth/') || req.path === '/api/health' || req.path === WEBHOOK_PATH) return next();
  if (req.path.startsWith('/api/') && !req.session?.user) return res.status(401).json({ error: 'unauthorized' });
  next();
}
app.use(requireAuth);

// Auth endpoints
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = findUser(username);
  if (!u || !bcrypt.compareSync(password || '', u.passhash)) return res.status(401).json({ error: 'invalid credentials' });
  req.session.user = { username };
  res.json({ ok: true, user: { username } });
});
app.post('/api/auth/logout', (req, res) => { req.session.destroy(()=> res.json({ ok: true })); });
app.get('/api/auth/me', (req, res) => { res.json({ user: req.session?.user || null }); });

// Upload config
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dest = path.join(DATA_DIR, req.query.path || 'uploads');
    fs.mkdirSync(dest, { recursive: true });
    cb(null, dest);
  },
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^\w\-.]+/g, '_');
    cb(null, `${Date.now()}_${safe}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 1024 * 1024 * 1024 * 2 } });

function safeJoin(base, target) {
  const p = path.normalize(path.join(base, target));
  if (!p.startsWith(base)) throw new Error('Invalid path');
  return p;
}
function listDir(target) {
  const items = fs.readdirSync(target, { withFileTypes: true });
  return items.map((d) => {
    const full = path.join(target, d.name);
    const stat = fs.statSync(full);
    return {
      name: d.name, isDir: d.isDirectory(), size: stat.size, mtime: stat.mtimeMs,
      url: d.isDirectory() ? null : full.replace(DATA_DIR, '/data').replace(/\\\\/g, '/'),
      mime: d.isDirectory() ? null : (mime.lookup(d.name) || 'application/octet-stream')
    };
  });
}

// API
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/files', (req, res) => {
  try {
    const qp = req.query.path || '/';
    const target = safeJoin(DATA_DIR, qp);
    if (!fs.existsSync(target)) return res.status(404).json({ error: 'Not found' });
    let items = listDir(target);
    const sort = req.query.sort || 'name';
    const dir = (req.query.dir || 'asc') === 'asc' ? 1 : -1;
    const cmp = (a,b) => (a<b?-1:a>b?1:0) * dir;
    items = items.sort((a,b)=>{
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      if (sort==='size') return (a.size - b.size) * dir;
      if (sort==='mtime') return (a.mtime - b.mtime) * dir;
      return cmp(a.name.toLowerCase(), b.name.toLowerCase());
    });
    const breadcrumb = path.normalize(qp).split(path.sep).filter(Boolean);
    res.json({ path: qp, breadcrumb, items });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/folder', (req, res) => {
  try {
    const { path: dirPath = '/', name } = req.body;
    if (!name) return res.status(400).json({ error: 'Missing name' });
    const target = safeJoin(DATA_DIR, path.join(dirPath, name));
    fs.mkdirSync(target, { recursive: true });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/upload', upload.array('files', 50), (req, res) => {
  res.json({ ok: true, files: (req.files || []).map(f => ({
    filename: f.filename, originalname: f.originalname,
    url: f.path.replace(DATA_DIR, '/data').replace(/\\\\/g, '/')
  }))});
});

app.delete('/api/files', (req, res) => {
  try {
    const qp = req.query.path;
    if (!qp) return res.status(400).json({ error: 'path required' });
    const target = safeJoin(DATA_DIR, qp);
    if (!fs.existsSync(target)) return res.status(404).json({ error: 'Not found' });
    const stat = fs.statSync(target);
    if (stat.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
    else fs.unlinkSync(target);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/rename', (req, res) => {
  try {
    const { from, to } = req.body;
    if (!from || !to) return res.status(400).json({ error: 'from/to required' });
    const src = safeJoin(DATA_DIR, from);
    const dst = safeJoin(DATA_DIR, to);
    fs.renameSync(src, dst);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/move', (req, res) => {
  try {
    const { path: p, targetDir } = req.body;
    if (!p || !targetDir) return res.status(400).json({ error: 'path/targetDir required' });
    const base = path.basename(p);
    const dstPath = path.join(targetDir, base);
    const src = safeJoin(DATA_DIR, p);
    const dst = safeJoin(DATA_DIR, dstPath);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.renameSync(src, dst);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Telegram
let bot;
if (BOT_TOKEN) {
  bot = new Telegraf(BOT_TOKEN);
  bot.start((ctx) => ctx.reply('Kirim file/foto/video/audio. Saya simpan dan balas linknya.'));
  async function saveStreamedFile(readable, destPath) {
    await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
    return new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(destPath);
      readable.pipe(ws);
      ws.on('finish', resolve); ws.on('error', reject);
    });
  }
  async function handleFile(ctx, fileId, originalNameSuggest) {
    const file = await ctx.telegram.getFile(fileId);
    const link = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    const ext = path.extname(file.file_path || '') || path.extname(originalNameSuggest || '');
    const dateDir = dayjs().format('YYYY-MM-DD');
    const baseDir = path.join(DATA_DIR, 'telegram', dateDir);
    const safeName = (originalNameSuggest || 'file').replace(/[^\w\-.]+/g,'_');
    const filename = `${Date.now()}_${safeName}${ext || ''}`;
    const destPath = path.join(baseDir, filename);
    const res = await fetch(link);
    if (!res.ok) throw new Error('Failed to download file');
    await saveStreamedFile(res.body, destPath);
    const publicUrl = destPath.replace(DATA_DIR, `${PUBLIC_BASE_URL}/data`).replace(/\\\\/g, '/');
    await ctx.reply(`Tersimpan: ${publicUrl}`);
  }
  bot.on('document', async (ctx) => { const d = ctx.message.document; await handleFile(ctx, d.file_id, d.file_name); });
  bot.on('photo', async (ctx) => { const ph = ctx.message.photo.at(-1); await handleFile(ctx, ph.file_id, 'photo.jpg'); });
  bot.on('video', async (ctx) => { const v = ctx.message.video; await handleFile(ctx, v.file_id, v.file_name || 'video.mp4'); });
  bot.on('audio', async (ctx) => { const a = ctx.message.audio; await handleFile(ctx, a.file_id, a.file_name || 'audio.mp3'); });
  if (WEBHOOK_DISABLED) { bot.launch().then(()=> console.log('Telegram bot: long polling')); }
  else {
    app.use(bot.webhookCallback(WEBHOOK_PATH));
    const webhookUrl = `${PUBLIC_BASE_URL}${WEBHOOK_PATH}`;
    bot.telegram.setWebhook(webhookUrl).then(()=> console.log('Webhook set', webhookUrl)).catch(console.error);
  }
} else { console.warn('BOT_TOKEN not set. Telegram bot disabled.'); }

// Serve built web if any
const webDist = path.join(__dirname, 'web', 'dist');
if (fs.existsSync(webDist)) {
  app.use('/', express.static(webDist));
  app.get('*', (req, res) => res.sendFile(path.join(webDist, 'index.html')));
}

app.listen(PORT, () => console.log(`http://localhost:${PORT}`));
