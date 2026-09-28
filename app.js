/* =====================================================================
   CornerstoreAI – App-Logik
   Aufbau: Hilfsfunktionen · Daten laden/speichern (Supabase) · Ansichten
   ===================================================================== */
'use strict';

/* ---------- Hilfsfunktionen ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eur = n => (+n || 0).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
const toNum = v => { const n = parseFloat(String(v ?? '').replace(',', '.')); return isFinite(n) ? n : null; };
let netMode = false;
const conv = (n, vat = 19) => netMode ? n / (1 + vat / 100) : n;
const fmt = (n, vat = 19) => eur(conv(n, vat));
const num = (n, vat = 19) => conv(n, vat).toFixed(2).replace('.', ',');
function hash(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 1000; }
function toggleIn(arr, v) { return arr.includes(v) ? arr.filter(x => x !== v) : [...arr, v]; }
function ymd(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function isoKW(d) { const t = new Date(d); t.setHours(0, 0, 0, 0); t.setDate(t.getDate() + 3 - ((t.getDay() + 6) % 7)); const w1 = new Date(t.getFullYear(), 0, 4); return 1 + Math.round(((t - w1) / 864e5 - 3 + ((w1.getDay() + 6) % 7)) / 7); }
function weekStart(w) { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + w * 7); return d; }
function weekRange(w) { const s = weekStart(w), e = new Date(s); e.setDate(e.getDate() + 6); return { from: ymd(s), to: ymd(e), s, e }; }
function weekInfo(w) { const { s, e } = weekRange(w); const f = x => x.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }); return { kw: isoKW(s), range: f(s) + '–' + f(e) }; }
function weekLabel() { const wi = weekInfo(week); return (week ? 'Nächste' : 'Diese') + ' Woche · KW ' + wi.kw + ' (' + wi.range + ')'; }
function toast(t) { const e = $('#toast'); e.textContent = t; e.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => e.classList.remove('show'), 2800); }
function deDate(s) { return s ? new Date(s).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }) : ''; }

const CATEMOJI = [['alkoholfrei', '🥤'], ['alkohol', '🍺'], ['bier', '🍺'], ['zigarett', '🚬'], ['tabak', '🚬'], ['snack', '🍫'], ['süß', '🍬'], ['getränk', '🥤']];
function catEmoji(c) { const k = String(c).toLowerCase(); for (const [a, e] of CATEMOJI) if (k.includes(a)) return e; return '🛍️'; }
const CAT_COLORS = ['#4453e6', '#e08a1e', '#1fa07a', '#e0507f', '#1fa3c7', '#9457d1', '#7f9a1f'];
function catColor(cat) { const o = catList(); return CAT_COLORS[Math.max(0, o.indexOf(cat)) % CAT_COLORS.length]; }
function priceColor(price, min, max) { const r = max > min ? (price - min) / (max - min) : 0; return `hsl(${(120 - r * 120).toFixed(0)} 65% 45%)`; }
// Mehrwertsteuer: Lebensmittel meist 7 %, Getränke/Alkohol/Tabak/Non-Food 19 %
function guessVat(cat, name) {
  const t = (cat + ' ' + name).toLowerCase();
  if (/milch|snack|süß|suess|lebensmittel|brot|backwar|chips|schoko|gummi|haribo|obst|gemüse|kaffee|tee\b/.test(t) && !/getränk|drink|alkohol|bier|saft|wasser|limo|energy/.test(t)) return 7;
  return 19;
}
const RETAILER_SUGGEST = ['Rewe', 'Edeka', 'Penny', 'Netto', 'Kaufland', 'Lidl', 'Aldi Süd', 'Aldi Nord', 'Norma', 'Metro', 'Selgros', 'Action', 'Globus', 'Marktkauf', 'Hit', 'Netto City', 'Rossmann', 'dm', 'Trinkgut', 'Getränke Hoffmann'];

/* ---------- Zustand ---------- */
const CFG = window.CONFIG || {};
const configured = CFG.SUPABASE_URL && !/HIER_/.test(CFG.SUPABASE_URL) && CFG.SUPABASE_KEY && !/HIER_/.test(CFG.SUPABASE_KEY);
const sb = configured && window.supabase ? window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY) : null;

let S = { user: null, profile: null, products: [], vendorsRaw: [], vprices: [], retailRows: [], history: [], cart: [], lastRun: null, loaded: false };
let products = [], vendors = [], RETAIL = [], R = {}, cart = [];
let tab = 'dash', prevTab = 'dash', q = '', catFilter = [], dashProd = [], dashSearch = '', dealerFilter = [], week = 0, filterOpen = false, selected = [];
let authEmail = '', addOpen = false, bulkOpen = false, chartRange = 'month', authMode = 'login', authMsg = '', noteOpen = new Set(), scannedEan = null;

/* ---------- Supabase: Laden ---------- */
async function must(p) { const { data, error } = await p; if (error) throw error; return data; }
async function fetchAll(table, cols, mod = x => x) {
  let out = [], from = 0;
  for (;;) {
    const rows = await must(mod(sb.from(table).select(cols)).range(from, from + 999));
    out = out.concat(rows); if (rows.length < 1000) return out; from += 1000;
  }
}
async function loadAll() {
  const uid = S.user.id;
  const since = new Date(); since.setFullYear(since.getFullYear() - 5);
  const [profile, prods, vend, vp, rp, hist, crt, runs] = await Promise.all([
    must(sb.from('profiles').select('*').eq('id', uid).maybeSingle()),
    fetchAll('products', '*', x => x.order('name')),
    fetchAll('vendors', '*', x => x.order('id')),
    fetchAll('vendor_prices', 'vendor_id,product_id,price'),
    fetchAll('retail_prices', '*', x => x.order('id')),
    fetchAll('price_history', 'product_id,day,best_price', x => x.gte('day', ymd(since)).order('day')),
    fetchAll('cart_items', '*', x => x.order('created_at')),
    must(sb.from('collector_runs').select('*').order('id', { ascending: false }).limit(1)),
  ]);
  S.profile = profile || await must(sb.from('profiles').insert({ id: uid }).select().single());
  Object.assign(S, { products: prods, vendorsRaw: vend, vprices: vp, retailRows: rp, history: hist, cart: crt, lastRun: runs[0] || null, loaded: true });
  if (!loadAll.once) { netMode = !!S.profile.net_default; loadAll.once = true; }
  buildIndex();
}
function buildIndex() {
  RETAIL = S.profile?.retailers || [];
  products = S.products.map(p => ({ id: p.id, name: p.name, unit: p.unit, cat: p.category, ean: p.ean, search_term: p.search_term, vat: +p.vat_rate || 19 }));
  vendors = S.vendorsRaw.map(v => ({ id: v.id, name: v.name, net: v.prices_net, prices: {} }));
  for (const x of S.vprices) { const v = vendors.find(v => v.id === x.vendor_id); if (v) v.prices[x.product_id] = +x.price; }
  R = {};
  for (const r of S.retailRows) {
    const e = ((R[r.product_id] = R[r.product_id] || {})[r.retailer] = R[r.product_id][r.retailer] || { regular: null, regularMg: null, deals: [], auto: [] });
    if (r.ext_key === 'regular') e.regular = r;
    else if (r.ext_key === 'regular-mg') e.regularMg = r;
    else if (r.ext_key.startsWith('deal:')) e.deals.push(r);
    else e.auto.push(r);
  }
  cart = S.cart.map(c => ({ pid: c.product_id, qty: c.qty || '', note: c.note || '', checked: c.checked }));
  dealerFilter = dealerFilter.filter(d => dealerList().includes(d));
}
const prod = id => products.find(p => p.id === id);

/* ---------- Preislogik ---------- */
function retailEntry(pid, r, w) {
  const e = R[pid]?.[r]; if (!e) return null;
  const { from, to } = weekRange(w);
  const cands = [...e.deals.filter(d => d.ext_key === 'deal:' + from), ...e.auto.filter(a => !a.hidden && (a.valid_from || from) <= to && (a.valid_to || to) >= from)];
  const deal = cands.sort((a, b) => a.price - b.price)[0] || null;
  const regular = e.regular ? +e.regular.price : e.regularMg ? +e.regularMg.price : null;
  return { regular, deal };
}
function vendorGross(v, p) { const n = v.prices[p.id]; if (n == null) return null; return v.net ? n * (1 + p.vat / 100) : n; }
function allOffers(pid, w = week) {
  const p = prod(pid), o = [];
  for (const r of RETAIL) {
    if (dealerFilter.length && !dealerFilter.includes(r)) continue;
    const e = retailEntry(pid, r, w); if (!e) continue;
    const price = e.deal ? +e.deal.price : e.regular; if (!(price > 0)) continue;
    const normal = e.deal ? (e.deal.regular_price != null ? +e.deal.regular_price : e.regular) : null;
    o.push({ name: r, price, deal: !!e.deal, normal, kind: 'retail', row: e.deal });
  }
  for (const v of vendors) {
    if (dealerFilter.length && !dealerFilter.includes(v.name)) continue;
    const g = vendorGross(v, p); if (g != null) o.push({ name: v.name, price: g, deal: false, normal: null, kind: 'vendor' });
  }
  return o.sort((a, b) => a.price - b.price);
}
function catList() { return [...new Set(products.map(p => p.cat))].sort(); }
function dealerList() { return [...RETAIL, ...vendors.map(v => v.name)]; }
function fp() { return products.filter(p => (!catFilter.length || catFilter.includes(p.cat)) && (!dashProd.length || dashProd.includes(p.id))); }
function visible() { return products.filter(p => (!q || p.name.toLowerCase().includes(q.toLowerCase())) && (!catFilter.length || catFilter.includes(p.cat))); }

/* ---------- Aktionen mit Fehlerbehandlung ---------- */
async function act(fn, okMsg) {
  try { await fn(); if (okMsg) toast(okMsg); }
  catch (e) { console.error(e); toast('⚠️ ' + (e.message || 'Fehler beim Speichern')); }
  try { if (S.user) await loadAll(); } catch (e) { console.error(e); }
  render();
}

/* =====================================================================
   Anmeldung
   ===================================================================== */
function authView() {
  if (!configured) return `<div class="auth"><div class="pcard"><h2>⚙️ Noch nicht eingerichtet</h2>
    <p class="sub">Trage in der Datei <span class="mono">config.js</span> deine Supabase-Adresse und den Publishable Key ein (Anleitung Schritt 3).</p></div></div>`;
  const m = authMode;
  const title = { login: 'Anmelden', register: 'Konto erstellen', forgot: 'Passwort vergessen', recover: 'Neues Passwort festlegen' }[m];
  return `<div class="auth"><div class="pcard"><h2>${title}</h2>
  <form onsubmit="authSubmit(event)">
    ${m !== 'recover' ? `<label class="field">E-Mail<input name="email" type="email" autocomplete="email" value="${esc(authEmail)}" required></label>` : ''}
    ${m === 'login' || m === 'register' || m === 'recover' ? `<label class="field">Passwort<input name="pw" type="password" minlength="8" autocomplete="${m === 'login' ? 'current-password' : 'new-password'}" required></label>` : ''}
    ${authMsg ? `<p class="err">${esc(authMsg)}</p>` : ''}
    <button style="width:100%;margin-top:4px">${{ login: 'Anmelden', register: 'Registrieren', forgot: 'Link zum Zurücksetzen senden', recover: 'Passwort speichern' }[m]}</button>
  </form>
  <div class="row between" style="margin-top:10px">
    ${m === 'login' ? `<button class="switchlink" onclick="setAuth('register')">Konto erstellen</button><button class="switchlink" onclick="setAuth('forgot')">Passwort vergessen?</button>`
      : m !== 'recover' ? `<button class="switchlink" onclick="setAuth('login')">‹ Zur Anmeldung</button>` : ''}
  </div></div></div>`;
}
function setAuth(m) { authMode = m; authMsg = ''; render(); }
async function authSubmit(e) {
  e.preventDefault(); const f = e.target, email = f.email?.value.trim(), pw = f.pw?.value; authMsg = ''; if (email) authEmail = email;
  try {
    if (authMode === 'login') { const { error } = await sb.auth.signInWithPassword({ email, password: pw }); if (error) throw error; }
    else if (authMode === 'register') {
      const { data, error } = await sb.auth.signUp({ email, password: pw, options: { emailRedirectTo: location.origin + location.pathname } });
      if (error) throw error;
      if (!data.session) { authMode = 'login'; authMsg = '📧 Fast geschafft: Bitte bestätige den Link in deiner E-Mail und melde dich dann an.'; }
    } else if (authMode === 'forgot') {
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname }); if (error) throw error;
      authMode = 'login'; authMsg = '📧 Wir haben dir einen Link geschickt.';
    } else if (authMode === 'recover') {
      const { error } = await sb.auth.updateUser({ password: pw }); if (error) throw error;
      authMode = 'login'; toast('✅ Passwort geändert'); await startSession();
    }
  } catch (err) { authMsg = translateAuth(err.message); }
  render();
}
function translateAuth(m) {
  if (/invalid login/i.test(m)) return 'E-Mail oder Passwort falsch.';
  if (/not confirmed/i.test(m)) return 'Bitte bestätige zuerst deine E-Mail-Adresse.';
  if (/already registered/i.test(m)) return 'Diese E-Mail ist schon registriert.';
  if (/at least/i.test(m)) return 'Das Passwort muss mindestens 8 Zeichen haben.';
  if (/rate limit/i.test(m)) return 'Zu viele Versuche. Bitte kurz warten.';
  return m;
}
async function startSession() {
  const { data } = await sb.auth.getSession();
  S.user = data.session?.user || null;
  if (S.user) { try { await loadAll(); } catch (e) { console.error(e); toast('⚠️ Daten konnten nicht geladen werden: ' + e.message); } }
  render();
}
async function logout() { openMenu(false); await sb.auth.signOut(); S = { ...S, user: null, loaded: false }; tab = 'dash'; loadAll.once = false; render(); toast('Abgemeldet'); }

/* =====================================================================
   Grundgerüst
   ===================================================================== */
function render() {
  const loggedIn = !!(S.user && S.loaded) && authMode !== 'recover';
  $('#topbar').classList.toggle('hidden', !loggedIn);
  $('#nav').classList.toggle('hidden', !loggedIn);
  $('#lastrun').textContent = loggedIn && S.lastRun ? `Preise zuletzt abgerufen: ${new Date(S.lastRun.finished_at || S.lastRun.started_at).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} Uhr` : '';
  if (!loggedIn) { $('#app').innerHTML = S.user && !S.loaded && authMode !== 'recover' ? '<p class="loading">Lädt …</p>' : authView(); updateSelBar(); return; }
  $('#vatSwitch').checked = netMode;
  $('#menuAvatar').textContent = ((S.profile.name || S.user.email || '?').match(/\b\w/g) || ['?']).slice(0, 2).join('').toUpperCase();
  $('#menuShop').textContent = S.profile.shop_name || 'Mein Späti';
  $('#menuMail').textContent = S.user.email || '';
  const tabs = [['dash', '🏠', 'Dashboard'], ['cart', '🛒', 'Einkaufsliste'], ['products', '📦', 'Produkte'], ['vendors', '🏬', 'Händler']];
  $('#nav').innerHTML = tabs.map(([k, ic, l]) => `<button class="${tab === k ? 'on' : ''}" onclick="go('${k}')"><span class="ic">${ic}</span>${l}${k === 'cart' && cart.length ? `<span class="navbadge">${cart.length}</span>` : ''}</button>`).join('');
  $('#app').innerHTML = tab.startsWith('page:') ? pageView(tab.slice(5)) : tab === 'dash' ? dash() : tab === 'cart' ? cartView() : tab === 'products' ? productsView() : vendorsView();
  updateSelBar();
}
function go(t) { tab = t; window.scrollTo && window.scrollTo(0, 0); render(); }
function toggleNet() { netMode = !netMode; render(); }
async function refreshPrices() {
  await act(async () => {}, null);
  toast(S.lastRun ? '🔄 Aktualisiert · letzter Preisabruf ' + new Date(S.lastRun.finished_at || S.lastRun.started_at).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '🔄 Aktualisiert · der erste automatische Preisabruf steht noch aus');
}

/* ---------- Filter ---------- */
function filterBox() {
  const wi = weekInfo(week), dl = dealerList(), cl = catList(), sq = dashSearch.toLowerCase();
  const n = catFilter.length + dashProd.length + dealerFilter.length;
  const pl = products.filter(x => !sq || x.name.toLowerCase().includes(sq));
  const chip = (on, fn, t) => `<button type="button" class="chip ${on ? 'on' : ''}" onclick="${fn}">${t}</button>`;
  return `<details class="filterbox" ${filterOpen ? 'open' : ''} ontoggle="filterOpen=this.open">
  <summary><span>Filter</span><span class="row"><span class="pillsm">${week ? 'Nächste' : 'Diese'} Woche</span>${n ? `<span class="badge">${n}</span>` : ''}</span></summary>
  <div class="panel">
    <div class="filter-section"><h4>🗓️ Zeitraum</h4><div class="seg">${chip(week === 0, 'week=0;render()', 'Diese Woche')}${chip(week === 1, 'week=1;render()', 'Nächste Woche')}</div><p class="sub">KW ${wi.kw} · ${wi.range}</p></div>
    <div class="filter-section"><h4>🏷️ Kategorien</h4><div class="filters" style="margin:0">${cl.map((c, i) => chip(catFilter.includes(c), `toggleCat(${i})`, catEmoji(c) + ' ' + esc(c))).join('') || '<span class="muted">Noch keine Kategorien.</span>'}</div></div>
    <div class="filter-section"><h4>🏬 Händler</h4><div class="filters" style="margin:0">${dl.map((d, i) => chip(dealerFilter.includes(d), `toggleDealer(${i})`, (i < RETAIL.length ? '🏬 ' : '📦 ') + esc(d))).join('')}</div></div>
    <div class="filter-section"><h4>📦 Produkte${dashProd.length ? ` (${dashProd.length})` : ''}</h4>
      <input id="fsearch" type="search" placeholder="Produkt suchen…" aria-label="Produkt im Filter suchen" value="${esc(dashSearch)}" oninput="onFSearch(this.value)" style="width:100%;margin-bottom:8px">
      <div class="checklist">${pl.map(x => `<label><input type="checkbox" ${dashProd.includes(x.id) ? 'checked' : ''} onchange="toggleDashProd(${x.id})">${catEmoji(x.cat)} ${esc(x.name)}</label>`).join('') || '<span class="muted">Kein Produkt gefunden.</span>'}</div></div>
    ${n ? `<button type="button" class="ghost sm" style="margin-top:12px" onclick="catFilter=[];dashProd=[];dealerFilter=[];render()">Filter zurücksetzen</button>` : ''}
  </div></details>`;
}
function toggleCat(i) { catFilter = toggleIn(catFilter, catList()[i]); render(); }
function toggleDealer(i) { dealerFilter = toggleIn(dealerFilter, dealerList()[i]); render(); }
function toggleDashProd(id) { dashProd = toggleIn(dashProd, id); render(); }
function onFSearch(v) { dashSearch = v; render(); const i = $('#fsearch'); if (i) { i.focus(); const l = i.value.length; i.setSelectionRange && i.setSelectionRange(l, l); } }
function catChips() { return `<div class="filters">${catList().map((c, i) => `<button type="button" class="chip ${catFilter.includes(c) ? 'on' : ''}" onclick="toggleCat(${i})">${catEmoji(c)} ${esc(c)}</button>`).join('')}</div>`; }

/* ---------- Dashboard ---------- */
function banners() {
  const out = [];
  if (!(S.profile.zip || '').trim()) out.push(`<div class="banner"><p>📍 Trag die <b>Postleitzahl</b> deines Ladens ein, damit wir die Angebote in deiner Nähe finden.</p><button class="sm" onclick="openPage('laden')">Jetzt eintragen</button></div>`);
  if (!products.length) out.push(`<div class="banner"><p>📦 Du hast noch keine Produkte. Leg deine Ware unter „Produkte“ an – oder starte mit Beispielen.</p><span class="row"><button class="sm" onclick="seedExamples()">Beispiele anlegen</button><button class="ghost sm" onclick="go('products')">Selbst anlegen</button></span></div>`);
  return out.join('');
}
function dash() {
  const list = fp(), best = {}; let save = 0;
  for (const x of list) { const o = allOffers(x.id); best[x.id] = o; if (o.length > 1) save += conv(o[1].price - o[0].price, x.vat); }
  const ol = offerList();
  return `${banners()}${filterBox()}
  <p class="hint">👆 Tippe auf ein Produkt, um es für deine Einkaufsliste auszuwählen.</p>
  <section class="dash-block"><h2>🔥 Angebote</h2><p class="sub">${weekLabel()} · nur Angebote, die zugleich der günstigste Preis sind</p>
    ${ol.length ? `<div class="offer-scroll">${ol.map(offerCard).join('')}</div>` : '<p class="muted">Aktuell keine Angebote, die gleichzeitig die günstigste Quelle sind.</p>'}</section>
  <section class="dash-block">${priceChart()}</section>
  <section class="dash-block"><h2>📊 Kennzahlen</h2><div class="stats">
    <div class="stat t1"><span class="ic">📦</span><b>${list.length}</b><span>Produkte im Vergleich</span></div>
    <div class="stat t2"><span class="ic">🏬</span><b>${dealerFilter.length || dealerList().length}</b><span>Angebundene Quellen</span></div>
    <div class="stat t3"><span class="ic">💰</span><b>${eur(save)}</b><span>Ersparnis ggü. zweitbestem Preis</span></div>
    <div class="stat t4"><span class="ic">🔥</span><b>${ol.length}</b><span>Beste Angebote</span></div></div></section>
  <section class="dash-block"><h2>🏷️ Preisvergleich</h2><div class="plist">${list.map(x => pcard(x, best[x.id])).join('') || '<p class="muted">Kein Produkt gefunden.</p>'}</div></section>`;
}
function offerList() {
  const out = [];
  for (const x of fp()) {
    const off = allOffers(x.id); if (!off.length) continue; const c = off[0];
    for (const o of off) if (o.kind === 'retail' && o.deal && o.price === c.price) out.push({ p: x, o, pct: o.normal > o.price ? Math.round((1 - o.price / o.normal) * 100) : null });
  }
  return out.sort((a, b) => (b.pct || 0) - (a.pct || 0));
}
function offerCard(x) {
  const r = x.o.row, pack = r && r.pack_count > 1 ? `<div class="pmeta small">${r.pack_count}er für ${fmt(r.pack_price, x.p.vat)}</div>` : '';
  return `<div class="offer-card selectable${selected.includes(x.p.id) ? ' sel' : ''}" data-pid="${x.p.id}" onclick="cardClick(event,${x.p.id})" title="${esc(r?.title || '')}">
    <div class="oc-top"><span class="oc-emoji">${catEmoji(x.p.cat)}</span>${x.pct ? `<span class="badge">−${x.pct}%</span>` : '<span class="badge">Angebot</span>'}</div>
    <div><div class="pname">${esc(x.p.name)}</div><div class="pmeta">🏬 ${esc(x.o.name)}${r?.valid_to ? ' · bis ' + deDate(r.valid_to) : ''}</div>${pack}</div>
    <div class="oc-price"><b>${fmt(x.o.price, x.p.vat)}</b> ${x.o.normal > x.o.price ? `<span class="was">${fmt(x.o.normal, x.p.vat)}</span>` : ''}</div></div>`;
}
function pcard(p, offers) {
  const at = `class="pcard selectable${selected.includes(p.id) ? ' sel' : ''}" style="--cc:${catColor(p.cat)}" data-pid="${p.id}" onclick="cardClick(event,${p.id})"`;
  const head = `<div><div class="pname">${catEmoji(p.cat)} ${esc(p.name)}</div><div class="pmeta">${esc(p.cat)} · ${esc(p.unit)}</div></div>`;
  if (!offers.length) return `<div ${at}><div class="prow">${head}<span class="muted small">Noch keine Preise</span></div></div>`;
  const top = offers[0], min = top.price, max = offers[offers.length - 1].price, save = offers.length > 1 ? offers[1].price - min : 0;
  return `<div ${at}><div class="prow">${head}<div class="rec"><div class="price">${fmt(top.price, p.vat)}</div><div class="pmeta">🏆 ${esc(top.name)}</div>${save > 0.004 ? `<span class="tag">spart ${fmt(save, p.vat)} ggü. Nr. 2</span>` : ''}</div></div>
  <div class="bars">${offers.map(o => `<div class="bar-row" title="${esc(o.row?.title || '')}"><span class="src">${o.deal ? '🔥 ' : ''}${esc(o.name)}</span><span class="bar-track"><span class="bar-fill" style="width:${max > 0 ? (o.price / max * 100).toFixed(0) : 0}%;background:${priceColor(o.price, min, max)}"></span></span><span class="p">${fmt(o.price, p.vat)}</span></div>`).join('')}</div></div>`;
}

/* ---------- Preisverlauf (echte Daten aus price_history) ---------- */
function bucketKey(dateStr, range) {
  const d = new Date(dateStr + 'T12:00:00');
  if (range === 'week') { const m = new Date(d); m.setDate(m.getDate() - ((m.getDay() + 6) % 7)); return ymd(m); }
  if (range === 'month') return d.getFullYear() + '-' + d.getMonth();
  if (range === 'quarter') return d.getFullYear() + '-Q' + Math.floor(d.getMonth() / 3);
  return String(d.getFullYear());
}
function seriesDefs() {
  const list = fp(), out = [];
  if (dashProd.length) { const cnt = {}; for (const x of list.slice(0, 8)) { const i = cnt[x.cat] = (cnt[x.cat] || 0) + 1; out.push({ label: x.name, cat: x.cat, ids: [x.id], vat: x.vat, dash: ['', '6 3', '2 3', '8 3 2 3'][(i - 1) % 4] }); } return out; }
  for (const cat of [...new Set(list.map(x => x.cat))]) { const ps = list.filter(y => y.cat === cat); out.push({ label: cat, cat, ids: ps.map(p => p.id), vat: ps[0].vat, dash: '' }); }
  return out;
}
function priceChart() {
  const n = { week: 8, month: 12, quarter: 8, year: 5 }[chartRange], now = new Date(), labels = [], keys = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now);
    if (chartRange === 'week') d.setDate(d.getDate() - i * 7); else if (chartRange === 'month') { d.setDate(1); d.setMonth(d.getMonth() - i); } else if (chartRange === 'quarter') { d.setDate(1); d.setMonth(d.getMonth() - i * 3); } else d.setFullYear(d.getFullYear() - i);
    keys.push(bucketKey(ymd(d), chartRange));
    labels.push(chartRange === 'week' ? 'KW' + isoKW(d) : chartRange === 'month' ? d.toLocaleDateString('de-DE', { month: 'short', year: '2-digit' }) : chartRange === 'quarter' ? 'Q' + (Math.floor(d.getMonth() / 3) + 1) + ' ' + String(d.getFullYear()).slice(2) : String(d.getFullYear()));
  }
  // Durchschnitt pro Produkt und Zeitraum, dann Mittelwert über die Produkte der Serie
  const per = {};
  for (const h of S.history) { const k = h.product_id + '|' + bucketKey(h.day, chartRange); (per[k] = per[k] || []).push(+h.best_price); }
  const avg = a => a.reduce((s, x) => s + x, 0) / a.length;
  const series = seriesDefs().map(df => ({ ...df, vals: keys.map(k => { const v = df.ids.map(id => per[id + '|' + k]).filter(Boolean).map(avg); return v.length ? conv(avg(v), df.vat) : null; }) })).filter(s => s.vals.some(v => v != null));
  const points = series.reduce((s, x) => s + x.vals.filter(v => v != null).length, 0);
  const rc = (k, l) => `<button type="button" class="chip ${chartRange === k ? 'on' : ''}" onclick="chartRange='${k}';render()">${l}</button>`;
  const head = `<h2>📈 Preisentwicklung</h2><div class="row">${rc('week', 'Woche')}${rc('month', 'Monat')}${rc('quarter', 'Quartal')}${rc('year', 'Jahr')}</div>`;
  if (!points) return head + `<div class="pcard" style="margin-top:8px"><p class="muted" style="margin:0">Der Preisverlauf füllt sich ab jetzt automatisch – jeden Morgen kommt ein Messpunkt dazu.</p></div>`;
  const all = series.flatMap(x => x.vals.filter(v => v != null)), W = 640, H = 200, pl = 44, pr = 10, pt = 10, pb = 24;
  const mn = Math.min(...all), mx = Math.max(...all), sp = (mx - mn) || mx * 0.2 || 1, lo = Math.max(0, mn - sp * .15), hi = mx + sp * .15;
  const X = i => pl + (W - pl - pr) * (n > 1 ? i / (n - 1) : 0), Y = v => H - pb - (H - pt - pb) * ((v - lo) / (hi - lo));
  let svg = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" role="img" aria-label="Preisentwicklung">`;
  for (let g = 0; g <= 4; g++) { const gy = pt + (H - pt - pb) * g / 4; svg += `<line x1="${pl}" y1="${gy.toFixed(1)}" x2="${W - pr}" y2="${gy.toFixed(1)}" stroke="var(--line)"/><text x="${pl - 6}" y="${(gy + 3).toFixed(1)}" font-size="9" fill="var(--mute)" text-anchor="end" font-family="var(--mono)">${(hi - (hi - lo) * g / 4).toFixed(2).replace('.', ',')}</text>`; }
  labels.forEach((l, i) => { svg += `<text x="${X(i).toFixed(1)}" y="${H - 6}" font-size="9" fill="var(--mute)" text-anchor="middle">${esc(l)}</text>`; });
  for (const x of series) {
    const c = catColor(x.cat); let seg = [];
    const flush = () => { if (seg.length > 1) svg += `<polyline points="${seg.join(' ')}" fill="none" stroke="${c}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"${x.dash ? ` stroke-dasharray="${x.dash}"` : ''}/>`; seg = []; };
    x.vals.forEach((v, i) => { if (v == null) return flush(); seg.push(X(i).toFixed(1) + ',' + Y(v).toFixed(1)); svg += `<circle cx="${X(i).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="3" fill="${c}"><title>${esc(x.label)}: ${v.toFixed(2).replace('.', ',')} €</title></circle>`; });
    flush();
  }
  svg += '</svg>';
  return head + `<div class="pcard chart-wrap" style="margin-top:8px">${svg}</div>
  <div class="legend">${series.map(x => `<span><span class="dot" style="background:${catColor(x.cat)}"></span>${esc(x.label)}</span>`).join('')}</div>
  <p class="sub">Durchschnitt des jeweils günstigsten Preises pro Zeitraum${points < 3 ? ' · noch wenige Messpunkte, der Verlauf wächst täglich' : ''}.</p>`;
}

/* ---------- Produkte ---------- */
function productsView() {
  const list = visible();
  const vendorFields = vendors.map(v => `<input name="v${v.id}" inputmode="decimal" placeholder="${esc(v.name)} (${v.net ? 'netto' : 'brutto'})">`).join('');
  return `<div style="margin-top:4px"></div>
  <details class="filterbox fold" ${addOpen ? 'open' : ''} ontoggle="addOpen=this.open">
  <summary><span>➕ Produkt hinzufügen</span></summary><div class="panel">
  <form onsubmit="addProduct(event)" style="display:flex;flex-direction:column;gap:8px;align-items:flex-start">
    <div class="row"><input name="n" placeholder="Produktname (mit Größe, z. B. 0,5l)" required><input name="u" placeholder="Einheit (z. B. Flasche)" required>
    <input name="c" placeholder="Kategorie" list="catlist" required>
    <datalist id="catlist">${catList().map(c => `<option value="${esc(c)}">`).join('')}</datalist>
    <button type="button" class="ghost sm" onclick="document.getElementById('barcodeInput').click()">📷 Barcode scannen</button>
    <input id="barcodeInput" type="file" accept="image/*" capture="environment" style="display:none" onchange="scanBarcode(event)"></div>
    <p class="sub" id="eanInfo" style="margin:0">${scannedEan ? 'Barcode: ' + esc(scannedEan) : ''}</p>
    ${vendors.length ? `<div class="row">${vendorFields}</div><p class="sub" style="margin:0">Einkaufspreis pro Einheit bei deinen Großhändlern/Vertragspartnern, optional.</p>` : ''}
    <button>Hinzufügen</button>
  </form></div></details>

  <details class="filterbox fold" ${bulkOpen ? 'open' : ''} ontoggle="bulkOpen=this.open">
  <summary><span>📥 Produktliste hochladen</span></summary><div class="panel">
  <p class="sub" style="margin:0">Eine Zeile pro Produkt: <span class="mono">Name; Einheit; Kategorie</span>. Bestehende Namen werden aktualisiert, neue angelegt.</p>
  <textarea id="bulk" placeholder="Sternburg Export 0,5l; Flasche; Alkohol
Haribo Goldbären 200g; Beutel; Snacks"></textarea>
  <div class="toolbar">
    <button onclick="importBulk()">Liste importieren</button>
    <label class="file ghost sm">Datei wählen (.csv/.txt)<input type="file" accept=".csv,.txt" style="display:none" onchange="importFile(event)"></label>
    <label class="file ghost sm">📷 Foto/Liste abfotografieren<input type="file" accept="image/*" style="display:none" onchange="photoSoon(event)"></label>
  </div></div></details>

  <h2>📦 Aktuelle Produkte (${list.length}/${products.length})</h2>
  ${catChips()}
  <div class="plist">${list.map(p => `<div class="pcard selectable${selected.includes(p.id) ? ' sel' : ''}" style="--cc:${catColor(p.cat)}" data-pid="${p.id}" onclick="cardClick(event,${p.id})"><div class="row between"><div><b>${catEmoji(p.cat)} ${esc(p.name)}</b><br><span class="muted">${esc(p.cat)} · ${esc(p.unit)} · ${p.vat} % MwSt.</span></div>
    <button class="ghost sm" onclick="delProduct(${p.id})">Entfernen</button></div>
    ${priceDropdown(p)}</div>`).join('') || '<p class="muted">Kein Produkt gefunden.</p>'}</div>`;
}
function priceDropdown(p) {
  const off = allOffers(p.id), top = off[0], w0 = weekRange(0).from, w1 = weekRange(1).from;
  const autos = RETAIL.flatMap(r => (R[p.id]?.[r]?.auto || []).map(a => ({ ...a, r }))).sort((a, b) => (a.valid_from || '').localeCompare(b.valid_from || '') || a.price - b.price);
  return `<details class="pricedrop"><summary>Preise anzeigen${top ? ` · 🏆 ${esc(top.name)} ${fmt(top.price, p.vat)}` : ''}</summary>
    <div class="pricegrp"><h3>🤖 Automatisch gefundene Angebote</h3>
      ${autos.length ? autos.map(a => `<div class="offerline" style="${a.hidden ? 'opacity:.45' : ''}"><span class="t"><b>${esc(a.r)}</b> ${fmt(a.price, p.vat)}${a.pack_count > 1 ? ` <span class="small">(${a.pack_count}er ${fmt(a.pack_price, p.vat)})</span>` : ''} · ${deDate(a.valid_from)}–${deDate(a.valid_to)}<br><span class="small">${esc(a.title || '')}</span></span>
        <button type="button" class="ghost sm" onclick="hideOffer(${a.id},${!a.hidden})">${a.hidden ? 'Wieder zeigen' : '✕ Falscher Treffer'}</button></div>`).join('')
        : `<p class="sub" style="margin:0">${(S.profile.zip || '').trim() ? 'Aktuell nichts gefunden. Der Abruf läuft jeden Morgen.' : 'Trag erst deine PLZ unter „Mein Laden“ ein.'}</p>`}
    </div>
    <div class="pricegrp"><h3>🏪 Einzelhandel (manuell)</h3>
      <div class="vgrid4 hd"><span></span><span>Regulär</span><span>Diese Wo.</span><span>Nächste Wo.</span></div>
      ${RETAIL.map((r, i) => { const e = R[p.id]?.[r] || {}; const d0 = (e.deals || []).find(d => d.ext_key === 'deal:' + w0), d1 = (e.deals || []).find(d => d.ext_key === 'deal:' + w1);
        return `<div class="vgrid4"><span class="muted">${esc(r)}</span>
        <input inputmode="decimal" value="${e.regular ? e.regular.price : ''}" placeholder="${e.regularMg ? String(e.regularMg.price).replace('.', ',') : '—'}" aria-label="Normalpreis ${esc(r)}" onchange="setRetail(${p.id},${i},this.value)">
        <input inputmode="decimal" placeholder="—" value="${d0 ? d0.price : ''}" aria-label="Angebot diese Woche ${esc(r)}" onchange="setDeal(${p.id},${i},0,this.value)">
        <input inputmode="decimal" placeholder="—" value="${d1 ? d1.price : ''}" aria-label="Angebot nächste Woche ${esc(r)}" onchange="setDeal(${p.id},${i},1,this.value)"></div>`; }).join('')}
      <p class="sub small" style="margin:4px 0 0">Graue Werte = zuletzt automatisch gesehener Normalpreis. Alles brutto pro ${esc(p.unit)}.</p>
    </div>
    <div class="pricegrp"><h3>📦 Großhändler &amp; Vertragspartner</h3>
      ${vendors.length ? vendors.map(v => `<div class="vgrid"><span class="muted">${esc(v.name)} <span class="small">(${v.net ? 'netto' : 'brutto'})</span></span>
        <input inputmode="decimal" placeholder="—" value="${v.prices[p.id] ?? ''}" aria-label="Preis ${esc(v.name)}" onchange="setVendorPrice(${v.id},${p.id},this.value)"><span></span></div>`).join('') : '<p class="muted">Noch keine Großhändler angelegt (Reiter „Händler“).</p>'}
    </div>
    <div class="pricegrp"><h3>⚙️ Produkt-Einstellungen</h3>
      <div class="pset"><input value="${esc(p.search_term || '')}" placeholder="Suchbegriff (optional, z. B. Sternburg Export)" aria-label="Suchbegriff" onchange="setProd(${p.id},'search_term',this.value)">
      <select aria-label="Mehrwertsteuer" onchange="setProd(${p.id},'vat_rate',this.value)"><option value="19" ${p.vat === 19 ? 'selected' : ''}>19 %</option><option value="7" ${p.vat === 7 ? 'selected' : ''}>7 %</option></select></div>
      <p class="sub small" style="margin:4px 0 0">Der Suchbegriff hilft, wenn die automatische Suche nichts oder das Falsche findet.</p>
    </div></details>`;
}
async function addProduct(e) {
  e.preventDefault(); const f = new FormData(e.target), name = f.get('n').trim(), cat = f.get('c').trim();
  if (products.some(p => p.name.toLowerCase() === name.toLowerCase())) return toast('Dieses Produkt gibt es schon');
  const vp = vendors.map(v => ({ v, val: toNum(f.get('v' + v.id)) })).filter(x => x.val != null);
  await act(async () => {
    const np = await must(sb.from('products').insert({ name, unit: f.get('u').trim(), category: cat, ean: scannedEan, vat_rate: guessVat(cat, name) }).select().single());
    if (vp.length) await must(sb.from('vendor_prices').insert(vp.map(x => ({ vendor_id: x.v.id, product_id: np.id, price: x.val }))));
    scannedEan = null; e.target.reset();
  }, 'Produkt hinzugefügt');
}
async function delProduct(id) {
  if (!confirm('Produkt wirklich entfernen? Alle hinterlegten Preise gehen dabei verloren.')) return;
  selected = selected.filter(x => x !== id); dashProd = dashProd.filter(x => x !== id);
  await act(() => must(sb.from('products').delete().eq('id', id)), 'Produkt entfernt');
}
async function setProd(id, field, v) { await act(() => must(sb.from('products').update({ [field]: field === 'vat_rate' ? +v : (v.trim() || null) }).eq('id', id)), 'Gespeichert'); }
async function importBulk() {
  const lines = $('#bulk').value.split('\n').map(l => l.trim()).filter(Boolean); let n = 0;
  await act(async () => {
    const ins = [];
    for (const l of lines) {
      const [name, unit = 'Stück', cat = 'Sonstiges'] = l.split(/[;\t]/).map(s => s.trim()); if (!name) continue;
      const ex = products.find(p => p.name.toLowerCase() === name.toLowerCase());
      if (ex) await must(sb.from('products').update({ unit: unit || 'Stück', category: cat || 'Sonstiges' }).eq('id', ex.id));
      else if (!ins.some(x => x.name.toLowerCase() === name.toLowerCase())) ins.push({ name, unit: unit || 'Stück', category: cat || 'Sonstiges', vat_rate: guessVat(cat, name) });
      n++;
    }
    if (ins.length) await must(sb.from('products').insert(ins));
  });
  toast(n + ' Produkte importiert');
}
function importFile(e) { const f = e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => { $('#bulk').value = r.result; importBulk(); }; r.readAsText(f); }
function photoSoon() { toast('📷 Foto-Erkennung kommt in einer späteren Version – bitte Text oder Datei nutzen'); }
async function seedExamples() {
  await act(() => must(sb.from('products').insert([
    { name: 'Sternburg Export 0,5l', unit: 'Flasche', category: 'Alkohol', vat_rate: 19 },
    { name: 'Astra Rotlicht 0,33l Dose', unit: 'Dose', category: 'Alkohol', vat_rate: 19 },
    { name: 'Jägermeister 0,7l', unit: 'Flasche', category: 'Alkohol', vat_rate: 19 },
    { name: 'Red Bull 0,25l Dose', unit: 'Dose', category: 'Alkoholfrei', vat_rate: 19 },
    { name: 'Haribo Goldbären 200g', unit: 'Beutel', category: 'Snacks', vat_rate: 7 },
  ])), 'Beispielprodukte angelegt');
}

/* Barcode: echtes Auslesen aus dem Foto + Produktname von Open Food Facts */
async function scanBarcode(e) {
  const file = e.target.files[0]; if (!file) return; const form = e.target.closest('form');
  toast('🔍 Barcode wird gelesen …');
  try {
    const code = await decodeBarcode(file);
    if (!code) return toast('Kein Barcode erkannt – bitte näher und scharf fotografieren');
    scannedEan = code; $('#eanInfo').textContent = 'Barcode: ' + code;
    const r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=product_name,product_name_de,brands,quantity,categories_tags`);
    const j = r.ok ? await r.json() : {};
    if (j.status === 1 && j.product) {
      const pr = j.product, brand = (pr.brands || '').split(',')[0].trim(), pn = pr.product_name_de || pr.product_name || '';
      form.n.value = [pn.toLowerCase().includes(brand.toLowerCase()) ? '' : brand, pn, pr.quantity || ''].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      const tags = (pr.categories_tags || []).join(' ');
      if (!form.c.value) form.c.value = /alcohol|beer|wine|spirit/.test(tags) ? 'Alkohol' : /beverage|drink|water|soda/.test(tags) ? 'Alkoholfrei' : /snack|sweet|candy|chocolate|chips/.test(tags) ? 'Snacks' : '';
      toast('✅ Erkannt: ' + form.n.value);
    } else toast('Barcode ' + code + ' erkannt – Name bitte selbst eintragen');
  } catch (err) { console.error(err); toast('⚠️ Barcode konnte nicht gelesen werden'); }
  e.target.value = '';
}
async function decodeBarcode(file) {
  if ('BarcodeDetector' in window) {
    try { const bmp = await createImageBitmap(file); const r = await new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e'] }).detect(bmp); if (r[0]) return r[0].rawValue; } catch (e) { /* Rückfall unten */ }
  }
  if (!window.ZXing) await new Promise((ok, fail) => { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js'; s.onload = ok; s.onerror = fail; document.head.appendChild(s); });
  const url = URL.createObjectURL(file);
  try { const res = await new window.ZXing.BrowserMultiFormatReader().decodeFromImageUrl(url); return res.getText(); }
  catch (e) { return null; } finally { URL.revokeObjectURL(url); }
}

/* Supermarktpreise manuell / Angebote ausblenden */
async function setRetail(pid, ri, v) {
  const r = RETAIL[ri], n = toNum(v);
  await act(() => n == null
    ? must(sb.from('retail_prices').delete().match({ product_id: pid, retailer: r, ext_key: 'regular' }))
    : must(sb.from('retail_prices').upsert({ product_id: pid, retailer: r, ext_key: 'regular', price: n, is_offer: false, source: 'manuell', fetched_at: new Date().toISOString() }, { onConflict: 'product_id,retailer,ext_key' })));
}
async function setDeal(pid, ri, w, v) {
  const r = RETAIL[ri], n = toNum(v), { from, to } = weekRange(w), key = 'deal:' + from;
  await act(() => n == null
    ? must(sb.from('retail_prices').delete().match({ product_id: pid, retailer: r, ext_key: key }))
    : must(sb.from('retail_prices').upsert({ product_id: pid, retailer: r, ext_key: key, price: n, is_offer: true, valid_from: from, valid_to: to, source: 'manuell', fetched_at: new Date().toISOString() }, { onConflict: 'product_id,retailer,ext_key' })));
}
async function hideOffer(id, hide) { await act(() => must(sb.from('retail_prices').update({ hidden: hide }).eq('id', id)), hide ? 'Treffer ausgeblendet' : 'Treffer wieder sichtbar'); }

/* ---------- Händler ---------- */
function vendorsView() {
  return `<h2>🏪 Einzelhandel</h2>
  <p class="sub">Diese Supermärkte werden jeden Morgen automatisch nach Angeboten in deiner Nähe durchsucht. Normalpreise kannst du im Reiter „Produkte“ unter „Preise anzeigen“ ergänzen.</p>
  <div class="row">${RETAIL.map((r, i) => `<span class="chip on" style="cursor:default;display:inline-flex;align-items:center;gap:6px">${esc(r)}<button type="button" class="ghost sm" style="padding:0 2px;border:0;background:none;color:inherit" onclick="delRetailer(${i})" aria-label="${esc(r)} entfernen">✕</button></span>`).join('') || '<p class="muted">Noch keine Supermärkte hinterlegt.</p>'}</div>
  <form onsubmit="addRetailer(event)" class="row" style="margin-top:8px"><input name="n" placeholder="Name des Supermarkts" list="retlist" required><datalist id="retlist">${RETAILER_SUGGEST.filter(x => !RETAIL.includes(x)).map(x => `<option value="${esc(x)}">`).join('')}</datalist><button>Hinzufügen</button></form>

  <h2>📦 Großhändler &amp; Vertragspartner</h2>
  <p class="sub">Preise, die du selbst mit Lieferanten oder Herstellern ausgehandelt hast. Preise pro Produkt trägst du hier ein oder direkt beim Anlegen eines Produkts.</p>
  <form onsubmit="addVendor(event)" class="row" style="margin-bottom:14px"><input name="n" placeholder="Name des Händlers" required><button>Hinzufügen</button></form>
  <div class="gap-list">${vendors.map(v => `<div class="pcard"><div class="row between"><b>${esc(v.name)}</b><button class="ghost sm" onclick="delVendor(${v.id})">Entfernen</button></div>
    <label class="row" style="margin-top:6px;font-size:.85rem"><input type="checkbox" ${v.net ? 'checked' : ''} onchange="setVendorNet(${v.id},this.checked)"> Preise sind netto (ohne MwSt.)</label>
    <div class="pricegrp"><h3>Preise pro Artikel</h3>
      ${products.length ? products.map(p => `<div class="vgrid"><span class="muted">${esc(p.name)}</span>
        <input inputmode="decimal" placeholder="—" value="${v.prices[p.id] ?? ''}" aria-label="Preis ${esc(p.name)} bei ${esc(v.name)}" onchange="setVendorPrice(${v.id},${p.id},this.value)">
        <span></span></div>`).join('') : '<p class="muted">Noch keine Produkte angelegt.</p>'}
    </div>
    <details class="pricedrop"><summary>Preisliste hochladen oder aktualisieren</summary>
      <p class="sub">Eine Zeile pro Produkt: <span class="mono">Produktname; Preis</span>. Bekannte Produktnamen werden automatisch aktualisiert.</p>
      <textarea id="vbulk${v.id}" placeholder="Sternburg Export 0,5l; 0,71"></textarea>
      <div class="toolbar">
        <button type="button" onclick="importVendorBulk(${v.id})">Liste übernehmen</button>
        <label class="file ghost sm">Datei wählen<input type="file" accept=".csv,.txt" style="display:none" onchange="importVendorFile(event,${v.id})"></label>
        <label class="file ghost sm">📷 Foto/Liste abfotografieren<input type="file" accept="image/*" style="display:none" onchange="photoSoon(event)"></label>
      </div>
    </details>
  </div>`).join('') || '<p class="muted">Noch keine Großhändler angelegt.</p>'}</div>`;
}
async function saveProfile(patch, msg) { await act(() => must(sb.from('profiles').update(patch).eq('id', S.user.id)), msg); }
async function addRetailer(e) {
  e.preventDefault(); const n = e.target.n.value.trim();
  if (!n || RETAIL.some(r => r.toLowerCase() === n.toLowerCase())) return toast('Diesen Supermarkt gibt es schon');
  await saveProfile({ retailers: [...RETAIL, n] }, 'Supermarkt hinzugefügt');
}
async function delRetailer(i) {
  const r = RETAIL[i]; if (!confirm(r + ' wirklich entfernen? Alle hinterlegten Preise dort gehen verloren.')) return;
  await act(async () => { await must(sb.from('retail_prices').delete().eq('retailer', r)); await must(sb.from('profiles').update({ retailers: RETAIL.filter(x => x !== r) }).eq('id', S.user.id)); }, 'Supermarkt entfernt');
}
async function addVendor(e) { e.preventDefault(); const n = e.target.n.value.trim(); await act(() => must(sb.from('vendors').insert({ name: n })), 'Händler hinzugefügt'); }
async function delVendor(id) { if (!confirm('Händler wirklich entfernen?')) return; await act(() => must(sb.from('vendors').delete().eq('id', id)), 'Händler entfernt'); }
async function setVendorNet(id, net) { await act(() => must(sb.from('vendors').update({ prices_net: net }).eq('id', id))); }
async function setVendorPrice(vid, pid, v) {
  const n = toNum(v);
  await act(() => n == null ? must(sb.from('vendor_prices').delete().match({ vendor_id: vid, product_id: pid }))
    : must(sb.from('vendor_prices').upsert({ vendor_id: vid, product_id: pid, price: n, updated_at: new Date().toISOString() }, { onConflict: 'vendor_id,product_id' })));
}
async function importVendorBulk(vid) {
  const ta = $('#vbulk' + vid); if (!ta) return; const ve = vendors.find(v => v.id === vid); const rows = [];
  for (const l of ta.value.split('\n').map(l => l.trim()).filter(Boolean)) {
    const [name, price] = l.split(/[;\t]/).map(s => s.trim()); const p = products.find(x => x.name.toLowerCase() === (name || '').toLowerCase()), n = toNum(price);
    if (p && n != null) rows.push({ vendor_id: vid, product_id: p.id, price: n, updated_at: new Date().toISOString() });
  }
  if (!rows.length) return toast('Keine bekannten Produkte gefunden – Namen müssen genau passen');
  await act(() => must(sb.from('vendor_prices').upsert(rows, { onConflict: 'vendor_id,product_id' })), rows.length + ' Preise bei ' + ve.name + ' aktualisiert');
}
function importVendorFile(e, vid) { const f = e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => { const ta = $('#vbulk' + vid); if (ta) { ta.value = r.result; importVendorBulk(vid); } }; r.readAsText(f); }

/* ---------- Auswahl + Einkaufsliste ---------- */
function cardClick(e, id) { if (e.target && e.target.closest && e.target.closest('input,button,summary,label,select,textarea,a,details')) return; toggleSelect(id); }
function toggleSelect(id) { selected = toggleIn(selected, id); document.querySelectorAll('[data-pid="' + id + '"]').forEach(el => el.classList.toggle('sel', selected.includes(id))); updateSelBar(); }
function updateSelBar() {
  const b = $('#selbar'); if (!b) return;
  if (!selected.length || !S.user) { b.classList.remove('show'); b.innerHTML = ''; return; }
  b.classList.add('show');
  b.innerHTML = `<span class="selcount">🛒 ${selected.length} ausgewählt</span><span class="row"><button onclick="addSelectedToCart()">Zur Einkaufsliste</button><button class="ghost" onclick="clearSel()" aria-label="Auswahl aufheben">✕</button></span>`;
}
function clearSel() { selected = []; render(); }
async function addSelectedToCart() {
  const ids = selected.filter(id => !cart.some(c => c.pid === id)); selected = [];
  await act(() => ids.length ? must(sb.from('cart_items').insert(ids.map(id => ({ product_id: id })))) : Promise.resolve(), '🛒 ' + ids.length + (ids.length === 1 ? ' Produkt' : ' Produkte') + ' zur Einkaufsliste hinzugefügt');
}
const cartUpd = (id, patch) => must(sb.from('cart_items').update(patch).match({ user_id: S.user.id, product_id: id }));
async function toggleCheck(id) { const c = S.cart.find(c => c.product_id === id); c.checked = !c.checked; buildIndex(); render(); try { await cartUpd(id, { checked: c.checked }); } catch (e) { toast('⚠️ ' + e.message); } }
async function setQty(id, v) { await act(() => cartUpd(id, { qty: v })); }
let noteTimers = {};
function setNote(id, v) { const c = S.cart.find(c => c.product_id === id); c.note = v; clearTimeout(noteTimers[id]); noteTimers[id] = setTimeout(() => cartUpd(id, { note: v }).catch(e => toast('⚠️ ' + e.message)), 600); }
function toggleNote(id) { noteOpen.has(id) ? noteOpen.delete(id) : noteOpen.add(id); buildIndex(); render(); const t = $('#note' + id); t && t.focus(); }
async function rmCart(id) { await act(() => must(sb.from('cart_items').delete().match({ user_id: S.user.id, product_id: id }))); }
async function clearDone() { await act(() => must(sb.from('cart_items').delete().match({ user_id: S.user.id, checked: true }))); }
function cartView() {
  const ids = fp().map(x => x.id), shown = cart.filter(c => ids.includes(c.pid));
  let total = 0; const done = shown.filter(c => c.checked).length;
  const rows = shown.map(c => {
    const x = prod(c.pid), b = allOffers(x.id)[0], qn = toNum(c.qty);
    if (b) total += (qn > 0 ? qn : 1) * conv(b.price, x.vat);
    return `<div class="citem${c.checked ? ' done' : ''}" style="--cc:${catColor(x.cat)}"><div class="crow">
      <input type="checkbox" class="chk" ${c.checked ? 'checked' : ''} onchange="toggleCheck(${x.id})" aria-label="Abhaken">
      <div class="cinfo"><div class="pname">${catEmoji(x.cat)} ${esc(x.name)}</div><div class="pmeta">${esc(x.unit)}${b ? ` · 🏆 ${esc(b.name)} ${fmt(b.price, x.vat)}` : ''}</div></div>
      <div class="cacts"><button type="button" class="iconbtn${c.note ? ' has' : ''}" onclick="toggleNote(${x.id})" aria-label="Kommentar">💬</button>
        <input class="qty" inputmode="decimal" placeholder="Menge" value="${esc(c.qty)}" onchange="setQty(${x.id},this.value)" aria-label="Menge">
        <button type="button" class="iconbtn" onclick="rmCart(${x.id})" aria-label="Entfernen">🗑️</button></div></div>
      ${noteOpen.has(x.id) ? `<textarea id="note${x.id}" class="note" placeholder="Kommentar…" oninput="setNote(${x.id},this.value)">${esc(c.note)}</textarea>` : ''}</div>`;
  }).join('');
  return `${filterBox()}
  <section class="dash-block"><h2>🛒 Einkaufsliste</h2>
  ${cart.length ? `<div class="cartsum"><span>🧾 ${done}/${shown.length} abgehakt</span><b>ca. ${eur(total)}</b></div>
    ${rows || '<p class="muted">Keine Artikel für diese Filter.</p>'}
    ${cart.some(c => c.checked) ? '<button class="ghost sm" style="margin-top:10px" onclick="clearDone()">✔️ Abgehakte entfernen</button>' : ''}`
    : '<p class="muted">Deine Einkaufsliste ist leer. Tippe im Dashboard oder unter „Produkte“ auf Artikel und dann oben auf „Zur Einkaufsliste“.</p>'}</section>`;
}

/* =====================================================================
   Menü + Unterseiten
   ===================================================================== */
function openMenu(on) { $('#menu').classList.toggle('show', on); $('#menuOverlay').classList.toggle('show', on); $('#menu').setAttribute('aria-hidden', !on); }
function openPage(p) { openMenu(false); if (!tab.startsWith('page:')) prevTab = tab; go('page:' + p); }
function back() { go(prevTab); }
function fld(k, label, type = 'text', ph = '', extra = '') { return `<label class="field">${label}<input name="${k}" type="${type}" value="${esc(S.profile[k] || '')}" placeholder="${esc(ph)}" ${extra}></label>`; }
async function saveForm(e) { e.preventDefault(); const patch = Object.fromEntries(new FormData(e.target)); await saveProfile(patch, '✅ Gespeichert'); }
async function changePw(e) {
  e.preventDefault(); const pw = e.target.pw.value;
  await act(async () => { const { error } = await sb.auth.updateUser({ password: pw }); if (error) throw error; e.target.reset(); }, '✅ Passwort geändert');
}
async function setNotify(k, v) { await saveProfile({ notify: { ...S.profile.notify, [k]: v } }); }
function pageView(p) {
  const head = t => `<button class="page-back" onclick="back()">‹ Zurück</button><h2 style="margin-top:.6rem">${t}</h2>`;
  if (p === 'konto') return head('👤 Kontodaten') + `<form class="pcard" onsubmit="saveForm(event)" style="margin-bottom:10px">
    ${fld('name', 'Name')}<label class="field">E-Mail<input value="${esc(S.user.email)}" disabled></label>${fld('phone', 'Telefon', 'tel', '+49 …')}
    <button>Speichern</button></form>
    <form class="pcard" onsubmit="changePw(event)"><label class="field">Neues Passwort<input name="pw" type="password" minlength="8" autocomplete="new-password" required></label><button class="ghost">Passwort ändern</button></form>`;
  if (p === 'laden') return head('🏪 Mein Laden') + `<form class="pcard" onsubmit="saveForm(event)">
    ${fld('shop_name', 'Name des Ladens')}${fld('street', 'Straße & Hausnummer')}
    <div class="row" style="flex-wrap:nowrap"><div style="flex:0 0 110px">${fld('zip', 'PLZ', 'text', '68159', 'inputmode="numeric" pattern="[0-9]{5}" required')}</div><div style="flex:1">${fld('city', 'Ort')}</div></div>
    ${fld('vat_id', 'USt-IdNr. (für Großhandel)', 'text', 'DE…')}
    <p class="sub" style="margin:0 0 10px">Mit der Postleitzahl sucht die App jeden Morgen die Prospekt-Angebote der Supermärkte in deiner Nähe.</p>
    <button>Speichern</button></form>`;
  if (p === 'benachrichtigungen') {
    const n = S.profile.notify || {}, t = (k, l, d) => `<label class="row between" style="padding:8px 0;border-bottom:1px dashed var(--line)"><span><b style="font-weight:600">${l}</b><br><span class="sub">${d}</span></span><input type="checkbox" class="chk" ${n[k] ? 'checked' : ''} onchange="setNotify('${k}',this.checked)"></label>`;
    return head('🔔 Benachrichtigungen') + `<div class="pcard">${t('deals', 'Neue Top-Angebote', 'Wenn ein Angebot günstiger ist als dein Großhändler')}${t('drops', 'Preissenkungen', 'Wenn ein Produkt deutlich billiger wird')}${t('weekly', 'Wochenübersicht', 'Jeden Montag die Angebote der Woche')}
    <p class="sub small" style="margin:8px 0 0">Deine Auswahl wird gespeichert. Der Versand der Benachrichtigungen kommt in einer späteren Version.</p></div>`;
  }
  if (p === 'einstellungen') return head('⚙️ Einstellungen') + `<div class="pcard">
    <label class="row between" style="padding:6px 0"><span>Preise standardmäßig netto anzeigen</span><input type="checkbox" class="chk" ${S.profile.net_default ? 'checked' : ''} onchange="netMode=this.checked;saveProfile({net_default:this.checked},'Gespeichert')"></label></div>`;
  if (p === 'support') {
    const mail = CFG.SUPPORT_EMAIL;
    return head('💬 Hilfe &amp; Support') + `
    <div class="pcard" style="margin-bottom:10px"><b>Häufige Fragen</b>
    ${[['Woher kommen die Supermarktpreise?', 'Jeden Morgen durchsucht die App die aktuellen Prospekt-Angebote der Supermärkte rund um deine Postleitzahl. Normalpreise, die nicht online stehen, kannst du beim Produkt selbst eintragen.'],
       ['Warum findet die App ein Produkt nicht?', 'Prospekte enthalten nur Angebote. Wenn gerade niemand dein Produkt im Angebot hat, gibt es nichts zu finden. Hilft das nicht, trag beim Produkt einen kürzeren Suchbegriff ein.'],
       ['Ein Angebot passt nicht zu meinem Produkt.', 'Tippe beim Produkt unter „Preise anzeigen“ auf „Falscher Treffer“. Es wird dann nicht mehr berücksichtigt.'],
       ['Warum wird ein Kasten auf Flaschenpreis umgerechnet?', 'Damit du fair vergleichen kannst: Alle Preise gelten pro Einheit (z. B. pro Flasche). Der Packungspreis steht klein daneben.'],
       ['Was bedeutet Brutto/Netto?', 'Netto zeigt die Preise ohne Mehrwertsteuer (7 % bzw. 19 % je Produkt) – praktisch für den Vergleich mit Großhandelspreisen.']]
      .map(([q, a]) => `<details class="pricedrop"><summary>${q}</summary><p class="sub">${a}</p></details>`).join('')}</div>
    <div class="pcard"><b>Nachricht an den Support</b><textarea id="supportMsg" class="note" placeholder="Wie können wir helfen?" style="margin:8px 0"></textarea>
    ${mail ? `<button onclick="location.href='mailto:${esc(mail)}?subject=CornerstoreAI%20Support&body='+encodeURIComponent($('#supportMsg').value)">✉️ Per E-Mail senden</button>` : '<p class="sub" style="margin:0">Support-Adresse noch nicht eingerichtet (config.js).</p>'}</div>`;
  }
  if (p === 'rechtliches') return head('📄 Datenschutz &amp; Impressum') + `<div class="pcard"><details class="pricedrop" style="border:0;margin:0;padding:0"><summary>Datenschutzerklärung</summary><p class="sub">Platzhalter – muss vor der Freigabe für andere Nutzer ergänzt werden.</p></details><details class="pricedrop"><summary>Impressum</summary><p class="sub">Platzhalter – muss vor der Freigabe für andere Nutzer ergänzt werden.</p></details><details class="pricedrop"><summary>Nutzungsbedingungen</summary><p class="sub">Platzhalter.</p></details>
    <button class="ghost sm" style="margin-top:12px;color:var(--hot)" onclick="deleteAccountInfo()">Konto löschen</button></div>`;
  return head('Seite') + '<p class="muted">Kommt bald.</p>';
}
function deleteAccountInfo() { toast('Zum Löschen bitte an den Support schreiben – die Funktion kommt in einer späteren Version.'); }
document.addEventListener('keydown', e => { if (e.key === 'Escape') openMenu(false); });

/* =====================================================================
   Start
   ===================================================================== */
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
if (sb) {
  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') { authMode = 'recover'; S.user = session?.user || null; render(); return; }
    const uid = session?.user?.id;
    if (event === 'SIGNED_IN' && uid && uid !== S.user?.id) setTimeout(startSession, 0);
    if (event === 'SIGNED_OUT') { S.user = null; render(); }
  });
  startSession();
} else render();
