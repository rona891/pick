// ── State ──────────────────────────────────────────────────────────────────
let codeReader = null;
let scannerActive = false;
let adminUnlocked = false;
let editingClienteId = null;
let semanaActual = '';
let soloPendientes = false;
let wakeLock = null;
let resumenData = [];
let filtroActivo = 'todos';
const sortByImporte = true;
let descripTimer = null;
let cameras = [];
let currentCameraIndex = 0;

// ── Init ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  aplicarModo();
  if (getToken()) {
    if (mayoristaCaducado()) {
      showMayoristaSelector();
    } else {
      showApp();
    }
  } else {
    showLogin();
  }

  document.querySelectorAll('.admin-tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.adminTab;
      document.querySelectorAll('.admin-tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.adminTab === target));
      document.querySelectorAll('.admin-tab-panel').forEach((p) => p.classList.toggle('hidden', p.dataset.adminPanel !== target));
      if (target === 'usuarios') loadUsers();
      if (target === 'nueva-semana') loadSemanasAdmin();
      if (target === 'zonas') loadZonas();
    });
  });
});

// ── Views ──────────────────────────────────────────────────────────────────
function showLogin() {
  document.getElementById('login-view').classList.remove('hidden');
  document.getElementById('mayorista-view').classList.add('hidden');
  document.getElementById('app-view').classList.add('hidden');
  document.getElementById('login-error').classList.add('hidden');
}

function showMayoristaSelector() {
  document.getElementById('mayorista-view').classList.remove('hidden');
  document.getElementById('login-view').classList.add('hidden');
  document.getElementById('app-view').classList.add('hidden');
}

function showApp() {
  document.getElementById('login-view').classList.add('hidden');
  document.getElementById('mayorista-view').classList.add('hidden');
  document.getElementById('app-view').classList.remove('hidden');
  const adminBtn = document.querySelector('.tab-btn[data-tab="admin"]');
  adminBtn.classList.toggle('hidden', !esAdminOVendedor());
  if (esVendedor()) document.getElementById('nav-admin-label').textContent = 'Gestión';
  document.getElementById('topbar-usuario').textContent = localStorage.getItem('username') || '';
  const m = getMayorista();
  aplicarTema(m);
  document.getElementById('topbar-logo').src = m === 'diarco' ? 'diarco.png' : 'yaguar.png';
  loadSemanas().then(() => loadStats());
  switchTab('pick');
  prewarmCamera();
  renderHistorial();
  setTimeout(() => document.getElementById('barcode-input').focus(), 200);
}

// ── Modo claro / oscuro ────────────────────────────────────────────────────
function esLightMode() {
  return localStorage.getItem('lightMode') === '1';
}

function aplicarModo() {
  const light = esLightMode();
  document.body.classList.toggle('light-mode', light);
  const btn = document.getElementById('btn-theme');
  if (btn) btn.textContent = light ? '🌙' : '☀';
}

document.getElementById('btn-theme').addEventListener('click', () => {
  localStorage.setItem('lightMode', esLightMode() ? '0' : '1');
  aplicarModo();
});

// ── Selector de mayorista ──────────────────────────────────────────────────
function aplicarTema(mayorista) {
  document.body.classList.remove('theme-yaguar', 'theme-diarco');
  if (mayorista) document.body.classList.add(`theme-${mayorista}`);
}

document.querySelectorAll('.mayorista-card').forEach((btn) => {
  btn.addEventListener('click', () => {
    setMayorista(btn.dataset.mayorista);
    aplicarTema(btn.dataset.mayorista);
    showApp();
  });
});

function cambiarMayorista() {
  localStorage.removeItem('mayorista_ts');
  aplicarTema(null);
  showMayoristaSelector();
}

// ── Auth ───────────────────────────────────────────────────────────────────
document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  const btn = document.getElementById('login-btn');
  const errorDiv = document.getElementById('login-error');

  errorDiv.classList.add('hidden');
  btn.disabled = true;
  btn.textContent = 'Entrando...';

  try {
    const res = await api.login(username, password);
    setToken(res.access_token);
    setRol(res.rol);
    localStorage.setItem('username', username);
    if (mayoristaCaducado()) {
      showMayoristaSelector();
    } else {
      showApp();
    }
    setTimeout(() => { if (!isFullscreen()) enterFullscreen(); }, 300);
  } catch (err) {
    errorDiv.textContent = err.message || 'Usuario o contraseña incorrectos';
    errorDiv.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Entrar';
  }
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  await api.logout().catch(() => {});
  clearToken();
  stopScanner();
  adminUnlocked = false;
  document.getElementById('results').innerHTML = '';
  showLogin();
});

// ── Semanas ────────────────────────────────────────────────────────────────
async function loadSemanas() {
  try {
    const semanas = await api.getSemanas();
    const select = document.getElementById('semana-select');
    if (semanas.length === 0) {
      select.innerHTML = '<option value="">Sin semanas cargadas</option>';
      semanaActual = '';
    } else {
      select.innerHTML = semanas.map((s) => `<option value="${s.nombre}">${s.nombre}</option>`).join('');
      semanaActual = semanas[0].nombre;
      select.value = semanaActual;
    }
  } catch (_) {}
}

document.getElementById('semana-select').addEventListener('change', (e) => {
  semanaActual = e.target.value;
  document.getElementById('results').innerHTML = '';
  document.getElementById('barcode-input').value = '';
  document.getElementById('descrip-input').value = '';
  hideDescripResults();
  loadStats();
  if (document.querySelector('.tab-btn[data-tab="clientes"]').classList.contains('active')) {
    loadResumen();
  }
});

// ── Stats ──────────────────────────────────────────────────────────────────
async function loadStats() {
  try {
    const stats = await api.getStats(semanaActual);
    document.getElementById('stat-total').textContent = stats.total;
    document.getElementById('stat-completed').textContent = stats.completed;
    document.getElementById('stat-pending').textContent = stats.pending;
    updateProgressBar(stats.completed, stats.total);
  } catch (_) {}
}

function updateProgressBar(completed, total) {
  const fill = document.getElementById('progress-bar-fill');
  const label = document.getElementById('progress-pct');
  if (!fill) return;
  const pct = total > 0 ? Math.round(completed / total * 100) : 0;
  fill.style.width = pct + '%';
  fill.style.background = pct >= 100 ? 'var(--green)' : 'var(--accent)';
  if (label) { label.textContent = pct + '%'; label.style.color = pct >= 100 ? 'var(--green)' : ''; }
}

// ── Tabs ───────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== tab));
  if (scannerActive && tab !== 'pick') stopScanner();
  if (sobScannerActive && tab !== 'sobrantes') stopSobScanner();
  if (tab === 'clientes') loadResumen();
  if (tab === 'admin') initAdmin();
  if (tab === 'sobrantes') initSobrantes();
}

// ── Tab: Pick ──────────────────────────────────────────────────────────────
document.getElementById('search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const val = document.getElementById('barcode-input').value.trim();
  if (!val) return;
  // Para DIARCO: primero intenta por barcode (EAN-13/EAN-14), luego por cod_art DIARCO
  if (getMayorista() === 'diarco') {
    await searchDiarco(val);
  } else {
    await searchBarcode(val);
  }
});


async function searchDiarco(val) {
  // Intenta por barcode EAN (unidad o bulto), si falla busca por código DIARCO
  const results = document.getElementById('results');
  results.innerHTML = '<p class="loading">Buscando...</p>';
  try {
    const picks = await api.getByBarcode(val, semanaActual);
    addToHistorial(val, picks[0]?.descrip || val);
    renderPicks(picks, results);
    loadStats();
  } catch {
    // Fallback: buscar por código de artículo DIARCO
    try {
      const picks = await api.getByCodArt(val, semanaActual);
      addToHistorial(val, picks[0]?.descrip || val);
      renderPicks(picks, results);
      loadStats();
    } catch {
      results.innerHTML = `<p class="error-msg">Producto no encontrado</p>`;
    }
  }
}

async function searchByCodArt(codArt) {
  const results = document.getElementById('results');
  results.innerHTML = '<p class="loading">Buscando...</p>';
  try {
    const picks = await api.getByCodArt(codArt, semanaActual);
    addToHistorial(codArt, picks[0]?.descrip || codArt);
    renderPicks(picks, results);
    loadStats();
  } catch (err) {
    results.innerHTML = `<p class="error-msg">Producto no encontrado</p>`;
  }
}

async function searchBarcode(codBar) {
  const results = document.getElementById('results');
  results.innerHTML = '<p class="loading">Buscando...</p>';

  try {
    const picks = await api.getByBarcode(codBar, semanaActual);
    addToHistorial(codBar, picks[0]?.descrip || codBar);

    const todosEntregados = picks.length > 0 && picks.every(p => (p.estado || '').startsWith('completado'));

    if (todosEntregados) {
      // Ocultar y resetear el botón solo-pendientes — el banner tiene su propio toggle
      const spBtn = document.getElementById('solo-pendientes-btn');
      spBtn.classList.add('hidden');
      if (soloPendientes) {
        soloPendientes = false;
        spBtn.classList.remove('active');
        spBtn.textContent = 'Solo pendientes';
      }
      results.innerHTML = `
        <div class="entregado-banner">
          <span>✓ Este producto ya fue entregado a todos los clientes</span>
          <button class="btn-ver-entregados" id="toggle-entregados">Ver items</button>
        </div>
        <div id="entregados-container" class="hidden"></div>
      `;
      const container = document.getElementById('entregados-container');
      renderPicks(picks, container);
      document.getElementById('toggle-entregados').addEventListener('click', function () {
        const isHidden = container.classList.toggle('hidden');
        this.textContent = isHidden ? 'Ver items' : 'Ocultar items';
      });
    } else {
      document.getElementById('solo-pendientes-btn').classList.remove('hidden');
      renderPicks(picks);
      aplicarFiltroPendientes(results);
    }
  } catch (err) {
    document.getElementById('solo-pendientes-btn').classList.remove('hidden');
    const noEncontrado = err.message.includes('No se encontraron picks');
    results.innerHTML = `<p class="error-msg">${noEncontrado ? 'Producto no encontrado' : err.message}</p>`;
  }
}

// ── Historial ──────────────────────────────────────────────────────────────
function addToHistorial(codBar, descrip) {
  let hist = JSON.parse(localStorage.getItem('pick_historial') || '[]');
  // normalizar entradas viejas (strings) a objetos
  hist = hist.map(e => typeof e === 'string' ? { cod: e, descrip: e } : e);
  hist = [{ cod: codBar, descrip }, ...hist.filter(e => e.cod !== codBar)].slice(0, 5);
  localStorage.setItem('pick_historial', JSON.stringify(hist));
  renderHistorial();
}

function renderHistorial() {
  let hist = JSON.parse(localStorage.getItem('pick_historial') || '[]');
  hist = hist.map(e => typeof e === 'string' ? { cod: e, descrip: e } : e);
  const chips = document.getElementById('historial-chips');
  const wrap = document.getElementById('historial-wrap');
  if (!chips) return;
  if (hist.length === 0) { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');
  chips.innerHTML = hist.map(e => `<span class="hist-chip" data-cod="${e.cod}">${e.descrip}</span>`).join('');
  chips.querySelectorAll('.hist-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const cod = chip.dataset.cod;
      document.getElementById('barcode-input').value = cod;
      if (getMayorista() === 'diarco') searchDiarco(cod);
      else searchBarcode(cod);
    });
  });
}

// ── Solo pendientes ────────────────────────────────────────────────────────
document.getElementById('solo-pendientes-btn').addEventListener('click', () => {
  soloPendientes = !soloPendientes;
  const btn = document.getElementById('solo-pendientes-btn');
  btn.classList.toggle('active', soloPendientes);
  btn.textContent = soloPendientes ? 'Ver todos' : 'Solo pendientes';
  aplicarFiltroPendientes(document.getElementById('results'));
});

function aplicarFiltroPendientes(container) {
  container.querySelectorAll('.pick-card').forEach((card) => {
    const completado = card.classList.contains('completed');
    card.style.display = (soloPendientes && completado) ? 'none' : '';
  });
}

// ── Formato cantidad ───────────────────────────────────────────────────────
function estadoClass(estado) {
  if ((estado || '').startsWith('completado')) return 'estado-ok';
  return 'estado-entregado';
}

function formatCantidad(uni, bul, uxb) {
  uni = uni || 0; bul = bul || 0; uxb = uxb || 0;
  if (uxb > 1 && bul > 0 && uni === bul * uxb) {
    return { main: `${bul} bulto${bul !== 1 ? 's' : ''}`, sub: `× ${uxb} uni/bulto` };
  }
  return { main: `${uni} uni`, sub: uxb > 1 ? `× ${uxb} uni/bulto` : null };
}

function formatImporte(n) {
  if (!n) return '';
  return '$' + Math.round(n).toLocaleString('es-AR');
}

function formatRestante(uni, cantidad, bul, uxb) {
  uni = uni || 0; cantidad = cantidad || 0; bul = bul || 0; uxb = uxb || 0;
  const restante = Math.max(0, uni - cantidad);
  const restanteBul = (uxb > 0 && restante % uxb === 0) ? restante / uxb : 0;
  return formatCantidad(restante, restanteBul, uxb);
}

function getEntregadoLabel(uni, bul, uxb) {
  uni = uni || 0; bul = bul || 0; uxb = uxb || 0;
  if (uxb > 1 && bul > 0 && uni === bul * uxb) {
    return `✓ ENTREGADO — ${bul} BUL`;
  }
  return `✓ ENTREGADO — ${uni} UNI`;
}

// ── Render picks ───────────────────────────────────────────────────────────
function renderPicks(picks, container = document.getElementById('results')) {
  container.innerHTML = '';

  // Pendientes primero
  const sorted = [...picks].sort((a, b) => {
    const ac = (a.estado || '').startsWith('completado') ? 1 : 0;
    const bc = (b.estado || '').startsWith('completado') ? 1 : 0;
    return ac - bc;
  });

  sorted.forEach((pick) => {
    const card = document.createElement('div');
    card.className = 'pick-card';
    card.dataset.pickId = pick.id;
    card.dataset.nombre = pick.nombre || '';
    card.dataset.uni = pick.uni || 0;
    card.dataset.bul = pick.bul || 0;
    card.dataset.uxb = pick.uxb || 0;

    const isCompleted = (pick.estado || '').startsWith('completado');
    if (isCompleted) card.classList.add('completed');

    const cantidad = pick.cantidad_pickeada ?? 0;
    const uni = pick.uni ?? 0;
    const uxb = pick.uxb ?? 0;
    const isParcial = cantidad > 0 && cantidad < uni;
    if (isParcial) card.classList.add('parcial');
    const qty = formatRestante(uni, cantidad, pick.bul, uxb);

    card.innerHTML = `
      <div class="pick-header">
        <span class="pick-art">${pick.cod_art ?? ''}</span>
      </div>
      <div class="pick-descrip">${pick.descrip ?? ''}</div>
      <div class="pick-meta">
        <span>${pick.nombre ?? pick.cliente ?? ''}</span>
        <span class="pick-loc">${pick.localidad ?? ''}</span>
      </div>
      <div class="pick-qty-info">
        <span class="qty-main">${qty.main}</span>
        ${qty.sub ? `<span class="qty-sub">${qty.sub}</span>` : ''}
      </div>
      <div class="pick-estado ${estadoClass(pick.estado)}">${pick.estado ?? 'sin estado'}</div>
      <div class="pick-controls"></div>
    `;

    renderControls(card, cantidad, isCompleted);
    container.appendChild(card);
  });

  aplicarFiltroPendientes(container);

  // Actualizar progreso en el sheet si aplica
  updateSheetProgress();
}

// ── Render controles de pick ───────────────────────────────────────────────
function renderControls(card, cantidad, isCompleted) {
  const ctrl = card.querySelector('.pick-controls');
  const uni = parseInt(card.dataset.uni) || 0;
  const bul = parseInt(card.dataset.bul) || 0;
  const uxb = parseInt(card.dataset.uxb) || 0;
  const id = parseInt(card.dataset.pickId);
  const entLabel = getEntregadoLabel(uni, bul, uxb);

  if (isCompleted) {
    ctrl.innerHTML = `<button class="btn-undo">Desmarcar</button>`;
    ctrl.querySelector('.btn-undo').addEventListener('click', async () => {
      if (!await confirmar('¿Desmarcar este pick y volver a 0?', 'Sí, desmarcar')) return;
      await saveQuantity(id, 0, card);
    });
  } else {
    let current = cantidad;
    ctrl.innerHTML = `
      <button class="btn-entregado">${entLabel}</button>
      <div class="pick-stepper">
        <button class="btn-step-minus">−</button>
        <input class="step-value" type="number" min="0" max="${uni}" value="${current}" inputmode="numeric" />
        <button class="btn-step-plus">+</button>
        <button class="btn-save">Guardar</button>
      </div>
    `;

    const inputEl = ctrl.querySelector('.step-value');

    const syncFromInput = () => {
      let v = parseInt(inputEl.value);
      if (isNaN(v) || v < 0) v = 0;
      if (v > uni) v = uni;
      current = v;
      inputEl.value = current;
    };

    ctrl.querySelector('.btn-entregado').addEventListener('click', () => saveQuantity(id, uni, card));

    ctrl.querySelector('.btn-step-minus').addEventListener('click', () => {
      syncFromInput();
      current = Math.max(0, current - 1);
      inputEl.value = current;
    });

    ctrl.querySelector('.btn-step-plus').addEventListener('click', () => {
      syncFromInput();
      current = Math.min(uni, current + 1);
      inputEl.value = current;
    });

    inputEl.addEventListener('change', syncFromInput);
    inputEl.addEventListener('blur', syncFromInput);
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { syncFromInput(); saveQuantity(id, current, card); }
    });

    ctrl.querySelector('.btn-save').addEventListener('click', () => { syncFromInput(); saveQuantity(id, current, card); });
  }
}

// ── Guardar cantidad ───────────────────────────────────────────────────────
async function saveQuantity(id, cantidad, card) {
  try {
    const res = await api.updateQuantity(id, cantidad);
    const isCompleted = res.estado.startsWith('completado');
    const uni = parseInt(card.dataset.uni) || 0;
    const uxb = parseInt(card.dataset.uxb) || 0;
    const bul = parseInt(card.dataset.bul) || 0;
    const isParcial = cantidad > 0 && cantidad < uni;
    card.classList.toggle('completed', isCompleted);
    card.classList.toggle('parcial', isParcial);
    card.querySelector('.pick-estado').textContent = res.estado;
    card.querySelector('.pick-estado').className = `pick-estado ${estadoClass(res.estado)}`;

    const qty = formatRestante(uni, cantidad, bul, uxb);
    card.querySelector('.qty-main').textContent = qty.main;
    const qtySub = card.querySelector('.qty-sub');
    if (qtySub) qtySub.textContent = qty.sub || '';

    renderControls(card, cantidad, isCompleted);
    aplicarFiltroPendientes(card.closest('#results, .cliente-picks-content') || document.getElementById('results'));

    if (navigator.vibrate) navigator.vibrate(isCompleted ? [60, 40, 60] : 40);
    if (isCompleted) playBeep(880, 80);

    showToast(isCompleted ? '✓ Completado' : 'Actualizado', isCompleted ? 'success' : 'info');

    if (isCompleted) checkClienteCompleto(card.dataset.nombre);

    updateSheetProgress();
    loadStats();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ── Chequeo cliente completo ───────────────────────────────────────────────
function checkClienteCompleto(nombre) {
  if (!nombre) return;
  const allCards = Array.from(document.querySelectorAll('.pick-card[data-nombre]'));
  const clientCards = allCards.filter((c) => c.dataset.nombre === nombre);
  if (clientCards.length > 0 && clientCards.every((c) => c.classList.contains('completed'))) {
    playCompletionSound();
    showToast(`🎉 ${nombre} — ¡listo para despacho!`, 'success');
  }
}

// ── Progreso en bottom-sheet ───────────────────────────────────────────────
function updateSheetProgress() {
  const content = document.getElementById('cliente-picks-content');
  const el = document.getElementById('cliente-picks-progress');
  if (!el || !content) return;
  const all = content.querySelectorAll('.pick-card').length;
  const done = content.querySelectorAll('.pick-card.completed').length;
  el.textContent = all > 0 ? `${done} / ${all} completados` : '';
}

// ── Sonido ─────────────────────────────────────────────────────────────────
function playBeep(freq = 880, ms = 80) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + ms / 1000);
    osc.start();
    osc.stop(ctx.currentTime + ms / 1000);
    setTimeout(() => ctx.close(), ms + 50);
  } catch (_) {}
}

function playCompletionSound() {
  playBeep(880, 100);
  setTimeout(() => playBeep(1100, 160), 130);
}

// ── Loop de decodificación rotada (90°) ───────────────────────────────────
const _rotCanvas = document.createElement('canvas');
const _rotCtx = _rotCanvas.getContext('2d', { willReadFrequently: true });

async function runRotatedDecodeLoop(video) {
  while (scannerActive) {
    await new Promise((r) => requestAnimationFrame(r));
    if (!scannerActive || video.videoWidth === 0 || video.readyState < 2) continue;

    const vw = video.videoWidth;
    const vh = video.videoHeight;

    // Frame rotado 90° — convierte barcodes verticales en horizontales para ZXing
    _rotCanvas.width = vh;
    _rotCanvas.height = vw;
    _rotCtx.save();
    _rotCtx.translate(vh / 2, vw / 2);
    _rotCtx.rotate(Math.PI / 2);
    _rotCtx.drawImage(video, -vw / 2, -vh / 2, vw, vh);
    _rotCtx.restore();

    try {
      const lum = new ZXing.HTMLCanvasElementLuminanceSource(_rotCanvas);
      const bmp = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(lum));
      const result = codeReader.reader.decode(bmp);
      if (scannerActive && result) {
        onScanResult(result);
        return;
      }
    } catch (_) {
      // NotFoundException en este frame — continuar
    }
  }
}

// ── Wake Lock ──────────────────────────────────────────────────────────────
async function requestWakeLock() {
  if ('wakeLock' in navigator) {
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch (_) {}
  }
}

function releaseWakeLock() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

// ── Precalentar cámara ─────────────────────────────────────────────────────
// Solo solicita el permiso sin abrir stream (evita conflictos con ZXing)
async function prewarmCamera() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    // enumerateDevices dispara el diálogo de permiso sin abrir stream
    await navigator.mediaDevices.enumerateDevices();
  } catch (_) {}
}

// ── Búsqueda por descripción ───────────────────────────────────────────────
document.getElementById('descrip-input').addEventListener('input', (e) => {
  clearTimeout(descripTimer);
  const q = e.target.value.trim();
  if (q.length < 2) { hideDescripResults(); return; }
  descripTimer = setTimeout(() => buscarPorDescrip(q), 300);
});

document.getElementById('descrip-input').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideDescripResults();
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.descrip-search-wrap')) hideDescripResults();
});

async function buscarPorDescrip(q) {
  try {
    const items = await api.buscarPorDescrip(q, semanaActual);
    const container = document.getElementById('descrip-results');
    if (!items.length) {
      container.innerHTML = '<div class="descrip-item-empty">Sin resultados</div>';
    } else {
      container.innerHTML = items.map((item) => `
        <div class="descrip-item" data-codbar="${item.cod_bar ?? ''}" data-codart="${item.cod_art ?? ''}">
          <span class="descrip-item-name">${item.descrip ?? ''}</span>
          <span class="descrip-item-code">${item.cod_art ?? ''}</span>
        </div>
      `).join('');
      container.querySelectorAll('.descrip-item').forEach((el) => {
        el.addEventListener('click', async () => {
          const codBar = el.dataset.codbar;
          const codArt = el.dataset.codart;
          const descrip = el.querySelector('.descrip-item-name').textContent;
          document.getElementById('descrip-input').value = descrip;
          hideDescripResults();
          if (codBar) {
            document.getElementById('barcode-input').value = codBar;
            searchBarcode(codBar);
          } else {
            document.getElementById('barcode-input').value = codArt;
            await searchByCodArt(codArt);
          }
        });
      });
    }
    container.classList.remove('hidden');
  } catch (_) {}
}

function hideDescripResults() {
  document.getElementById('descrip-results').classList.add('hidden');
}

// ── Camera scanner ─────────────────────────────────────────────────────────
document.getElementById('scan-btn').addEventListener('click', async () => {
  if (scannerActive) stopScanner();
  else await startScanner();
});

function onScanResult(result) {
  if (!result) return;
  const code = result.getText();
  document.getElementById('barcode-input').value = code;
  if (navigator.vibrate) navigator.vibrate(80);
  stopScanner();
  if (getMayorista() === 'diarco') {
    searchDiarco(code);
  } else {
    searchBarcode(code);
  }
}

async function startScanner(deviceId = null) {
  const container = document.getElementById('scanner-container');
  container.classList.remove('hidden');
  document.getElementById('scan-btn').textContent = 'Detener';
  scannerActive = true;

  await requestWakeLock();

  const targetId = deviceId ?? localStorage.getItem('pick_last_camera') ?? null;
  const hints = new Map([
    [2, [                          // POSSIBLE_FORMATS — solo códigos de barra lineales
      ZXing.BarcodeFormat.EAN_13,
      ZXing.BarcodeFormat.EAN_8,
      ZXing.BarcodeFormat.CODE_128,
      ZXing.BarcodeFormat.CODE_39,
      ZXing.BarcodeFormat.UPC_A,
      ZXing.BarcodeFormat.UPC_E,
    ]],
    [3, true],                     // TRY_HARDER
  ]);
  codeReader = new ZXing.BrowserMultiFormatReader(hints, 0); // 0ms = decodifica cada frame

  await codeReader.decodeFromVideoDevice(targetId, 'scanner-video', onScanResult);

  container.classList.add('scanner-open');

  // Loop paralelo que decodifica el frame rotado 90° — cubre cualquier orientación del código
  runRotatedDecodeLoop(document.getElementById('scanner-video'));

  const devices = await navigator.mediaDevices.enumerateDevices();
  cameras = devices.filter((d) => d.kind === 'videoinput');
  document.getElementById('switch-camera-btn').classList.toggle('hidden', cameras.length <= 1);

  const video = document.getElementById('scanner-video');
  if (video.srcObject) {
    const track = video.srcObject.getVideoTracks()[0];
    if (track) {
      const settings = track.getSettings();
      localStorage.setItem('pick_last_camera', settings.deviceId);
      const idx = cameras.findIndex((c) => c.deviceId === settings.deviceId);
      if (idx !== -1) currentCameraIndex = idx;
      const caps = track.getCapabilities?.() || {};
      if ((caps.focusMode || []).includes('continuous')) {
        track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
      }
    }
  }
}

document.getElementById('scanner-video').addEventListener('click', async (e) => {
  const video = e.currentTarget;
  if (!video.srcObject || !scannerActive) return;

  const rect = video.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width;
  const y = (e.clientY - rect.top) / rect.height;

  const ind = document.getElementById('focus-indicator');
  ind.style.left = (e.clientX - rect.left) + 'px';
  ind.style.top  = (e.clientY - rect.top)  + 'px';
  ind.classList.remove('hidden', 'fading');
  setTimeout(() => ind.classList.add('fading'), 700);
  setTimeout(() => ind.classList.add('hidden'), 1200);

  const track = video.srcObject.getVideoTracks()[0];
  if (!track) return;
  try {
    await track.applyConstraints({ advanced: [{ focusMode: 'manual', pointsOfInterest: [{ x, y }] }] });
    setTimeout(() => track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {}), 1500);
  } catch (_) {}
});

async function switchCamera() {
  if (cameras.length <= 1) return;
  currentCameraIndex = (currentCameraIndex + 1) % cameras.length;
  if (codeReader) { codeReader.reset(); }
  const video = document.getElementById('scanner-video');
  if (video.srcObject) { video.srcObject.getTracks().forEach((t) => t.stop()); video.srcObject = null; }
  await startScanner(cameras[currentCameraIndex].deviceId);
}

function stopScanner() {
  if (!scannerActive) return;
  scannerActive = false;
  releaseWakeLock();

  if (codeReader) { codeReader.reset(); codeReader = null; }
  const video = document.getElementById('scanner-video');
  if (video.srcObject) { video.srcObject.getTracks().forEach((t) => t.stop()); video.srcObject = null; }

  cameras = [];
  currentCameraIndex = 0;
  document.getElementById('scanner-container').classList.remove('scanner-open');
  document.getElementById('scanner-container').classList.add('hidden');
  document.getElementById('scan-btn').textContent = 'Escanear';
  document.getElementById('switch-camera-btn').classList.add('hidden');
}

// ── Tab: Clientes ──────────────────────────────────────────────────────────
async function loadResumen() {
  const container = document.getElementById('resumen-list');
  container.innerHTML = '<p class="loading">Cargando...</p>';
  try {
    resumenData = await api.getResumen(semanaActual);
    renderResumen();
  } catch (err) {
    container.innerHTML = `<p class="error-msg">${err.message}</p>`;
  }
}

document.querySelectorAll('.filter-btn[data-filter]').forEach((btn) => {
  btn.addEventListener('click', () => {
    filtroActivo = btn.dataset.filter;
    document.querySelectorAll('.filter-btn[data-filter]').forEach((b) => b.classList.toggle('active', b.dataset.filter === filtroActivo));
    renderResumen();
  });
});


document.getElementById('clientes-search').addEventListener('input', (e) => {
  renderResumen(e.target.value.trim().toLowerCase());
});

function getPapelesKey() {
  return `papeles_separados_${semanaActual}`;
}

function getPapelesSeparados() {
  try { return new Set(JSON.parse(localStorage.getItem(getPapelesKey()) || '[]')); }
  catch { return new Set(); }
}

function savePapelSeparado(nombre, marcado) {
  const set = getPapelesSeparados();
  marcado ? set.add(nombre) : set.delete(nombre);
  localStorage.setItem(getPapelesKey(), JSON.stringify([...set]));
}

function renderResumen(searchQ = '') {
  const container = document.getElementById('resumen-list');
  let filtered = filtroActivo === 'todos'
    ? resumenData
    : resumenData.filter((r) => r.estado_general === filtroActivo);

  if (searchQ) {
    filtered = filtered.filter((r) => r.nombre.toLowerCase().includes(searchQ));
  }

  if (!filtered.length) {
    container.innerHTML = '<p class="loading">Sin resultados</p>';
    return;
  }

  const separados = getPapelesSeparados();
  const sorted = [...filtered].sort((a, b) => {
    const as = separados.has(a.nombre) ? 1 : 0;
    const bs = separados.has(b.nombre) ? 1 : 0;
    if (as !== bs) return as - bs;
    if (sortByImporte) return (b.importe_total || 0) - (a.importe_total || 0);
    return 0;
  });

  container.innerHTML = sorted.map((r) => {
    const marcado = separados.has(r.nombre);
    return `
    <div class="resumen-row">
      <button class="btn-papel${marcado ? ' marcado' : ''}" data-papel="${encodeURIComponent(r.nombre)}">✓</button>
      <div class="resumen-card estado-${r.estado_general}${marcado ? ' papel-separado' : ''}" data-nombre="${encodeURIComponent(r.nombre)}">
        <div class="resumen-nombre">${r.nombre}</div>
        <div class="resumen-stats">
          <span class="tag-ok">${r.completados} ✓</span>
          <span class="tag-pend">${r.pendientes} pend.</span>
          <span class="tag-total">${r.total} total</span>
          ${r.importe_total > 0 ? `<span class="tag-importe">${formatImporte(r.importe_total)}</span>` : ''}
        </div>
        <div class="resumen-badge badge-${r.estado_general}">${r.estado_general}</div>
        <button class="btn-ver-picks">›</button>
      </div>
    </div>
  `}).join('');

  container.querySelectorAll('.btn-papel').forEach((btn) => {
    btn.addEventListener('click', () => {
      const nombre = decodeURIComponent(btn.dataset.papel);
      const marcado = !btn.classList.contains('marcado');
      savePapelSeparado(nombre, marcado);
      renderResumen(document.getElementById('clientes-search').value.trim().toLowerCase());
    });
  });

  container.querySelectorAll('.resumen-card').forEach((card) => {
    card.addEventListener('click', () => {
      abrirPicksCliente(decodeURIComponent(card.dataset.nombre));
    });
  });
}

// ── Picks por cliente (bottom-sheet) ──────────────────────────────────────
async function abrirPicksCliente(nombre) {
  document.getElementById('cliente-picks-title').textContent = nombre;
  document.getElementById('cliente-picks-progress').textContent = '';
  const content = document.getElementById('cliente-picks-content');
  content.innerHTML = '<p class="loading">Cargando...</p>';
  document.getElementById('cliente-picks-overlay').classList.remove('hidden');

  try {
    const picks = await api.getPicksPorCliente(nombre, semanaActual);
    if (!picks.length) {
      content.innerHTML = '<p class="loading">Sin items</p>';
    } else {
      renderPicks(picks, content);
      updateSheetProgress();
    }
  } catch (err) {
    content.innerHTML = `<p class="error-msg">${err.message}</p>`;
  }
}

document.getElementById('cliente-picks-close').addEventListener('click', () => {
  document.getElementById('cliente-picks-overlay').classList.add('hidden');
  loadResumen();
});

document.getElementById('cliente-picks-overlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) {
    document.getElementById('cliente-picks-overlay').classList.add('hidden');
    loadResumen();
  }
});


// ── Tab: Admin ─────────────────────────────────────────────────────────────
function initAdmin() {
  const vendedor = esVendedor();
  if (adminUnlocked || esAdmin() || vendedor) {
    adminUnlocked = true;
    document.getElementById('admin-lock').classList.add('hidden');
    document.getElementById('admin-panel').classList.remove('hidden');

    // Vendedor: ocultar Semanas y Usuarios
    document.querySelector('.admin-tab-btn[data-admin-tab="nueva-semana"]').classList.toggle('hidden', vendedor);
    document.querySelector('.admin-tab-btn[data-admin-tab="usuarios"]').classList.toggle('hidden', vendedor);

    const esDiarco = getMayorista() === 'diarco';
    if (esDiarco && !vendedor) {
      document.querySelectorAll('.admin-tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.admin-tab-panel').forEach(p => p.classList.add('hidden'));
      const firstBtn = document.querySelector('.admin-tab-btn:not(.hidden)');
      if (firstBtn) {
        firstBtn.classList.add('active');
        const target = firstBtn.dataset.adminTab;
        document.querySelector(`.admin-tab-panel[data-admin-panel="${target}"]`)?.classList.remove('hidden');
        if (target === 'nueva-semana') loadSemanasAdmin();
        if (target === 'clientes') loadClientes();
      }
    } else {
      // Asegurar que Clientes esté activo para Yaguar o vendedor
      document.querySelectorAll('.admin-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.adminTab === 'clientes'));
      document.querySelectorAll('.admin-tab-panel').forEach(p => p.classList.toggle('hidden', p.dataset.adminPanel !== 'clientes'));
      loadClientes();
    }
  } else {
    document.getElementById('admin-lock').classList.remove('hidden');
    document.getElementById('admin-panel').classList.add('hidden');
  }
}

document.getElementById('admin-unlock-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pw = document.getElementById('admin-password').value;
  const errorDiv = document.getElementById('admin-error');
  errorDiv.classList.add('hidden');
  try {
    await api.verifyAdmin(pw);
    adminUnlocked = true;
    document.getElementById('admin-lock').classList.add('hidden');
    document.getElementById('admin-panel').classList.remove('hidden');
    loadClientes();
  } catch {
    errorDiv.textContent = 'Contraseña incorrecta';
    errorDiv.classList.remove('hidden');
  }
});

async function loadSinRegistrar() {
  const sec = document.getElementById('sin-registrar-section');
  if (!sec) return;
  try {
    const pendientes = await api.getSinRegistrar();
    if (!pendientes.length) { sec.innerHTML = ''; return; }
    const esc = (s) => (s || '').replace(/'/g, '&#39;').replace(/"/g, '&quot;');
    sec.innerHTML = `
      <div class="sin-reg-wrap">
        <div class="admin-section-title sin-reg-title">
          Sin registrar <span class="sin-reg-count">${pendientes.length}</span>
        </div>
        <p class="admin-tab-desc">Estos clientes aparecieron en picks importados pero no tienen datos completos. Hacé clic en "Registrar" para cargarlos.</p>
        <div class="table-wrap" style="margin-bottom:0">
          <table class="clientes-table">
            <thead><tr><th>Código</th><th>Nombre en el pick</th><th></th></tr></thead>
            <tbody>${pendientes.map((p) => `
              <tr onclick="registrarClientePendiente('${esc(p.id)}','${esc(p.nombre_obs)}')">
                <td class="td-full">${p.id}</td>
                <td class="td-full">${p.nombre_obs || '—'}</td>
                <td onclick="event.stopPropagation()"><div class="td-actions">
                  <button class="btn-edit" onclick="registrarClientePendiente('${esc(p.id)}','${esc(p.nombre_obs)}')">Registrar</button>
                </div></td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
        <div class="admin-divider"></div>
      </div>`;
  } catch { sec.innerHTML = ''; }
}

function registrarClientePendiente(codigo, nombreObs) {
  openClienteForm(null, codigo, nombreObs);
}

document.getElementById('btn-nuevo-cliente').addEventListener('click', async () => {
  if (getMayorista() === 'yaguar') {
    try {
      const res = await api.getCodigoLibreYaguar();
      openClienteForm(null, res.codigo);
    } catch {
      showToast('No hay códigos libres disponibles', 'error');
    }
  } else {
    openClienteForm(null);
  }
});

// ── Info-btn: toggle de ayuda contextual ──────────────────────────────────
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.info-btn');
  if (!btn) return;
  const content = btn.parentElement.querySelector('.info-content');
  if (!content) return;
  const visible = content.classList.toggle('visible');
  btn.classList.toggle('active', visible);
});

// ── Admin búsqueda de clientes ─────────────────────────────────────────────
document.getElementById('admin-clientes-search').addEventListener('input', (e) => {
  const q = e.target.value.toLowerCase();
  document.querySelectorAll('#clientes-tbody tr').forEach((row) => {
    row.style.display = row.textContent.toLowerCase().includes(q) ? '' : 'none';
  });
});

async function loadClientes() {
  const m = getMayorista();
  const esYaguar = m === 'yaguar';
  document.getElementById('th-codigo-yaguar').style.display = esYaguar ? '' : 'none';
  document.getElementById('th-flete-yaguar').style.display = esYaguar ? '' : 'none';
  document.getElementById('btn-exportar-clientes').classList.toggle('hidden', !esYaguar);
  const colspan = esYaguar ? 8 : 6;
  const tbody = document.getElementById('clientes-tbody');
  tbody.innerHTML = `<tr><td colspan="${colspan}" class="loading">Cargando...</td></tr>`;
  try {
    const clientes = await api.getClientes();
    const dn = 'display:none';
    tbody.innerHTML = clientes.map((c) => {
      const flete = c.flete != null ? (Math.round(c.flete * 10000) / 100) + '%' : '';
      const yHide = esYaguar ? '' : dn;
      return `<tr data-id="${c.id}" onclick="openClienteForm(${c.id})"><td class="td-full" style="${yHide}">${c.id_yaguar ?? ''}</td><td class="td-full">${c.nombre ?? ''}</td><td>${c.localidad ?? ''}</td><td>${c.telefono ?? ''}</td><td>${c.contacto ?? ''}</td><td>${c.vendedor ?? ''}</td><td style="${yHide}">${flete}</td><td onclick="event.stopPropagation()"><div class="td-actions"><button class="btn-edit" onclick="openClienteForm(${c.id})">Editar</button><button class="btn-del" onclick="deleteCliente(${c.id})">Eliminar</button></div></td></tr>`;
    }).join('');
    // Reaplicar filtro de búsqueda si hay texto
    const q = document.getElementById('admin-clientes-search').value.toLowerCase();
    if (q) {
      document.querySelectorAll('#clientes-tbody tr').forEach((row) => {
        row.style.display = row.textContent.toLowerCase().includes(q) ? '' : 'none';
      });
    }
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="${colspan}" class="error-msg">${err.message}</td></tr>`;
  }
  loadSinRegistrar();
}

document.getElementById('btn-exportar-clientes').addEventListener('click', () => {
  window.location.href = '/api/yaguar/export/clientes';
});

async function openClienteForm(id, codigoPreverificado = null, nombrePre = null) {
  editingClienteId = id;
  document.getElementById('modal-title').textContent = id ? 'Editar cliente' : 'Nuevo cliente';

  const esYaguar = getMayorista() === 'yaguar';
  const idInput = document.getElementById('cf-id_yaguar');

  // Mostrar campo ID para ambos mayoristas con label correspondiente
  document.getElementById('cf-id-yaguar-wrap').style.display = '';
  document.getElementById('cf-id-label').textContent = esYaguar ? 'Código Yaguar' : 'Código DIARCO';
  document.getElementById('cf-flete-wrap').style.display = esYaguar ? '' : 'none';

  // Yaguar: readonly (auto-asignado). DIARCO: editable manualmente.
  idInput.readOnly = esYaguar;
  idInput.value = '';
  idInput.placeholder = esYaguar ? '' : 'Ingresá el código DIARCO';

  const fields = ['nombre', 'localidad', 'direccion', 'telefono', 'contacto', 'vendedor'];
  fields.forEach((f) => { document.getElementById(`cf-${f}`).value = ''; });
  document.getElementById('cf-flete').value = '';
  if (nombrePre) document.getElementById('cf-nombre').value = nombrePre;

  const zonas = await api.getZonas().catch(() => []);
  const sel = document.getElementById('cf-localidad');
  sel.innerHTML = '<option value="">— Seleccioná una zona —</option>' +
    zonas.map((z) => `<option value="${z.nombre}">${z.nombre}</option>`).join('');

  if (id) {
    api.getClientes().then((list) => {
      const c = list.find((x) => x.id === id);
      if (c) {
        fields.forEach((f) => { document.getElementById(`cf-${f}`).value = c[f] ?? ''; });
        idInput.value = c.id_yaguar ?? '';
        document.getElementById('cf-flete').value = c.flete ?? '';
      }
    });
  } else if (codigoPreverificado) {
    idInput.value = codigoPreverificado;
    // Si viene de sin-registrar, el código ya es conocido → readonly
    if (nombrePre) idInput.readOnly = true;
  }

  document.getElementById('cliente-modal').classList.remove('hidden');
}

document.getElementById('modal-close').addEventListener('click', () => {
  document.getElementById('cliente-modal').classList.add('hidden');
});

document.getElementById('cliente-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = {};
  ['nombre', 'localidad', 'direccion', 'telefono', 'contacto', 'vendedor'].forEach((f) => {
    data[f] = document.getElementById(`cf-${f}`).value.trim() || null;
  });
  data.id_yaguar = document.getElementById('cf-id_yaguar').value.trim() || null;
  const fleteVal = document.getElementById('cf-flete').value.trim();
  data.flete = fleteVal !== '' ? parseFloat(fleteVal) : null;

  if (!data.localidad) { showToast('Seleccioná una zona', 'error'); return; }
  if (!data.vendedor) { showToast('Ingresá el vendedor', 'error'); return; }

  if (editingClienteId) {
    const ok = await confirmar('¿Confirmás los cambios en este cliente?');
    if (!ok) return;
  }

  try {
    if (editingClienteId) {
      await api.updateCliente(editingClienteId, data);
      showToast('Cliente actualizado', 'success');
    } else {
      await api.createCliente(data);
      showToast('Cliente creado', 'success');
    }
    document.getElementById('cliente-modal').classList.add('hidden');
    loadClientes();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

async function deleteCliente(id) {
  if (!await confirmar('¿Eliminar este cliente?', 'Sí, eliminar')) return;
  try {
    await api.deleteCliente(id);
    showToast('Cliente eliminado', 'info');
    loadClientes();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ── Modal: clientes faltantes post-import ──────────────────────────────────
let _cfmPendientes = [];
let _cfmNombres = {};
let _cfmEsYaguar = true;
let _cfmNoCF = new Set();
let _cfmIdx = 0;

async function abrirModalClientesFaltantes(ids, nombres = {}, esYaguar = true, noCF = []) {
  _cfmPendientes = ids;
  _cfmNombres = nombres;
  _cfmEsYaguar = esYaguar;
  _cfmNoCF = new Set(noCF);
  _cfmIdx = 0;
  await _cfmMostrar();
}

async function _cfmMostrar() {
  if (_cfmIdx >= _cfmPendientes.length) {
    document.getElementById('clientes-faltantes-modal').classList.add('hidden');
    loadClientes();
    return;
  }
  const id = _cfmPendientes[_cfmIdx];
  const total = _cfmPendientes.length;
  document.getElementById('cfm-id_yaguar').value = id;
  document.getElementById('cfm-progreso').textContent = `${_cfmIdx + 1} de ${total}`;

  document.getElementById('cfm-no-cf-aviso').classList.toggle('hidden', !_cfmNoCF.has(id));

  // Pre-rellenar nombre desde OBSERVACION si está disponible
  document.getElementById('cfm-nombre').value = _cfmNombres[id] || '';
  ['direccion', 'telefono', 'contacto'].forEach((f) => {
    document.getElementById(`cfm-${f}`).value = '';
  });

  const [zonas, vendedores] = await Promise.all([
    api.getZonas().catch(() => []),
    api.getVendedoresYaguar().catch(() => []),
  ]);

  const selZona = document.getElementById('cfm-localidad');
  selZona.innerHTML = '<option value="">— Seleccioná una zona —</option>' +
    zonas.map((z) => `<option value="${z.nombre}">${z.nombre}</option>`).join('');

  const selVend = document.getElementById('cfm-vendedor');
  selVend.innerHTML = '<option value="">— Seleccioná un vendedor —</option>' +
    vendedores.map((v) => `<option value="${v}">${v}</option>`).join('');

  document.getElementById('clientes-faltantes-modal').classList.remove('hidden');
}

document.getElementById('cfm-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = { id_yaguar: document.getElementById('cfm-id_yaguar').value };
  ['nombre', 'localidad', 'direccion', 'telefono', 'contacto', 'vendedor'].forEach((f) => {
    data[f] = document.getElementById(`cfm-${f}`).value.trim() || null;
  });
  if (!data.nombre) { showToast('Ingresá el nombre', 'error'); return; }
  try {
    await api.createCliente(data);
    showToast('Cliente guardado', 'success');
  } catch (err) {
    showToast(err.message, 'error');
    return;
  }
  _cfmIdx++;
  await _cfmMostrar();
});

document.getElementById('cfm-skip').addEventListener('click', async () => {
  _cfmIdx++;
  await _cfmMostrar();
});

document.getElementById('cfm-close').addEventListener('click', () => {
  document.getElementById('clientes-faltantes-modal').classList.add('hidden');
  loadClientes();
});


// ── Admin: Semanas ─────────────────────────────────────────────────────────
async function loadSemanasAdmin() {
  const list = document.getElementById('semanas-admin-list');
  if (!list) return;

  const m = getMayorista();

  // Descripción y formulario según mayorista
  document.getElementById('semanas-desc').innerHTML = m === 'diarco'
    ? '<p>Acá se cargan los pedidos de DIARCO. Completá el nombre de la semana, las fechas del pedido, y subí el archivo.</p><p>Si reimportás una semana con el mismo nombre, se reemplazan todos sus picks anteriores.</p>'
    : '<p>Acá se cargan los pedidos de Yaguar. Completá el nombre de la semana, las fechas del pedido, y subí los archivos.</p><p>Si reimportás una semana con el mismo nombre, se reemplazan todos sus picks anteriores.</p>';
  document.getElementById('import-yaguar').classList.toggle('hidden', m === 'diarco');
  document.getElementById('import-diarco').classList.toggle('hidden', m !== 'diarco');

  try {
    const semanas = await api.getSemanas();
    if (semanas.length === 0) {
      list.innerHTML = '<p class="semana-admin-empty">No hay semanas cargadas</p>';
      return;
    }
    list.innerHTML = semanas.map((s) => `
      <div class="semana-admin-item">
        <span class="semana-nombre-tag">${s.nombre}</span>
        <a class="btn-export" href="${api.exportPicksUrl(s.nombre)}" download>↓ Excel</a>
        <button class="btn-del" onclick="deleteSemana(${s.id}, '${s.nombre.replace(/'/g, "\\'")}')">Eliminar</button>
      </div>
    `).join('');
  } catch (err) {
    list.innerHTML = `<p class="error-msg">${err.message}</p>`;
  }
}

async function deleteSemana(id, nombre) {
  if (!await confirmar(`¿Eliminar "${nombre}" del selector? Los picks quedan guardados para análisis futuro.`, 'Sí, eliminar')) return;
  try {
    await api.deleteSemana(id);
    showToast(`Semana ${nombre} eliminada`, 'info');
    await loadSemanas();
    loadSemanasAdmin();
    if (semanaActual === nombre) {
      semanaActual = document.getElementById('semana-select').value;
      loadStats();
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ── Admin: Usuarios ────────────────────────────────────────────────────────
async function loadUsers() {
  const tbody = document.getElementById('users-tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="4" class="loading">Cargando...</td></tr>';
  try {
    const users = await api.getUsers();
    tbody.innerHTML = users.map((u) => {
      const esSuperadmin = u.rol === 'superadmin';
      const esAdminUser = u.rol === 'admin';
      const rolLabel = esSuperadmin ? '<span style="color:var(--accent)">Superadmin</span>'
                     : esAdminUser  ? '<span style="color:var(--green)">Admin</span>'
                     :                '<span style="color:var(--muted)">Operario</span>';
      const esSuperadminActual = getRol() === 'superadmin';
      const toggleBtn = (esSuperadmin || !esSuperadminActual) ? '' : `
        <label class="rol-switch" title="${esAdminUser ? 'Quitar admin' : 'Dar admin'}">
          <input type="checkbox" ${esAdminUser ? 'checked' : ''} onchange="toggleRol(${u.id}, '${u.rol}', this)">
          <span class="rol-switch-track"><span class="rol-switch-thumb"></span></span>
          <span class="rol-switch-label">${esAdminUser ? 'Admin' : 'Operario'}</span>
        </label>`;
      const delBtn = esSuperadmin ? '' : `<button class="btn-del" onclick="deleteUser(${u.id})">✕</button>`;
      return `
        <tr>
          <td>${u.username}</td>
          <td>${rolLabel}</td>
          <td>${u.created_at ? new Date(u.created_at).toLocaleDateString('es') : '—'}</td>
          <td class="td-actions">${esSuperadmin ? '<span style="color:var(--muted)">—</span>' : toggleBtn + delBtn}</td>
        </tr>`;
    }).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" class="error-msg">${err.message}</td></tr>`;
  }
}

async function toggleRol(id, rolActual, checkbox) {
  const nuevoRol = rolActual === 'admin' ? 'operario' : 'admin';
  try {
    await api.updateRol(id, nuevoRol);
    showToast(`Rol actualizado a ${nuevoRol}`, 'success');
    loadUsers();
  } catch (err) {
    checkbox.checked = !checkbox.checked;
    showToast(err.message, 'error');
  }
}

async function deleteUser(id) {
  if (!await confirmar('¿Eliminar este usuario?', 'Sí, eliminar')) return;
  try {
    await api.deleteUser(id);
    showToast('Usuario eliminado', 'info');
    loadUsers();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

document.getElementById('nuevo-usuario-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('nu-email').value.trim();
  const password = document.getElementById('nu-password').value;
  try {
    await api.createUser(username, password);
    showToast(`Usuario ${username} creado`, 'success');
    document.getElementById('nuevo-usuario-form').reset();
    loadUsers();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// ── Admin: Nueva Semana ────────────────────────────────────────────────────
document.getElementById('db-file-input').addEventListener('change', (e) => {
  const files = Array.from(e.target.files);
  const list = document.getElementById('upload-file-list');
  list.innerHTML = files.map((f) => `
    <div class="upload-file-item">
      <span class="upload-file-name">${f.name}</span>
      <span class="upload-file-size">${(f.size / 1024).toFixed(1)} KB</span>
    </div>
  `).join('');
  document.getElementById('btn-importar-semana').disabled = files.length === 0;
});

document.getElementById('btn-importar-semana').addEventListener('click', async () => {
  const nombre = document.getElementById('semana-nombre').value.trim();
  const fechaDesde = document.getElementById('semana-fecha-desde').value.replace(/-/g, '');
  const fechaHasta = document.getElementById('semana-fecha-hasta').value.replace(/-/g, '');
  const files = document.getElementById('db-file-input').files;

  if (!nombre) { showToast('Ingresá un nombre para el pick', 'error'); return; }
  if (!fechaDesde || !fechaHasta) { showToast('Seleccioná las fechas', 'error'); return; }
  if (files.length === 0) { showToast('Seleccioná al menos un archivo .db', 'error'); return; }

  const semanas = await api.getSemanas();
  if (semanas.some((s) => s.nombre === nombre)) {
    const ok = await confirmar(`La semana "${nombre}" ya existe. ¿Querés reemplazarla con los nuevos datos? Esto borrará todos los picks actuales de esa semana.`);
    if (!ok) return;
  }

  const formData = new FormData();
  formData.append('nombre', nombre);
  formData.append('fecha_desde', fechaDesde);
  formData.append('fecha_hasta', fechaHasta);
  for (const file of files) formData.append('archivos', file);

  const btn = document.getElementById('btn-importar-semana');
  btn.disabled = true;
  btn.textContent = 'Importando...';

  const resultPanel = document.getElementById('import-result');

  try {
    const res = await api.importarSemana(formData);
    await loadSemanas();
    loadStats();
    loadSemanasAdmin();

    if (res.clientes_no_encontrados.length === 0) {
      resultPanel.className = 'import-result result-ok';
      resultPanel.innerHTML = `
        <div class="import-result-title ok">Importación exitosa</div>
        ${res.picks_importados} picks cargados para <strong>${res.semana}</strong>. Todos los clientes fueron encontrados.
      `;
    } else {
      const tags = res.clientes_no_encontrados
        .map((id) => `<span class="import-missing-tag">${id}</span>`)
        .join('');
      resultPanel.className = 'import-result result-warn';
      resultPanel.innerHTML = `
        <div class="import-result-title warn">
          ${res.picks_importados} picks importados — ${res.clientes_no_encontrados.length} cliente${res.clientes_no_encontrados.length > 1 ? 's' : ''} sin datos
        </div>
        Los siguientes IDs no están en la tabla de clientes:
        <div class="import-missing-list">${tags}</div>
      `;
      abrirModalClientesFaltantes(res.clientes_no_encontrados, {}, true, res.no_encontrados_no_cf || []);
    }
    resultPanel.classList.remove('hidden');
  } catch (err) {
    resultPanel.className = 'import-result result-warn';
    resultPanel.innerHTML = `<div class="import-result-title warn">Error</div>${err.message}`;
    resultPanel.classList.remove('hidden');
  } finally {
    btn.disabled = files.length === 0;
    btn.textContent = 'Importar picks';
  }
});

// ── Admin: Importar DIARCO ─────────────────────────────────────────────────
document.getElementById('diarco-file-input').addEventListener('change', (e) => {
  const files = Array.from(e.target.files);
  const list = document.getElementById('diarco-upload-list');
  list.innerHTML = files.map((f) => `
    <div class="upload-file-item">
      <span class="upload-file-name">${f.name}</span>
      <span class="upload-file-size">${(f.size / 1024).toFixed(1)} KB</span>
    </div>
  `).join('');
  document.getElementById('btn-importar-diarco').disabled = files.length === 0;
});

document.getElementById('btn-importar-diarco').addEventListener('click', async () => {
  const nombre = document.getElementById('diarco-semana-nombre').value.trim();
  const fechaDesde = document.getElementById('diarco-fecha-desde').value.replace(/-/g, '');
  const fechaHasta = document.getElementById('diarco-fecha-hasta').value.replace(/-/g, '');
  const files = document.getElementById('diarco-file-input').files;

  if (!nombre) { showToast('Ingresá un nombre para el pick', 'error'); return; }
  if (!fechaDesde || !fechaHasta) { showToast('Seleccioná las fechas', 'error'); return; }
  if (files.length === 0) { showToast('Seleccioná al menos un archivo MobileAssistantBU.db', 'error'); return; }

  const semanas = await api.getSemanas();
  if (semanas.some((s) => s.nombre === nombre)) {
    const ok = await confirmar(`La semana "${nombre}" ya existe. ¿Querés reemplazarla con los nuevos datos?`);
    if (!ok) return;
  }

  const formData = new FormData();
  formData.append('nombre', nombre);
  formData.append('fecha_desde', fechaDesde);
  formData.append('fecha_hasta', fechaHasta);
  for (const file of files) formData.append('archivos', file);

  const btn = document.getElementById('btn-importar-diarco');
  btn.disabled = true;
  btn.textContent = 'Importando...';
  const resultPanel = document.getElementById('import-result');

  try {
    const res = await api.importarSemana(formData);
    await loadSemanas();
    loadStats();
    loadSemanasAdmin();
    const sinDatos = res.clientes_sin_datos || [];
    if (sinDatos.length > 0) {
      const tags = sinDatos.map((c) => `<span class="import-missing-tag">${c.id}</span>`).join('');
      resultPanel.className = 'import-result result-warn';
      resultPanel.innerHTML = `
        <div class="import-result-title warn">
          ${res.picks_importados} picks importados — ${sinDatos.length} cliente${sinDatos.length > 1 ? 's' : ''} sin datos
        </div>
        Los siguientes IDs no tienen nombre asignado:
        <div class="import-missing-list">${tags}</div>
      `;
      const ids = sinDatos.map((c) => c.id);
      const nombres = Object.fromEntries(sinDatos.map((c) => [c.id, c.nombre]));
      abrirModalClientesFaltantes(ids, nombres, false);
    } else {
      resultPanel.className = 'import-result result-ok';
      resultPanel.innerHTML = `
        <div class="import-result-title ok">Importación exitosa</div>
        ${res.picks_importados} picks cargados para <strong>${res.semana}</strong> — ${res.clientes} clientes.
      `;
    }
    resultPanel.classList.remove('hidden');
  } catch (err) {
    resultPanel.className = 'import-result result-warn';
    resultPanel.innerHTML = `<div class="import-result-title warn">Error</div>${err.message}`;
    resultPanel.classList.remove('hidden');
  } finally {
    btn.disabled = files.length === 0;
    btn.textContent = 'Importar picks';
  }
});

// ── Cambiar contraseña ─────────────────────────────────────────────────────
document.getElementById('change-pw-btn').addEventListener('click', () => {
  document.getElementById('pw-form').reset();
  document.getElementById('username-form').reset();
  document.getElementById('pw-modal').classList.remove('hidden');
});

document.getElementById('pw-modal-close').addEventListener('click', () => {
  document.getElementById('pw-modal').classList.add('hidden');
});

document.getElementById('pw-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const current = document.getElementById('pw-current').value;
  const newPw = document.getElementById('pw-new').value;
  const confirm = document.getElementById('pw-confirm').value;

  if (newPw !== confirm) {
    showToast('Las contraseñas nuevas no coinciden', 'error');
    return;
  }

  try {
    await api.changePassword(current, newPw);
    document.getElementById('pw-modal').classList.add('hidden');
    showToast('Contraseña actualizada', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
});

document.getElementById('username-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const newUsername = document.getElementById('un-new').value.trim();
  const password = document.getElementById('un-password').value;

  try {
    await api.changeUsername(password, newUsername);
    document.getElementById('pw-modal').classList.add('hidden');
    clearToken();
    showLogin();
    showToast(`Nombre cambiado a "${newUsername}". Ingresá de nuevo.`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// ── Pantalla completa (solo mobile) ────────────────────────────────────────
(function () {
  const MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (!MOBILE) return;

  const btn = document.getElementById('btn-fullscreen');

  function enterFullscreen() {
    const el = document.documentElement;
    if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  }

  function exitFullscreen() {
    if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
    else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
  }

  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }

  function updateBtn() {
    if (!btn) return;
    btn.textContent = isFullscreen() ? '⊡' : '⛶';
    btn.title = isFullscreen() ? 'Salir de pantalla completa' : 'Pantalla completa';
  }

  document.addEventListener('fullscreenchange', updateBtn);
  document.addEventListener('webkitfullscreenchange', updateBtn);

  if (btn) btn.addEventListener('click', () => {
    if (isFullscreen()) exitFullscreen(); else enterFullscreen();
  });

})();

// ── Admin: Zonas ───────────────────────────────────────────────────────────
async function populateRepartosSelect(selectId, valorActual = '') {
  const sel = document.getElementById(selectId);
  const repartos = await api.getRepartos().catch(() => []);
  sel.innerHTML = '<option value="">— Sin reparto —</option>' +
    repartos.map((r) => `<option value="${r.nombre}" ${r.nombre === valorActual ? 'selected' : ''}>${r.nombre}</option>`).join('');
}

function renderRepartosOrden(repartos) {
  const list = document.getElementById('repartos-orden-list');
  list.innerHTML = repartos.map((r, i) => `
    <div class="reparto-orden-item">
      <span class="reparto-orden-num">${i + 1}</span>
      <span class="reparto-orden-nombre">${r.nombre}</span>
      <button class="btn-orden" onclick="moverReparto(${r.id}, 'up')" ${i === 0 ? 'disabled' : ''}>▲</button>
      <button class="btn-orden" onclick="moverReparto(${r.id}, 'down')" ${i === repartos.length - 1 ? 'disabled' : ''}>▼</button>
    </div>
  `).join('');
}

async function moverReparto(id, direccion) {
  try {
    const repartos = await api.moverReparto(id, direccion);
    renderRepartosOrden(repartos);
    await populateRepartosSelect('nz-reparto', document.getElementById('nz-reparto').value);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function loadZonas() {
  const tbody = document.getElementById('zonas-tbody');
  try {
    const [zonas, repartos] = await Promise.all([api.getZonas(), api.getRepartos()]);
    renderRepartosOrden(repartos);
    const repActual = document.getElementById('nz-reparto').value;
    document.getElementById('nz-reparto').innerHTML = '<option value="">— Sin reparto —</option>' +
      repartos.map((r) => `<option value="${r.nombre}" ${r.nombre === repActual ? 'selected' : ''}>${r.nombre}</option>`).join('');
    if (!zonas.length) {
      tbody.innerHTML = '<tr><td colspan="3" class="error-msg">No hay zonas cargadas</td></tr>';
      return;
    }
    tbody.innerHTML = zonas.map((z) => `
      <tr data-id="${z.id}">
        <td>${z.nombre}</td>
        <td>${z.reparto || '<span style="color:var(--muted)">—</span>'}</td>
        <td>
          <button class="btn-edit" onclick="editZona(${z.id}, '${z.nombre.replace(/'/g, "\\'")}', '${(z.reparto || '').replace(/'/g, "\\'")}')">Editar</button>
          <button class="btn-del" onclick="deleteZona(${z.id}, '${z.nombre.replace(/'/g, "\\'")}')">✕</button>
        </td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="3" class="error-msg">${err.message}</td></tr>`;
  }
}

function editZona(id, nombre, reparto) {
  document.getElementById('nz-nombre').value = nombre;
  document.getElementById('nz-reparto').value = reparto;
  const btn = document.querySelector('#nueva-zona-form button[type="submit"]');
  btn.textContent = 'Guardar cambios';
  btn.dataset.editId = id;
}

async function deleteZona(id, nombre) {
  const ok = await confirmar(`¿Eliminar la zona "${nombre}"?`);
  if (!ok) return;
  try {
    await api.deleteZona(id);
    showToast(`Zona ${nombre} eliminada`, 'info');
    loadZonas();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

document.getElementById('nueva-zona-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const nombre = document.getElementById('nz-nombre').value.trim();
  const reparto = document.getElementById('nz-reparto').value;
  const btn = e.target.querySelector('button[type="submit"]');
  const editId = btn.dataset.editId;

  try {
    if (editId) {
      await api.updateZona(parseInt(editId), nombre, reparto);
      showToast('Zona actualizada', 'success');
      delete btn.dataset.editId;
      btn.textContent = 'Agregar zona';
    } else {
      await api.createZona(nombre, reparto);
      showToast(`Zona ${nombre} creada`, 'success');
    }
    document.getElementById('nz-nombre').value = '';
    document.getElementById('nz-reparto').value = '';
    loadZonas();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// ── Modal de confirmación ──────────────────────────────────────────────────
function confirmar(msg, btnLabel = 'Sí, confirmar') {
  return new Promise((resolve) => {
    const overlay = document.getElementById('confirm-modal');
    document.getElementById('confirm-msg').textContent = msg;
    overlay.classList.remove('hidden');
    const ok = document.getElementById('confirm-ok');
    ok.textContent = btnLabel;
    const cancel = document.getElementById('confirm-cancel');
    function cleanup(result) {
      overlay.classList.add('hidden');
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      resolve(result);
    }
    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }
    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
  });
}

// ── Toast ──────────────────────────────────────────────────────────────────
function showToast(msg, type = 'info') {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = `toast toast-${type} show`;
  setTimeout(() => toast.classList.remove('show'), 2800);
}

// ══════════════════════════════════════════════════════════════════════════════
// SOBRANTES
// ══════════════════════════════════════════════════════════════════════════════

let _sobListas = [];
let _sobListaActual = null;
let _sobItems = [];
let sobScannerActive = false;
let _sobCodeReader = null;
let _sobCameras = [];
let _sobCamIdx = 0;

async function initSobrantes() {
  await loadSobListas();
}

async function loadSobListas() {
  try {
    _sobListas = await api.sobGetListas();
  } catch { _sobListas = []; }

  const sel = document.getElementById('sob-lista-select');
  if (_sobListas.length === 0) {
    const hoy = new Date().toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const nombre = `Sobrantes ${hoy}`;
    _sobListaActual = nombre;
    sel.innerHTML = `<option value="${nombre}">${nombre} (nueva)</option>`;
  } else {
    sel.innerHTML = _sobListas.map(l =>
      `<option value="${l.lista}">${l.lista} (${l.items} ítems)</option>`
    ).join('');
    if (!_sobListaActual || !_sobListas.find(l => l.lista === _sobListaActual)) {
      _sobListaActual = _sobListas[0].lista;
    }
    sel.value = _sobListaActual;
  }
  await loadSobItems();
}

async function loadSobItems() {
  const lista = document.getElementById('sob-lista-select').value;
  _sobListaActual = lista;
  if (!lista) { renderSobItems([]); return; }
  try {
    _sobItems = await api.sobGetItems(lista);
  } catch { _sobItems = []; }
  renderSobItems(_sobItems);
}

function renderSobItems(items) {
  const container = document.getElementById('sob-items');
  const exportBar = document.getElementById('sob-export-bar');
  const exportLink = document.getElementById('sob-export-link');

  if (items.length === 0) {
    container.innerHTML = '<p style="color:var(--muted);font-size:13px;padding:8px 0">Escaneá o buscá un producto para empezar.</p>';
    exportBar.classList.add('hidden');
    return;
  }

  exportBar.classList.remove('hidden');
  exportLink.href = api.sobExportUrl(_sobListaActual);
  exportLink.download = `sobrantes_${_sobListaActual}.xlsx`;

  container.innerHTML = items.map(item => `
    <div class="sob-item" data-id="${item.id}">
      <div class="sob-item-top">
        <div class="sob-item-info">
          <div class="sob-item-descrip">${item.descrip || item.cod_bar || item.cod_art || '—'}</div>
          <div class="sob-item-cod">${[item.cod_bar, item.cod_art].filter(Boolean).join(' · ')}</div>
        </div>
        <button class="sob-item-remove" data-id="${item.id}">✕</button>
      </div>
      <div class="sob-steppers">
        <div class="sob-stepper">
          <span class="sob-stepper-label">UNI</span>
          <button class="btn-step-minus sob-btn" data-id="${item.id}" data-field="unidades">−</button>
          <span class="sob-stepper-val" data-id="${item.id}" data-field="unidades">${item.unidades}</span>
          <button class="btn-step-plus sob-btn" data-id="${item.id}" data-field="unidades">+</button>
        </div>
        <div class="sob-stepper">
          <span class="sob-stepper-label">BUL</span>
          <button class="btn-step-minus sob-btn" data-id="${item.id}" data-field="bultos">−</button>
          <span class="sob-stepper-val" data-id="${item.id}" data-field="bultos">${item.bultos}</span>
          <button class="btn-step-plus sob-btn" data-id="${item.id}" data-field="bultos">+</button>
        </div>
      </div>
    </div>
  `).join('');
}

// Delegated stepper clicks
document.getElementById('sob-items').addEventListener('click', async (e) => {
  const btn = e.target.closest('.sob-btn');
  if (btn) {
    const id = parseInt(btn.dataset.id);
    const field = btn.dataset.field;
    const item = _sobItems.find(i => i.id === id);
    if (!item) return;
    const delta = btn.classList.contains('btn-step-plus') ? 1 : -1;
    item[field] = Math.max(0, item[field] + delta);
    document.querySelector(`.sob-stepper-val[data-id="${id}"][data-field="${field}"]`).textContent = item[field];
    try {
      await api.sobUpdateItem(_sobListaActual, id, item.unidades, item.bultos);
    } catch { showToast('Error al actualizar', 'error'); }
    return;
  }
  const removeBtn = e.target.closest('.sob-item-remove');
  if (removeBtn) {
    const id = parseInt(removeBtn.dataset.id);
    try {
      await api.sobDeleteItem(_sobListaActual, id);
      _sobItems = _sobItems.filter(i => i.id !== id);
      renderSobItems(_sobItems);
    } catch { showToast('Error al eliminar', 'error'); }
  }
});

// Buscar / escanear
async function sobBuscar(codBar) {
  if (!codBar.trim()) return;
  const lista = document.getElementById('sob-lista-select').value || _sobListaActual;
  if (!lista) { showToast('Creá una lista primero', 'error'); return; }

  let cod_art = null, descrip = null;
  try {
    const lookup = await api.sobLookup(codBar.trim());
    cod_art = lookup.cod_art;
    descrip = lookup.descrip;
  } catch { /* no pasa nada, igual agregamos con solo el barcode */ }

  try {
    const res = await api.sobAddItem(lista, { cod_bar: codBar.trim(), cod_art, descrip });
    if (res.action === 'existing') {
      // Resaltar el existente
      _sobItems = await api.sobGetItems(lista);
      renderSobItems(_sobItems);
      setTimeout(() => {
        const el = document.querySelector(`.sob-item[data-id="${res.id}"]`);
        if (el) { el.classList.add('highlight'); el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
        setTimeout(() => el?.classList.remove('highlight'), 1500);
      }, 50);
    } else {
      _sobItems = await api.sobGetItems(lista);
      await loadSobListas();
      renderSobItems(_sobItems);
      // Scroll al nuevo (primer elemento)
      setTimeout(() => document.querySelector('.sob-item')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    }
  } catch (err) { showToast(err.message, 'error'); }
  document.getElementById('sob-barcode-input').value = '';
}

document.getElementById('sob-buscar-btn').addEventListener('click', () => {
  sobBuscar(document.getElementById('sob-barcode-input').value);
});
document.getElementById('sob-barcode-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); sobBuscar(e.target.value); }
});

// Nueva lista
document.getElementById('sob-nueva-btn').addEventListener('click', async () => {
  const hoy = new Date().toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const nombre = prompt('Nombre de la nueva lista:', `Sobrantes ${hoy}`);
  if (!nombre || !nombre.trim()) return;
  try {
    await api.sobCrearLista(nombre.trim());
    _sobListaActual = nombre.trim();
    await loadSobListas();
  } catch (err) { showToast(err.message, 'error'); }
});

// Cambiar lista
document.getElementById('sob-lista-select').addEventListener('change', loadSobItems);

// Eliminar lista
document.getElementById('sob-del-lista-btn').addEventListener('click', async () => {
  const lista = document.getElementById('sob-lista-select').value;
  if (!lista) return;
  if (!confirm(`¿Eliminar la lista "${lista}"? Esta acción no se puede deshacer.`)) return;
  try {
    await api.sobDeleteLista(lista);
    _sobListaActual = null;
    await loadSobListas();
    showToast('Lista eliminada', 'info');
  } catch (err) { showToast(err.message, 'error'); }
});

// ── Scanner sobrantes ─────────────────────────────────────────────────────────
document.getElementById('sob-scan-btn').addEventListener('click', async () => {
  if (sobScannerActive) stopSobScanner();
  else await startSobScanner();
});

async function startSobScanner(deviceId = null) {
  const container = document.getElementById('sob-scanner-container');
  container.classList.remove('hidden');
  document.getElementById('sob-scan-btn').textContent = 'Detener';
  sobScannerActive = true;
  const hints = new Map([[2, [ZXing.BarcodeFormat.EAN_13, ZXing.BarcodeFormat.EAN_8, ZXing.BarcodeFormat.CODE_128, ZXing.BarcodeFormat.CODE_39]], [3, true]]);
  _sobCodeReader = new ZXing.BrowserMultiFormatReader(hints, 0);
  const targetId = deviceId ?? localStorage.getItem('pick_last_camera') ?? null;
  await _sobCodeReader.decodeFromVideoDevice(targetId, 'sob-scanner-video', async (result) => {
    if (result) {
      const code = result.getText();
      stopSobScanner();
      await sobBuscar(code);
    }
  });
  container.classList.add('scanner-open');
  const devices = await navigator.mediaDevices.enumerateDevices();
  _sobCameras = devices.filter(d => d.kind === 'videoinput');
  document.getElementById('sob-switch-camera-btn').classList.toggle('hidden', _sobCameras.length <= 1);
}

function stopSobScanner() {
  if (!sobScannerActive) return;
  sobScannerActive = false;
  if (_sobCodeReader) { _sobCodeReader.reset(); _sobCodeReader = null; }
  const video = document.getElementById('sob-scanner-video');
  if (video?.srcObject) { video.srcObject.getTracks().forEach(t => t.stop()); video.srcObject = null; }
  document.getElementById('sob-scanner-container').classList.remove('scanner-open');
  document.getElementById('sob-scanner-container').classList.add('hidden');
  document.getElementById('sob-scan-btn').textContent = 'Escanear';
  document.getElementById('sob-switch-camera-btn').classList.add('hidden');
}

function switchSobCamera() {
  if (!_sobCameras.length) return;
  _sobCamIdx = (_sobCamIdx + 1) % _sobCameras.length;
  stopSobScanner();
  startSobScanner(_sobCameras[_sobCamIdx].deviceId);
}