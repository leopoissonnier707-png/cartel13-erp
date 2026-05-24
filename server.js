const express = require('express');
const session = require('express-session');
const axios = require('axios');
const path = require('path');

const app = express();

// ── CONFIG ──────────────────────────────────────────────
const DISCORD_CLIENT_ID     = '1507502059971153970';
const DISCORD_CLIENT_SECRET = '7W8aPIoHKxE5DRTYTqPmQZuFXZW0dylu';
const REDIRECT_URI          = 'https://cartel13-erp.onrender.com/auth/discord/callback';
const SUPABASE_URL          = 'https://ndrhccebzzcomwikzrdo.supabase.co';
const SUPABASE_KEY          = 'sb_publishable_J3tPl-WoZrARPVZG1uw-PQ_AKUn5...'; // remplacé par env var
const OWNER_DISCORD_ID      = '1370496502425845856';

// ── SUPABASE HELPER ──────────────────────────────────────
async function supabase(method, table, data = null, filter = '') {
  const key = process.env.SUPABASE_KEY || SUPABASE_KEY;
  const url = `${SUPABASE_URL}/rest/v1/${table}${filter}`;
  const headers = {
    'apikey': key,
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
    'Prefer': method === 'POST' ? 'return=representation' : 'return=representation'
  };
  try {
    const res = await axios({ method, url, headers, data });
    return res.data;
  } catch(e) {
    console.error('Supabase error:', e.response?.data || e.message);
    return null;
  }
}

// ── MIDDLEWARE ───────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: 'cartel13-super-secret-key-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

// ── AUTH MIDDLEWARE ──────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session.user) return next();
  res.status(401).json({ error: 'Non connecté' });
}
function requireAdmin(req, res, next) {
  if (req.session.user && req.session.user.role === 'admin') return next();
  res.status(403).json({ error: 'Accès refusé' });
}

// ── DISCORD OAUTH ────────────────────────────────────────
app.get('/auth/discord', (req, res) => {
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'identify'
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

app.get('/auth/discord/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/?error=no_code');

  try {
    // Échange code contre token
    const tokenRes = await axios.post('https://discord.com/api/oauth2/token',
      new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const { access_token } = tokenRes.data;

    // Récupère infos utilisateur Discord
    const userRes = await axios.get('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${access_token}` }
    });
    const discordUser = userRes.data;
    const avatarUrl = discordUser.avatar
      ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`
      : `https://cdn.discordapp.com/embed/avatars/0.png`;

    // Vérifie si c'est le owner (admin permanent)
    if (discordUser.id === OWNER_DISCORD_ID) {
      // Upsert owner dans la DB
      const existing = await supabase('GET', 'members', null, `?discord_id=eq.${discordUser.id}`);
      if (!existing || existing.length === 0) {
        await supabase('POST', 'members', {
          discord_id: discordUser.id,
          username: discordUser.username,
          avatar: avatarUrl,
          role: 'admin',
          added_by: 'system'
        });
      } else {
        await supabase('PATCH', 'members', { username: discordUser.username, avatar: avatarUrl, role: 'admin' }, `?discord_id=eq.${discordUser.id}`);
      }
      req.session.user = { discord_id: discordUser.id, username: discordUser.username, avatar: avatarUrl, role: 'admin' };
      return res.redirect('/app');
    }

    // Vérifie si le membre est autorisé
    const members = await supabase('GET', 'members', null, `?discord_id=eq.${discordUser.id}`);
    if (!members || members.length === 0) {
      return res.redirect('/?error=not_authorized');
    }
    const member = members[0];
    if (member.banned) return res.redirect('/?error=banned');

    // Met à jour avatar/username
    await supabase('PATCH', 'members', { username: discordUser.username, avatar: avatarUrl }, `?discord_id=eq.${discordUser.id}`);

    req.session.user = {
      discord_id: discordUser.id,
      username: member.username || discordUser.username,
      avatar: avatarUrl,
      role: member.role || 'member'
    };
    res.redirect('/app');
  } catch (e) {
    console.error('Auth error:', e.response?.data || e.message);
    res.redirect('/?error=auth_failed');
  }
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json(req.session.user);
});

// ── MEMBERS API ──────────────────────────────────────────
app.get('/api/members', requireAdmin, async (req, res) => {
  const data = await supabase('GET', 'members', null, '?order=created_at.desc');
  res.json(data || []);
});

app.post('/api/members', requireAdmin, async (req, res) => {
  const { discord_id, role } = req.body;
  if (!discord_id) return res.status(400).json({ error: 'discord_id requis' });
  const existing = await supabase('GET', 'members', null, `?discord_id=eq.${discord_id}`);
  if (existing && existing.length > 0) return res.status(400).json({ error: 'Membre déjà existant' });
  const data = await supabase('POST', 'members', {
    discord_id,
    username: discord_id,
    avatar: `https://cdn.discordapp.com/embed/avatars/0.png`,
    role: role || 'member',
    added_by: req.session.user.username
  });
  await addLog(req.session.user.username, `Nouveau membre ajouté : ${discord_id}`, 'member', '👤');
  res.json(data);
});

app.patch('/api/members/:id', requireAdmin, async (req, res) => {
  const data = await supabase('PATCH', 'members', req.body, `?discord_id=eq.${req.params.id}`);
  await addLog(req.session.user.username, `Membre ${req.params.id} modifié`, 'member', '✏️');
  res.json(data);
});

app.delete('/api/members/:id', requireAdmin, async (req, res) => {
  await supabase('DELETE', 'members', null, `?discord_id=eq.${req.params.id}`);
  await addLog(req.session.user.username, `Membre ${req.params.id} supprimé`, 'member', '🗑');
  res.json({ ok: true });
});

// ── CATEGORIES API ───────────────────────────────────────
app.get('/api/categories', requireAuth, async (req, res) => {
  const data = await supabase('GET', 'categories', null, '?order=id.asc');
  res.json(data || []);
});

app.post('/api/categories', requireAdmin, async (req, res) => {
  const data = await supabase('POST', 'categories', req.body);
  await addLog(req.session.user.username, `Catégorie créée : ${req.body.name}`, 'admin', '📁');
  res.json(data);
});

app.delete('/api/categories/:id', requireAdmin, async (req, res) => {
  await supabase('DELETE', 'categories', null, `?id=eq.${req.params.id}`);
  res.json({ ok: true });
});

// ── PRODUCTS API ─────────────────────────────────────────
app.get('/api/products', requireAuth, async (req, res) => {
  const data = await supabase('GET', 'products', null, '?order=id.asc');
  res.json(data || []);
});

app.post('/api/products', requireAdmin, async (req, res) => {
  const data = await supabase('POST', 'products', req.body);
  await addLog(req.session.user.username, `Produit créé : ${req.body.name}`, 'admin', '🏪');
  res.json(data);
});

app.patch('/api/products/:id', requireAdmin, async (req, res) => {
  const data = await supabase('PATCH', 'products', req.body, `?id=eq.${req.params.id}`);
  res.json(data);
});

app.delete('/api/products/:id', requireAdmin, async (req, res) => {
  await supabase('DELETE', 'products', null, `?id=eq.${req.params.id}`);
  res.json({ ok: true });
});

// ── ORDERS API ───────────────────────────────────────────
app.get('/api/orders', requireAuth, async (req, res) => {
  const isAdmin = req.session.user.role === 'admin';
  const filter = isAdmin
    ? '?order=created_at.desc'
    : `?user_id=eq.${req.session.user.discord_id}&order=created_at.desc`;
  const data = await supabase('GET', 'orders', null, filter);
  res.json(data || []);
});

app.post('/api/orders', requireAuth, async (req, res) => {
  const body = { ...req.body, user_id: req.session.user.discord_id, status: 'pending' };
  const data = await supabase('POST', 'orders', body);
  await addLog(req.session.user.username, `Nouvelle commande ${body.order_id} — ${body.product_name}`, 'order', '🛒');
  res.json(data);
});

app.patch('/api/orders/:id', requireAdmin, async (req, res) => {
  const data = await supabase('PATCH', 'orders', req.body, `?order_id=eq.${req.params.id}`);
  await addLog(req.session.user.username, `Commande ${req.params.id} → ${req.body.status}`, 'order', '📋');
  res.json(data);
});

// ── LOGS API ─────────────────────────────────────────────
app.get('/api/logs', requireAdmin, async (req, res) => {
  const data = await supabase('GET', 'logs', null, '?order=created_at.desc&limit=200');
  res.json(data || []);
});

async function addLog(username, action, type, icon) {
  await supabase('POST', 'logs', { user_name: username, action, type, icon });
}

// ── SETTINGS API ─────────────────────────────────────────
app.get('/api/settings', requireAuth, async (req, res) => {
  const data = await supabase('GET', 'settings', null, '');
  const obj = {};
  (data || []).forEach(s => obj[s.key] = s.value);
  res.json(obj);
});

app.post('/api/settings', requireAdmin, async (req, res) => {
  const { key, value } = req.body;
  const existing = await supabase('GET', 'settings', null, `?key=eq.${key}`);
  if (existing && existing.length > 0) {
    await supabase('PATCH', 'settings', { value }, `?key=eq.${key}`);
  } else {
    await supabase('POST', 'settings', { key, value });
  }
  res.json({ ok: true });
});

// ── PAGES ────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/app', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Cartel 13 ERP sur le port ${PORT}`));
