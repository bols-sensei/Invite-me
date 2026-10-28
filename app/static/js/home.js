/* Accueil : événements, équipe (administrateur), profil et préférences. */
import { $, $$, esc, icon, api, toast, sheet, sheetHead, busy, dateFr, initials, plural, norm, roleLabel, pct, meter, ring, animateRings, empty, skeletons, shellHTML, setActiveTab, setTheme, getTheme, prefs, debounce, watchScroll } from './core.js';
import { queue } from './offline.js';

export class Home {
  constructor(user) { this.user = user; this.tab = 'evenements'; this.events = null; this.users = null; this.stats = {}; this.filter = 'tous'; }

  get isAdmin() { return this.user.role === 'admin'; }
  get tabs() {
    return [{ id: 'evenements', label: 'Événements', icon: 'calendar', href: '/#evenements' },
      ...(this.isAdmin ? [{ id: 'equipe', label: 'Équipe', icon: 'users', href: '/#equipe' }] : []),
      { id: 'profil', label: 'Profil', icon: 'user', href: '/#profil' }];
  }

  mount(app) {
    this.app = app;
    app.innerHTML = shellHTML({ tabs: this.tabs, active: this.tab, title: 'Invitations', sub: roleLabel(this.user.role) });
    this.view = $('#view'); watchScroll();
    this.onClick = e => this.click(e); this.view.addEventListener('click', this.onClick);
  }
  destroy() { this.view && this.view.removeEventListener('click', this.onClick); }

  setTab(t) {
    this.tab = this.tabs.some(x => x.id === t) ? t : 'evenements';
    setActiveTab(this.tab);
    const titles = { evenements: ['Événements', roleLabel(this.user.role)], equipe: ['Équipe', 'Comptes et rôles'], profil: ['Profil', this.user.username] };
    const [t1, s1] = titles[this.tab]; $('#barTitle').innerHTML = `${esc(t1)}<span class="sub ellipsis">${esc(s1)}</span>`;
    $('#barActions').innerHTML = this.tab === 'evenements' ? `<button class="btn icon ghost" data-act="reload" aria-label="Actualiser">${icon('refresh', 'sm')}</button>` : '';
    ({ evenements: () => this.renderEvents(), equipe: () => this.renderTeam(), profil: () => this.renderProfile() })[this.tab]();
    scrollTo(0, 0);
  }

  /* ---------- Événements ---------- */
  async renderEvents(force) {
    const v = this.view;
    if (!this.events || force) {
      v.innerHTML = `<div class="col" style="margin-top:8px">${skeletons(3, 110)}</div>`;
      try {
        if (this.isAdmin) { const d = await api('/admin/api/overview'); this.events = d.events; this.userCount = d.users; }
        else this.events = (await api('/supervisor/api/events')).map(e => ({ ...e, status: '' }));
      } catch (e) { v.innerHTML = empty('wifioff', e.network ? 'Connexion indisponible' : 'Chargement impossible', e.message, '<button class="btn primary" data-act="reload">Réessayer</button>'); return; }
    }
    const today = new Date().toISOString().slice(0, 10);
    const all = this.events;
    const dated = e => e.event_date && /^\d{4}/.test(e.event_date);
    const list = all.filter(e => this.filter === 'tous' ? true : this.filter === 'avenir' ? (!dated(e) || e.event_date >= today) : (dated(e) && e.event_date < today));
    const hello = (this.user.full_name || this.user.username || '').split(' ')[0];
    v.innerHTML = `<div class="col loose" style="margin-top:8px">
      <section><h1>Bonjour ${esc(hello)}</h1><p class="muted">${this.isAdmin ? 'Créez vos événements, importez les invités et suivez les entrées.' : 'Choisissez un événement pour contrôler les accès.'}</p></section>
      ${this.isAdmin ? `<div class="tiles"><div class="tile"><strong class="num">${all.length}</strong><span>Événement${all.length > 1 ? 's' : ''}</span></div><div class="tile"><strong class="num">${all.reduce((a, e) => a + (e.invitations || 0), 0)}</strong><span>Invitations au total</span></div></div>
      <button class="btn primary block" data-act="new-event">${icon('plus', 'sm')}Nouvel événement</button>` : ''}
      ${all.length > 2 ? `<div class="chips" role="group" aria-label="Filtrer">${[['tous', 'Tous'], ['avenir', 'À venir'], ['passes', 'Passés']].map(([k, l]) => `<button class="chip" aria-pressed="${this.filter === k}" data-filter="${k}">${l}</button>`).join('')}</div>` : ''}
      <div class="col" id="evList">${list.length ? list.map(e => this.eventCard(e)).join('') : (all.length ? empty('calendar', 'Aucun événement dans cette catégorie') : (this.isAdmin ? empty('calendar', 'Aucun événement pour l’instant', 'Créez votre premier événement, puis importez la liste des invités.') : empty('shield', 'Aucun événement affecté', 'Demandez à l’administrateur de vous affecter à un événement.')))}</div></div>`;
    animateRings(v);
    if (this.isAdmin) this.loadStats(list);
  }
  eventCard(e) {
    const s = this.stats[e.id] || (e.expected != null ? { expected: e.expected, entered: e.entered } : null);
    const p = s ? pct(s.entered, s.expected) : 0;
    return `<a class="event-card" href="/event/${e.id}" data-link data-ev="${e.id}">
      <div class="row between"><span class="date">${esc(dateFr(e.event_date, false))}</span>${e.status && e.status !== 'draft' ? `<span class="badge ${e.status === 'active' ? 'ok' : ''}">${esc(({ draft: 'Brouillon', active: 'En cours', closed: 'Terminé' })[e.status] || e.status)}</span>` : ''}</div>
      <div><h3 style="font-size:1.12rem">${esc(e.name)}</h3><p class="small muted row" style="margin-top:3px">${e.venue ? icon('pin', 'sm') + esc(e.venue) : '<span class="faint">Lieu à définir</span>'}</p></div>
      <div data-prog>${s && s.expected ? `${meter(s.entered, s.expected)}<div class="row between small" style="margin-top:6px"><span class="muted num">${s.entered} entrée${s.entered > 1 ? 's' : ''} sur ${s.expected}</span><strong class="num">${p}%</strong></div>` : `<p class="small muted">${plural(e.invitations || 0, 'invitation')}</p>`}</div></a>`;
  }
  async loadStats(list) {                       // l'aperçu admin ne donne pas les entrées : on lit le détail de chaque événement
    const todo = list.filter(e => !this.stats[e.id]).slice(0, 24);
    await Promise.allSettled(todo.map(async e => {
      const d = await api(`/admin/api/events/${e.id}`);
      this.stats[e.id] = { expected: d.invitations.reduce((a, i) => a + i.quota, 0), entered: d.invitations.reduce((a, i) => a + i.entered, 0) };
      const card = $(`[data-ev="${e.id}"] [data-prog]`, this.view);
      if (card) { const s = this.stats[e.id]; card.innerHTML = s.expected ? `${meter(s.entered, s.expected)}<div class="row between small" style="margin-top:6px"><span class="muted num">${s.entered} entrée${s.entered > 1 ? 's' : ''} sur ${s.expected}</span><strong class="num">${pct(s.entered, s.expected)}%</strong></div>` : `<p class="small muted">Aucune invitation importée</p>`; }
    }));
  }

  /* ---------- Équipe ---------- */
  async renderTeam(force) {
    const v = this.view;
    if (!this.users || force) {
      v.innerHTML = `<div class="col" style="margin-top:8px">${skeletons(4, 64)}</div>`;
      try { this.users = await api('/admin/api/users'); } catch (e) { v.innerHTML = empty('wifioff', 'Chargement impossible', e.message, '<button class="btn primary" data-act="reload-team">Réessayer</button>'); return; }
    }
    const count = r => this.users.filter(u => u.role === r).length;
    v.innerHTML = `<div class="col loose" style="margin-top:8px">
      <div class="tiles"><div class="tile"><strong class="num">${count('agent')}</strong><span>Agents</span></div><div class="tile"><strong class="num">${count('supervisor')}</strong><span>Superviseurs</span></div></div>
      <button class="btn primary block" data-act="new-user">${icon('plus', 'sm')}Nouveau compte</button>
      <div class="searchbox">${icon('search', 'sm')}<input class="input" id="uq" type="search" placeholder="Rechercher un compte" aria-label="Rechercher un compte"></div>
      <div class="list" id="uList"></div></div>`;
    const paint = () => { const q = norm($('#uq').value); const rows = this.users.filter(u => !q || norm(u.full_name + ' ' + u.username).includes(q)); $('#uList').innerHTML = rows.map(u => `<div class="item"><div class="avatar">${esc(initials(u.full_name))}</div><div class="grow"><div class="title ellipsis">${esc(u.full_name)}</div><div class="meta"><span>${esc(u.username)}</span></div></div><span class="badge ${u.role === 'admin' ? 'cobalt' : u.role === 'supervisor' ? 'brand' : ''}">${roleLabel(u.role)}</span>${u.active ? '' : '<span class="badge bad">Désactivé</span>'}</div>`).join('') || empty('search', 'Aucun compte trouvé'); };
    $('#uq').addEventListener('input', debounce(paint, 120)); paint();
  }
  newUser() {
    const gen = () => { const a = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; const r = crypto.getRandomValues(new Uint8Array(12)); return [...r].map(x => a[x % a.length]).join(''); };
    const d = sheet(`${sheetHead('Nouveau compte', 'Un agent contrôle les entrées, un superviseur suit l’activité.')}
      <form class="sheet-body" id="uf" autocomplete="off">
        <label class="field">Nom complet<input class="input" name="full_name" required autocomplete="off"></label>
        <label class="field">Identifiant<input class="input" name="username" required autocapitalize="none" autocomplete="off" spellcheck="false"></label>
        <label class="field">Mot de passe initial <small>10 caractères minimum</small><div class="manual"><input class="input" name="password" id="pw" required minlength="10" autocomplete="new-password" spellcheck="false"><button type="button" class="btn ghost" id="gen">${icon('key', 'sm')}Générer</button></div></label>
        <label class="field">Rôle<select class="select" name="role"><option value="agent">Agent de contrôle</option><option value="supervisor">Superviseur</option></select></label>
        <div id="ue"></div><button class="btn primary block" type="submit">Créer le compte</button></form>`);
    $('#gen', d).onclick = () => { $('#pw', d).value = gen(); };
    $('#uf', d).onsubmit = async e => {
      e.preventDefault(); const f = e.target, b = $('button[type=submit]', f), data = Object.fromEntries(new FormData(f)); busy(b, true);
      try {
        await api('/admin/api/users', { method: 'POST', json: data }); this.users = null;
        d.close(); this.credentials(data); if (this.tab === 'equipe') this.renderTeam(true);
      } catch (err) { busy(b, false); $('#ue', d).innerHTML = `<div class="banner bad" role="alert">${icon('alert', 'sm')}<span>${esc(err.message)}</span></div>`; }
    };
  }
  credentials(u) {
    const txt = `Invitations — accès\nIdentifiant : ${u.username}\nMot de passe : ${u.password}\nAdresse : ${location.origin}`;
    const d = sheet(`${sheetHead('Compte créé', u.full_name)}<div class="sheet-body"><div class="card flat col tight"><div class="small muted">Identifiant</div><strong>${esc(u.username)}</strong><div class="small muted" style="margin-top:6px">Mot de passe</div><strong class="num" style="font-size:1.1rem">${esc(u.password)}</strong></div>
      <p class="small muted">Ce mot de passe ne sera plus affiché. Transmettez-le de façon sûre.</p>
      <button class="btn primary block" id="cp">${icon('copy', 'sm')}Copier les accès</button><button class="btn ghost block" data-close>Terminer</button></div>`);
    $('#cp', d).onclick = async () => { try { await navigator.clipboard.writeText(txt); toast('Accès copiés.', 'ok'); } catch { toast('Copie impossible, notez les accès.', 'bad'); } };
  }
  newEvent() {
    const d = sheet(`${sheetHead('Nouvel événement')}<form class="sheet-body" id="ef">
      <label class="field">Nom de l’événement<input class="input" name="name" required maxlength="180" placeholder="Ex. Mariage Mukendi"></label>
      <label class="field">Date<input class="input" type="date" name="event_date"></label>
      <label class="field">Lieu<input class="input" name="venue" maxlength="240" placeholder="Lieu de la réception"></label>
      <div id="ee"></div><button class="btn primary block" type="submit">Créer l’événement</button></form>`);
    $('#ef', d).onsubmit = async e => {
      e.preventDefault(); const b = $('button[type=submit]', e.target); busy(b, true);
      try { const r = await api('/admin/api/events', { method: 'POST', json: Object.fromEntries(new FormData(e.target)) }); toast('Événement créé. Importez maintenant les invités.', 'ok'); d.close(); location.href = `/event/${r.id}#gerer`; }
      catch (err) { busy(b, false); $('#ee', d).innerHTML = `<div class="banner bad" role="alert">${icon('alert', 'sm')}<span>${esc(err.message)}</span></div>`; }
    };
  }

  /* ---------- Profil ---------- */
  async renderProfile() {
    const p = prefs.get(), th = getTheme(), n = await queue.count();
    this.view.innerHTML = `<div class="col loose" style="margin-top:8px">
      <div class="card row"><div class="avatar" style="width:56px;height:56px;border-radius:18px;font-size:1.2rem">${esc(initials(this.user.full_name))}</div><div class="grow"><h2>${esc(this.user.full_name)}</h2><p class="muted small">${esc(this.user.username)}</p></div><span class="badge brand">${roleLabel(this.user.role)}</span></div>
      <section class="col"><h2 style="font-size:1.05rem">Apparence</h2>
        <div class="seg" role="group" aria-label="Thème">${[['auto', 'Auto'], ['light', 'Clair'], ['dark', 'Sombre']].map(([k, l]) => `<button data-theme="${k}" aria-pressed="${th === k}">${l}</button>`).join('')}</div></section>
      <section class="col"><h2 style="font-size:1.05rem">Contrôle d’accès</h2>
        ${[['sound', 'Signal sonore', 'Un bip confirme chaque contrôle'], ['vibrate', 'Vibration', 'Retour tactile sur mobile'], ['autoSingle', 'Entrée immédiate', 'Valide sans confirmation les invitations individuelles scannées']].map(([k, t, s]) => `<label class="item" style="cursor:pointer"><div class="grow"><div class="title">${t}</div><div class="small muted">${s}</div></div><input type="checkbox" data-pref="${k}" ${p[k] ? 'checked' : ''} style="width:22px;height:22px;accent-color:var(--brand)"></label>`).join('')}</section>
      <section class="col"><h2 style="font-size:1.05rem">Application</h2>
        <button class="btn ghost block ${window._ia_install ? '' : 'hidden'}" id="install">${icon('phone', 'sm')}Installer sur l’écran d’accueil</button>
        <div class="banner ${navigator.onLine ? 'ok' : 'warn'}">${icon(navigator.onLine ? 'check' : 'wifioff', 'sm')}<span>${navigator.onLine ? 'Connecté au serveur' : 'Hors ligne'}${n ? `, ${plural(n, 'contrôle')} en attente` : ''}</span></div>
        <form action="/logout" method="post" id="lo"><button class="btn danger block" type="submit">${icon('logout', 'sm')}Se déconnecter</button></form></section></div>`;
    $('#install', this.view).onclick = async () => { const e = window._ia_install; if (!e) return; e.prompt(); await e.userChoice; window._ia_install = null; $('#install').classList.add('hidden'); };
    $('#lo', this.view).onsubmit = async e => {
      if (n && !confirm(`${plural(n, 'contrôle')} hors ligne ne sont pas encore synchronisés. Se déconnecter quand même ?`)) { e.preventDefault(); return; }
      navigator.serviceWorker?.controller?.postMessage('clear-pages');
    };
  }

  click(e) {
    const f = e.target.closest('[data-filter]'); if (f) { this.filter = f.dataset.filter; this.renderEvents(); return; }
    const t = e.target.closest('[data-theme]'); if (t) { setTheme(t.dataset.theme); $$('[data-theme]', this.view).forEach(b => b.setAttribute('aria-pressed', b === t)); return; }
    const pr = e.target.closest('[data-pref]'); if (pr) { prefs.set(pr.dataset.pref, pr.checked); return; }
    const a = e.target.closest('[data-act]'); if (!a) return;
    ({ 'new-event': () => this.newEvent(), 'new-user': () => this.newUser(), reload: () => { this.stats = {}; this.renderEvents(true); }, 'reload-team': () => this.renderTeam(true) })[a.dataset.act]?.();
  }
}
