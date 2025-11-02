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

// --- Konfigurasi direktori dasar & env
const __dirname = path.resolve();              // menunjuk ke /project/server
const BASE_DIR = path.join(__dirname, '..');   // root proyek
dotenv.config({ path: path.join(BASE_DIR, '.env') });

// --- Inisialisasi variabel penting
const app = express();
const DATA_DIR = path.join(BASE_DIR, 'data');
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

// --- Session config (edit cookie bila lintas domain)
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax' }
}));

// --- CORS sederhana untuk dev
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,PUT,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// --- Public folder
app.use('/data', express.static(DATA_DIR, { fallthrough: true, index: false }));

// --- Users file fix
const USERS_FILE = path.join(__dirname, 'users.json');
function ensureUsersFile() {
  if (!fs.existsSync(USERS_FILE)) {
    const hash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
    fs.writeFileSync(USERS_FILE, JSON.stringify([{ username: ADMIN_USER, passhash: hash }], null, 2));
    console.log(`Created users.json with admin user '${ADMIN_USER}'`);
  }
}
ensureUsersFile();

function findUser(username) {
  try {
    const arr = JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
    return arr.find(u => u.username === username);
  } catch { return null; }
}

// --- Middleware auth
function requireAuth(req, res, next) {
  if (req.path.startsWith('/api/auth/') || req.path === WEBHOOK_PATH || req.path === '/api/health') return next();
  if (req.path.startsWith('/api/') && !req.session?.user)
    return res.status(401).json({ error: 'unauthorized' });
  next();
}
app.use(requireAuth);

// --- Auth endpoints
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = findUser(username);
  if (!u || !bcrypt.compareSync(password || '', u.passhash))
    return res.status(401).json({ error: 'invalid credentials' });
  req.session.user = { username };
  res.json({ ok: true, user: { username } });
});
app.post('/api/auth/guest', (req, res) => {
  req.session.regenerate(err => {
    if (err) {
      console.error('Failed to create guest session', err);
      return res.status(500).json({ error: 'guest session unavailable' });
    }
    const user = { username: 'tamu', role: 'guest' };
    req.session.user = user;
    res.json({ ok: true, user });
  });
});
app.post('/api/auth/logout', (req, res) => { req.session.destroy(() => res.json({ ok: true })); });
app.get('/api/auth/me', (req, res) => res.json({ user: req.session?.user || null }));

// --- Upload config
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
const upload = multer({ storage, limits: { fileSize: 2 * 1024 * 1024 * 1024 } });

function safeJoin(base, target) {
  const p = path.normalize(path.join(base, target));
  if (!p.startsWith(base)) throw new Error('Invalid path');
  return p;
}

// --- API file manager
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/files', (req, res) => {
  try {
    const qp = req.query.path || '/';
    const target = safeJoin(DATA_DIR, qp);
    if (!fs.existsSync(target)) return res.status(404).json({ error: 'Not found' });
    const items = fs.readdirSync(target, { withFileTypes: true }).map(d => {
      const full = path.join(target, d.name);
      const stat = fs.statSync(full);
      return {
        name: d.name, isDir: d.isDirectory(), size: stat.size, mtime: stat.mtimeMs,
        url: d.isDirectory() ? null : full.replace(DATA_DIR, '/data').replace(/\\/g, '/'),
        mime: d.isDirectory() ? null : (mime.lookup(d.name) || 'application/octet-stream')
      };
    });
    res.json({ path: qp, items });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/upload', upload.array('files', 50), (req, res) => {
  res.json({ ok: true, files: (req.files || []).map(f => ({
    filename: f.filename, originalname: f.originalname,
    url: f.path.replace(DATA_DIR, '/data').replace(/\\/g, '/')
  }))});
});

// --- Telegram bot
let bot;
if (BOT_TOKEN) {
  bot = new Telegraf(BOT_TOKEN);
  bot.start(ctx => ctx.reply('Kirim file, saya simpan dan kirim linknya.'));
  async function save(ctx, fileId, name) {
    const f = await ctx.telegram.getFile(fileId);
    const link = `https://api.telegram.org/file/bot${BOT_TOKEN}/${f.file_path}`;
    const dateDir = dayjs().format('YYYY-MM-DD');
    const destDir = path.join(DATA_DIR, 'telegram', dateDir);
    fs.mkdirSync(destDir, { recursive: true });
    const safe = name.replace(/[^\w\-.]+/g, '_');
    const dest = path.join(destDir, `${Date.now()}_${safe}`);
    const res = await fetch(link);
    const stream = fs.createWriteStream(dest);
    await new Promise((r) => { res.body.pipe(stream); stream.on('finish', r); });
    const url = dest.replace(DATA_DIR, `${PUBLIC_BASE_URL}/data`).replace(/\\/g, '/');
    ctx.reply(`Tersimpan: ${url}`);
  }
  bot.on('document', ctx => save(ctx, ctx.message.document.file_id, ctx.message.document.file_name));
  bot.on('photo', ctx => save(ctx, ctx.message.photo.at(-1).file_id, 'photo.jpg'));
  if (WEBHOOK_DISABLED) bot.launch(); else app.use(bot.webhookCallback(WEBHOOK_PATH));
} else console.warn('BOT_TOKEN not set, bot disabled.');

// --- Serve frontend (jika build)
const webDist = path.join(BASE_DIR, 'web', 'dist');
if (fs.existsSync(webDist)) {
  app.use('/', express.static(webDist));
  app.get('*', (req, res) => res.sendFile(path.join(webDist, 'index.html')));
}

app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
