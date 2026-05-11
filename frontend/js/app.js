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
let descripTimer = null;
let cameras = [];
let currentCameraIndex = 0;

// ── Init ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  if (getToken()) {
    showApp();
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
    });
  });
});

// ── Views ──────────────────────────────────────────────────────────────────
function showLogin() {
  document.getElementById('login-view').classList.remove('hidden');
  document.getElementById('app-view').classList.add('hidden');
  document.getElementById('login-error').classList.add('hidden');
}

function showApp() {
  document.getElementById('login-view').classList.add('hidden');
  document.getElementById('app-view').classList.remove('hidden');
  loadSemanas().then(() => loadStats());
  switchTab('pick');
  prewarmCamera();
  renderHistorial();
  setTimeout(() => document.getElementById('barcode-input').focus(), 200);
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
    showApp();
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

  if (tab === 'clientes') loadResumen();
  if (tab === 'admin') initAdmin();
}

// ── Tab: Pick ──────────────────────────────────────────────────────────────
document.getElementById('search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const val = document.getElementById('barcode-input').value.trim();
  if (val) await searchBarcode(val);
});


async function searchBarcode(codBar) {
  const results = document.getElementById('results');
  results.innerHTML = '<p class="loading">Buscando...</p>';

  try {
    const picks = await api.getByBarcode(codBar, semanaActual);
    addToHistorial(codBar, picks[0]?.descrip || codBar);

    const todosEntregados = picks.length > 0 && picks.every(p => (p.estado || '').startsWith('completado'));

    if (todosEntregados) {
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
      renderPicks(picks);
      aplicarFiltroPendientes(results);
    }
  } catch (err) {
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
      document.getElementById('barcode-input').value = chip.dataset.cod;
      searchBarcode(chip.dataset.cod);
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
      if (!confirm('¿Desmarcar este pick y volver a 0?')) return;
      await saveQuantity(id, 0, card);
    });
  } else {
    let current = cantidad;
    ctrl.innerHTML = `
      <button class="btn-entregado">${entLabel}</button>
      <div class="pick-stepper">
        <button class="btn-step-minus">−</button>
        <span class="step-value">${current}</span>
        <button class="btn-step-plus">+</button>
        <button class="btn-save">Guardar</button>
      </div>
    `;

    const valueEl = ctrl.querySelector('.step-value');

    ctrl.querySelector('.btn-entregado').addEventListener('click', () => saveQuantity(id, uni, card));

    ctrl.querySelector('.btn-step-minus').addEventListener('click', () => {
      current = Math.max(0, current - 1);
      valueEl.textContent = current;
    });

    ctrl.querySelector('.btn-step-plus').addEventListener('click', () => {
      current = Math.min(uni, current + 1);
      valueEl.textContent = current;
    });

    ctrl.querySelector('.btn-save').addEventListener('click', () => saveQuantity(id, current, card));
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
        <div class="descrip-item" data-codbar="${item.cod_bar}">
          <span class="descrip-item-name">${item.descrip ?? ''}</span>
          <span class="descrip-item-code">${item.cod_art ?? ''}</span>
        </div>
      `).join('');
      container.querySelectorAll('.descrip-item').forEach((el) => {
        el.addEventListener('click', () => {
          const codBar = el.dataset.codbar;
          const descrip = el.querySelector('.descrip-item-name').textContent;
          document.getElementById('descrip-input').value = descrip;
          document.getElementById('barcode-input').value = codBar;
          hideDescripResults();
          searchBarcode(codBar);
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
  searchBarcode(code);
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

document.querySelectorAll('.filter-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    filtroActivo = btn.dataset.filter;
    document.querySelectorAll('.filter-btn').forEach((b) => b.classList.toggle('active', b.dataset.filter === filtroActivo));
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
    return as - bs;
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
  if (adminUnlocked) {
    loadClientes();
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

document.getElementById('btn-nuevo-cliente').addEventListener('click', () => openClienteForm(null));

// ── Admin búsqueda de clientes ─────────────────────────────────────────────
document.getElementById('admin-clientes-search').addEventListener('input', (e) => {
  const q = e.target.value.toLowerCase();
  document.querySelectorAll('#clientes-tbody tr').forEach((row) => {
    row.style.display = row.textContent.toLowerCase().includes(q) ? '' : 'none';
  });
});

async function loadClientes() {
  const tbody = document.getElementById('clientes-tbody');
  tbody.innerHTML = '<tr><td colspan="6" class="loading">Cargando...</td></tr>';
  try {
    const clientes = await api.getClientes();
    tbody.innerHTML = clientes.map((c) => `
      <tr data-id="${c.id}">
        <td>${c.nombre ?? ''}</td>
        <td>${c.localidad ?? ''}</td>
        <td>${c.telefono ?? ''}</td>
        <td>${c.contacto ?? ''}</td>
        <td>${c.vendedor ?? ''}</td>
        <td class="td-actions">
          <button class="btn-edit" onclick="openClienteForm(${c.id})">Editar</button>
          <button class="btn-del" onclick="deleteCliente(${c.id})">Eliminar</button>
        </td>
      </tr>
    `).join('');
    // Reaplicar filtro de búsqueda si hay texto
    const q = document.getElementById('admin-clientes-search').value.toLowerCase();
    if (q) {
      document.querySelectorAll('#clientes-tbody tr').forEach((row) => {
        row.style.display = row.textContent.toLowerCase().includes(q) ? '' : 'none';
      });
    }
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="error-msg">${err.message}</td></tr>`;
  }
}

function openClienteForm(id) {
  editingClienteId = id;
  document.getElementById('modal-title').textContent = id ? 'Editar cliente' : 'Nuevo cliente';

  const fields = ['nombre', 'localidad', 'direccion', 'telefono', 'contacto', 'vendedor'];
  fields.forEach((f) => { document.getElementById(`cf-${f}`).value = ''; });

  if (id) {
    // Buscar en las filas ya cargadas en la tabla en lugar de llamar API de nuevo
    const row = document.querySelector(`#clientes-tbody tr[data-id="${id}"]`);
    if (row) {
      const cells = row.querySelectorAll('td');
      const mapping = ['nombre', 'localidad', null, 'telefono', 'contacto', 'vendedor'];
      // La tabla no tiene dirección, necesitamos la API solo para ese campo
    }
    api.getClientes().then((list) => {
      const c = list.find((x) => x.id === id);
      if (c) {
        fields.forEach((f) => { document.getElementById(`cf-${f}`).value = c[f] ?? ''; });
      }
    });
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
  if (!confirm('¿Eliminar este cliente?')) return;
  try {
    await api.deleteCliente(id);
    showToast('Cliente eliminado', 'info');
    loadClientes();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ── Admin: Semanas ─────────────────────────────────────────────────────────
async function loadSemanasAdmin() {
  const list = document.getElementById('semanas-admin-list');
  if (!list) return;
  try {
    const semanas = await api.getSemanas();
    if (semanas.length === 0) {
      list.innerHTML = '<p class="semana-admin-empty">No hay semanas cargadas</p>';
      return;
    }
    list.innerHTML = semanas.map((s) => `
      <div class="semana-admin-item">
        <span class="semana-nombre-tag">${s.nombre}</span>
        <button class="btn-del" onclick="deleteSemana(${s.id}, '${s.nombre.replace(/'/g, "\\'")}')">Eliminar</button>
      </div>
    `).join('');
  } catch (err) {
    list.innerHTML = `<p class="error-msg">${err.message}</p>`;
  }
}

async function deleteSemana(id, nombre) {
  if (!confirm(`¿Eliminar "${nombre}" del selector?\n\nLos picks quedan guardados para análisis futuro.`)) return;
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
  tbody.innerHTML = '<tr><td colspan="3" class="loading">Cargando...</td></tr>';
  try {
    const users = await api.getUsers();
    tbody.innerHTML = users.map((u) => `
      <tr>
        <td>${u.username}</td>
        <td>${u.created_at ? new Date(u.created_at).toLocaleDateString('es') : '—'}</td>
        <td class="td-actions">
          <button class="btn-del" onclick="deleteUser(${u.id})">Eliminar</button>
        </td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="3" class="error-msg">${err.message}</td></tr>`;
  }
}

async function deleteUser(id) {
  if (!confirm('¿Eliminar este usuario?')) return;
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
        Los siguientes IDs no están en la tabla de clientes. Andá a Admin → Clientes para agregarlos:
        <div class="import-missing-list">${tags}</div>
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

// ── Modal de confirmación ──────────────────────────────────────────────────
function confirmar(msg) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('confirm-modal');
    document.getElementById('confirm-msg').textContent = msg;
    overlay.classList.remove('hidden');
    const ok = document.getElementById('confirm-ok');
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
