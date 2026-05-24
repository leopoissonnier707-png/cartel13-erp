const express = require('express');
const session = require('express-session');
const axios = require('axios');
const path = require('path');

const app = express();

const DISCORD_CLIENT_ID     = process.env.DISCORD_CLIENT_ID     || '1507502059971153970';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '7W8aPIoHKxE5DRTYTqPmQZuFXZW0dylu';
const REDIRECT_URI          = process.env.REDIRECT_URI          || 'https://cartel13-erp.onrender.com/auth/discord/callback';
const SUPABASE_URL          = process.env.SUPABASE_URL          || 'https://ndrhccebzzcomwikzrdo.supabase.co';
const SUPABASE_KEY          = process.env.SUPABASE_KEY          || '';
const DISCORD_WEBHOOK       = process.env.DISCORD_WEBHOOK       || 'https://discord.com/api/webhooks/1508029444302831791/RyCpp9C7fbHiuY9ut0n6EoRyJUuEVQyKZD9ylu4vg3jib8pK-V3-i4bYgIRBVn2mUS18';

const CARTEL_ROLE_ID        = process.env.CARTEL_ROLE_ID        || '1508107733600047115';
const GUILD_ID              = process.env.GUILD_ID              || '1487519238267600919';
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

async function log(username, action, type, icon) {
  await sb('POST', 'logs', { user_name: username, action, type, icon });
}

// ── DISCORD BOT DM ─────────────────────────────────────
async function sendDM(userId, content) {
  try {
    // Crée le canal DM
    const dmRes = await axios.post(
      'https://discord.com/api/v10/users/@me/channels',
      { recipient_id: userId },
      { headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    const channelId = dmRes.data.id;
    // Envoie le message
    await axios.post(
      `https://discord.com/api/v10/channels/${channelId}/messages`,
      { content },
      { headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    console.log(`[DM] Envoyé à ${userId}`);
  } catch(e) {
    console.error('[DM Error]', e.response?.data || e.message);
  }
}

// ── DISCORD WEBHOOK ────────────────────────────────────
async function sendWebhook(content, embed) {
  if (!DISCORD_WEBHOOK) return;
  try {
    const payload = {};
    if (content) payload.content = content;
    if (embed) payload.embeds = [embed];
    await axios.post(DISCORD_WEBHOOK, payload);
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

function auth(req, res, next) {
  if (req.session.user) return next();
  res.status(401).json({ error: 'Non connecté' });
}
function staffOrAdmin(req, res, next) {
  if (['admin','staff'].includes(req.session.user?.role)) return next();
  res.status(403).json({ error: 'Accès refusé' });
}
function adminOnly(req, res, next) {
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
    const tokenRes = await axios.post(
      'https://discord.com/api/oauth2/token',
      new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code, redirect_uri: REDIRECT_URI
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const { access_token } = tokenRes.data;
    const userRes = await axios.get('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${access_token}` }
    });
    const du = userRes.data;
    const avatar = du.avatar
      ? `https://cdn.discordapp.com/avatars/${du.id}/${du.avatar}.png`
      : `https://cdn.discordapp.com/embed/avatars/0.png`;

    const rows = await sb('GET', 'members', null, `?discord_id=eq.${du.id}`);

    if (!rows || rows.length === 0) {
      const role = du.id === OWNER_ID ? 'admin' : 'member';
      await sb('POST', 'members', {
        discord_id: du.id, username: du.username,
        avatar, role, added_by: 'auto', banned: false
      });
      req.session.user = { discord_id: du.id, username: du.username, avatar, role };
    } else {
      const member = rows[0];
      if (member.banned) return res.redirect('/?error=banned');
      const role = du.id === OWNER_ID ? 'admin' : member.role;
      await sb('PATCH', 'members', { username: du.username, avatar }, `?discord_id=eq.${du.id}`);
      req.session.user = { discord_id: du.id, username: du.username, avatar, role };
    }

    res.redirect('/app');
  } catch(e) {
    console.error('[Auth]', e.response?.data || e.message);
    res.redirect('/?error=auth_failed');
  }
});

app.get('/auth/logout', (req, res) => { req.session.destroy(); res.redirect('/'); });
app.get('/api/me', auth, (req, res) => res.json(req.session.user));

// ── MEMBERS ────────────────────────────────────────────
app.get('/api/members', staffOrAdmin, async (req, res) => {
  res.json(await sb('GET', 'members', null, '?order=created_at.desc') || []);
});

app.post('/api/members', adminOnly, async (req, res) => {
  const { discord_id, role } = req.body;
  if (!discord_id) return res.status(400).json({ error: 'discord_id requis' });
  const existing = await sb('GET', 'members', null, `?discord_id=eq.${discord_id}`);
  if (existing && existing.length > 0) {
    const data = await sb('PATCH', 'members', { role: role || 'admin' }, `?discord_id=eq.${discord_id}`);
    await log(req.session.user.username, `Rôle de ${discord_id} → ${role}`, 'member', '⭐');
    return res.json(data || { ok: true });
  }
  const data = await sb('POST', 'members', {
    discord_id, username: discord_id,
    avatar: `https://cdn.discordapp.com/embed/avatars/0.png`,
    role: role || 'admin', added_by: req.session.user.username, banned: false
  });
  await log(req.session.user.username, `Membre ajouté : ${discord_id} (${role})`, 'member', '👤');
  res.json(data || { ok: true });
});

app.patch('/api/members/:id', adminOnly, async (req, res) => {
  const data = await sb('PATCH', 'members', req.body, `?discord_id=eq.${req.params.id}`);
  await log(req.session.user.username, `Membre ${req.params.id} modifié`, 'member', '✏️');
  res.json(data || { ok: true });
});

app.delete('/api/members/:id', adminOnly, async (req, res) => {
  await sb('DELETE', 'members', null, `?discord_id=eq.${req.params.id}`);
  await log(req.session.user.username, `Membre supprimé : ${req.params.id}`, 'member', '🗑');
  res.json({ ok: true });
});

// ── CATEGORIES ─────────────────────────────────────────
app.get('/api/categories', auth, async (req, res) => {
  res.json(await sb('GET', 'categories', null, '?order=id.asc') || []);
});
app.post('/api/categories', adminOnly, async (req, res) => {
  const data = await sb('POST', 'categories', req.body);
  await log(req.session.user.username, `Catégorie créée : ${req.body.name}`, 'admin', '📁');
  res.json(data || { ok: true });
});
app.delete('/api/categories/:id', adminOnly, async (req, res) => {
  await sb('DELETE', 'categories', null, `?id=eq.${req.params.id}`);
  res.json({ ok: true });
});

// ── PRODUCTS ───────────────────────────────────────────
app.get('/api/products', auth, async (req, res) => {
  res.json(await sb('GET', 'products', null, '?order=id.asc') || []);
});
app.post('/api/products', adminOnly, async (req, res) => {
  const data = await sb('POST', 'products', req.body);
  await log(req.session.user.username, `Produit créé : ${req.body.name}`, 'admin', '🏪');
  res.json(data || { ok: true });
});
app.patch('/api/products/:id', adminOnly, async (req, res) => {
  const data = await sb('PATCH', 'products', req.body, `?id=eq.${req.params.id}`);
  res.json(data || { ok: true });
});
app.delete('/api/products/:id', adminOnly, async (req, res) => {
  await sb('DELETE', 'products', null, `?id=eq.${req.params.id}`);
  res.json({ ok: true });
});

// ── ORDERS ─────────────────────────────────────────────
app.get('/api/orders', auth, async (req, res) => {
  const isStaff = ['admin','staff'].includes(req.session.user.role);
  const filter = isStaff
    ? '?order=created_at.desc'
    : `?user_id=eq.${req.session.user.discord_id}&order=created_at.desc`;
  res.json(await sb('GET', 'orders', null, filter) || []);
});

app.post('/api/orders', auth, async (req, res) => {
  const body = { ...req.body, user_id: req.session.user.discord_id, status: 'pending' };
  const data = await sb('POST', 'orders', body);
  await log(req.session.user.username, `Nouvelle commande ${body.order_id} — ${body.product_name}`, 'order', '🛒');

  // MP au client
  await sendDM(req.session.user.discord_id,
    `🛒 **Cartel 13 — Commande reçue !**\n\n` +
    `Salut **${req.session.user.username}** ! Ta commande a bien été transmise au Cartel 13. ✅\n\n` +
    `> 🆔 Référence : **${body.order_id}**\n` +
    `> 📦 Produit : **${body.product_name}** ×${body.quantity}\n` +
    `> 💰 Total : **${Number(body.total).toLocaleString('fr-FR')} $** (${body.currency === 'dirty' ? 'argent sale' : 'argent propre'})\n\n` +
    `Un membre du Cartel reviendra vers toi très prochainement. 🤝`
  );

  // Webhook avec ping du rôle
  await sendWebhook(
    `<@&${CARTEL_ROLE_ID}> 🚨 Nouvelle commande !`,
    {
      title: `🛒 Commande — ${body.order_id}`,
      color: 0xc0392b,
      fields: [
        { name: '👤 Prénom RP', value: body.rp_name, inline: true },
        { name: '👥 Groupe', value: body.rp_group, inline: true },
        { name: '📞 Téléphone RP', value: body.phone, inline: true },
        { name: '📦 Produit', value: `${body.product_name} ×${body.quantity}`, inline: true },
        { name: '💰 Total', value: `${Number(body.total).toLocaleString('fr-FR')} $ (${body.currency === 'dirty' ? '💰 sale' : '💵 propre'})`, inline: true },
        { name: '📝 Note', value: body.note || 'Aucune', inline: false },
      ],
      footer: { text: `Discord : ${req.session.user.username} | Cartel 13 ERP` },
      timestamp: new Date().toISOString()
    }
  );

  res.json(data || { ok: true });
});

app.patch('/api/orders/:id', staffOrAdmin, async (req, res) => {
  const { status, rating } = req.body;
  const data = await sb('PATCH', 'orders', req.body, `?order_id=eq.${req.params.id}`);

  // Récupère la commande
  const orders = await sb('GET', 'orders', null, `?order_id=eq.${req.params.id}`);
  const order = orders?.[0];

  if (status === 'accepted' && order) {
    await sendDM(order.user_id,
      `✅ **Cartel 13 — Commande acceptée !**\n\n` +
      `Salut **${order.username}** ! Ta commande **${req.params.id}** a été prise en charge par **${req.session.user.username}**. 💼\n\n` +
      `> 📞 Tu seras contacté sur ton téléphone RP : **${order.phone}**\n` +
      `> 💬 Tu peux aussi ouvrir un ticket sur notre serveur Discord.\n\n` +
      `Prépare-toi, la livraison arrive bientôt ! 🚗`
    );
    await sendWebhook(null, {
      title: `✅ Commande acceptée — ${req.params.id}`,
      color: 0x27ae60,
      description: `Prise en charge par **${req.session.user.username}**\nClient RP : **${order.rp_name}**`,
      timestamp: new Date().toISOString()
    });
  }

  if (status === 'delivered' && order) {
    await sendDM(order.user_id,
      `📦 **Cartel 13 — Commande livrée !**\n\n` +
      `Salut **${order.username}** ! Ta commande **${req.params.id}** a été livrée avec succès par **${req.session.user.username}**. 🎉\n\n` +
      `Merci de ta confiance envers le Cartel 13 ! 🙏\n\n` +
      `> ⭐ Pense à noter ta livraison sur le site dans **"Mes commandes"** !\n` +
      `> 🌐 ${REDIRECT_URI.replace('/auth/discord/callback', '')}`
    );
    await sendWebhook(null, {
      title: `📦 Commande livrée — ${req.params.id}`,
      color: 0x2980b9,
      description: `Livrée par **${req.session.user.username}**\nClient : **${order.rp_name}**`,
      timestamp: new Date().toISOString()
    });
  }

  if (status === 'refused' && order) {
    await sendDM(order.user_id,
      `❌ **Cartel 13 — Commande refusée**\n\n` +
      `Salut **${order.username}**, ta commande **${req.params.id}** n'a pas pu être traitée.\n\n` +
      `Ouvre un ticket sur notre serveur Discord pour plus d'informations.`
    );
  }

  if (rating && order) {
    await sendWebhook(null, {
      title: `⭐ Nouvelle notation — ${req.params.id}`,
      color: 0xf0c040,
      description: `**${order.username}** a noté la livraison de **${req.session.user.username}** :\n${'⭐'.repeat(Number(rating))}${'☆'.repeat(5 - Number(rating))} **(${rating}/5)**`,
      timestamp: new Date().toISOString()
    });
  }

  await log(req.session.user.username, `Commande ${req.params.id} → ${status || 'modifiée'}`, 'order', '📋');
  res.json(data || { ok: true });
});

// ── LOGS ───────────────────────────────────────────────
app.get('/api/logs', staffOrAdmin, async (req, res) => {
  res.json(await sb('GET', 'logs', null, '?order=created_at.desc&limit=300') || []);
});

// ── SETTINGS ───────────────────────────────────────────
app.get('/api/settings', auth, async (req, res) => {
  const data = await sb('GET', 'settings', null, '') || [];
  const obj = {};
  data.forEach(s => obj[s.key] = s.value);
  res.json(obj);
});

app.post('/api/settings', adminOnly, async (req, res) => {
  const { key, value } = req.body;
  const existing = await sb('GET', 'settings', null, `?key=eq.${key}`);
  if (existing && existing.length > 0) {
    await sb('PATCH', 'settings', { value }, `?key=eq.${key}`);
  } else {
    await sb('POST', 'settings', { key, value });
  }
  await log(req.session.user.username, `Paramètre modifié : ${key}`, 'admin', '⚙️');
  res.json({ ok: true });
});

// ── PAGES ──────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/app', (req, res) => {
  if (!req.session.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Cartel 13 ERP sur le port ${PORT}`));
