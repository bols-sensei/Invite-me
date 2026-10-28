/* Contrôle d'accès : caméra (BarcodeDetector ou jsQR), NFC, saisie manuelle, verdict, hors ligne. */
import { $, esc, icon, api, toast, sheet, sheetHead, busy, uuid, feedback, prefs, plural, meter, rel, empty } from './core.js';
import { enqueue, queue, issues, syncQueue } from './offline.js';

export function scanToken(value) {
  let v = String(value || '').trim();
  if (v.includes('token:')) v = v.slice(v.indexOf('token:') + 6).trim();
  try { const u = new URL(v); v = u.searchParams.get('token') || u.searchParams.get('code') || u.pathname.split('/').filter(Boolean).pop() || v; } catch { }
  return v;
}
export const parseQr = v => { const m = /^IA1\.(\d+)\.(\S+)$/.exec(v); return m ? { eventId: +m[1], token: m[2] } : null; };
const classify = (v, method) => /^INV-/i.test(v) ? 'ref' : /^IA1\./.test(v) ? 'token' : (/^[A-Za-z0-9_-]{24,}$/.test(v) || (method !== 'manual' && /^\S{12,}$/.test(v))) ? 'token' : 'name';
const loadScript = src => new Promise((ok, ko) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = ko; document.head.appendChild(s); });

export function mountScanner(root, ctx) {
  const eid = ctx.eventId;
  let stream = null, detector = null, timer = null, paused = false, working = false, lastCode = '', lastAt = 0, nfcAbort = null, canvas = null;
  const history = [];

  root.innerHTML = `<div class="col loose">
    <div id="scNet"></div>
    <div class="viewfinder" id="vf"></div>
    <form class="manual" id="manual" role="search">
      <input class="input" id="mIn" placeholder="Référence, nom ou code" autocomplete="off" autocapitalize="none" enterkeyhint="search" aria-label="Référence, nom ou code">
      <button class="btn primary icon" aria-label="Vérifier">${icon('search')}</button>
    </form>
    <div class="row wrap"><button class="btn ghost sm" id="nfcBtn">${icon('nfc', 'sm')}Lire une carte NFC</button></div>
    <div id="scQueue"></div><div id="scIssues"></div><div id="scHistory"></div></div>`;
  const vf = $('#vf', root);

  /* ---------- Viseur ---------- */
  function idle() {
    vf.innerHTML = `<div class="idle">${icon('camera')}<div><strong style="font:650 1.15rem var(--font-display)">Prêt à scanner</strong><p class="small" style="opacity:.8;margin-top:2px">Cadrez le QR code de l’invitation.</p></div><button class="btn primary" id="camBtn">Activer la caméra</button></div>`;
    $('#camBtn', vf).onclick = startCam;
  }
  async function startCam() {
    if (!navigator.mediaDevices?.getUserMedia) { toast('Caméra indisponible : ouvrez l’application en HTTPS (ou sur localhost).', 'bad', 5200); return; }
    try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false }); }
    catch (e) { toast(e.name === 'NotAllowedError' ? 'Autorisez l’accès à la caméra dans le navigateur.' : 'Impossible d’ouvrir la caméra.', 'bad', 4800); return; }
    const track = stream.getVideoTracks()[0];
    const canTorch = !!(track.getCapabilities && track.getCapabilities().torch);
    vf.innerHTML = `<video playsinline muted autoplay></video><div class="reticle"></div><div class="sweep"></div>
      <div class="tools">${canTorch ? `<button class="btn icon" id="torch" aria-label="Lampe" aria-pressed="false">${icon('bolt')}</button>` : ''}<button class="btn icon" id="stopCam" aria-label="Arrêter la caméra">${icon('x')}</button></div>`;
    const video = $('video', vf); video.srcObject = stream; await video.play().catch(() => { });
    $('#stopCam', vf).onclick = stopCam;
    if (canTorch) { let on = false; $('#torch', vf).onclick = async e => { on = !on; try { await track.applyConstraints({ advanced: [{ torch: on }] }); e.currentTarget.setAttribute('aria-pressed', on); } catch { } }; }
    if ('BarcodeDetector' in window) { try { detector = new BarcodeDetector({ formats: ['qr_code'] }); } catch { detector = null; } }
    if (!detector && !window.jsQR) { try { await loadScript('/static/js/vendor/jsqr.js'); } catch { toast('Lecteur QR indisponible.', 'bad'); } }
    tick(video);
  }
  function tick(video) {
    if (!stream) return;
    const next = () => { timer = setTimeout(() => tick(video), 110); };
    if (paused || video.readyState < 2) return next();
    (async () => {
      try {
        let val = null;
        if (detector) { const c = await detector.detect(video); val = c[0]?.rawValue; }
        else if (window.jsQR) {
          const w = Math.min(640, video.videoWidth), h = Math.round(w * video.videoHeight / video.videoWidth);
          canvas = canvas || document.createElement('canvas'); canvas.width = w; canvas.height = h;
          const cx = canvas.getContext('2d', { willReadFrequently: true }); cx.drawImage(video, 0, 0, w, h);
          const img = cx.getImageData(0, 0, w, h); val = window.jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' })?.data;
        }
        if (val) { vf.classList.add('flash'); setTimeout(() => vf.classList.remove('flash'), 500); handle(val, 'qr'); }
      } catch { }
      next();
    })();
  }
  function stopCam() {
    clearTimeout(timer); timer = null;
    if (stream) stream.getTracks().forEach(t => t.stop());
    stream = null; idle();
  }
  const onVis = () => { if (document.hidden && stream) stopCam(); };
  document.addEventListener('visibilitychange', onVis);

  /* ---------- Traitement d'un code ---------- */
  async function handle(raw, method) {
    const v = scanToken(raw); if (!v || working) return;
    const now = Date.now(); if (v === lastCode && now - lastAt < 2500) return;
    lastCode = v; lastAt = now; working = true; paused = true;
    const qr = parseQr(v);
    if (qr && qr.eventId !== eid) return wrongEvent(qr.eventId);
    try { await resolve(v, method); } finally { working = false; }
  }
  const resume = () => { paused = false; working = false; };

  async function resolve(v, method) {
    const kind = classify(v, method);
    if (!navigator.onLine) return offlineFlow(v, kind, method);
    let rows;
    try { rows = await api(`/checkin/api/events/${eid}/lookup?q=${encodeURIComponent(kind === 'token' ? 'token:' + v : v)}`); }
    catch (e) { if (e.network) return offlineFlow(v, kind, method); feedback('bad'); toast(e.message, 'bad'); return resume(); }
    if (!rows.length) return notFound(v);
    const exact = rows.find(r => r.reference.toLowerCase() === v.toLowerCase());
    if (rows.length === 1 || exact || kind === 'token') return verdict(exact || rows[0], { method, token: kind === 'token' ? v : '' });
    picker(rows, method);
  }

  function picker(rows, method) {
    const d = sheet(`${sheetHead('Plusieurs invités trouvés', 'Choisissez la bonne invitation.')}<div class="sheet-body"><div class="list">${rows.map((r, i) => `<button class="item" data-i="${i}"><div class="avatar ${r.remaining === 0 ? 'done' : ''}">${esc((r.guest_name || '?')[0].toUpperCase())}</div><div class="grow"><div class="title ellipsis">${esc(r.guest_name)}</div><div class="meta"><span>${esc(r.reference)}</span><span>${esc(r.invitation_type)}</span></div></div><div class="qty num">${r.entered}/${r.quota}<small>entrés</small></div></button>`).join('')}</div></div>`, { onClose: () => { if (!d._picked) resume(); } });
    d.addEventListener('click', e => { const b = e.target.closest('[data-i]'); if (b) { d._picked = true; verdict(rows[+b.dataset.i], { method }); } });
  }

  function wrongEvent(other) {
    feedback('bad'); remember('bad', 'QR d’un autre événement', `Événement n° ${other}`);
    sheet(`<div class="verdict bad"><div class="ico">${icon('x', 'lg')}</div><h2>QR d’un autre événement</h2><p>Cette invitation est destinée à l’événement n° ${other}. Vous contrôlez l’événement n° ${eid}.</p></div>
      <div class="sheet-body"><p class="small muted">Ne laissez pas entrer : le QR code n’est valable que pour son propre événement.</p><button class="btn primary block" data-close>Scanner un autre code</button></div>`, { onClose: resume });
  }

  function notFound(v) {
    feedback('bad'); remember('bad', 'Invitation introuvable', v.length > 18 ? v.slice(0, 8) + '…' : v);
    const d = sheet(`<div class="verdict bad"><div class="ico">${icon('x', 'lg')}</div><h2>Invitation introuvable</h2><p>Ce code ne correspond à aucune invitation active de cet événement.</p></div>
      <div class="sheet-body"><button class="btn primary block" data-close>Scanner un autre code</button></div>`, { onClose: resume });
  }

  async function register(inv, qty, method) {
    return api(`/checkin/api/events/${eid}/entry`, { method: 'POST', json: { invitation_id: inv.id, quantity: qty, method, idempotency_key: uuid() } });
  }

  function verdict(inv, { method = 'qr', token = '' } = {}) {
    const api_method = method === 'nfc' ? 'nfc' : method === 'manual' ? 'manual' : 'qr';
    const badges = `<div class="row wrap"><span class="badge brand">${esc(inv.reference)}</span><span class="badge">${esc(inv.invitation_type)}</span>${inv.table_name ? `<span class="badge cobalt">${icon('table', 'sm')}Table ${esc(inv.table_name)}</span>` : ''}</div>`;
    if (inv.remaining <= 0) {
      feedback('bad'); remember('bad', inv.guest_name, 'Quota atteint');
      const d = sheet(`<div class="verdict bad"><div class="ico">${icon('x', 'lg')}</div><h2>Quota atteint</h2><p>${esc(inv.guest_name)}</p></div>
        <div class="sheet-body">${badges}${meter(inv.entered, inv.quota)}<p class="small muted">Les ${inv.quota} personne${inv.quota > 1 ? 's' : ''} de cette invitation sont déjà entrées. Ne laissez pas passer sans accord d’un superviseur.</p>
        ${ctx.role === 'supervisor' ? `<button class="btn tonal block" id="exBtn">${icon('flag', 'sm')}Signaler une exception</button>` : ''}
        <button class="btn primary block" data-close>Compris</button></div>`, { onClose: resume });
      const ex = $('#exBtn', d); if (ex) ex.onclick = () => { d.close(); ctx.exception(inv); };
      return;
    }
    // Entrée automatique pour une invitation individuelle (option du profil)
    if (prefs.get().autoSingle && inv.quota === 1 && method !== 'manual') return quick(inv, api_method);
    let qty = 1;
    const d = sheet(`<div class="verdict ok"><div class="ico">${icon('check', 'lg')}</div><h2>Invitation valide</h2><p>${esc(inv.guest_name)}</p></div>
      <div class="sheet-body">${badges}
        <div class="col tight">${meter(inv.entered, inv.quota)}<p class="small muted num">${inv.entered} sur ${inv.quota} déjà entré${inv.entered > 1 ? 's' : ''}, ${inv.remaining} restant${inv.remaining > 1 ? 's' : ''}</p></div>
        ${inv.remaining > 1 ? `<div><p class="small muted" style="text-align:center;margin-bottom:6px">Combien de personnes entrent ?</p><div class="stepper"><button id="m" aria-label="Moins">−</button><output id="q" class="num">1</output><button id="p" aria-label="Plus">+</button></div></div>` : ''}
        <div id="vErr"></div>
        <button class="btn primary block" id="go" style="min-height:56px;font-size:1.05rem">Enregistrer 1 entrée</button>
        <button class="btn ghost block" data-close>Annuler</button></div>`, { onClose: resume });
    const upd = () => { $('#q', d) && ($('#q', d).textContent = qty); $('#go', d).textContent = `Enregistrer ${qty} entrée${qty > 1 ? 's' : ''}`; };
    $('#m', d) && ($('#m', d).onclick = () => { qty = Math.max(1, qty - 1); upd(); });
    $('#p', d) && ($('#p', d).onclick = () => { qty = Math.min(inv.remaining, qty + 1); upd(); });
    $('#go', d).onclick = async e => {
      const b = e.currentTarget; busy(b, true); $('#vErr', d).innerHTML = '';
      try {
        const res = await register(inv, qty, api_method);
        feedback('ok'); remember('ok', inv.guest_name, `${qty} entrée${qty > 1 ? 's' : ''}`);
        toast(`${res.reference} : ${plural(qty, 'entrée')} enregistrée${qty > 1 ? 's' : ''}. Restant : ${res.remaining}`, 'ok');
        ctx.onEntry(inv.id, res); d.close();
      } catch (err) {
        busy(b, false);
        if (err.network && token) { d.close(); return offlineFlow(token, 'token', method); }
        feedback('bad'); $('#vErr', d).innerHTML = `<div class="banner bad" role="alert">${icon('alert', 'sm')}<span>${esc(err.message)}</span></div>`;
        if (err.status === 409) ctx.onEntry(inv.id, null);
      }
    };
  }

  async function quick(inv, m) {
    try {
      const res = await register(inv, 1, m);
      feedback('ok'); remember('ok', inv.guest_name, '1 entrée'); ctx.onEntry(inv.id, res);
      const d = sheet(`<div class="verdict ok"><div class="ico">${icon('check', 'lg')}</div><h2>Entrée enregistrée</h2><p>${esc(inv.guest_name)}${inv.table_name ? ' — table ' + esc(inv.table_name) : ''}</p></div>`, { onClose: resume });
      setTimeout(() => d.open && d.close(), 1500);
    } catch (e) { feedback('bad'); toast(e.message, 'bad'); resume(); }
  }

  /* ---------- Hors ligne ---------- */
  async function offlineFlow(v, kind, method) {
    if (kind !== 'token') {
      const c = ctx.cached(); const hit = c.find(i => i.reference.toLowerCase() === v.toLowerCase()) || c.find(i => i.guest_name.toLowerCase().includes(v.toLowerCase()));
      feedback('warn');
      sheet(`<div class="verdict warn"><div class="ico">${icon('wifioff', 'lg')}</div><h2>Vérification impossible hors ligne</h2><p>${hit ? esc(hit.guest_name) : 'Sans réseau, seul un QR code ou une carte NFC peut être mis en attente.'}</p></div>
        <div class="sheet-body">${hit ? `<div class="row wrap"><span class="badge brand">${esc(hit.reference)}</span><span class="badge">Dernier état connu : ${hit.entered}/${hit.quota} entrés</span></div>` : ''}
        <p class="small muted">Le QR code contient le jeton de l’invitation. Scannez-le pour l’enregistrer en attente ; il sera contrôlé dès que le réseau revient.</p><button class="btn primary block" data-close>Compris</button></div>`, { onClose: resume });
      return;
    }
    const dup = (await queue.all()).find(e => e.token === v && e.event_id === eid);
    if (dup) {
      feedback('bad'); remember('bad', 'Déjà en attente', 'Scanné sur cet appareil');
      sheet(`<div class="verdict bad"><div class="ico">${icon('x', 'lg')}</div><h2>Déjà scanné</h2><p>Ce code est déjà en attente sur cet appareil.</p></div><div class="sheet-body"><button class="btn primary block" data-close>Compris</button></div>`, { onClose: resume });
      return;
    }
    feedback('warn'); let qty = 1;
    const d = sheet(`<div class="verdict warn"><div class="ico">${icon('wifioff', 'lg')}</div><h2>Hors ligne</h2><p>Le contrôle sera mis en attente, puis vérifié à la synchronisation.</p></div>
      <div class="sheet-body"><div><p class="small muted" style="text-align:center;margin-bottom:6px">Nombre de personnes</p><div class="stepper"><button id="m" aria-label="Moins">−</button><output id="q" class="num">1</output><button id="p" aria-label="Plus">+</button></div></div>
      <button class="btn primary block" id="go" style="min-height:56px">Mettre en attente</button><button class="btn ghost block" data-close>Annuler</button></div>`, { onClose: resume });
    $('#m', d).onclick = () => { qty = Math.max(1, qty - 1); $('#q', d).textContent = qty; };
    $('#p', d).onclick = () => { qty = Math.min(50, qty + 1); $('#q', d).textContent = qty; };
    $('#go', d).onclick = async () => {
      await enqueue({ client_id: uuid(), event_id: eid, token: v, quantity: qty, method: method === 'nfc' ? 'nfc' : method === 'manual' ? 'manual' : 'qr', occurred_at: new Date().toISOString() });
      remember('warn', 'En attente', plural(qty, 'personne')); toast('Contrôle mis en attente.', ''); d.close();
    };
  }

  /* ---------- NFC ---------- */
  async function startNfc() {
    if (!('NDEFReader' in window)) { toast('NFC indisponible ici. Essayez Chrome sur Android, ou scannez le QR.', 'bad', 4500); return; }
    if (nfcAbort) { nfcAbort.abort(); nfcAbort = null; $('#nfcBtn', root).lastChild.textContent = 'Lire une carte NFC'; return; }
    try {
      nfcAbort = new AbortController(); const r = new NDEFReader(); await r.scan({ signal: nfcAbort.signal });
      $('#nfcBtn', root).lastChild.textContent = 'NFC actif, approchez la carte'; toast('Approchez la carte NFC du téléphone.');
      r.onreading = ev => {
        for (const rec of ev.message.records) {
          if (rec.recordType === 'text' || rec.recordType === 'url') { handle(new TextDecoder(rec.encoding || 'utf-8').decode(rec.data), 'nfc'); return; }
        }
        toast('Aucun jeton lisible sur cette carte.', 'bad');
      };
    } catch (e) { nfcAbort = null; toast('Lecture NFC impossible : ' + e.message, 'bad', 4500); }
  }

  /* ---------- Saisie manuelle ---------- */
  $('#manual', root).onsubmit = e => { e.preventDefault(); const i = $('#mIn', root); const v = i.value.trim(); if (v) { handle(v, 'manual'); i.value = ''; i.blur(); } };
  $('#nfcBtn', root).onclick = startNfc;

  /* ---------- Historique de session, file, anomalies ---------- */
  function remember(kind, title, sub) { history.unshift({ kind, title, sub, at: new Date() }); history.length = Math.min(history.length, 8); renderHistory(); }
  function renderHistory() {
    $('#scHistory', root).innerHTML = history.length ? `<div><div class="section-title" style="margin-top:6px"><h2>Derniers contrôles</h2></div><div class="card" style="padding:4px 14px"><div class="feed">${history.map(h => `<div class="f"><div class="dot" style="${h.kind === 'bad' ? 'background:var(--bad-soft);color:var(--bad)' : h.kind === 'warn' ? 'background:var(--warn-soft);color:var(--warn)' : ''}">${icon(h.kind === 'ok' ? 'check' : h.kind === 'warn' ? 'clock' : 'x', 'sm')}</div><div class="grow"><div class="title ellipsis" style="font-weight:650">${esc(h.title)}</div><div class="small muted">${esc(h.sub)}</div></div><span class="tiny faint">${rel(h.at)}</span></div>`).join('')}</div></div></div>` : '';
  }
  async function renderQueue() {
    const n = await queue.count(); const off = !navigator.onLine;
    $('#scNet', root).innerHTML = off ? `<div class="banner warn" role="status">${icon('wifioff', 'sm')}<span>Hors ligne. Les QR codes scannés sont mis en attente puis vérifiés au retour du réseau.</span></div>` : '';
    $('#scQueue', root).innerHTML = n ? `<div class="banner info"><span class="grow">${icon('clock', 'sm')} ${plural(n, 'contrôle')} en attente de synchronisation</span><button class="btn sm primary" id="syncBtn" ${off ? 'disabled' : ''}>Synchroniser</button></div>` : '';
    const sb = $('#syncBtn', root); if (sb) sb.onclick = () => doSync(true);
    const list = issues.all().filter(i => i.event_id === eid);
    $('#scIssues', root).innerHTML = list.length ? `<div class="card flat col"><div class="row between"><h3>À vérifier avec un superviseur</h3><button class="btn sm ghost" id="clrIssues">Tout effacer</button></div>${list.map(i => `<div class="banner ${i.status === 'conflict' ? 'warn' : 'bad'}" style="align-items:flex-start">${icon('alert', 'sm')}<div class="grow"><strong>${esc(i.reference || 'Code inconnu')}</strong> ${i.quantity ? '(' + plural(i.quantity, 'personne') + ')' : ''}<div class="small">${esc(i.reason)}</div></div><button class="btn icon sm ghost" data-issue="${esc(i.client_id)}" aria-label="Ignorer" style="width:34px;min-height:34px">${icon('x', 'sm')}</button></div>`).join('')}</div>` : '';
    root.querySelectorAll('[data-issue]').forEach(b => b.onclick = () => { issues.remove(b.dataset.issue); renderQueue(); });
    const c = $('#clrIssues', root); if (c) c.onclick = () => { list.forEach(i => issues.remove(i.client_id)); renderQueue(); };
  }
  async function doSync(manual) {
    if (!navigator.onLine) return;
    try {
      const r = await syncQueue(); if (!r || !r.total) { if (manual) toast('Rien à synchroniser.'); return; }
      toast(`${r.synced} synchronisé${r.synced > 1 ? 's' : ''}${r.issues.length ? `, ${r.issues.length} à vérifier` : ''}.`, r.issues.length ? '' : 'ok');
      if (r.issues.length) feedback('warn'); ctx.onEntry(null, null);
    } catch (e) { if (manual || !e.network) toast('Synchronisation impossible : ' + e.message, 'bad'); }
    renderQueue();
  }
  const onNet = () => { renderQueue(); if (navigator.onLine) doSync(false); };
  addEventListener('online', onNet); addEventListener('offline', onNet);
  document.addEventListener('ia:queue', renderQueue);

  idle(); renderQueue(); if (navigator.onLine) doSync(false);

  return {
    destroy() {
      stopCam(); if (nfcAbort) nfcAbort.abort();
      removeEventListener('online', onNet); removeEventListener('offline', onNet);
      document.removeEventListener('ia:queue', renderQueue); document.removeEventListener('visibilitychange', onVis);
    },
    handle,
  };
}
