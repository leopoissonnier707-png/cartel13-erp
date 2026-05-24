const express = require('express');
const session = require('express-session');
const axios = require('axios');
const path = require('path');

const app = express();

// ── CONFIG ─────────────────────────────────────────────
const DISCORD_CLIENT_ID     = process.env.DISCORD_CLIENT_ID     || '1507502059971153970';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '7W8aPIoHKxE5DRTYTqPmQZuFXZW0dylu';
const REDIRECT_URI          = process.env.REDIRECT_URI          || 'https://cartel13-erp.onrender.com/auth/discord/callback';
const SUPABASE_URL          = process.env.SUPABASE_URL          || 'https://ndrhccebzzcomwikzrdo.supabase.co';
const SUPABASE_KEY          = process.env.SUPABASE_KEY          || '';
const DISCORD_WEBHOOK       = process.env.DISCORD_WEBHOOK       || '';
const OWNER_ID              = '1370496502425845856';

// ── SUPABASE ────────────────────────────────────────────
async function sb(method, table, data, filter = '') {
  const url = `${SUPABASE_URL}/rest/v1/${table}${filter}`;
  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
  };
  try {
    const res = await axios({ method, url, headers, data });
    return res.data;
  } catch(e) {
    console.error(`[Supabase] ${method} ${table}:`, e.response?.data || e.message);
    return null;
  }
}

// ── DISCORD WEBHOOK ────────────────────────────────────
async function sendWebhook(embed) {
  if (!DISCORD_WEBHOOK) return;
  try {
    await axios.post(DISCORD_WEBHOOK, { embeds: [embed] });
  } catch(e) {
    console.error('[Webhook]', e.message);
  }
}

// ── MIDDLEWARE ─────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'cartel13-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

// ── AUTH GUARDS ────────────────────────────────────────
function auth(req, res, next) {
  if (req.session.user) return next();
  res.status(401).json({ error: 'Non connecté' });
}
function admin(req, res, next) {
  if (req.session.user?.role === 'admin') return next();
  res.status(403).json({ error: 'Accès refusé' });
}

// ── DISCORD OAUTH ──────────────────────────────────────
app.get('/auth/discord', (req, res) => {
  const p = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'identify'
  });
  res.redirect(`https://discord.com/oauth2/authorize?${p}`);
});

app.get('/auth/discord/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/?error=no_code');
  try {
    // Échange le code
    const tokenRes = await axios.post(
      'https://discord.com/api/oauth2/token',
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

    // Récupère le profil Discord
    const userRes = await axios.get('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${access_token}` }
    });
    const du = userRes.data;
    const avatar = du.avatar
      ? `https://cdn.discordapp.com/avatars/${du.id}/${du.avatar}.png`
      : `https://cdn.discordapp.com/embed/avatars/${parseInt(du.id) % 5}.png`;

    // Owner → toujours admin
    if (du.id === OWNER_ID) {
      const existing = await sb('GET', 'members', null, `?discord_id=eq.${du.id}`);
      if (!existing || existing.length === 0) {
        await sb('POST', 'members', { discord_id: du.id, username: du.username, avatar, role: 'admin', added_by: 'system' });
      } else {
        await sb('PATCH', 'members', { username: du.username, avatar, role: 'admin' }, `?discord_id=eq.${du.id}`);
      }
      req.session.user = { discord_id: du.id, username: du.username, avatar, role: 'admin' };
      return res.redirect('/app');
    }

    // Vérifie si autorisé
    const rows = await sb('GET', 'members', null, `?discord_id=eq.${du.id}`);
    if (!rows || rows.length === 0) return res.redirect('/?error=not_authorized');
    const member = rows[0];
    if (member.banned) return res.redirect('/?error=banned');

    // Met à jour avatar
    await sb('PATCH', 'members', { username: du.username, avatar }, `?discord_id=eq.${du.id}`);

    req.session.user = { discord_id: du.id, username: du.username, avatar, role: member.role || 'member' };
    res.redirect('/app');
  } catch(e) {
    console.error('[Auth]', e.response?.data || e.message);
    res.redirect('/?error=auth_failed');
  }
});

app.get('/auth/logout', (req, res) => { req.session.destroy(); res.redirect('/'); });
app.get('/api/me', auth, (req, res) => res.json(req.session.user));

// ── MEMBERS ────────────────────────────────────────────
app.get('/api/members', admin, async (req, res) => {
  const data = await sb('GET', 'members', null, '?order=created_at.desc');
  res.json(data || []);
});

app.post('/api/members', admin, async (req, res) => {
  const { discord_id, role } = req.body;
  if (!discord_id) return res.status(400).json({ error: 'discord_id requis' });
  const existing = await sb('GET', 'members', null, `?discord_id=eq.${discord_id}`);
  if (existing && existing.length > 0) return res.status(400).json({ error: 'Déjà existant' });
  const data = await sb('POST', 'members', {
    discord_id, username: discord_id,
    avatar: `https://cdn.discordapp.com/embed/avatars/0.png`,
    role: role || 'member', added_by: req.session.user.username
  });
  await sb('POST', 'logs', { user_name: req.session.user.username, action: `Membre ajouté : ${discord_id}`, type: 'member', icon: '👤' });
  res.json(data);
});

app.patch('/api/members/:id', admin, async (req, res) => {
  const data = await sb('PATCH', 'members', req.body, `?discord_id=eq.${req.params.id}`);
  await sb('POST', 'logs', { user_name: req.session.user.username, action: `Membre ${req.params.id} modifié`, type: 'member', icon: '✏️' });
  res.json(data || { ok: true });
});

app.delete('/api/members/:id', admin, async (req, res) => {
  await sb('DELETE', 'members', null, `?discord_id=eq.${req.params.id}`);
  await sb('POST', 'logs', { user_name: req.session.user.username, action: `Membre supprimé : ${req.params.id}`, type: 'member', icon: '🗑' });
  res.json({ ok: true });
});

// ── CATEGORIES ─────────────────────────────────────────
app.get('/api/categories', auth, async (req, res) => {
  const data = await sb('GET', 'categories', null, '?order=id.asc');
  res.json(data || []);
});

app.post('/api/categories', admin, async (req, res) => {
  const data = await sb('POST', 'categories', req.body);
  await sb('POST', 'logs', { user_name: req.session.user.username, action: `Catégorie créée : ${req.body.name}`, type: 'admin', icon: '📁' });
  res.json(data || { ok: true });
});

app.delete('/api/categories/:id', admin, async (req, res) => {
  await sb('DELETE', 'categories', null, `?id=eq.${req.params.id}`);
  res.json({ ok: true });
});

// ── PRODUCTS ───────────────────────────────────────────
app.get('/api/products', auth, async (req, res) => {
  const data = await sb('GET', 'products', null, '?order=id.asc');
  res.json(data || []);
});

app.post('/api/products', admin, async (req, res) => {
  const data = await sb('POST', 'products', req.body);
  await sb('POST', 'logs', { user_name: req.session.user.username, action: `Produit créé : ${req.body.name}`, type: 'admin', icon: '🏪' });
  res.json(data || { ok: true });
});

app.patch('/api/products/:id', admin, async (req, res) => {
  const data = await sb('PATCH', 'products', req.body, `?id=eq.${req.params.id}`);
  await sb('POST', 'logs', { user_name: req.session.user.username, action: `Produit modifié : ${req.params.id}`, type: 'admin', icon: '✏️' });
  res.json(data || { ok: true });
});

app.delete('/api/products/:id', admin, async (req, res) => {
  await sb('DELETE', 'products', null, `?id=eq.${req.params.id}`);
  res.json({ ok: true });
});

// ── ORDERS ─────────────────────────────────────────────
app.get('/api/orders', auth, async (req, res) => {
  const isAdmin = req.session.user.role === 'admin';
  const filter = isAdmin
    ? '?order=created_at.desc'
    : `?user_id=eq.${req.session.user.discord_id}&order=created_at.desc`;
  const data = await sb('GET', 'orders', null, filter);
  res.json(data || []);
});

app.post('/api/orders', auth, async (req, res) => {
  const body = { ...req.body, user_id: req.session.user.discord_id, status: 'pending' };
  const data = await sb('POST', 'orders', body);
  await sb('POST', 'logs', { user_name: req.session.user.username, action: `Nouvelle commande ${body.order_id} — ${body.product_name}`, type: 'order', icon: '🛒' });

  // Webhook Discord
  await sendWebhook({
    title: `🛒 Nouvelle commande — ${body.order_id}`,
    color: 0xc0392b,
    fields: [
      { name: '👤 Client RP', value: body.rp_name, inline: true },
      { name: '👥 Groupe', value: body.rp_group, inline: true },
      { name: '📞 Téléphone RP', value: body.phone, inline: true },
      { name: '📦 Produit', value: `${body.product_name} ×${body.quantity}`, inline: true },
      { name: '💰 Total', value: `${Number(body.total).toLocaleString('fr-FR')} $ (${body.currency === 'dirty' ? 'sale' : 'propre'})`, inline: true },
      { name: '📝 Note', value: body.note || 'Aucune', inline: false },
    ],
    footer: { text: `Discord: ${req.session.user.username} | Cartel 13 ERP` },
    timestamp: new Date().toISOString()
  });

  res.json(data || { ok: true });
});

app.patch('/api/orders/:id', admin, async (req, res) => {
  const data = await sb('PATCH', 'orders', req.body, `?order_id=eq.${req.params.id}`);

  // Webhook selon statut
  if (req.body.status === 'accepted') {
    await sendWebhook({
      title: `✅ Commande acceptée — ${req.params.id}`,
      color: 0x27ae60,
      description: `Prise en charge par **${req.session.user.username}**\nLe client sera contacté sur son téléphone RP.`,
      timestamp: new Date().toISOString()
    });
  } else if (req.body.status === 'delivered') {
    await sendWebhook({
      title: `📦 Commande livrée — ${req.params.id}`,
      color: 0x2980b9,
      description: `Livrée par **${req.session.user.username}**`,
      timestamp: new Date().toISOString()
    });
  } else if (req.body.status === 'refused') {
    await sendWebhook({
      title: `❌ Commande refusée — ${req.params.id}`,
      color: 0x7f8c8d,
      timestamp: new Date().toISOString()
    });
  }

  await sb('POST', 'logs', { user_name: req.session.user.username, action: `Commande ${req.params.id} → ${req.body.status}`, type: 'order', icon: '📋' });
  res.json(data || { ok: true });
});

// ── LOGS ───────────────────────────────────────────────
app.get('/api/logs', admin, async (req, res) => {
  const data = await sb('GET', 'logs', null, '?order=created_at.desc&limit=300');
  res.json(data || []);
});

// ── SETTINGS ───────────────────────────────────────────
app.get('/api/settings', auth, async (req, res) => {
  const data = await sb('GET', 'settings', null, '');
  const obj = {};
  (data || []).forEach(s => obj[s.key] = s.value);
  res.json(obj);
});

app.post('/api/settings', admin, async (req, res) => {
  const { key, value } = req.body;
  const existing = await sb('GET', 'settings', null, `?key=eq.${encodeURIComponent(key)}`);
  if (existing && existing.length > 0) {
    await sb('PATCH', 'settings', { value }, `?key=eq.${encodeURIComponent(key)}`);
  } else {
    await sb('POST', 'settings', { key, value });
  }
  await sb('POST', 'logs', { user_name: req.session.user.username, action: `Paramètre modifié : ${key}`, type: 'admin', icon: '⚙️' });
  res.json({ ok: true });
});

// ── PAGES ──────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/app', (req, res) => {
  if (!req.session.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Cartel 13 ERP démarré sur le port ${PORT}`));
