/* Page d'un événement : Aperçu, Invités, Scanner, Suivi (superviseur/admin), Gérer (admin). */
import { $, $$, esc, icon, api, toast, sheet, sheetHead, busy, dateFr, initials, plural, norm, roleLabel, methodLabel, pct, meter, ring, animateRings, empty, skeletons, shellHTML, setActiveTab, setBadge, rel, clock, parseTs, feedback, uuid, debounce, watchScroll } from './core.js';
import { cache, queue } from './offline.js';
import { mountScanner } from './scanner.js';

const STATUS = { draft: 'Brouillon', active: 'En cours', closed: 'Terminé' };
const DEC = { review: ['À examiner', 'warn'], pending: ['À examiner', 'warn'], approve: ['Approuvée', 'ok'], approved: ['Approuvée', 'ok'], reject: ['Rejetée', 'bad'], rejected: ['Rejetée', 'bad'] };

export class EventView {
  constructor(id, user) {
    this.id = id; this.user = user; this.role = user.role; this.tab = null;
    this.detail = null; this.dash = null; this.activity = null; this.exceptions = null; this.agents = null;
    this.stale = false; this.scanner = null; this.timer = null;
    this.g = { q: '', status: 'tous', type: 'tous', shown: 40 }; this.seg = 'agents'; this.exFilter = 'tous';
  }
  get isAdmin() { return this.role === 'admin'; }
  get canFollow() { return this.role === 'supervisor' || this.isAdmin; }
  get tabs() {
    const t = {
      apercu: { id: 'apercu', label: 'Aperçu', icon: 'home', href: '#apercu' },
      invites: { id: 'invites', label: 'Invités', icon: 'list', href: '#invites' },
      scan: { id: 'scan', label: 'Scanner', icon: 'scan', href: '#scan', scan: true },
      suivi: { id: 'suivi', label: 'Suivi', icon: 'pulse', href: '#suivi' },
      gerer: { id: 'gerer', label: 'Gérer', icon: 'sliders', href: '#gerer' },
    };
    if (this.isAdmin) return [t.apercu, t.invites, t.scan, t.suivi, t.gerer];
    if (this.role === 'supervisor') return [t.apercu, t.invites, t.scan, t.suivi];
    return [t.apercu, t.scan, t.invites];
  }

  mount(app) {
    this.app = app;
    app.innerHTML = shellHTML({
      tabs: this.tabs, active: '', title: 'Événement',
      back: `<a class="btn icon ghost" href="/" data-link aria-label="Retour aux événements">${icon('back')}</a>`,
      actions: `<button class="btn icon ghost" data-act="reload" aria-label="Actualiser">${icon('refresh', 'sm')}</button>`,
    });
    this.view = $('#view'); watchScroll();
    this.onClick = e => this.click(e); this.view.addEventListener('click', this.onClick);
    this.onNet = () => { this.updateNet(); if (navigator.onLine) this.refresh(true); };
    addEventListener('online', this.onNet); addEventListener('offline', this.onNet);
    this.onQueue = async () => setBadge('scan', await this.queueCount());
    document.addEventListener('ia:queue', this.onQueue);
    this.view.innerHTML = `<div class="col" style="margin-top:8px">${skeletons(1, 250)}${skeletons(2, 80)}</div>`;
    this.ready = this.load().then(ok => { if (ok) this.setTab(this.tab || ''); });
    this.timer = setInterval(() => { if (!document.hidden && navigator.onLine && this.detail) this.refresh(true); }, 15000);
    this.onQueue();
  }
  destroy() {
    clearInterval(this.timer); this.scanner?.destroy(); this.scanner = null;
    this.view?.removeEventListener('click', this.onClick);
    removeEventListener('online', this.onNet); removeEventListener('offline', this.onNet);
    document.removeEventListener('ia:queue', this.onQueue);
  }
  async queueCount() { return (await queue.all()).filter(i => i.event_id === this.id).length; }

  /* ---------- Données ---------- */
  async load() {
    try {
      this.detail = await api(`/admin/api/events/${this.id}`); this.stale = false; cache.set(this.id, this.detail);
      await this.loadDash();
    } catch (e) {
      const c = cache.get(this.id);
      if (e.network && c) { this.detail = c.data; this.stale = true; this.cachedAt = c.at; }
      else { this.view.innerHTML = empty(e.status === 403 ? 'shield' : 'wifioff', e.status === 403 ? 'Événement non attribué' : e.status === 404 ? 'Événement introuvable' : 'Chargement impossible', e.message, `<a class="btn primary" href="/" data-link>Retour aux événements</a>`); return false; }
    }
    $('#barTitle').innerHTML = `${esc(this.detail.name)}<span class="sub ellipsis">${esc(dateFr(this.detail.event_date, false))}${this.detail.venue ? ', ' + esc(this.detail.venue) : ''}</span>`;
    document.title = this.detail.name + ' — Invitations';
    return true;
  }
  async loadDash() {
    if (this.isAdmin) { try { this.activity = await api(`/supervisor/api/events/${this.id}/activity`); } catch (e) { if (!e.network) this.activity = []; } return; }
    try { this.dash = await api(`/supervisor/api/events/${this.id}/dashboard`); } catch (e) { if (!e.network) this.dash = null; }
  }
  async refresh(silent) {
    try {
      this.detail = await api(`/admin/api/events/${this.id}`); this.stale = false; cache.set(this.id, this.detail); await this.loadDash();
      if (this.canFollow && this.tab === 'suivi') await this.loadFollow();
    } catch (e) { if (!silent) toast(e.network ? 'Hors ligne : données du dernier chargement.' : e.message, 'bad'); this.stale = !!e.network; }
    this.updateNet();
    if (this.tab === 'apercu') this.renderOverview(); else if (this.tab === 'invites') this.paintGuests(); else if (this.tab === 'suivi') this.paintFollow();
    else if (this.tab === 'gerer' && !silent) this.renderManage();
  }
  invs() { return this.detail?.invitations || []; }
  stats() {
    const inv = this.invs(), S = { count: inv.length, expected: 0, entered: 0, arrived: 0, complete: 0, partial: 0, types: {}, tables: {} };
    for (const i of inv) {
      S.expected += i.quota; S.entered += i.entered; if (i.entered > 0) S.arrived++; if (i.remaining === 0) S.complete++; else if (i.entered > 0) S.partial++;
      const t = (S.types[i.invitation_type] ||= { n: 0, q: 0, e: 0 }); t.n++; t.q += i.quota; t.e += i.entered;
      if (i.table_name) { const b = (S.tables[i.table_name] ||= { q: 0, e: 0 }); b.q += i.quota; b.e += i.entered; }
    }
    S.remaining = Math.max(0, S.expected - S.entered); S.pct = pct(S.entered, S.expected); return S;
  }

  /* ---------- Navigation d'onglets ---------- */
  setTab(t) {
    if (!this.detail) { this.tab = t; return; }
    const ids = this.tabs.map(x => x.id);
    if (!ids.includes(t)) t = this.role === 'agent' ? 'scan' : 'apercu';
    const changed = t !== this.tab; this.tab = t; setActiveTab(t);
    if (this.scanner && t !== 'scan') { this.scanner.destroy(); this.scanner = null; }
    if (!changed && this.view.dataset.tab === t) return;
    this.view.dataset.tab = t; scrollTo(0, 0);
    ({ apercu: () => this.renderOverview(), invites: () => this.renderGuests(), scan: () => this.renderScan(), suivi: () => this.renderFollow(), gerer: () => this.renderManage() })[t]();
  }
  updateNet() {
    const l = $('.live', this.view); if (!l) return;
    const off = !navigator.onLine || this.stale; l.classList.toggle('off', off);
    l.lastChild.textContent = off ? (this.cachedAt ? 'Données du ' + rel(new Date(this.cachedAt)) : 'Hors ligne') : 'En direct';
  }

  /* ---------- Aperçu ---------- */
  async renderOverview() {
    const d = this.detail, S = this.stats(), v = this.view; v.dataset.tab = 'apercu';
    const off = !navigator.onLine || this.stale, q = await this.queueCount();
    const types = Object.entries(S.types).sort((a, b) => b[1].q - a[1].q), tables = Object.entries(S.tables).sort((a, b) => b[1].e - a[1].e || b[1].q - a[1].q).slice(0, 8);
    const recent = this.dash?.recent_entries || [];
    v.innerHTML = `<div class="col loose" style="margin-top:8px">
      <section class="hero"><div class="row between"><span class="live ${off ? 'off' : ''}"><i></i><span>${off ? (this.cachedAt ? 'Données du ' + rel(new Date(this.cachedAt)) : 'Hors ligne') : 'En direct'}</span></span>${d.status && d.status !== 'draft' ? `<span class="badge" style="background:rgba(255,255,255,.16);color:#fff">${esc(STATUS[d.status] || d.status)}</span>` : ''}</div>
        <h1 style="margin-top:12px">${esc(d.name)}</h1>
        <p class="muted small row wrap" style="margin-top:4px;gap:4px 14px"><span class="row" style="gap:5px">${icon('calendar', 'sm')}${esc(dateFr(d.event_date))}</span>${d.venue ? `<span class="row" style="gap:5px">${icon('pin', 'sm')}${esc(d.venue)}</span>` : ''}</p>
        <div class="hero-grid">${ring(S.pct)}<div class="kpis"><div class="kpi"><strong class="num">${S.entered}</strong><span>Présents</span></div><div class="kpi"><strong class="num">${S.remaining}</strong><span>Restants</span></div><div class="kpi"><strong class="num">${S.expected}</strong><span>Attendus</span></div><div class="kpi"><strong class="num">${S.count}</strong><span>Invitations</span></div></div></div></section>
      ${q ? `<a class="banner info" href="#scan" data-link>${icon('clock', 'sm')}<span class="grow">${plural(q, 'contrôle')} en attente de synchronisation</span><strong>Voir</strong></a>` : ''}
      <div class="tiles"><div class="tile"><strong class="num">${S.arrived}<span class="faint" style="font-size:.95rem"> / ${S.count}</span></strong><span>Invitations arrivées</span></div><div class="tile"><strong class="num">${S.complete}</strong><span>Invitations complètes</span></div></div>
      ${!S.count ? `<div class="card">${empty('upload', 'Aucune invitation', this.isAdmin ? 'Importez la liste des invités pour démarrer.' : 'La liste des invités n’a pas encore été importée.', this.isAdmin ? '<a class="btn primary" href="#gerer" data-link>Importer les invités</a>' : '')}</div>` : ''}
      ${types.length > 1 ? `<section class="card col"><h2 style="font-size:1.05rem">Par type d’invitation</h2><div class="bars">${types.map(([k, t]) => `<div class="bar-row"><span class="ellipsis">${esc(k)}</span>${meter(t.e, t.q)}<span class="num small muted">${t.e}/${t.q}</span></div>`).join('')}</div></section>` : ''}
      ${tables.length ? `<section class="card col"><h2 style="font-size:1.05rem">Tables</h2><div class="bars">${tables.map(([k, t]) => `<div class="bar-row"><span class="ellipsis">Table ${esc(k)}</span>${meter(t.e, t.q)}<span class="num small muted">${t.e}/${t.q}</span></div>`).join('')}</div></section>` : ''}
      ${this.isAdmin ? this.activityCard() : `<section class="card"><div class="row between"><h2 style="font-size:1.05rem">Dernières entrées</h2><span class="tiny faint">${recent.length ? 'Les ' + recent.length + ' plus récentes' : ''}</span></div>${recent.length ? `<div class="feed">${recent.map(r => `<div class="f"><div class="dot">+${r.quantity}</div><div class="grow"><div class="title ellipsis" style="font-weight:650">${esc(r.guest_name)}</div><div class="small muted row wrap" style="gap:2px 10px"><span>${esc(r.reference)}</span><span>${esc(r.agent)}</span><span class="badge">${methodLabel(r.method)}</span></div></div><div class="tiny faint" style="text-align:right">${clock(r.created_at)}<br>${rel(r.created_at)}</div></div>`).join('')}</div>` : empty('ticket', 'Aucune entrée pour l’instant', 'Les entrées apparaissent ici dès qu’un contrôle est enregistré.')}</section>`}
    </div>`;
    animateRings(v);
  }
  activityCard() {
    const a = this.activity || [];
    return `<section class="card"><h2 style="font-size:1.05rem">Activité des agents</h2>${a.length ? `<div class="feed">${[...a].sort((x, y) => (y.last_activity || '').localeCompare(x.last_activity || '')).map(x => `<div class="f"><div class="dot" style="background:var(--brand-soft);color:var(--brand)">${esc(initials(x.full_name))}</div><div class="grow"><div class="title" style="font-weight:650">${esc(x.full_name)}</div><div class="small muted">${plural(x.entries, 'contrôle')} pour ${plural(x.people, 'personne')}</div></div><span class="tiny faint">${rel(x.last_activity)}</span></div>`).join('')}</div>` : empty('pulse', 'Aucune activité', 'Les contrôles des agents apparaîtront ici.')}</section>`;
  }

  /* ---------- Invités ---------- */
  renderGuests() {
    const S = this.stats(), types = Object.keys(S.types); this.view.dataset.tab = 'invites';
    this.view.innerHTML = `<div class="col" style="margin-top:8px">
      <div class="searchbox">${icon('search', 'sm')}<input class="input" id="gq" type="search" placeholder="Nom, référence ou table" value="${esc(this.g.q)}" aria-label="Rechercher un invité" autocomplete="off"></div>
      <div class="chips" id="gChips" role="group" aria-label="Filtrer par état"></div>
      ${types.length > 1 ? `<div class="chips" id="gTypes" role="group" aria-label="Filtrer par type"></div>` : ''}
      <p class="small muted" id="gCount" aria-live="polite"></p>
      <div class="list" id="gList"></div><button class="btn ghost block hidden" id="gMore">Afficher plus</button></div>`;
    $('#gq').addEventListener('input', debounce(e => { this.g.q = e.target.value; this.g.shown = 40; this.paintGuests(); }, 140));
    $('#gMore').onclick = () => { this.g.shown += 60; this.paintGuests(); };
    this.paintGuests();
  }
  paintGuests() {
    if (!$('#gList')) return;
    const all = this.invs(), q = norm(this.g.q);
    const st = i => i.remaining === 0 ? 'complets' : i.entered > 0 ? 'encours' : 'attendus';
    const base = all.filter(i => (this.g.type === 'tous' || i.invitation_type === this.g.type) && (!q || norm(`${i.guest_name} ${i.reference} ${i.table_name}`).includes(q)));
    const count = k => base.filter(i => k === 'tous' || st(i) === k).length;
    $('#gChips').innerHTML = [['tous', 'Tous'], ['attendus', 'Attendus'], ['encours', 'En cours'], ['complets', 'Complets']].map(([k, l]) => `<button class="chip" data-gs="${k}" aria-pressed="${this.g.status === k}">${l} <span class="n num">${count(k)}</span></button>`).join('');
    const tc = $('#gTypes'); if (tc) tc.innerHTML = ['tous', ...Object.keys(this.stats().types)].map(k => `<button class="chip" data-gt="${esc(k)}" aria-pressed="${this.g.type === k}">${k === 'tous' ? 'Tous les types' : esc(k)}</button>`).join('');
    const rows = base.filter(i => this.g.status === 'tous' || st(i) === this.g.status);
    $('#gCount').textContent = rows.length === all.length ? plural(all.length, 'invitation') : `${plural(rows.length, 'résultat')} sur ${all.length}`;
    $('#gList').innerHTML = rows.length ? rows.slice(0, this.g.shown).map(i => `<button class="item" data-guest="${i.id}"><div class="avatar ${i.remaining === 0 ? 'done' : i.entered > 0 ? 'part' : ''}">${i.remaining === 0 ? icon('check', 'sm') : esc((i.guest_name || '?')[0].toUpperCase())}</div><div class="grow"><div class="title ellipsis">${esc(i.guest_name)}</div><div class="meta"><span>${esc(i.reference)}</span><span>${esc(i.invitation_type)}</span>${i.table_name ? `<span>${icon('table', 'sm')}${esc(i.table_name)}</span>` : ''}</div></div><div class="qty num">${i.entered}/${i.quota}<small>entrés</small></div></button>`).join('') : (all.length ? empty('search', 'Aucun invité trouvé', 'Essayez un autre nom, une référence ou changez de filtre.') : empty('list', 'Aucune invitation', this.isAdmin ? 'Importez la liste depuis l’onglet Gérer.' : ''));
    $('#gMore').classList.toggle('hidden', rows.length <= this.g.shown); $('#gMore').textContent = `Afficher plus (${rows.length - this.g.shown} restants)`;
  }
  openGuest(id) {
    const i = this.invs().find(x => x.id === id); if (!i) return;
    const online = navigator.onLine; let qty = 1;
    const d = sheet(`<div class="sheet-head" style="padding:6px 18px 0"><div class="grow"><h2>${esc(i.guest_name)}</h2><div class="row wrap" style="margin-top:6px"><span class="badge brand">${esc(i.reference)}</span><span class="badge">${esc(i.invitation_type)}</span>${i.table_name ? `<span class="badge cobalt">${icon('table', 'sm')}Table ${esc(i.table_name)}</span>` : ''}</div></div><button class="btn icon ghost" data-close aria-label="Fermer">${icon('x')}</button></div>
      <div class="sheet-body">
        <div class="col tight">${meter(i.entered, i.quota)}<p class="small muted num">${i.entered} sur ${i.quota} entrés, ${i.remaining} restant${i.remaining > 1 ? 's' : ''}</p></div>
        ${i.remaining > 0 ? (online ? `${i.remaining > 1 ? `<div class="stepper"><button id="m" aria-label="Moins">−</button><output id="q" class="num">1</output><button id="p" aria-label="Plus">+</button></div>` : ''}<div id="ge"></div><button class="btn primary block" id="go" style="min-height:56px;font-size:1.05rem">Enregistrer 1 entrée</button>` : `<div class="banner warn">${icon('wifioff', 'sm')}<span>Hors ligne : scannez le QR code de l’invité pour mettre l’entrée en attente.</span></div>`) : `<div class="banner ok">${icon('check', 'sm')}<span>Tous les invités de cette invitation sont entrés.</span></div>`}
        ${this.role === 'supervisor' ? `<button class="btn tonal block" id="ex">${icon('flag', 'sm')}Signaler une exception</button>` : ''}</div>`);
    const upd = () => { $('#q', d) && ($('#q', d).textContent = qty); $('#go', d).textContent = `Enregistrer ${qty} entrée${qty > 1 ? 's' : ''}`; };
    $('#m', d) && ($('#m', d).onclick = () => { qty = Math.max(1, qty - 1); upd(); });
    $('#p', d) && ($('#p', d).onclick = () => { qty = Math.min(i.remaining, qty + 1); upd(); });
    $('#go', d) && ($('#go', d).onclick = async e => {
      const b = e.currentTarget; busy(b, true);
      try {
        const res = await api(`/checkin/api/events/${this.id}/entry`, { method: 'POST', json: { invitation_id: i.id, quantity: qty, method: 'manual', idempotency_key: uuid() } });
        feedback('ok'); toast(`${res.reference} : ${plural(qty, 'entrée')} enregistrée${qty > 1 ? 's' : ''}.`, 'ok'); this.onEntry(i.id, res); d.close();
      } catch (err) { busy(b, false); feedback('bad'); $('#ge', d).innerHTML = `<div class="banner bad" role="alert">${icon('alert', 'sm')}<span>${esc(err.message)}</span></div>`; if (err.status === 409) this.refresh(true); }
    });
    $('#ex', d) && ($('#ex', d).onclick = () => { d.close(); this.exceptionSheet(i); });
  }
  onEntry(invId, res) {
    const i = invId && this.invs().find(x => x.id === invId);
    if (i && res) { i.entered = res.entered; i.remaining = res.remaining; cache.set(this.id, this.detail); }
    if (this.tab === 'invites') this.paintGuests();
    this.refresh(true);
  }

  /* ---------- Scanner ---------- */
  renderScan() {
    this.view.dataset.tab = 'scan'; this.view.innerHTML = '<div style="margin-top:8px" id="scanRoot"></div>';
    this.scanner = mountScanner($('#scanRoot'), { eventId: this.id, role: this.role, cached: () => this.invs(), onEntry: (id, r) => this.onEntry(id, r), exception: inv => { const i = this.invs().find(x => x.id === inv.id) || inv; this.exceptionSheet(i); } });
  }

  /* ---------- Exceptions ---------- */
  exceptionSheet(i, defaultDecision = 'review') {
    let decision = defaultDecision;
    const d = sheet(`${sheetHead('Exception', `${i.guest_name} (${i.reference})`)}<form class="sheet-body" id="xf">
      <div class="seg" role="group" aria-label="Décision">${[['review', 'À examiner'], ['approve', 'Approuver'], ['reject', 'Rejeter']].map(([k, l]) => `<button type="button" data-d="${k}" aria-pressed="${k === decision}">${l}</button>`).join('')}</div>
      <label class="field">Motif <small>8 caractères minimum, conservé dans le journal d’audit</small><textarea class="textarea" name="reason" required minlength="8" maxlength="1000" placeholder="Ex. Invité présent avec un accompagnant non prévu, accord de la famille"></textarea></label>
      <div id="xe"></div><button class="btn primary block" type="submit">Enregistrer la décision</button></form>`);
    $$('[data-d]', d).forEach(b => b.onclick = () => { decision = b.dataset.d; $$('[data-d]', d).forEach(x => x.setAttribute('aria-pressed', x === b)); });
    $('#xf', d).onsubmit = async e => {
      e.preventDefault(); const b = $('button[type=submit]', e.target); busy(b, true);
      try { await api(`/checkin/api/events/${this.id}/exceptions`, { method: 'POST', json: { invitation_id: i.id, reason: new FormData(e.target).get('reason'), decision } }); toast('Décision enregistrée.', 'ok'); d.close(); this.exceptions = null; if (this.tab === 'suivi') this.renderFollow(); else this.loadFollow(); }
      catch (err) { busy(b, false); $('#xe', d).innerHTML = `<div class="banner bad" role="alert">${icon('alert', 'sm')}<span>${esc(err.message)}</span></div>`; }
    };
  }

  /* ---------- Suivi ---------- */
  async loadFollow() {
    const [a, x, g] = await Promise.allSettled([
      api(`/supervisor/api/events/${this.id}/activity`), api(`/supervisor/api/events/${this.id}/exceptions`),
      this.isAdmin ? Promise.resolve(null) : api(`/supervisor/api/events/${this.id}/agents`)]);
    if (a.status === 'fulfilled') this.activity = a.value; if (x.status === 'fulfilled') this.exceptions = x.value; if (g.status === 'fulfilled' && g.value) this.agents = g.value;
    this.followErr = a.status === 'rejected' && x.status === 'rejected' ? (a.reason?.message || 'Erreur') : '';
    setBadge('suivi', this.groupExceptions().filter(g => g.current.status === 'pending').length);
  }
  groupExceptions() {
    const map = new Map();
    for (const e of this.exceptions || []) { if (!map.has(e.reference)) map.set(e.reference, []); map.get(e.reference).push(e); }
    return [...map.values()].map(list => { list.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')); return { current: list[0], list }; }).sort((a, b) => (b.current.created_at || '').localeCompare(a.current.created_at || ''));
  }
  async renderFollow() {
    this.view.dataset.tab = 'suivi';
    this.view.innerHTML = `<div class="col" style="margin-top:8px"><div class="seg" role="group" aria-label="Section">${[['agents', 'Agents'], ['exceptions', 'Exceptions'], ['equipe', 'Équipe']].map(([k, l]) => `<button data-seg="${k}" aria-pressed="${this.seg === k}">${l}${k === 'exceptions' ? '<span class="badge warn hidden" id="exN" style="margin-left:6px"></span>' : ''}</button>`).join('')}</div><div id="fBody" class="col">${this.activity || this.exceptions ? '' : skeletons(3, 70)}</div></div>`;
    if (!this.activity || !this.exceptions || !this.agents) await this.loadFollow();
    this.paintFollow();
  }
  paintFollow() {
    const b = $('#fBody'); if (!b) return;
    $$('[data-seg]', this.view).forEach(x => x.setAttribute('aria-pressed', x.dataset.seg === this.seg));
    const groups = this.groupExceptions(), pend = groups.filter(g => g.current.status === 'pending').length, n = $('#exN'); if (n) { n.textContent = pend; n.classList.toggle('hidden', !pend); }
    if (this.followErr) { b.innerHTML = empty('wifioff', 'Suivi indisponible', this.followErr, '<button class="btn primary" data-act="reload-follow">Réessayer</button>'); return; }
    if (this.seg === 'agents') {
      const a = [...(this.activity || [])].sort((x, y) => (y.last_activity || '').localeCompare(x.last_activity || '')), max = Math.max(1, ...a.map(x => x.people));
      b.innerHTML = a.length ? `<div class="tiles"><div class="tile"><strong class="num">${a.length}</strong><span>Agent${a.length > 1 ? 's' : ''} actif${a.length > 1 ? 's' : ''}</span></div><div class="tile"><strong class="num">${a.reduce((s, x) => s + x.entries, 0)}</strong><span>Contrôles</span></div></div>
        <div class="list">${a.map(x => `<div class="item" style="align-items:flex-start"><div class="avatar">${esc(initials(x.full_name))}</div><div class="grow col tight"><div class="row between"><div class="title">${esc(x.full_name)}</div><strong class="num">${x.people}</strong></div><div class="meter"><i style="width:${pct(x.people, max)}%"></i></div><div class="small muted row wrap" style="gap:4px 10px">${plural(x.entries, 'contrôle')}<span>Dernier contrôle ${rel(x.last_activity)}</span>${(x.methods || []).map(m => `<span class="badge">${methodLabel(m)}</span>`).join('')}</div></div></div>`).join('')}</div>` : empty('pulse', 'Aucune activité pour l’instant', 'Les contrôles de chaque agent apparaîtront ici en direct.');
    } else if (this.seg === 'exceptions') {
      const rows = groups.filter(g => this.exFilter === 'tous' || (this.exFilter === 'pending' ? g.current.status === 'pending' : g.current.status !== 'pending'));
      b.innerHTML = `<div class="chips">${[['tous', 'Toutes'], ['pending', 'À examiner'], ['done', 'Traitées']].map(([k, l]) => `<button class="chip" data-ef="${k}" aria-pressed="${this.exFilter === k}">${l}</button>`).join('')}</div>
        ${this.isAdmin ? `<div class="banner info">${icon('shield', 'sm')}<span>Les décisions sont prises par les superviseurs.</span></div>` : ''}
        <div class="list">${rows.length ? rows.map(g => { const c = g.current, [lab, cls] = DEC[c.status] || [c.status, '']; return `<div class="item" style="align-items:flex-start"><div class="avatar part">${icon('flag', 'sm')}</div><div class="grow col tight"><div class="row between"><div class="title ellipsis">${esc(c.guest_name)}</div><span class="badge ${cls}">${lab}</span></div><div class="small muted"><span>${esc(c.reference)}</span> signalé par ${esc(c.agent)}, ${rel(c.created_at)}</div><p class="small">${esc(c.reason)}</p>${g.list.length > 1 ? `<p class="tiny faint">${plural(g.list.length, 'décision')} dans l’historique</p>` : ''}${this.role === 'supervisor' && c.status === 'pending' ? `<div class="row" style="margin-top:4px"><button class="btn sm primary" data-ex-do="${esc(c.reference)}">Décider</button></div>` : ''}</div></div>`; }).join('') : empty('flag', this.exceptions?.length ? 'Rien dans cette catégorie' : 'Aucune exception', 'Les cas particuliers signalés par les superviseurs apparaîtront ici.')}</div>`;
    } else {
      const team = this.isAdmin ? (this.detail.assignments || []).map(u => ({ name: u.full_name, username: u.username, role: u.role, active: true })) : (this.agents || []);
      b.innerHTML = `<div class="list">${team.length ? team.map(u => `<div class="item"><div class="avatar">${esc(initials(u.name))}</div><div class="grow"><div class="title ellipsis">${esc(u.name)}</div><div class="meta"><span>${esc(u.username)}</span></div></div><span class="badge ${u.role === 'supervisor' ? 'brand' : ''}">${roleLabel(u.role)}</span>${u.active ? '' : '<span class="badge bad">Inactif</span>'}</div>`).join('') : empty('users', 'Aucun agent affecté')}</div>`;
    }
  }

  /* ---------- Gérer (admin) ---------- */
  renderManage() {
    const d = this.detail, S = this.stats(); this.view.dataset.tab = 'gerer';
    this.view.innerHTML = `<div class="col loose" style="margin-top:8px">
      <section class="card col"><div class="row between"><div><h2 style="font-size:1.05rem">Équipe affectée</h2><p class="small muted">${plural(d.assignments.length, 'compte')}</p></div><button class="btn sm primary" data-act="assign">${icon('plus', 'sm')}Affecter</button></div>
        <div class="list">${d.assignments.length ? d.assignments.map(u => `<div class="item"><div class="avatar">${esc(initials(u.full_name))}</div><div class="grow"><div class="title ellipsis">${esc(u.full_name)}</div><div class="meta"><span>${esc(u.username)}</span></div></div><span class="badge ${u.role === 'supervisor' ? 'brand' : ''}">${roleLabel(u.role)}</span></div>`).join('') : empty('users', 'Personne n’est affecté', 'Affectez des agents et des superviseurs pour qu’ils voient cet événement.')}</div></section>
      <section class="card col"><div><h2 style="font-size:1.05rem">Importer les invités</h2><p class="small muted">Fichier .xlsx ou .csv. Les nouvelles lignes s’ajoutent à la suite et les références existantes ne changent jamais.</p></div>
        <label class="drop" id="drop" for="file">${icon('upload', 'lg')}<strong id="fname">Choisir un fichier</strong><span class="small">Colonnes : nom, nombre, type (facultatif), table (facultatif)</span></label>
        <input type="file" id="file" class="sr-only" accept=".xlsx,.xlsm,.csv">
        <div id="imErr"></div>
        <div class="row wrap"><button class="btn primary grow" id="doImport" disabled>Importer</button><button class="btn ghost" data-act="template">${icon('download', 'sm')}Modèle CSV</button></div></section>
      <section class="card col"><div><h2 style="font-size:1.05rem">Dossier pour le designer</h2><p class="small muted">Archive ZIP : PDF de référence, manifeste Excel et un QR code PNG par invitation (${plural(S.count, 'invitation')}).</p></div>
        <button class="btn primary block" data-act="pack" ${S.count ? '' : 'disabled'}>${icon('download', 'sm')}Générer le dossier</button>
        <p class="tiny faint">Ces fichiers contiennent des données personnelles : ne les transmettez qu’au designer autorisé.</p></section></div>`;
    const f = $('#file'); f.onchange = () => { const x = f.files[0]; $('#fname').textContent = x ? `${x.name} (${Math.max(1, Math.round(x.size / 1024))} Ko)` : 'Choisir un fichier'; $('#drop').classList.toggle('has', !!x); $('#doImport').disabled = !x; $('#imErr').innerHTML = ''; };
    $('#doImport').onclick = () => this.doImport();
  }
  async doImport() {
    const x = $('#file').files[0]; if (!x) return; const b = $('#doImport'); busy(b, true); $('#imErr').innerHTML = '';
    const fd = new FormData(); fd.append('file', x);
    try {
      const r = await api(`/admin/api/events/${this.id}/import`, { method: 'POST', form: fd }); feedback('ok');
      await this.refresh(true); this.renderManage();
      sheet(`<div class="verdict ok"><div class="ico">${icon('check', 'lg')}</div><h2>${plural(r.created, 'invitation')} importée${r.created > 1 ? 's' : ''}</h2><p>${esc(r.references[0] || '')}${r.references.length > 1 ? ' à ' + esc(r.references[r.references.length - 1]) : ''}</p></div><div class="sheet-body"><p class="small muted">${esc(r.message)}</p><a class="btn primary block" href="#invites" data-link data-close>Voir les invités</a><button class="btn ghost block" data-close>Fermer</button></div>`);
    } catch (e) {
      busy(b, false); const parts = String(e.message).split(/ ; |\. /).filter(Boolean);
      $('#imErr').innerHTML = `<div class="banner bad" role="alert" style="align-items:flex-start">${icon('alert', 'sm')}<div class="col tight">${parts.slice(0, 8).map(p => `<span>${esc(p)}</span>`).join('')}</div></div>`;
    }
  }
  async assign() {
    let users; try { users = await api('/admin/api/users'); } catch (e) { toast(e.message, 'bad'); return; }
    const taken = new Set(this.detail.assignments.map(a => a.id)), free = users.filter(u => u.active && u.role !== 'admin' && !taken.has(u.id));
    const d = sheet(`${sheetHead('Affecter à l’événement', this.detail.name)}<form class="sheet-body" id="af">${free.length ? `<div class="list">${free.map(u => `<label class="item" style="cursor:pointer"><div class="avatar">${esc(initials(u.full_name))}</div><div class="grow"><div class="title">${esc(u.full_name)}</div><div class="meta"><span>${esc(u.username)}</span></div></div><span class="badge ${u.role === 'supervisor' ? 'brand' : ''}">${roleLabel(u.role)}</span><input type="checkbox" name="u" value="${u.id}" style="width:22px;height:22px;accent-color:var(--brand)"></label>`).join('')}</div><button class="btn primary block" type="submit">Affecter la sélection</button>` : empty('users', 'Tous les comptes sont déjà affectés', 'Créez un nouveau compte depuis l’onglet Équipe de l’accueil.')}</form>`);
    const form = $('#af', d); form.onsubmit = async e => {
      e.preventDefault(); const ids = [...form.querySelectorAll('input:checked')].map(i => +i.value); if (!ids.length) { toast('Sélectionnez au moins un compte.'); return; }
      const b = $('button[type=submit]', form); busy(b, true); let ok = 0;
      for (const id of ids) { try { await api(`/admin/api/events/${this.id}/assignments`, { method: 'POST', json: { user_id: id } }); ok++; } catch (err) { toast(err.message, 'bad'); } }
      d.close(); if (ok) toast(`${plural(ok, 'compte')} affecté${ok > 1 ? 's' : ''}.`, 'ok'); await this.refresh(true); this.renderManage();
    };
  }
  async pack(btn) {
    busy(btn, true);
    try {
      const r = await api(`/admin/api/events/${this.id}/designer-pack`); const blob = await r.blob();
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `event_${this.id}_designer_pack.zip`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      toast(`Dossier généré (${Math.max(1, Math.round(blob.size / 1024))} Ko).`, 'ok');
    } catch (e) { toast(e.message, 'bad'); } finally { busy(btn, false); }
  }
  template() {
    const csv = '\ufeffnom;type;nombre;table\nFamille Mukendi;groupe;4;1\nJean Kabasele;individuelle;1;2\nMarie et Paul Ilunga;couple;2;3\n';
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); a.download = 'modele_invites.csv'; document.body.appendChild(a); a.click(); a.remove();
  }

  click(e) {
    const g = e.target.closest('[data-guest]'); if (g) return this.openGuest(+g.dataset.guest);
    const gs = e.target.closest('[data-gs]'); if (gs) { this.g.status = gs.dataset.gs; this.g.shown = 40; return this.paintGuests(); }
    const gt = e.target.closest('[data-gt]'); if (gt) { this.g.type = gt.dataset.gt; this.g.shown = 40; return this.paintGuests(); }
    const sg = e.target.closest('[data-seg]'); if (sg) { this.seg = sg.dataset.seg; return this.paintFollow(); }
    const ef = e.target.closest('[data-ef]'); if (ef) { this.exFilter = ef.dataset.ef; return this.paintFollow(); }
    const xd = e.target.closest('[data-ex-do]'); if (xd) { const i = this.invs().find(x => x.reference === xd.dataset.exDo); if (i) this.exceptionSheet(i, 'approve'); return; }
    const a = e.target.closest('[data-act]'); if (!a) return;
    ({ reload: () => this.refresh(false), 'reload-follow': () => this.renderFollow(), assign: () => this.assign(), pack: () => this.pack(a), template: () => this.template() })[a.dataset.act]?.();
  }
}
