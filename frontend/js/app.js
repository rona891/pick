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

// ── Estado: scanner por cliente ────────────────────────────────────────────
let currentClientePicks = [];  // picks del cliente abierto en el sheet
let clienteScanMode = false;   // true cuando el scanner está en modo cliente
let clienteActual = '';        // nombre del cliente cuyo sheet está abierto

// ── Estado: filtro de repartos en Clientes tab ─────────────────────────────
let filtroRepartosClientes = new Set();  // repartos seleccionados como chips
let _clienteEsFA = false;               // true cuando el nuevo cliente es Factura A

function _actualizarCuitHint() {
  const hint = document.getElementById('cf-cuit-hint');
  if (!hint) return;
  hint.textContent = _clienteEsFA ? '*' : '(opcional)';
  hint.style.color = _clienteEsFA ? 'var(--danger, #e53e3e)' : 'var(--muted)';
}

// ── Estado: filtro de repartos en Pick tab ─────────────────────────────────
let filtroRepartosPick = new Set();      // repartos seleccionados en Pick
let zonaRepartoMap = {};                 // { 'MERLO': 'Merlo', 'VILLA LARCA': 'Sur Arriba', ... }
let _lastPickSearch = null;              // { code: string } para re-ejecutar al cambiar filtro
let _highlightedCard = null;             // tarjeta resaltada actualmente en el sheet de cliente

// ── Persistencia de vista y actividad ─────────────────────────────────────
const INACTIVIDAD_MS = 10 * 60 * 1000; // 10 minutos

function _saveView(view) {
  localStorage.setItem('_last_view', view);
}

function _saveAdminTab(adminTab) {
  localStorage.setItem('_last_admin_tab', adminTab);
}

function _getAdminTab() {
  return localStorage.getItem('_last_admin_tab') || null;
}

function _updateActivity() {
  localStorage.setItem('_last_activity', Date.now().toString());
}

function _actividadReciente() {
  const ts = parseInt(localStorage.getItem('_last_activity') || '0');
  return Date.now() - ts < INACTIVIDAD_MS;
}

function _restoreView() {
  const view = localStorage.getItem('_last_view') || 'pick';
  switch (view) {
    case 'sobrantes': showSobrantes(); break;
    case 'novedades': showNovedades(); break;
    case 'hub':       showHub(); break;
    case 'clientes':  showApp('clientes'); break;
    case 'admin':     showApp('admin'); break;
    default:          showApp('pick'); break;
  }
}

// Cualquier click o touch del usuario cuenta como actividad
['click', 'touchstart'].forEach(evt =>
  document.addEventListener(evt, _updateActivity, { passive: true })
);

// ── Init ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  aplicarModo();
  if (getToken()) {
    // Refrescar permisos desde el servidor antes de mostrar la vista,
    // para evitar usar datos stale de una sesión anterior con distinto rol
    checkPermissions().finally(() => {
      if (mayoristaCaducado() || !_actividadReciente()) {
        showHub();
      } else {
        _restoreView();
      }
    });
  } else {
    showLogin();
  }

  document.querySelectorAll('.admin-tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.adminTab;
      document.querySelectorAll('.admin-tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.adminTab === target));
      document.querySelectorAll('.admin-tab-panel').forEach((p) => p.classList.toggle('hidden', p.dataset.adminPanel !== target));
      _setTopbarSection(_ADMIN_TAB_LABELS[target] || target);
      _saveAdminTab(target);
      if (target === 'usuarios') loadUsers();
      if (target === 'nueva-semana') loadSemanasAdmin();
      if (target === 'zonas') loadZonas();
      if (target === 'reparto') loadAsignaciones();
      if (target === 'historial') loadHistorial();
      if (target === 'articulos') loadArticulos();
    });
  });
});

// ── Views ──────────────────────────────────────────────────────────────────
function _hideAllViews() {
  document.getElementById('login-view').classList.add('hidden');
  document.getElementById('hub-view').classList.add('hidden');
  document.getElementById('app-view').classList.add('hidden');
  document.getElementById('sobrantes-view').classList.add('hidden');
  document.getElementById('novedades-view').classList.add('hidden');
}

function showNovedades() {
  stopNovScanner();
  _hideAllViews();
  _saveView('novedades');
  const m = getMayorista();
  aplicarTema(m);
  document.getElementById('nov-logo').src = m === 'diarco' ? 'diarco.png' : 'yaguar.png';
  document.getElementById('nov-usuario').textContent = localStorage.getItem('username') || '';
  document.getElementById('novedades-view').classList.remove('hidden');
  initNovedades();
}

function showLogin() {
  _hideAllViews();
  document.getElementById('login-view').classList.remove('hidden');
  document.getElementById('login-error').classList.add('hidden');
}

function showHub() {
  stopSobScanner();
  _hideAllViews();
  _saveView('hub');
  document.getElementById('hub-view').classList.remove('hidden');
  document.getElementById('hub-picking-section').classList.remove('hidden');
  const tieneHerr = tieneSobrantes() || tieneNovedades();
  document.getElementById('hub-herramientas').classList.toggle('hidden', !tieneHerr);
  document.getElementById('hub-btn-sobrantes').classList.toggle('hidden', !tieneSobrantes());
  document.getElementById('hub-btn-novedades').classList.toggle('hidden', !tieneNovedades());
  document.getElementById('hub-sob-selector').classList.add('hidden');
  document.getElementById('hub-nov-selector').classList.add('hidden');
  document.getElementById('hub-admin-btn').classList.toggle('hidden', !esAdmin());
  const hubTheme = document.getElementById('hub-theme-btn');
  if (hubTheme) hubTheme.textContent = esLightMode() ? '🌙' : '☀';
  document.getElementById('hub-usuario').textContent = localStorage.getItem('username') || '';

  // Ocultar cards según mayorista + destino: solo mostrar si el usuario
  // tiene permiso para ese mayorista Y para esa sección
  document.querySelectorAll('.mayorista-card').forEach(c => {
    const m    = c.dataset.mayorista;
    const dest = c.dataset.destino || 'pick';
    const tieneM = m === 'yaguar' ? tieneYaguar() : tieneDiarco();
    let tieneDest;
    if      (dest === 'sobrantes') tieneDest = tieneSobrantes();
    else if (dest === 'novedades') tieneDest = tieneNovedades();
    else {
      // La card de picking solo aparece si hay pick o permisos de PANEL
      // (no basta con usuarios/roles que se gestionan desde el hub)
      const _panelApp = ['admin_clientes','admin_clientes_full','admin_semanas',
                         'admin_zonas','admin_auditoria','admin_articulos'];
      tieneDest = tienePick() || _panelApp.some(p => hasPerm(p));
    }
    c.classList.toggle('hidden', !tieneM || !tieneDest);
  });

  // Ocultar la sección Picking entera si no quedan cards visibles
  const hayCardsPick = [...document.querySelectorAll('.mayorista-card[data-destino="pick"]')]
    .some(c => !c.classList.contains('hidden'));
  document.getElementById('hub-picking-section').classList.toggle('hidden', !hayCardsPick);

  // Si el mayorista activo ya no es accesible, cambiar al que sí está disponible
  const actual = getMayorista();
  if ((actual === 'yaguar' && !tieneYaguar()) || (actual === 'diarco' && !tieneDiarco())) {
    if (tieneYaguar()) setMayorista('yaguar');
    else if (tieneDiarco()) setMayorista('diarco');
  }
}

function showSobrantes() {
  _hideAllViews();
  _saveView('sobrantes');
  const m = getMayorista();
  aplicarTema(m);
  document.getElementById('sob-logo').src = m === 'diarco' ? 'diarco.png' : 'yaguar.png';
  document.getElementById('sob-usuario').textContent = localStorage.getItem('username') || '';
  document.getElementById('sobrantes-view').classList.remove('hidden');
  initSobrantes();
}

function volverAlHub() {
  stopSobScanner();
  showHub();
}

// Alias para compatibilidad con llamadas existentes
function showMayoristaSelector() { showHub(); }

function showApp(initialTab = 'pick') {
  _hideAllViews();
  document.getElementById('app-view').classList.remove('hidden');
  const adminBtn = document.querySelector('.tab-btn[data-tab="admin"]');
  // Solo mostrar Panel si tiene permisos reales de panel (no basta usuarios/roles del hub)
  const _panelPerms = ['admin_clientes','admin_clientes_full','admin_semanas',
                       'admin_zonas','admin_auditoria','admin_articulos'];
  const tienePanelReal = _panelPerms.some(p => hasPerm(p)) || esVendedor();
  adminBtn.classList.toggle('hidden', !tienePanelReal);
  if (esVendedor()) document.getElementById('nav-admin-label').textContent = 'Gestión';
  else document.getElementById('nav-admin-label').textContent = 'Panel';
  const sinPick = !tienePick();
  document.querySelector('.tab-btn[data-tab="pick"]').classList.toggle('hidden', sinPick);
  document.querySelector('.tab-btn[data-tab="clientes"]').classList.toggle('hidden', sinPick);
  if (sinPick && initialTab !== 'admin') initialTab = 'admin';
  document.getElementById('topbar-usuario').textContent = localStorage.getItem('username') || '';
  const m = getMayorista();
  aplicarTema(m);
  document.getElementById('topbar-logo').src = m === 'diarco' ? 'diarco.png' : 'yaguar.png';
  loadSemanas().then(() => { loadStats(); });
  loadZonaRepartoMap();
  switchTab(initialTab);
  if (initialTab === 'pick') loadChipsRepartoPick();
  prewarmCamera();
  renderHistorial();
}

// ── Permisos en tiempo real ────────────────────────────────────────────────
async function checkPermissions() {
  if (!getToken()) return;
  try {
    const me = await api.getMe();
    const prev = _ALL_PERMS.map(p => localStorage.getItem(p));
    _savePerms(me);
    if (me.rol) setRol(me.rol);
    const changed = _ALL_PERMS.some((p, i) => (me[p] ? '1' : '0') !== prev[i]);
    if (changed) {
      const hubVisible = !document.getElementById('hub-view').classList.contains('hidden');
      if (hubVisible) showHub();
      // Si el mayorista activo ya no es accesible, forzar cambio
      const actual = getMayorista();
      if ((actual === 'yaguar' && !tieneYaguar()) || (actual === 'diarco' && !tieneDiarco())) {
        if (tieneYaguar()) setMayorista('yaguar');
        else if (tieneDiarco()) setMayorista('diarco');
      }
    }
  } catch { /* silencioso */ }
}

// Chequear al volver a la pestaña del browser
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) checkPermissions();
});

// Chequear cada 15 segundos mientras la app está activa
setInterval(() => { if (!document.hidden) checkPermissions(); }, 15000);

// ── Modo claro / oscuro ────────────────────────────────────────────────────
function esLightMode() {
  return localStorage.getItem('lightMode') === '1';
}

function aplicarModo() {
  const light = esLightMode();
  document.body.classList.toggle('light-mode', light);
  document.querySelectorAll('.btn-theme').forEach(btn => {
    btn.textContent = light ? '🌙' : '☀';
  });
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.btn-theme')) return;
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
    const m = btn.dataset.mayorista;
    const destino = btn.dataset.destino || 'pick';

    // Verificar permisos en tiempo de click (doble protección además de la ocultación visual)
    const tieneM = m === 'yaguar' ? tieneYaguar() : tieneDiarco();
    let tieneDest;
    if      (destino === 'sobrantes') tieneDest = tieneSobrantes();
    else if (destino === 'novedades') tieneDest = tieneNovedades();
    else {
      const _panelApp = ['admin_clientes','admin_clientes_full','admin_semanas',
                         'admin_zonas','admin_auditoria','admin_articulos'];
      tieneDest = tienePick() || _panelApp.some(p => hasPerm(p));
    }
    if (!tieneM || !tieneDest) return; // bloquear si no tiene permiso

    setMayorista(m);
    aplicarTema(m);
    if (destino === 'sobrantes') {
      showSobrantes();
    } else if (destino === 'novedades') {
      showNovedades();
    } else {
      const _lastView = localStorage.getItem('_last_view');
      const _panelApp = ['admin_clientes','admin_clientes_full','admin_semanas',
                         'admin_zonas','admin_auditoria','admin_articulos'];
      const _tienePanelReal = _panelApp.some(p => hasPerm(p)) || esVendedor();
      if (_lastView === 'admin' && _tienePanelReal) {
        showApp('admin');  // initAdmin restaurará el sub-tab guardado
      } else if (!tienePick()) {
        showApp('admin');
      } else {
        showApp('pick');
      }
    }
  });
});

function cambiarMayorista() {
  localStorage.removeItem('mayorista_ts');
  aplicarTema(null);
  showHub();
}

document.getElementById('hub-btn-sobrantes').addEventListener('click', () => {
  document.getElementById('hub-nov-selector').classList.add('hidden');
  document.getElementById('hub-sob-selector').classList.remove('hidden');
  window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
});

document.getElementById('app-back-btn').addEventListener('click', () => showHub());
document.getElementById('sob-back-btn').addEventListener('click', volverAlHub);

document.getElementById('hub-btn-novedades').addEventListener('click', () => {
  document.getElementById('hub-sob-selector').classList.add('hidden');
  document.getElementById('hub-nov-selector').classList.remove('hidden');
  window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
});
document.getElementById('hub-nov-cancelar').addEventListener('click', () => {
  document.getElementById('hub-nov-selector').classList.add('hidden');
});

// ── Hub topbar: Usuarios, Tema, Cuenta, Salir ──────────────────────────────
document.getElementById('hub-admin-btn').addEventListener('click', () => {
  // Resetear al tab Usuarios
  document.getElementById('gest-panel-usuarios').classList.remove('hidden');
  document.getElementById('gest-panel-roles').classList.add('hidden');
  document.querySelectorAll('.gest-tab-btn').forEach(b => {
    const active = b.dataset.gestTab === 'usuarios';
    b.style.borderBottomColor = active ? 'var(--accent)' : 'transparent';
    b.style.color = active ? 'var(--text)' : 'var(--muted)';
  });
  document.getElementById('usuarios-modal').classList.remove('hidden');
  loadUsers();
  _recargarSelectsRoles();
});

document.getElementById('usuarios-modal-close').addEventListener('click', () => {
  document.getElementById('usuarios-modal').classList.add('hidden');
});
document.getElementById('usuarios-modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
});

document.getElementById('hub-theme-btn').addEventListener('click', () => {
  localStorage.setItem('lightMode', esLightMode() ? '0' : '1');
  aplicarModo();
  document.getElementById('hub-theme-btn').textContent = esLightMode() ? '🌙' : '☀';
});

document.getElementById('hub-cuenta-btn').addEventListener('click', () => {
  document.getElementById('pw-form').reset();
  document.getElementById('username-form').reset();
  document.getElementById('pw-modal').classList.remove('hidden');
});

document.getElementById('hub-salir-btn').addEventListener('click', async () => {
  await api.logout().catch(() => {});
  clearToken();
  stopSobScanner();
  adminUnlocked = false;
  showLogin();
});

document.getElementById('hub-sob-cancelar').addEventListener('click', () => {
  document.getElementById('hub-sob-selector').classList.add('hidden');
});

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
    _savePerms(res);
    localStorage.setItem('username', username);
    showHub(); // siempre mostrar el hub al iniciar sesión
    setTimeout(() => { if (!isFullscreen()) enterFullscreen(); }, 300);
  } catch (err) {
    errorDiv.textContent = err.message || 'Usuario o contraseña incorrectos';
    errorDiv.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Entrar';
  }
});

document.getElementById('logout-btn')?.addEventListener('click', async () => {
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
  if (!semanaActual) {
    document.getElementById('stat-total').textContent = 0;
    document.getElementById('stat-completed').textContent = 0;
    document.getElementById('stat-pending').textContent = 0;
    updateProgressBar(1, 1); // 100% — no hay picks pendientes
    return;
  }
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

// ── Nombre de sección en topbar ────────────────────────────────────────────
const _TAB_LABELS = { pick: 'Pick', clientes: 'Clientes', admin: 'Panel' };
const _ADMIN_TAB_LABELS = {
  'clientes': 'Clientes', 'nueva-semana': 'Semanas', 'usuarios': 'Usuarios',
  'zonas': 'Zonas', 'reparto': 'Reparto', 'historial': 'Auditoría',
  'articulos': 'Artículos', 'roles': 'Roles',
};
function _setTopbarSection(name) {
  const el = document.getElementById('topbar-section');
  if (el) el.textContent = name || '';
}

// ── Tabs ───────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== tab));
  if (scannerActive && tab !== 'pick') { clienteScanMode = false; stopScanner(); }
  if (sobScannerActive && tab !== 'sobrantes') stopSobScanner();
  if (histScannerActive && tab !== 'admin') stopHistScanner();
  if (tab === 'clientes') { loadChipsReparto(); loadResumen(); }
  if (tab === 'admin') initAdmin();
  if (tab === 'sobrantes') initSobrantes();
  _saveView(tab);
  _setTopbarSection(_TAB_LABELS[tab] || tab);
}

// ── Tab: Pick ──────────────────────────────────────────────────────────────
// El input de barcode está oculto; se llena por el scanner. Este listener
// permite pegar un código desde el portapapeles (uso interno/admin).
document.getElementById('barcode-input').addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  const val = e.target.value.trim();
  if (!val) return;
  if (getMayorista() === 'diarco') {
    await searchDiarco(val);
  } else {
    await searchBarcode(val);
  }
});


async function searchDiarco(val) {
  // Intenta por barcode EAN (unidad o bulto), si falla busca por código DIARCO
  _lastPickSearch = { code: val };
  const results = document.getElementById('results');
  results.innerHTML = '<p class="loading">Buscando...</p>';
  try {
    let picks = await api.getByBarcode(val, semanaActual);
    addToHistorial(val, picks[0]?.descrip || val);
    picks = filtrarPicksPorReparto(picks);
    if (!picks.length && filtroRepartosPick.size) {
      results.innerHTML = `<p class="error-msg">Sin pedidos en los repartos seleccionados</p>`;
      return;
    }
    renderPicks(picks, results);
    loadStats();
  } catch {
    // Fallback: buscar por código de artículo DIARCO
    try {
      let picks = await api.getByCodArt(val, semanaActual);
      addToHistorial(val, picks[0]?.descrip || val);
      picks = filtrarPicksPorReparto(picks);
      if (!picks.length && filtroRepartosPick.size) {
        results.innerHTML = `<p class="error-msg">Sin pedidos en los repartos seleccionados</p>`;
        return;
      }
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
    let picks = await api.getByCodArt(codArt, semanaActual);
    addToHistorial(codArt, picks[0]?.descrip || codArt);
    picks = filtrarPicksPorReparto(picks);
    if (!picks.length && filtroRepartosPick.size) {
      results.innerHTML = `<p class="error-msg">Sin pedidos en los repartos seleccionados</p>`;
      return;
    }
    renderPicks(picks, results);
    loadStats();
  } catch (err) {
    results.innerHTML = `<p class="error-msg">Producto no encontrado</p>`;
  }
}

async function searchBarcode(codBar) {
  _lastPickSearch = { code: codBar };
  const results = document.getElementById('results');
  results.innerHTML = '<p class="loading">Buscando...</p>';

  try {
    let picks = await api.getByBarcode(codBar, semanaActual);
    addToHistorial(codBar, picks[0]?.descrip || codBar);
    picks = filtrarPicksPorReparto(picks);
    if (!picks.length && filtroRepartosPick.size) {
      results.innerHTML = `<p class="error-msg">Sin pedidos en los repartos seleccionados</p>`;
      return;
    }

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
  uni = uni || 0; cantidad = cantidad || 0; uxb = uxb || 0;
  const restante = Math.max(0, uni - cantidad);
  if (uxb > 1 && restante >= uxb) {
    const bulRest = Math.floor(restante / uxb);
    const uniRest = restante % uxb;
    const main = uniRest > 0
      ? `${bulRest} bul y ${uniRest} uni`
      : `${bulRest} bulto${bulRest !== 1 ? 's' : ''}`;
    return { main, sub: `× ${uxb} uni/bulto` };
  }
  return { main: `${restante} uni`, sub: uxb > 1 ? `× ${uxb} uni/bulto` : null };
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
    ctrl.innerHTML = `
      <button class="btn-entregado">${entLabel}</button>
      <button class="btn-parcial">Entregar parcial...</button>
    `;
    ctrl.querySelector('.btn-entregado').addEventListener('click', () => saveQuantity(id, uni, card));
    ctrl.querySelector('.btn-parcial').addEventListener('click', () => {
      const descrip = card.querySelector('.pick-descrip')?.textContent || '';
      const nombre = card.querySelector('.pick-meta span')?.textContent || '';
      openParcialModal(id, uni, uxb, bul, card, descrip, nombre, cantidad);
    });
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
    if (_highlightedCard === card) _clearHighlight();
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

// ── Modal de entrega parcial ───────────────────────────────────────────────
let _parcialPick = null;

function openParcialModal(id, uni, uxb, bul, card, descrip, nombre, cantidadActual = 0) {
  _parcialPick = { id, uni, uxb, bul, card, cantidadActual };
  const sinBultos = uxb <= 1;
  document.getElementById('parcial-modal-title').textContent = 'Entrega parcial';
  document.getElementById('parcial-modal-desc').textContent = `${descrip}${nombre ? ' — ' + nombre : ''}`;
  document.getElementById('parcial-bultos-wrap').classList.toggle('hidden', sinBultos);
  document.getElementById('parcial-uni-label').textContent = sinBultos ? 'Unidades' : 'Unidades sueltas';
  document.getElementById('parcial-bultos').value = 0;
  document.getElementById('parcial-unidades').value = 0;

  // Nota de ayuda: visible solo si ya se entregó algo
  const ayuda = document.getElementById('parcial-ayuda');
  if (cantidadActual > 0) {
    const bulAct = uxb > 1 ? Math.floor(cantidadActual / uxb) : 0;
    const uniAct = uxb > 1 ? cantidadActual % uxb : cantidadActual;
    const cantStr = bulAct > 0
      ? (uniAct > 0 ? `${bulAct} bul y ${uniAct} uni` : `${bulAct} bul`)
      : `${uniAct} uni`;
    ayuda.textContent = `Ya se registraron ${cantStr}. Para corregir una entrega errónea podés ingresar valores negativos (hasta −${cantStr}).`;
    ayuda.classList.remove('hidden');
  } else {
    ayuda.classList.add('hidden');
  }

  _actualizarParcialPreview();
  document.getElementById('parcial-modal').classList.remove('hidden');
  const primerInput = sinBultos
    ? document.getElementById('parcial-unidades')
    : document.getElementById('parcial-bultos');
}

function _actualizarParcialPreview() {
  if (!_parcialPick) return;
  const { uni, uxb, cantidadActual } = _parcialPick;
  const bultos = parseInt(document.getElementById('parcial-bultos').value) || 0;
  const unidades = parseInt(document.getElementById('parcial-unidades').value) || 0;
  const delta = (uxb > 1 ? uxb * bultos : 0) + unidades;
  const nuevaCantidad = cantidadActual + delta;
  const preview = document.getElementById('parcial-total-preview');
  const ok = delta !== 0 && nuevaCantidad >= 0 && nuevaCantidad <= uni;
  let msg = `Nueva cantidad: ${nuevaCantidad} uni`;
  if (nuevaCantidad < 0) msg = `Resultado negativo (${nuevaCantidad} uni)`;
  else if (nuevaCantidad > uni) msg = `Excede el pedido (${nuevaCantidad}/${uni} uni)`;
  else if (delta === 0) msg = 'Ingresá una cantidad distinta de cero';
  preview.textContent = msg;
  preview.className = `parcial-total ${ok ? '' : 'parcial-total-error'}`;
  document.getElementById('parcial-confirmar').disabled = !ok;
}

function cerrarParcialModal() {
  _parcialPick = null;
  document.getElementById('parcial-modal').classList.add('hidden');
}

document.getElementById('parcial-modal-close').addEventListener('click', cerrarParcialModal);
document.getElementById('parcial-cancelar').addEventListener('click', cerrarParcialModal);

document.querySelectorAll('.btn-parcial-step').forEach((btn) => {
  btn.addEventListener('click', () => {
    const field = btn.dataset.field;
    const input = document.getElementById(`parcial-${field}`);
    const delta = parseInt(btn.dataset.delta);
    const val = (parseInt(input.value) || 0) + delta;
    input.value = val; // sin floor — permite negativos
    _actualizarParcialPreview();
  });
});

['parcial-bultos', 'parcial-unidades'].forEach((inputId) => {
  document.getElementById(inputId).addEventListener('input', _actualizarParcialPreview);
});

document.getElementById('parcial-confirmar').addEventListener('click', async () => {
  if (!_parcialPick) return;
  const { id, uni, uxb, card, cantidadActual } = _parcialPick;
  const bultos = parseInt(document.getElementById('parcial-bultos').value) || 0;
  const unidades = parseInt(document.getElementById('parcial-unidades').value) || 0;
  const delta = (uxb > 1 ? uxb * bultos : 0) + unidades;
  const nuevaCantidad = Math.max(0, Math.min(uni, cantidadActual + delta));
  cerrarParcialModal();
  await saveQuantity(id, nuevaCantidad, card);
});

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

// Cerrar dropdowns al hacer click fuera
document.addEventListener('click', (e) => {
  [
    ['filtro-estado-wrap',           'filtro-estado-dropdown'],
    ['filtro-reparto-clientes-wrap', 'filtro-reparto-clientes'],
    ['filtro-reparto-pick-wrap',     'filtro-reparto-pick'],
  ].forEach(([wrapId, dropId]) => {
    const wrap = document.getElementById(wrapId);
    if (wrap && !wrap.contains(e.target)) {
      document.getElementById(dropId)?.classList.add('hidden');
    }
  });
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
  if (navigator.vibrate) navigator.vibrate(80);
  const enModoCliente = clienteScanMode;
  stopScanner();
  if (enModoCliente) {
    clienteScanMode = true;  // mantener modo activo para que handleClienteScan pueda reabrirlo
    handleClienteScan(code);
  } else {
    document.getElementById('barcode-input').value = code;
    if (getMayorista() === 'diarco') {
      searchDiarco(code);
    } else {
      searchBarcode(code);
    }
  }
}

async function startScanner(deviceId = null) {
  const container = document.getElementById('scanner-container');
  container.classList.remove('hidden');
  const scanBtn = document.getElementById('scan-btn');
  scanBtn.textContent = 'Detener';
  scanBtn.classList.add('scanner-active-label');
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
      applyTorchPreference(track, 'torch-btn');
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

async function toggleTorch(videoId, btnId) {
  const video = document.getElementById(videoId);
  const btn = document.getElementById(btnId);
  if (!video?.srcObject) return;
  const track = video.srcObject.getVideoTracks()[0];
  if (!track) return;
  const on = btn.dataset.torchOn !== 'true';
  try {
    await track.applyConstraints({ advanced: [{ torch: on }] });
    btn.dataset.torchOn = String(on);
    btn.textContent = on ? '🔦 Flash ON' : '🔦 Flash';
    btn.classList.toggle('torch-active', on);
    localStorage.setItem('pick_torch', String(on));
  } catch (_) {}
}

function applyTorchPreference(track, btnId) {
  const caps = track.getCapabilities?.() || {};
  const btn = document.getElementById(btnId);
  const hasTorch = 'torch' in caps;
  btn.classList.toggle('hidden', !hasTorch);
  if (!hasTorch) return;
  const on = localStorage.getItem('pick_torch') === 'true';
  track.applyConstraints({ advanced: [{ torch: on }] }).catch(() => {});
  btn.dataset.torchOn = String(on);
  btn.textContent = on ? '🔦 Flash ON' : '🔦 Flash';
  btn.classList.toggle('torch-active', on);
}

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
  const scanBtnStop = document.getElementById('scan-btn');
  scanBtnStop.textContent = 'Escanear';
  scanBtnStop.classList.remove('scanner-active-label');
  document.getElementById('switch-camera-btn').classList.add('hidden');
  const torchBtn = document.getElementById('torch-btn');
  torchBtn.classList.add('hidden');
  torchBtn.dataset.torchOn = 'false';
  torchBtn.classList.remove('torch-active');
}

// ── Zona→Reparto map (compartido entre Pick y Clientes) ────────────────────
async function loadZonaRepartoMap() {
  try {
    const zonas = await api.getZonas();
    zonaRepartoMap = {};
    zonas.forEach((z) => { if (z.reparto) zonaRepartoMap[z.nombre.toUpperCase()] = z.reparto; });
  } catch (_) {}
}

// ── Chips de reparto en pestaña Pick ──────────────────────────────────────
function _actualizarBotonFiltroPick() {
  const btn = document.getElementById('btn-toggle-filtro-pick');
  if (!btn) return;
  if (!filtroRepartosPick.size) {
    btn.textContent = 'Reparto: Todos ▾';
    btn.classList.remove('filtro-toggle-active');
  } else if (filtroRepartosPick.size === 1) {
    btn.textContent = `Reparto: ${[...filtroRepartosPick][0]} ▾`;
    btn.classList.add('filtro-toggle-active');
  } else {
    btn.textContent = `Reparto: ${filtroRepartosPick.size} sel. ▾`;
    btn.classList.add('filtro-toggle-active');
  }
}

async function loadChipsRepartoPick() {
  const outerWrap = document.getElementById('filtro-reparto-pick-wrap');
  const dropdown = document.getElementById('filtro-reparto-pick');
  const container = document.getElementById('chips-reparto-pick');
  if (!outerWrap || !dropdown || !container) return;

  try {
    const repartos = await api.getRepartos();
    if (!repartos.length) { outerWrap.classList.add('hidden'); return; }

    outerWrap.classList.remove('hidden');

    const stored = localStorage.getItem(`filtro_repartos_pick_${getMayorista()}`);
    if (stored) {
      try { filtroRepartosPick = new Set(JSON.parse(stored)); } catch { filtroRepartosPick = new Set(); }
    }

    _actualizarBotonFiltroPick();

    // Toggle del dropdown
    const toggleBtn = document.getElementById('btn-toggle-filtro-pick');
    toggleBtn.onclick = () => dropdown.classList.toggle('hidden');

    container.innerHTML = repartos.map((r) => {
      const active = filtroRepartosPick.has(r.nombre) ? ' active' : '';
      return `<button class="chip-reparto${active}" data-reparto="${r.nombre}">${r.nombre}</button>`;
    }).join('');

    container.querySelectorAll('.chip-reparto').forEach((chip) => {
      chip.addEventListener('click', () => {
        const rep = chip.dataset.reparto;
        if (filtroRepartosPick.has(rep)) {
          filtroRepartosPick.delete(rep);
          chip.classList.remove('active');
        } else {
          filtroRepartosPick.add(rep);
          chip.classList.add('active');
        }
        localStorage.setItem(`filtro_repartos_pick_${getMayorista()}`, JSON.stringify([...filtroRepartosPick]));
        _actualizarBotonFiltroPick();
        // Re-ejecutar la última búsqueda con el nuevo filtro (Task 4)
        if (_lastPickSearch) {
          if (getMayorista() === 'diarco') searchDiarco(_lastPickSearch.code);
          else searchBarcode(_lastPickSearch.code);
        }
      });
    });
  } catch (_) {
    outerWrap.classList.add('hidden');
  }
}

// Filtra un array de picks según el filtro de repartos activo en Pick tab
function filtrarPicksPorReparto(picks) {
  if (!filtroRepartosPick.size) return picks;
  return picks.filter((p) => {
    const localidad = (p.localidad || '').toUpperCase();
    const reparto = zonaRepartoMap[localidad];
    return reparto && filtroRepartosPick.has(reparto);
  });
}

// ── Tab: Clientes ──────────────────────────────────────────────────────────

// Carga los chips de reparto para el filtro en la pestaña Clientes
function _actualizarBotonFiltroClientes() {
  const btn = document.getElementById('btn-toggle-filtro-clientes');
  if (!btn) return;
  if (!filtroRepartosClientes.size) {
    btn.textContent = 'Reparto: Todos ▾';
    btn.classList.remove('filtro-toggle-active');
  } else if (filtroRepartosClientes.size === 1) {
    btn.textContent = `Reparto: ${[...filtroRepartosClientes][0]} ▾`;
    btn.classList.add('filtro-toggle-active');
  } else {
    btn.textContent = `Reparto: ${filtroRepartosClientes.size} sel. ▾`;
    btn.classList.add('filtro-toggle-active');
  }
}

async function loadChipsReparto() {
  const outerWrap = document.getElementById('filtro-reparto-clientes-wrap');
  const dropdown = document.getElementById('filtro-reparto-clientes');
  const container = document.getElementById('chips-reparto-clientes');
  if (!outerWrap || !dropdown || !container) return;

  try {
    const repartos = await api.getRepartos();
    if (!repartos.length) { outerWrap.classList.add('hidden'); return; }

    outerWrap.classList.remove('hidden');

    const stored = localStorage.getItem(`filtro_repartos_${getMayorista()}`);
    if (stored) {
      try { filtroRepartosClientes = new Set(JSON.parse(stored)); } catch { filtroRepartosClientes = new Set(); }
    }

    _actualizarBotonFiltroClientes();

    const toggleBtn = document.getElementById('btn-toggle-filtro-clientes');
    toggleBtn.onclick = () => dropdown.classList.toggle('hidden');

    container.innerHTML = repartos.map((r) => {
      const active = filtroRepartosClientes.has(r.nombre) ? ' active' : '';
      return `<button class="chip-reparto${active}" data-reparto="${r.nombre}">${r.nombre}</button>`;
    }).join('');

    container.querySelectorAll('.chip-reparto').forEach((chip) => {
      chip.addEventListener('click', () => {
        const rep = chip.dataset.reparto;
        if (filtroRepartosClientes.has(rep)) {
          filtroRepartosClientes.delete(rep);
          chip.classList.remove('active');
        } else {
          filtroRepartosClientes.add(rep);
          chip.classList.add('active');
        }
        localStorage.setItem(`filtro_repartos_${getMayorista()}`, JSON.stringify([...filtroRepartosClientes]));
        _actualizarBotonFiltroClientes();
        loadResumen();
      });
    });
  } catch (_) {
    outerWrap.classList.add('hidden');
  }
}

async function loadResumen() {
  const container = document.getElementById('resumen-list');
  container.innerHTML = '<p class="loading">Cargando...</p>';
  try {
    resumenData = await api.getResumen(semanaActual, [...filtroRepartosClientes]);
    renderResumen();
  } catch (err) {
    container.innerHTML = `<p class="error-msg">${err.message}</p>`;
  }
}

const _ESTADO_LABELS = { todos: 'Todos', completo: 'Completo', incompleto: 'Incompleto', pendiente: 'Pendiente' };

document.getElementById('btn-toggle-filtro-estado').addEventListener('click', () => {
  document.getElementById('filtro-estado-dropdown').classList.toggle('hidden');
});

document.querySelectorAll('#filtro-estado-dropdown .chip-reparto[data-filter]').forEach((btn) => {
  btn.addEventListener('click', () => {
    filtroActivo = btn.dataset.filter;
    document.querySelectorAll('#filtro-estado-dropdown .chip-reparto[data-filter]').forEach((b) =>
      b.classList.toggle('active', b.dataset.filter === filtroActivo));
    document.getElementById('btn-toggle-filtro-estado').textContent =
      `Estado: ${_ESTADO_LABELS[filtroActivo] ?? filtroActivo} ▾`;
    document.getElementById('filtro-estado-dropdown').classList.add('hidden');
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
  clienteActual = nombre;
  document.getElementById('cliente-picks-title').textContent = nombre;
  document.getElementById('cliente-picks-progress').textContent = '';
  document.getElementById('scan-cliente-banner').classList.add('hidden');
  const content = document.getElementById('cliente-picks-content');
  content.innerHTML = '<p class="loading">Cargando...</p>';
  document.getElementById('cliente-picks-overlay').classList.remove('hidden');
  document.getElementById('scan-cliente-btn').classList.add('hidden');

  try {
    const picks = await api.getPicksPorCliente(nombre, semanaActual);
    currentClientePicks = picks;
    if (!picks.length) {
      content.innerHTML = '<p class="loading">Sin items</p>';
    } else {
      renderPicks(picks, content);
      updateSheetProgress();
      document.getElementById('scan-cliente-btn').classList.remove('hidden');
    }
  } catch (err) {
    content.innerHTML = `<p class="error-msg">${err.message}</p>`;
  }
}

function cerrarSheetCliente() {
  stopScanner();
  clienteScanMode = false;
  currentClientePicks = [];
  clienteActual = '';
  _clearHighlight();
  document.getElementById('scan-cliente-banner').classList.add('hidden');
  document.getElementById('scan-cliente-btn').classList.add('hidden');
  document.getElementById('cliente-picks-overlay').classList.add('hidden');
  loadResumen();
}

function _clearHighlight() {
  if (_highlightedCard) {
    _highlightedCard.classList.remove('scan-highlight');
    _highlightedCard = null;
  }
}

function _setHighlight(card) {
  _clearHighlight();
  if (card) {
    card.classList.add('scan-highlight');
    _highlightedCard = card;
  }
}

function scanAlert(msg) {
  return new Promise((resolve) => {
    document.getElementById('scan-alert-msg').textContent = msg;
    const overlay = document.getElementById('scan-alert-overlay');
    overlay.classList.remove('hidden');
    const ok = document.getElementById('scan-alert-ok');
    function onOk() {
      overlay.classList.add('hidden');
      ok.removeEventListener('click', onOk);
      resolve();
    }
    ok.addEventListener('click', onOk);
  });
}

document.getElementById('cliente-picks-close').addEventListener('click', cerrarSheetCliente);

document.getElementById('cliente-picks-overlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) cerrarSheetCliente();
});

// ── Scanner por cliente ────────────────────────────────────────────────────
document.getElementById('scan-cliente-btn').addEventListener('click', () => {
  clienteScanMode = true;
  document.getElementById('scan-cliente-nombre-banner').textContent = clienteActual;
  document.getElementById('scan-cliente-banner').classList.remove('hidden');
  startScanner();
});

async function handleClienteScan(code) {
  const match = currentClientePicks.find((p) =>
    p.cod_bar === code || p.cod_bar_bulto === code || p.cod_art === code
  );

  if (match) {
    playBeep(880, 80);
    const content = document.getElementById('cliente-picks-content');
    const card = content.querySelector(`[data-pick-id="${match.id}"]`);
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      _setHighlight(card); // resaltado persistente hasta nueva acción
    }
    // Reabrir scanner automáticamente para el siguiente escaneo
    setTimeout(() => { if (clienteScanMode) startScanner(); }, 600);
  } else {
    // Modal bloqueante — no reabre el scanner hasta que el operario toque OK
    await scanAlert(`Este artículo no está en el pedido de ${clienteActual}.`);
    // clienteScanMode sigue true; el operario presiona "Escanear" para continuar
  }
}


// ── Tab: Admin ─────────────────────────────────────────────────────────────
function initAdmin() {
  const vendedor = esVendedor();
  if (adminUnlocked || esAdmin() || vendedor) {
    adminUnlocked = true;
    document.getElementById('admin-lock').classList.add('hidden');
    document.getElementById('admin-panel').classList.remove('hidden');

    // Visibilidad de tabs según permisos granulares del rol
    document.querySelector('.admin-tab-btn[data-admin-tab="usuarios"]').classList.add('hidden'); // siempre en hub modal
    document.querySelector('.admin-tab-btn[data-admin-tab="clientes"]').classList.toggle('hidden', !puedeGestionarClientes());
    document.querySelector('.admin-tab-btn[data-admin-tab="nueva-semana"]').classList.toggle('hidden', !puedeImportarSemanas());
    document.querySelector('.admin-tab-btn[data-admin-tab="zonas"]').classList.toggle('hidden', !puedeGestionarZonas());
    document.querySelector('.admin-tab-btn[data-admin-tab="reparto"]').classList.toggle('hidden', !puedeGestionarZonas());
    document.querySelector('.admin-tab-btn[data-admin-tab="historial"]').classList.toggle('hidden', !puedeVerAuditoria());
    document.querySelector('.admin-tab-btn[data-admin-tab="articulos"]').classList.toggle('hidden', !puedeVerArticulos());

    // Buscar el tab a mostrar: el guardado (si existe y es visible) o el primero visible
    document.querySelectorAll('.admin-tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.admin-tab-panel').forEach(p => p.classList.add('hidden'));
    const savedAdminTab = _getAdminTab();
    const savedBtn = savedAdminTab
      ? document.querySelector(`.admin-tab-btn[data-admin-tab="${savedAdminTab}"]:not(.hidden)`)
      : null;
    const firstBtn = savedBtn || document.querySelector('.admin-tab-btn:not(.hidden)');
    if (firstBtn) {
      firstBtn.classList.add('active');
      const target = firstBtn.dataset.adminTab;
      document.querySelector(`.admin-tab-panel[data-admin-panel="${target}"]`)?.classList.remove('hidden');
      if (target === 'nueva-semana') loadSemanasAdmin();
      if (target === 'clientes') loadClientes();
      if (target === 'historial') loadHistorial();
      if (target === 'zonas') loadZonas();
      if (target === 'reparto') loadAsignaciones();
      if (target === 'articulos') loadArticulos();
      _setTopbarSection(_ADMIN_TAB_LABELS[target] || target);
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

document.getElementById('btn-nuevo-cliente').addEventListener('click', () => {
  const mayorista = getMayorista();
  document.getElementById('tipo-cliente-title').textContent =
    `Nuevo cliente ${mayorista === 'diarco' ? 'DIARCO' : 'Yaguar'}`;
  document.getElementById('tipo-cliente-modal').classList.remove('hidden');
});

document.getElementById('tipo-cliente-close').addEventListener('click', () => {
  document.getElementById('tipo-cliente-modal').classList.add('hidden');
});

document.getElementById('btn-tipo-cf').addEventListener('click', async () => {
  document.getElementById('tipo-cliente-modal').classList.add('hidden');
  try {
    const res = getMayorista() === 'diarco'
      ? await api.getCodigoLibreDiarco()
      : await api.getCodigoLibreYaguar();
    _clienteEsFA = false;
    openClienteForm(null, res.codigo, null, true); // true = es CF, mostrar botón no_zona
  } catch {
    showToast('No hay códigos libres disponibles', 'error');
  }
});

document.getElementById('btn-tipo-fa').addEventListener('click', () => {
  document.getElementById('tipo-cliente-modal').classList.add('hidden');
  _clienteEsFA = true;
  openClienteForm(null, null, null, false); // false = Factura A, código editable
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
document.getElementById('admin-clientes-search').addEventListener('input', () => {
  renderClientes();
});

let _clientesData = [];
let _clientesSortCol = 'nombre';
let _clientesSortDir = 1;  // 1 = asc, -1 = desc

function _norm(s) {
  return (s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, '');
}

function _lev(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({length: m + 1}, (_, i) =>
    Array.from({length: n + 1}, (_, j) => i === 0 ? j : j === 0 ? i : 0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = a[i-1] === b[j-1] ? d[i-1][j-1] : 1 + Math.min(d[i-1][j], d[i][j-1], d[i-1][j-1]);
  return d[m][n];
}

function _clienteMatch(query, campo) {
  const q = _norm(query);
  const t = _norm(campo);
  if (!q) return true;
  if (t.includes(q)) return true;
  if (q.length < 4) return false;
  const maxErr = Math.max(1, Math.floor(q.length / 4));
  for (let i = 0; i <= t.length - q.length; i++) {
    if (_lev(q, t.slice(i, i + q.length)) <= maxErr) return true;
  }
  return false;
}

async function loadClientes() {
  document.getElementById('btn-exportar-clientes').classList.remove('hidden');
  const tbody = document.getElementById('clientes-tbody');
  tbody.innerHTML = `<tr><td colspan="5" class="loading">Cargando...</td></tr>`;
  try {
    _clientesData = await api.getClientes();
    renderClientes();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" class="error-msg">${err.message}</td></tr>`;
  }
  loadSinRegistrar();
}

function renderClientes() {
  const tbody = document.getElementById('clientes-tbody');
  const q = document.getElementById('admin-clientes-search').value.toLowerCase();

  let data = [..._clientesData];

  // Ordenar
  data.sort((a, b) => {
    let va = a[_clientesSortCol], vb = b[_clientesSortCol];
    if (_clientesSortCol === 'flete') {
      va = parseFloat(va) || 0;
      vb = parseFloat(vb) || 0;
    } else if (_clientesSortCol === 'es_factura_a') {
      va = va ? 1 : 0;
      vb = vb ? 1 : 0;
    } else {
      va = (va || '').toString().toLowerCase();
      vb = (vb || '').toString().toLowerCase();
    }
    if (va < vb) return -_clientesSortDir;
    if (va > vb) return  _clientesSortDir;
    return 0;
  });

  // Actualizar indicadores en headers
  document.querySelectorAll('#clientes-table th[data-sort]').forEach((th) => {
    const col = th.dataset.sort;
    const arrow = col === _clientesSortCol ? (_clientesSortDir === 1 ? ' ▲' : ' ▼') : '';
    th.textContent = th.dataset.label + arrow;
  });

  tbody.innerHTML = data.map((c) => {
    const flete = c.flete != null ? (Math.round(c.flete * 10000) / 100) + '%' : '—';
    const tipoCell = c.es_factura_a
      ? '<span class="badge-fa">A</span>'
      : '<span class="badge-cf">CF</span>';
    const hidden = q && !_clienteMatch(q, c.nombre) && !_clienteMatch(q, c.id_yaguar ?? '') && !_clienteMatch(q, c.localidad ?? '') ? 'style="display:none"' : '';
    return `<tr data-id="${c.id}" onclick="openClienteForm(${c.id})" ${hidden}>
      <td class="td-full td-cod">${c.id_yaguar ?? '—'}</td>
      <td style="text-align:center;width:52px">${tipoCell}</td>
      <td class="td-full">${c.nombre ?? ''}</td>
      <td>${c.localidad ?? '—'}</td>
      <td>${flete}</td>
      <td onclick="event.stopPropagation()"><div class="td-actions">
        <button class="btn-edit" onclick="openClienteForm(${c.id})">Editar</button>
        <button class="btn-del" onclick="deleteCliente(${c.id})">Eliminar</button>
      </div></td>
    </tr>`;
  }).join('');
}

// Click en cabecera de tabla → ordenar
document.addEventListener('click', (e) => {
  const th = e.target.closest('#clientes-table th[data-sort]');
  if (!th) return;
  const col = th.dataset.sort;
  if (_clientesSortCol === col) {
    _clientesSortDir *= -1;
  } else {
    _clientesSortCol = col;
    _clientesSortDir = 1;
  }
  renderClientes();
});

document.getElementById('btn-exportar-clientes').addEventListener('click', () => {
  window.location.href = `/api/${getMayorista()}/export/clientes`;
});

async function openClienteForm(id, codigoPreverificado = null, nombrePre = null, esCF = null) {
  editingClienteId = id;
  document.getElementById('modal-title').textContent = id ? 'Editar cliente' : 'Nuevo cliente';

  const esYaguar = getMayorista() === 'yaguar';
  const idInput = document.getElementById('cf-id_yaguar');

  // Mostrar campo ID para ambos mayoristas con label correspondiente
  document.getElementById('cf-id-yaguar-wrap').style.display = '';
  document.getElementById('cf-id-label').textContent = esYaguar ? 'Código Yaguar' : 'Código DIARCO';
  document.getElementById('cf-flete-wrap').style.display = '';
  document.getElementById('cf-cod-sis-wrap').classList.toggle('hidden', !esYaguar);
  document.getElementById('cf-cod_sis').value = '';

  // CF: readonly (código del pool). FA y código manual: editable.
  const esReadonly = (esCF === true || (esCF === null && !!codigoPreverificado && !id));
  idInput.readOnly = esReadonly;
  idInput.value = '';
  idInput.placeholder = !esReadonly ? `Ingresá el código ${esYaguar ? 'Yaguar' : 'DIARCO'}` : '';

  // Botón "No existe en mi zona": para CF nuevos de cualquier mayorista
  const btnNoZona = document.getElementById('btn-no-en-zona');
  btnNoZona.classList.toggle('hidden', !(esCF === true && !id));

  const fields = ['nombre', 'localidad', 'direccion', 'telefono', 'contacto'];
  fields.forEach((f) => { document.getElementById(`cf-${f}`).value = ''; });
  document.getElementById('cf-vendedor').value = '';
  document.getElementById('cf-vendedor').disabled = false;
  document.getElementById('cf-flete').value = '';
  document.getElementById('cf-cuit_deposito').value = '';
  if (nombrePre) document.getElementById('cf-nombre').value = nombrePre;

  const [zonas, vendedores] = await Promise.all([
    api.getZonas().catch(() => []),
    api.getVendedoresYaguar().catch(() => []),
  ]);

  const sel = document.getElementById('cf-localidad');
  sel.innerHTML = '<option value="">— Seleccioná una zona —</option>' +
    zonas.map((z) => `<option value="${z.nombre}">${z.nombre}</option>`).join('');

  const selVend = document.getElementById('cf-vendedor');
  selVend.innerHTML = '<option value="">— Seleccioná un vendedor —</option>' +
    vendedores.map((v) => `<option value="${v}">${v}</option>`).join('');

  if (id) {
    api.getClientes().then((list) => {
      const c = list.find((x) => x.id === id);
      if (c) {
        ['nombre', 'localidad', 'direccion', 'telefono', 'contacto'].forEach((f) => {
          document.getElementById(`cf-${f}`).value = c[f] ?? '';
        });
        idInput.value = c.id_yaguar ?? '';
        document.getElementById('cf-flete').value = c.flete != null ? Math.round(c.flete * 10000) / 100 : '';
        document.getElementById('cf-cod_sis').value = c.cod_sis ?? '';
        document.getElementById('cf-cuit_deposito').value = c.cuit_deposito ?? '';
        _clienteEsFA = c.es_factura_a ?? false;
        _actualizarCuitHint();
        // Vendor: add to list if value isn't already an option (legacy/imported data)
        const vv = c.vendedor ?? '';
        if (vv && !selVend.querySelector(`option[value="${vv.replace(/"/g, '\\"')}"]`)) {
          const opt = document.createElement('option');
          opt.value = vv; opt.textContent = vv;
          selVend.appendChild(opt);
        }
        selVend.value = vv;
      }
    });
  } else if (codigoPreverificado) {
    idInput.value = codigoPreverificado;
    // Si viene de sin-registrar, el código ya es conocido → readonly
    if (nombrePre) idInput.readOnly = true;
  }

  // Vendedores editando: solo pueden tocar nombre, zona, dirección, teléfono, contacto
  // soloLectura = tiene permiso básico pero NO el completo (al editar un cliente existente)
  const soloLectura = !!id && !puedeGestionarClientesFull();
  idInput.readOnly = idInput.readOnly || soloLectura;
  selVend.disabled = soloLectura;
  document.getElementById('cf-flete-wrap').style.display   = soloLectura ? 'none' : '';
  document.getElementById('cf-cod-sis-wrap').classList.toggle('hidden', !esYaguar || soloLectura);
  // cuit_deposito visible en ambos modos (básico y completo)
  document.getElementById('cf-cuit-wrap').style.display    = '';
  _actualizarCuitHint();

  document.getElementById('cliente-modal').classList.remove('hidden');
}

document.getElementById('modal-close').addEventListener('click', () => {
  document.getElementById('cliente-modal').classList.add('hidden');
});

document.getElementById('cf-id_yaguar').addEventListener('input', (e) => {
  e.target.value = e.target.value.replace(/\D/g, '');
});

document.getElementById('btn-no-en-zona').addEventListener('click', async () => {
  const codigo = document.getElementById('cf-id_yaguar').value;
  if (!codigo) return;
  const ok = await confirmar(
    `¿Confirmar que el código ${codigo} no existe en tu zona? Se descartará y se asignará el siguiente disponible.`,
    'Sí, descartar'
  );
  if (!ok) return;
  try {
    const res = getMayorista() === 'diarco'
      ? await api.marcarNoZonaDiarco(codigo)
      : await api.marcarNoZona(codigo);
    showToast(`Código ${codigo} marcado como no disponible`, 'info');
    if (res.nuevo_codigo) {
      document.getElementById('cf-id_yaguar').value = res.nuevo_codigo;
    } else {
      showToast('No quedan más códigos libres', 'error');
      document.getElementById('cliente-modal').classList.add('hidden');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
});

document.getElementById('cliente-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = {};
  ['nombre', 'localidad', 'direccion', 'telefono', 'contacto', 'vendedor'].forEach((f) => {
    data[f] = document.getElementById(`cf-${f}`).value.trim() || null;
  });
  data.id_yaguar = document.getElementById('cf-id_yaguar').value.trim() || null;
  const fleteVal = document.getElementById('cf-flete').value.trim();
  data.flete = fleteVal !== '' ? parseFloat(fleteVal) / 100 : null;
  data.cod_sis = document.getElementById('cf-cod_sis').value.trim() || null;
  data.cuit_deposito = document.getElementById('cf-cuit_deposito').value.trim() || null;
  if (!editingClienteId) data.es_factura_a = _clienteEsFA;

  if (!data.localidad) { showToast('Seleccioná una zona', 'error'); return; }
  if (!data.vendedor) { showToast('Ingresá el vendedor', 'error'); return; }
  if (_clienteEsFA && !data.cuit_deposito) { showToast('El CUIT es obligatorio para clientes Factura A', 'error'); return; }

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
    ? `<p>Una <strong>semana</strong> es una sesión de picking: representa todos los pedidos de un rango de fechas que hay que separar en el depósito. Al importar, la app genera automáticamente una tarjeta por cada artículo de cada cliente dentro de ese rango.</p>
       <p>Las semanas aparecen en el selector de la pantalla de pick para que los operarios elijan sobre cuál trabajar. Podés marcar semanas viejas como <strong>Ocultas</strong> para que no aparezcan en ese selector — los datos se conservan para análisis futuro.</p>
       <p>El botón <strong>↓ Pick</strong> exporta el detalle de picks y cantidades entregadas. El botón <strong>↓ Mod</strong> (solo Yaguar) exporta la planilla de liquidación con totales por cliente, comisión EBD, SALDO y secciones de comprobantes/devoluciones.</p>`
    : `<p>Una <strong>semana</strong> es una sesión de picking: representa todos los pedidos de un rango de fechas que hay que separar en el depósito. Al importar, la app genera automáticamente una tarjeta por cada artículo de cada cliente dentro de ese rango.</p>
       <p>Las semanas aparecen en el selector de la pantalla de pick para que los operarios elijan sobre cuál trabajar. Podés marcar semanas viejas como <strong>Ocultas</strong> para que no aparezcan en ese selector — los datos se conservan para análisis futuro.</p>
       <p>El botón <strong>↓ Pick</strong> exporta el detalle de picks y cantidades entregadas. El botón <strong>↓ Mod</strong> (solo Yaguar) exporta la planilla de liquidación con totales por cliente, comisión EBD, SALDO y secciones de comprobantes/devoluciones.</p>`;
  document.getElementById('import-yaguar').classList.toggle('hidden', m === 'diarco');
  document.getElementById('import-diarco').classList.toggle('hidden', m !== 'diarco');

  try {
    const semanas = await api.getSemanasAdmin();
    if (semanas.length === 0) {
      list.innerHTML = '<p class="semana-admin-empty">No hay semanas cargadas</p>';
      return;
    }
    list.innerHTML = semanas.map((s) => {
      const visible = s.visible !== false;
      return `
        <div class="semana-admin-item">
          <span class="semana-nombre-tag${visible ? '' : ' semana-oculta'}">${s.nombre}</span>
          <button class="btn-toggle-visible ${visible ? 'btn-toggle-on' : 'btn-toggle-off'}"
                  onclick="toggleSemanaVisible(${s.id}, ${!visible})"
                  title="${visible ? 'Ocultar de operarios' : 'Mostrar a operarios'}">
            ${visible ? 'Visible' : 'Oculta'}
          </button>
          <a class="btn-export" href="${api.exportPicksUrl(s.nombre)}" download>↓ Pick</a>
          ${m === 'yaguar' ? `<a class="btn-export btn-export-mod" href="${api.exportModUrl(s.nombre)}" download>↓ Mod</a>` : ''}
          <button class="btn-del" onclick="deleteSemana(${s.id}, '${s.nombre.replace(/'/g, "\\'")}')">Eliminar</button>
        </div>
      `;
    }).join('');
  } catch (err) {
    list.innerHTML = `<p class="error-msg">${err.message}</p>`;
  }
}

async function toggleSemanaVisible(id, visible) {
  try {
    await api.toggleSemanaVisible(id, visible);
    loadSemanasAdmin();
    loadSemanas();
  } catch (err) {
    showToast(err.message, 'error');
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
const ROL_COLORS = { superadmin: 'var(--accent)', admin: 'var(--green)', vendedor: '#7eb8ff', operario: 'var(--muted)' };
const ROL_LABELS = { superadmin: 'Superadmin', admin: 'Admin', vendedor: 'Vendedor', operario: 'Operario' };

let _usersData = [];
let _usersSortCol = 'rol';
let _usersSortDir = 1;

async function loadUsers() {
  const tbody = document.getElementById('users-tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="3" class="loading">Cargando...</td></tr>';
  try {
    // Cargar roles si no están disponibles para que el orden por rol funcione
    if (!_rolesData.length) {
      _rolesData = await api.getRoles().catch(() => []);
    }
    _usersData = await api.getUsers();
    renderUsers();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="3" class="error-msg">${err.message}</td></tr>`;
  }
}

function renderUsers() {
  const tbody = document.getElementById('users-tbody');
  if (!tbody) return;
  const q = (document.getElementById('users-search')?.value || '').toLowerCase();

  // Usar el orden definido en la tabla de roles (si está cargado)
  const _rolWeight = (r) => {
    if (r === 'superadmin') return -1;
    const found = _rolesData.find(x => x.nombre === r);
    return found ? (found.orden ?? 100) : 100;
  };
  const superadmins = _usersData.filter(u => u.rol === 'superadmin');
  const resto = _usersData.filter(u => u.rol !== 'superadmin');
  const data = [...superadmins, ...resto.sort((a, b) => {
    let va, vb;
    if (_usersSortCol === 'rol') {
      va = _rolWeight(a.rol);
      vb = _rolWeight(b.rol);
    } else {
      va = (a[_usersSortCol] || '').toLowerCase();
      vb = (b[_usersSortCol] || '').toLowerCase();
    }
    if (va < vb) return -_usersSortDir;
    if (va > vb) return  _usersSortDir;
    return 0;
  })];

  // Actualizar indicadores en headers
  document.querySelectorAll('#users-table th[data-sort]').forEach(th => {
    const col = th.dataset.sort;
    const arrow = col === _usersSortCol ? (_usersSortDir === 1 ? ' ▲' : ' ▼') : '';
    th.textContent = th.dataset.label + arrow;
  });

  tbody.innerHTML = data.map((u) => {
    if (q && !u.username.toLowerCase().includes(q) && !(ROL_LABELS[u.rol] || u.rol).toLowerCase().includes(q)) {
      return '';
    }
    const esEsteSuperadmin = u.rol === 'superadmin';
    const superadminCount = data.filter(x => x.rol === 'superadmin').length;
    const callerEsSuperadmin = esSuperadmin();
    // El último superadmin no se puede tocar (ni editar ni eliminar)
    const esUltimoSuperadmin = esEsteSuperadmin && superadminCount <= 1;
    // Para los demás superadmins: solo otro superadmin puede tocarlos
    const puedeTocar = !esUltimoSuperadmin && (!esEsteSuperadmin || callerEsSuperadmin);
    const rolColor = _rolesData.find(r => r.nombre === u.rol)?.color || ROL_COLORS[u.rol] || 'var(--muted)';
    const rolLabel = `<span style="color:${rolColor}">${ROL_LABELS[u.rol] || u.rol}</span>`;
    const deleteBtn = puedeTocar ? `<button class="btn-del" onclick="deleteUser(${u.id})">✕</button>` : '';
    const clickAttr = puedeTocar ? `onclick="openEditUser(${u.id}, '${u.username.replace(/'/g, "\\'")}', '${u.rol}', ${u.acceso_sobrantes}, ${u.acceso_novedades}, ${u.acceso_pick})" style="cursor:pointer"` : '';
    return `<tr ${clickAttr}>
      <td>${u.username}</td>
      <td>${rolLabel}</td>
      <td onclick="event.stopPropagation()"><div class="td-actions">${deleteBtn}</div></td>
    </tr>`;
  }).join('');
}

// Click en header → ordenar
document.addEventListener('click', (e) => {
  const th = e.target.closest('#users-table th[data-sort]');
  if (!th) return;
  const col = th.dataset.sort;
  if (_usersSortCol === col) _usersSortDir *= -1;
  else { _usersSortCol = col; _usersSortDir = 1; }
  renderUsers();
});

// Buscador
document.getElementById('users-search')?.addEventListener('input', renderUsers);

// Tabs del modal de administración (Usuarios / Roles)
document.querySelectorAll('.gest-tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.gestTab;
    document.querySelectorAll('.gest-tab-btn').forEach(b => {
      const isActive = b.dataset.gestTab === tab;
      b.style.borderBottomColor = isActive ? 'var(--accent)' : 'transparent';
      b.style.color = isActive ? 'var(--text)' : 'var(--muted)';
    });
    document.getElementById('gest-panel-usuarios').classList.toggle('hidden', tab !== 'usuarios');
    document.getElementById('gest-panel-roles').classList.toggle('hidden', tab !== 'roles');
    if (tab === 'roles') loadRoles();
  });
});

// Botón Nuevo usuario
document.getElementById('btn-nuevo-usuario')?.addEventListener('click', () => {
  document.getElementById('nuevo-usuario-form').reset();
  _recargarSelectsRoles().then(() => {
    document.getElementById('nuevo-usuario-modal').classList.remove('hidden');
  });
});
document.getElementById('nuevo-usuario-modal-close')?.addEventListener('click', () => {
  document.getElementById('nuevo-usuario-modal').classList.add('hidden');
});
document.getElementById('nuevo-usuario-modal')?.addEventListener('click', (e) => {
  if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
});

// ── Modal editar usuario ───────────────────────────────────────────────────
function openEditUser(id, username, rol, accesoSobrantes, accesoNovedades, accesosPick) {
  document.getElementById('edit-user-id').value = id;
  document.getElementById('edit-username').value = username;
  // Incluir superadmin en el select solo si el caller ES superadmin
  const selRol = document.getElementById('edit-rol');
  if (esSuperadmin()) {
    if (!selRol.querySelector('option[value="superadmin"]')) {
      const opt = document.createElement('option');
      opt.value = 'superadmin'; opt.textContent = 'Superadmin';
      selRol.insertBefore(opt, selRol.firstChild);
    }
  } else {
    selRol.querySelector('option[value="superadmin"]')?.remove();
  }
  selRol.value = rol;
  document.getElementById('edit-sobrantes').checked = !!accesoSobrantes;
  document.getElementById('edit-novedades').checked = !!accesoNovedades;
  document.getElementById('edit-pick').checked = accesosPick === undefined ? true : !!accesosPick;
  document.getElementById('edit-rol-group').classList.remove('hidden');
  document.getElementById('edit-user-modal').classList.remove('hidden');
}

function closeEditUser() {
  document.getElementById('edit-user-modal').classList.add('hidden');
}

document.getElementById('edit-user-close').addEventListener('click', closeEditUser);
document.getElementById('edit-user-cancel').addEventListener('click', closeEditUser);

document.getElementById('edit-user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = parseInt(document.getElementById('edit-user-id').value);
  const data = {
    username: document.getElementById('edit-username').value.trim(),
    acceso_sobrantes: document.getElementById('edit-sobrantes').checked,
    acceso_novedades: document.getElementById('edit-novedades').checked,
    acceso_pick: document.getElementById('edit-pick').checked,
  };
  data.rol = document.getElementById('edit-rol').value;
  try {
    await api.updateUser(id, data);
    showToast('Usuario actualizado', 'success');
    closeEditUser();
    loadUsers();
    await checkPermissions(); // actualizar permisos del usuario actual de inmediato
  } catch (err) {
    showToast(err.message, 'error');
  }
});

async function toggleSobrantes(id, checkbox) {
  try {
    await api.updateSobrantesAcceso(id, checkbox.checked);
    showToast(`Acceso a sobrantes ${checkbox.checked ? 'activado' : 'desactivado'}`, 'success');
    loadUsers();
  } catch (err) {
    checkbox.checked = !checkbox.checked;
    showToast(err.message, 'error');
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
  const rol = document.getElementById('nu-rol').value;
  try {
    await api.createUser(username, password, rol);
    showToast(`Usuario ${username} creado`, 'success');
    document.getElementById('nuevo-usuario-form').reset();
    document.getElementById('nuevo-usuario-modal')?.classList.add('hidden');
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
document.getElementById('change-pw-btn')?.addEventListener('click', () => {
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

  function updateBtns() {
    const icon = isFullscreen() ? '⊡' : '⛶';
    const title = isFullscreen() ? 'Salir de pantalla completa' : 'Pantalla completa';
    document.querySelectorAll('.btn-fullscreen-mobile').forEach(b => {
      b.textContent = icon;
      b.title = title;
    });
  }

  document.addEventListener('fullscreenchange', updateBtns);
  document.addEventListener('webkitfullscreenchange', updateBtns);

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.btn-fullscreen-mobile')) return;
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

let _editZonaId = null;

async function editZona(id, nombre, reparto) {
  _editZonaId = id;
  document.getElementById('ez-nombre').value = nombre;
  // Poblar el select con los repartos actuales y seleccionar el correcto
  await populateRepartosSelect('ez-reparto', reparto);
  document.getElementById('edit-zona-modal').classList.remove('hidden');
}

document.getElementById('edit-zona-close').addEventListener('click', () => {
  document.getElementById('edit-zona-modal').classList.add('hidden');
});

document.getElementById('edit-zona-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!_editZonaId) return;
  const nombre = document.getElementById('ez-nombre').value.trim();
  const reparto = document.getElementById('ez-reparto').value;
  try {
    await api.updateZona(_editZonaId, nombre, reparto);
    showToast('Zona actualizada', 'success');
    document.getElementById('edit-zona-modal').classList.add('hidden');
    loadZonas();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

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
  try {
    await api.createZona(nombre, reparto);
    showToast(`Zona ${nombre} creada`, 'success');
    document.getElementById('nz-nombre').value = '';
    document.getElementById('nz-reparto').value = '';
    loadZonas();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// ── Modal de confirmación ──────────────────────────────────────────────────
function confirmar(msg, btnLabel = 'Sí, confirmar', mostrarCancelar = true) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('confirm-modal');
    document.getElementById('confirm-msg').textContent = msg;
    overlay.classList.remove('hidden');
    const ok = document.getElementById('confirm-ok');
    ok.textContent = btnLabel;
    const cancel = document.getElementById('confirm-cancel');
    cancel.style.display = mostrarCancelar ? '' : 'none';
    function cleanup(result) {
      overlay.classList.add('hidden');
      cancel.style.display = '';
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
let histScannerActive = false;
let _histCodeReader = null;
let _sobCameras = [];
let _sobCamIdx = 0;

async function initSobrantes() {
  await loadSobListas();
}

async function loadSobListas() {
  try {
    _sobListas = await api.sobGetListas();
  } catch { _sobListas = []; }

  const btn = document.getElementById('sob-lista-btn');
  const optionsContainer = document.getElementById('sob-lista-options');

  if (_sobListas.length === 0) {
    const now = new Date();
    const hoy = `${String(now.getDate()).padStart(2,'0')}-${String(now.getMonth()+1).padStart(2,'0')}-${now.getFullYear()}`;
    const nombre = `Sobrantes ${hoy}`;
    _sobListaActual = nombre;
    btn.textContent = `${nombre} ▾`;
    optionsContainer.innerHTML = `<button class="chip-reparto active" data-lista="${nombre}">${nombre}</button>`;
  } else {
    if (!_sobListaActual || !_sobListas.find(l => l.lista === _sobListaActual)) {
      _sobListaActual = _sobListas[0].lista;
    }
    btn.textContent = `${_sobListaActual} ▾`;
    optionsContainer.innerHTML = _sobListas.map(l =>
      `<button class="chip-reparto${l.lista === _sobListaActual ? ' active' : ''}" data-lista="${l.lista}">${l.lista}</button>`
    ).join('');
  }
  await loadSobItems();
}

async function loadSobItems() {
  const lista = _sobListaActual;
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
          <div class="sob-item-header-row">
            <span class="sob-mayorista-badge sob-mayorista-${item.mayorista || 'otro'}">${(item.mayorista || '?').toUpperCase()}</span>
            <div class="sob-item-descrip">${item.descrip || item.cod_bar || item.cod_art || '—'}</div>
          </div>
          <div class="sob-item-cod">${[item.cod_bar, item.cod_art].filter(Boolean).join(' · ')}</div>
        </div>
        <button class="sob-item-remove" data-id="${item.id}" title="Quitar artículo">✕</button>
      </div>
      <div class="sob-steppers">
        <div class="sob-stepper">
          <span class="sob-stepper-label">BUL</span>
          <button class="btn-step-minus sob-btn" data-id="${item.id}" data-field="bultos">−</button>
          <span class="sob-stepper-val" data-id="${item.id}" data-field="bultos">${item.bultos}</span>
          <button class="btn-step-plus sob-btn" data-id="${item.id}" data-field="bultos">+</button>
        </div>
        <div class="sob-stepper">
          <span class="sob-stepper-label">UNI</span>
          <button class="btn-step-minus sob-btn" data-id="${item.id}" data-field="unidades">−</button>
          <span class="sob-stepper-val" data-id="${item.id}" data-field="unidades">${item.unidades}</span>
          <button class="btn-step-plus sob-btn" data-id="${item.id}" data-field="unidades">+</button>
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
    if (!await confirmar('¿Quitar este artículo de la lista?', 'Sí, quitar')) return;
    try {
      await api.sobDeleteItem(_sobListaActual, id);
      _sobItems = _sobItems.filter(i => i.id !== id);
      renderSobItems(_sobItems);
    } catch { showToast('Error al eliminar', 'error'); }
  }
});

// Buscar / escanear
async function _sobAgregarArticulo(codBar, codArt, descrip, precioUnit, uxb) {
  const lista = _sobListaActual;
  if (!lista) { showToast('Creá una lista primero', 'error'); return; }
  try {
    const res = await api.sobAddItem(lista, {
      cod_bar: codBar || null, cod_art: codArt || null, descrip: descrip || null,
      mayorista: getMayorista(), precio_unit: precioUnit || null, uxb: uxb || 0,
    });
    _sobItems = await api.sobGetItems(lista);
    await loadSobListas();
    renderSobItems(_sobItems);
    if (res.action === 'existing') {
      showToast('Ya estaba en la lista — resaltado', 'info');
      setTimeout(() => {
        const el = document.querySelector(`.sob-item[data-id="${res.id}"]`);
        if (el) { el.classList.add('highlight'); el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
        setTimeout(() => el?.classList.remove('highlight'), 1500);
      }, 50);
    } else {
      showToast('Artículo agregado', 'success');
      setTimeout(() => document.querySelector('.sob-item')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    }
  } catch (err) { showToast(err.message, 'error'); }
}

async function sobBuscar(codBar) {
  const bar = (codBar || '').trim();
  if (!bar) return;
  if (!_sobListaActual) { showToast('Creá una lista primero', 'error'); return; }
  document.getElementById('sob-barcode-input').value = '';

  try {
    const items = await api.getArticulos(bar, 10);
    const exactos = items.filter(i => i.cod_bar === bar || i.cod_bar_bulto === bar);
    const lista_ = exactos.length ? exactos : items;

    if (lista_.length === 1) {
      const a = lista_[0];
      await _sobAgregarArticulo(bar, a.cod_art, a.descrip, a.precio_con_iva, a.uxb || 0);
    } else if (lista_.length > 1) {
      // Mostrar picker (reutiliza el panel de búsqueda de texto)
      const results = document.getElementById('sob-descrip-results');
      const fmt = (v) => v != null ? '$' + Number(v).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
      results.innerHTML = lista_.map(i =>
        `<div class="descrip-result-item" data-bar="${i.cod_bar || ''}" data-art="${i.cod_art || ''}" data-descrip="${(i.descrip || '').replace(/"/g, '&quot;')}" data-precio="${i.precio_con_iva ?? ''}" data-uxb="${i.uxb || 0}">
           <span class="descrip-result-text">${i.descrip}</span>
         </div>`
      ).join('');
      results.classList.remove('hidden');
    } else {
      _abrirFallbackModal(bar, async (art) => {
        await _sobAgregarArticulo(art.cod_bar, art.cod_art, art.descrip, art.precio_unit, art.uxb);
      });
    }
  } catch { showToast('Error al buscar el artículo', 'error'); }
}

document.getElementById('sob-barcode-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); sobBuscar(e.target.value); }
});

// Búsqueda por descripción
let _sobDescripTimer = null;
document.getElementById('sob-descrip-input').addEventListener('input', (e) => {
  clearTimeout(_sobDescripTimer);
  const q = e.target.value.trim();
  const results = document.getElementById('sob-descrip-results');
  if (q.length < 2) { results.classList.add('hidden'); return; }
  _sobDescripTimer = setTimeout(async () => {
    try {
      const items = await api.getArticulos(q, 50);
      if (!items.length) {
        results.innerHTML = '<div class="descrip-result-empty">Sin resultados</div>';
        results.classList.remove('hidden');
        return;
      }
      results.innerHTML = items.map(i =>
        `<div class="descrip-result-item" data-bar="${i.cod_bar || ''}" data-art="${i.cod_art || ''}" data-descrip="${(i.descrip || '').replace(/"/g, '&quot;')}" data-precio="${i.precio_con_iva ?? ''}" data-uxb="${i.uxb || 0}">
          <span class="descrip-result-text">${i.descrip}</span>
        </div>`
      ).join('');
      results.classList.remove('hidden');
    } catch { results.classList.add('hidden'); }
  }, 250);
});

document.getElementById('sob-descrip-results').addEventListener('click', async (e) => {
  const item = e.target.closest('.descrip-result-item');
  if (!item) return;
  document.getElementById('sob-descrip-results').classList.add('hidden');
  document.getElementById('sob-descrip-input').value = '';
  const lista = _sobListaActual;
  if (!lista) { showToast('Creá una lista primero', 'error'); return; }
  await _sobAgregarArticulo(
    item.dataset.bar || null,
    item.dataset.art || null,
    item.dataset.descrip || null,
    item.dataset.precio ? parseFloat(item.dataset.precio) : null,
    parseInt(item.dataset.uxb) || 0,
  );
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('#sob-descrip-input') && !e.target.closest('#sob-descrip-results')) {
    document.getElementById('sob-descrip-results')?.classList.add('hidden');
  }
  if (!e.target.closest('#sob-lista-wrap')) {
    document.getElementById('sob-lista-dropdown')?.classList.add('hidden');
  }
  if (!e.target.closest('#nov-semana-wrap')) {
    document.getElementById('nov-semana-dropdown')?.classList.add('hidden');
  }
  if (!e.target.closest('#hist-semana-wrap')) {
    document.getElementById('hist-semana-dropdown')?.classList.add('hidden');
  }
});

// Nueva lista — modal custom
document.getElementById('sob-nueva-btn').addEventListener('click', () => {
  const now = new Date();
  const hoy = `${String(now.getDate()).padStart(2,'0')}-${String(now.getMonth()+1).padStart(2,'0')}-${now.getFullYear()}`;
  const input = document.getElementById('sob-nueva-input');
  input.value = `Sobrantes ${hoy}`;
  document.getElementById('sob-nueva-modal').classList.remove('hidden');
});

document.getElementById('sob-nueva-confirm').addEventListener('click', async () => {
  const nombre = document.getElementById('sob-nueva-input').value.trim().replace(/\//g, '-');
  if (!nombre) return;
  document.getElementById('sob-nueva-modal').classList.add('hidden');
  try {
    await api.sobCrearLista(nombre);
    _sobListaActual = nombre;
    _sobItems = [];
    await loadSobListas();
  } catch (err) { showToast(err.message, 'error'); }
});

document.getElementById('sob-nueva-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('sob-nueva-confirm').click();
  if (e.key === 'Escape') document.getElementById('sob-nueva-modal').classList.add('hidden');
});

// Dropdown de lista
document.getElementById('sob-lista-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('sob-lista-dropdown').classList.toggle('hidden');
});

document.getElementById('sob-lista-options').addEventListener('click', (e) => {
  const opt = e.target.closest('[data-lista]');
  if (!opt) return;
  _sobListaActual = opt.dataset.lista;
  document.getElementById('sob-lista-btn').textContent = `${_sobListaActual} ▾`;
  document.getElementById('sob-lista-dropdown').classList.add('hidden');
  document.querySelectorAll('#sob-lista-options [data-lista]').forEach(b => b.classList.remove('active'));
  opt.classList.add('active');
  loadSobItems();
});

// Eliminar lista
document.getElementById('sob-del-lista-btn').addEventListener('click', async () => {
  const lista = _sobListaActual;
  if (!lista) return;
  if (!await confirmar(`¿Eliminar la lista "${lista}"? Esta acción no se puede deshacer.`, 'Sí, eliminar')) return;
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

// ── Scanner historial ─────────────────────────────────────────────────────────
document.getElementById('hist-scan-btn').addEventListener('click', async () => {
  if (histScannerActive) stopHistScanner();
  else await startHistScanner();
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
  const sobVideo = document.getElementById('sob-scanner-video');
  if (sobVideo.srcObject) {
    const track = sobVideo.srcObject.getVideoTracks()[0];
    if (track) {
      const caps = track.getCapabilities?.() || {};
      applyTorchPreference(track, 'sob-torch-btn');
    }
  }
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
  const sobTorchBtn = document.getElementById('sob-torch-btn');
  sobTorchBtn.classList.add('hidden');
  sobTorchBtn.dataset.torchOn = 'false';
  sobTorchBtn.classList.remove('torch-active');
}

function switchSobCamera() {
  if (!_sobCameras.length) return;
  _sobCamIdx = (_sobCamIdx + 1) % _sobCameras.length;
  stopSobScanner();
  startSobScanner(_sobCameras[_sobCamIdx].deviceId);
}

async function startHistScanner(deviceId = null) {
  const container = document.getElementById('hist-scanner-container');
  container.classList.remove('hidden');
  container.classList.add('scanner-open');
  document.getElementById('hist-scan-btn').textContent = 'Detener';
  histScannerActive = true;
  const hints = new Map([[2, [ZXing.BarcodeFormat.EAN_13, ZXing.BarcodeFormat.EAN_8, ZXing.BarcodeFormat.CODE_128, ZXing.BarcodeFormat.CODE_39]], [3, true]]);
  _histCodeReader = new ZXing.BrowserMultiFormatReader(hints, 0);
  const targetId = deviceId ?? localStorage.getItem('pick_last_camera') ?? null;
  await _histCodeReader.decodeFromVideoDevice(targetId, 'hist-scanner-video', (result) => {
    if (result) {
      const code = result.getText();
      stopHistScanner();
      const input = document.getElementById('hist-filter-producto');
      if (input) { input.value = code; renderHistorial(); }
    }
  });
  const histVideo = document.getElementById('hist-scanner-video');
  if (histVideo.srcObject) {
    const track = histVideo.srcObject.getVideoTracks()[0];
    if (track) {
      const caps = track.getCapabilities?.() || {};
      applyTorchPreference(track, 'hist-torch-btn');
    }
  }
}

function stopHistScanner() {
  if (!histScannerActive) return;
  histScannerActive = false;
  if (_histCodeReader) { _histCodeReader.reset(); _histCodeReader = null; }
  const video = document.getElementById('hist-scanner-video');
  if (video?.srcObject) { video.srcObject.getTracks().forEach(t => t.stop()); video.srcObject = null; }
  const container = document.getElementById('hist-scanner-container');
  container.classList.remove('scanner-open');
  container.classList.add('hidden');
  document.getElementById('hist-scan-btn').textContent = 'Escanear';
  const histTorchBtn = document.getElementById('hist-torch-btn');
  histTorchBtn.classList.add('hidden');
  histTorchBtn.dataset.torchOn = 'false';
  histTorchBtn.classList.remove('torch-active');
}

// ── Historial ─────────────────────────────────────────────────────────────
let _historialRows = [];

let _histSemana = '';

async function loadHistorial() {
  const resumenWrap = document.getElementById('historial-resumen');
  const tablaWrap = document.getElementById('historial-tabla-wrap');
  const semBtn = document.getElementById('hist-semana-btn');
  const semOptions = document.getElementById('hist-semana-options');
  const usuSel = document.getElementById('hist-filter-usuario');

  resumenWrap.innerHTML = '<p class="loading">Cargando...</p>';
  tablaWrap.innerHTML = '';

  // Cargar semanas para el dropdown
  try {
    const semanas = await api.getSemanas();
    if (semanas.length) {
      // Preseleccionar la semana activa del pick tab si está disponible
      const pre = semanaActual && semanas.find((s) => s.nombre === semanaActual) ? semanaActual : semanas[0].nombre;
      _histSemana = pre;
      semBtn.textContent = `${_histSemana} ▾`;
      semOptions.innerHTML = semanas.map((s) =>
        `<button class="chip-reparto${s.nombre === _histSemana ? ' active' : ''}" data-semana="${s.nombre}">${s.nombre}</button>`
      ).join('');
    } else {
      _histSemana = '';
      semBtn.textContent = 'Sin semanas ▾';
      semOptions.innerHTML = '';
    }
  } catch (_) {
    _histSemana = '';
    semBtn.textContent = 'Error ▾';
  }

  // Cargar todos los usuarios para el selector (una sola vez)
  try {
    const users = await api.getUsers();
    usuSel.innerHTML = '<option value="">Todos los usuarios</option>' +
      users.map((u) => `<option value="${u.username}">${u.username}</option>`).join('');
  } catch (_) {}

  async function fetchYRender() {
    resumenWrap.innerHTML = '<p class="loading">Cargando...</p>';
    tablaWrap.innerHTML = '';
    try {
      _historialRows = await api.getHistorial(_histSemana);
      renderHistorial();
    } catch (err) {
      resumenWrap.innerHTML = `<p class="error-msg">${err.message}</p>`;
    }
  }

  semOptions.addEventListener('click', (e) => {
    const opt = e.target.closest('[data-semana]');
    if (!opt) return;
    _histSemana = opt.dataset.semana;
    semBtn.textContent = `${_histSemana} ▾`;
    document.getElementById('hist-semana-dropdown').classList.add('hidden');
    semOptions.querySelectorAll('[data-semana]').forEach(b => b.classList.remove('active'));
    opt.classList.add('active');
    fetchYRender();
  });

  semBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    document.getElementById('hist-semana-dropdown').classList.toggle('hidden');
  });

  document.getElementById('hist-filter-producto').oninput = renderHistorial;
  usuSel.onchange = renderHistorial;
  document.getElementById('historial-solo-errores').onchange = renderHistorial;

  await fetchYRender();
}

function renderHistorial() {
  const resumenWrap = document.getElementById('historial-resumen');
  const tablaWrap = document.getElementById('historial-tabla-wrap');
  const soloErrores = document.getElementById('historial-solo-errores')?.checked;
  const filtroProd = (document.getElementById('hist-filter-producto')?.value || '').toLowerCase();
  const filtroUser = document.getElementById('hist-filter-usuario')?.value || '';
  const esc = (s) => (s || '—').replace(/</g, '&lt;');

  // Resumen por usuario (sobre todos los datos, sin filtro)
  const porUsuario = {};
  _historialRows.forEach((r) => {
    const u = r.updated_by || '?';
    if (!porUsuario[u]) porUsuario[u] = { completados: 0, incompletos: 0 };
    if (r.estado?.startsWith('completado')) porUsuario[u].completados++;
    else porUsuario[u].incompletos++;
  });

  if (!_historialRows.length) {
    resumenWrap.innerHTML = '<p class="muted-text">Sin actividad registrada. Los artículos aparecen aquí la primera vez que un operario registra una cantidad.</p>';
    tablaWrap.innerHTML = '';
    return;
  }

  resumenWrap.innerHTML = `
    <div class="historial-chips-wrap">
      ${Object.entries(porUsuario).map(([u, d]) => `
        <div class="historial-user-chip">
          <span class="historial-user-name">${esc(u)}</span>
          <span class="historial-stat ok">${d.completados} ✓</span>
          ${d.incompletos ? `<span class="historial-stat err">${d.incompletos} incompletos</span>` : ''}
        </div>
      `).join('')}
    </div>
  `;

  // Aplicar filtros a la tabla
  const filtrados = _historialRows.filter((r) => {
    if (soloErrores && r.estado?.startsWith('completado')) return false;
    if (filtroUser && r.updated_by !== filtroUser) return false;
    if (filtroProd) {
      const hayMatch = (r.cod_art || '').toLowerCase().includes(filtroProd) ||
                       (r.descrip || '').toLowerCase().includes(filtroProd);
      if (!hayMatch) return false;
    }
    return true;
  });

  if (!filtrados.length) {
    tablaWrap.innerHTML = '<p class="muted-text" style="margin-top:12px">Sin resultados para los filtros aplicados.</p>';
    return;
  }

  tablaWrap.innerHTML = `
    <div class="table-wrap" style="margin-top:8px">
      <table class="clientes-table">
        <thead>
          <tr>
            <th>Artículo</th>
            <th>Cliente</th>
            <th>Req.</th>
            <th>Entregado</th>
            <th>Usuario</th>
            <th>Fecha y hora</th>
          </tr>
        </thead>
        <tbody>
          ${filtrados.map((r) => {
            const completo = r.estado?.startsWith('completado');
            const dt = r.updated_at ? new Date(r.updated_at) : null;
            const fecha = dt
              ? dt.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' }) +
                ' ' + dt.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })
              : '—';
            return `<tr class="${completo ? '' : 'historial-row-error'}">
              <td title="${esc(r.descrip)}">${esc(r.cod_art)}<br><small>${esc(r.descrip?.slice(0, 30))}${(r.descrip?.length > 30) ? '…' : ''}</small></td>
              <td>${esc(r.nombre)}</td>
              <td>${r.uni ?? '—'}</td>
              <td><strong>${r.cantidad_entregada ?? 0}</strong> uni</td>
              <td><strong>${esc(r.updated_by)}</strong></td>
              <td style="white-space:nowrap;font-size:12px">${fecha}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

// ── Asignaciones admin ────────────────────────────────────────────────────
async function loadAsignaciones() {
  const sel = document.getElementById('reparto-semana-sel');
  const wrap = document.getElementById('reparto-asignaciones-wrap');
  wrap.innerHTML = '<p class="loading">Cargando...</p>';
  try {
    const [semanas, repartos, users] = await Promise.all([
      api.getSemanasAdmin(),  // solo semanas del mayorista activo
      api.getRepartos(),
      api.getUsers(),
    ]);
    sel.innerHTML = semanas.length
      ? semanas.map((s) => `<option value="${s.nombre}">${s.nombre}</option>`).join('')
      : '<option value="">Sin semanas cargadas</option>';
    if (semanaActual && semanas.find((s) => s.nombre === semanaActual)) sel.value = semanaActual;
    await renderAsignaciones(repartos, users, sel.value);
    sel.onchange = () => renderAsignaciones(repartos, users, sel.value);
  } catch (err) {
    wrap.innerHTML = `<p class="error-msg">${err.message}</p>`;
  }
}

async function renderAsignaciones(repartos, users, semana) {
  const wrap = document.getElementById('reparto-asignaciones-wrap');
  if (!semana) { wrap.innerHTML = '<p class="muted-text">No hay semanas disponibles.</p>'; return; }
  wrap.innerHTML = '<p class="loading">Cargando asignaciones...</p>';
  try {
    const asignaciones = await api.getAsignaciones(semana);
    const esc = s => (s || '').replace(/</g, '&lt;');
    const asigPorReparto = {};
    asignaciones.forEach(a => {
      if (!asigPorReparto[a.reparto]) asigPorReparto[a.reparto] = [];
      asigPorReparto[a.reparto].push({ id: a.id, user_id: a.user_id, username: a.username });
    });

    wrap.innerHTML = `
      <table class="clientes-table" style="margin-top:12px">
        <thead><tr><th>Reparto</th><th>Responsables</th><th></th></tr></thead>
        <tbody>
          ${repartos.map((r) => {
            const asigs = asigPorReparto[r.nombre] || [];
            const nombres = asigs.length ? asigs.map(a => esc(a.username)).join(', ') : '<span style="color:var(--muted)">Sin asignar</span>';
            return `<tr data-reparto="${esc(r.nombre)}" style="cursor:pointer">
              <td><strong>${esc(r.nombre)}</strong></td>
              <td class="reparto-nombres-cell">${nombres}</td>
              <td style="white-space:nowrap">
                <button class="btn-edit reparto-editar-btn" data-reparto="${esc(r.nombre)}">✏ Editar</button>
              </td>
            </tr>
            <tr class="reparto-dropdown-row hidden" data-reparto="${esc(r.nombre)}">
              <td colspan="3" style="padding:0">
                <div class="reparto-dropdown-panel" style="padding:12px 16px;background:var(--surface);border-top:1px solid var(--border)">
                  <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px">
                    ${users.map(u => {
                      const asig = asigs.find(a => a.user_id === u.id);
                      return `<label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;padding:4px 8px;border-radius:6px;border:1px solid var(--border)">
                        <input type="checkbox" class="reparto-user-cb"
                               data-reparto="${esc(r.nombre)}"
                               data-userid="${u.id}"
                               data-asigid="${asig ? asig.id : ''}"
                               ${asig ? 'checked' : ''} />
                        ${esc(u.username)}
                      </label>`;
                    }).join('')}
                  </div>
                  <div style="display:flex;align-items:center;gap:10px">
                    <button class="btn-primary reparto-guardar-btn" data-reparto="${esc(r.nombre)}" style="padding:6px 16px">Guardar</button>
                    <button class="btn-secondary reparto-cancelar-btn" data-reparto="${esc(r.nombre)}" style="padding:6px 12px">Cancelar</button>
                  </div>
                </div>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    `;

    // Abrir/cerrar dropdown por reparto
    wrap.onclick = async (e) => {
      const editBtn = e.target.closest('.reparto-editar-btn');
      const cancelBtn = e.target.closest('.reparto-cancelar-btn');
      const guardarBtn = e.target.closest('.reparto-guardar-btn');

      // Click en la fila principal (no en el dropdown ni en sus botones)
      const mainRow = !editBtn && !cancelBtn && !guardarBtn
        && e.target.closest('tr[data-reparto]:not(.reparto-dropdown-row)');

      const trigger = editBtn || mainRow;
      if (trigger) {
        const reparto = trigger.dataset?.reparto || trigger.closest('tr')?.dataset?.reparto;
        if (!reparto) return;
        // Cerrar otros dropdowns abiertos
        wrap.querySelectorAll('.reparto-dropdown-row').forEach(row => {
          if (row.dataset.reparto !== reparto) row.classList.add('hidden');
        });
        const dropRow = wrap.querySelector(`.reparto-dropdown-row[data-reparto="${reparto}"]`);
        dropRow?.classList.toggle('hidden');
      }

      if (cancelBtn) {
        const reparto = cancelBtn.dataset.reparto;
        wrap.querySelector(`.reparto-dropdown-row[data-reparto="${reparto}"]`)?.classList.add('hidden');
      }

      if (guardarBtn) {
        const reparto = guardarBtn.dataset.reparto;
        guardarBtn.disabled = true;
        guardarBtn.textContent = '...';
        try {
          const cbs = wrap.querySelectorAll(`.reparto-user-cb[data-reparto="${reparto}"]`);
          const ops = [];
          cbs.forEach(cb => {
            const userId = parseInt(cb.dataset.userid);
            const asigId = cb.dataset.asigid ? parseInt(cb.dataset.asigid) : null;
            if (cb.checked && !asigId) ops.push(api.setAsignacion({ semana, reparto, user_id: userId }));
            else if (!cb.checked && asigId) ops.push(api.deleteAsignacion(asigId));
          });
          await Promise.all(ops);
          // Recargar asignaciones de este reparto y actualizar la celda de nombres
          const newAsigs = await api.getAsignaciones(semana);
          const newAsigReparto = newAsigs.filter(a => a.reparto === reparto);
          const nuevosNombres = newAsigReparto.length ? newAsigReparto.map(a => esc(a.username)).join(', ') : '<span style="color:var(--muted)">Sin asignar</span>';
          const nombreCell = wrap.querySelector(`tr[data-reparto="${reparto}"] .reparto-nombres-cell`);
          if (nombreCell) nombreCell.innerHTML = nuevosNombres;
          // Actualizar data-asigid en los checkboxes
          cbs.forEach(cb => {
            const uid = parseInt(cb.dataset.userid);
            const match = newAsigReparto.find(a => a.user_id === uid);
            cb.dataset.asigid = match ? match.id : '';
            cb.checked = !!match;
          });
          wrap.querySelector(`.reparto-dropdown-row[data-reparto="${reparto}"]`)?.classList.add('hidden');
          showToast('Asignación guardada', 'success');
        } catch (err) {
          showToast(err.message, 'error');
        } finally {
          guardarBtn.disabled = false;
          guardarBtn.textContent = 'Guardar';
        }
      }
    };
  } catch (err) {
    wrap.innerHTML = `<p class="error-msg">${err.message}</p>`;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// NOVEDADES
// ══════════════════════════════════════════════════════════════════════════════

let _novSemana = '';
let _novItem = null;
let _novCliente = null;
let _novTipo = '';
let _novBultos = 0;
let _novUnidades = 0;
let _novScannerActive = false;
let _novCodeReader = null;
let _novClientes = [];
let _novClientesFiltrados = [];
let _novDescripTimer = null;
let _novMaxUni = null;  // máximo de unidades según lo pedido por el cliente

async function initNovedades() {
  const btn = document.getElementById('nov-semana-btn');
  const optionsContainer = document.getElementById('nov-semana-options');
  try {
    const semanas = await api.getSemanas();
    if (!semanas.length) {
      _novSemana = '';
      btn.textContent = 'Sin semanas ▾';
      optionsContainer.innerHTML = '';
    } else {
      _novSemana = semanas[0].nombre;
      btn.textContent = `${_novSemana} ▾`;
      optionsContainer.innerHTML = semanas.map(s =>
        `<button class="chip-reparto${s.nombre === _novSemana ? ' active' : ''}" data-semana="${s.nombre}">${s.nombre}</button>`
      ).join('');
    }
  } catch {
    _novSemana = '';
    btn.textContent = 'Error ▾';
  }
  try { _novClientes = await api.getClientes(); } catch { _novClientes = []; }
  _resetNovForm();
  await loadNovedades();
}

document.getElementById('nov-semana-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('nov-semana-dropdown').classList.toggle('hidden');
});

document.getElementById('nov-semana-options').addEventListener('click', (e) => {
  const opt = e.target.closest('[data-semana]');
  if (!opt) return;
  _novSemana = opt.dataset.semana;
  document.getElementById('nov-semana-btn').textContent = `${_novSemana} ▾`;
  document.getElementById('nov-semana-dropdown').classList.add('hidden');
  document.querySelectorAll('#nov-semana-options [data-semana]').forEach(b => b.classList.remove('active'));
  opt.classList.add('active');
  loadNovedades();
});

async function loadNovedades() {
  const container = document.getElementById('nov-items');
  const exportBar = document.getElementById('nov-export-bar');
  if (!_novSemana) { container.innerHTML = ''; exportBar.classList.add('hidden'); return; }
  try {
    const items = await api.novGetItems(_novSemana);
    renderNovedades(items);
  } catch (err) {
    container.innerHTML = `<p class="error-msg">${err.message}</p>`;
  }
}

function renderNovedades(items) {
  const container = document.getElementById('nov-items');
  const exportBar = document.getElementById('nov-export-bar');
  const exportLink = document.getElementById('nov-export-link');
  if (!items.length) {
    container.innerHTML = '<p style="color:var(--muted);font-size:13px;padding:8px 0">No hay novedades para esta semana.</p>';
    exportBar.classList.add('hidden');
    return;
  }
  exportBar.classList.remove('hidden');
  exportLink.href = api.novExportUrl(_novSemana);
  exportLink.download = `novedades_${getMayorista()}_${_novSemana.replace(/\s/g, '_')}.xlsx`;
  const tipoBadge = { devolucion: 'Devolución', faltante: 'Faltante', cambio: 'Cambio' };
  const tipoColor = { devolucion: 'var(--orange)', faltante: 'var(--red)', cambio: '#7eb8ff' };
  container.innerHTML = items.map(item => {
    const uxb = item.uxb || 0;
    const uniTotal = (item.bultos || 0) * uxb + (item.unidades || 0);
    const cantStr = uxb > 1
      ? `${item.bultos} bul × ${uxb} + ${item.unidades} uni (${uniTotal} total)`
      : `${item.unidades} uni`;
    return `<div class="nov-item" data-id="${item.id}">
      <div class="nov-item-top">
        <span class="nov-tipo-badge" style="color:${tipoColor[item.tipo] || 'var(--muted)'}">
          ${tipoBadge[item.tipo] || item.tipo}
        </span>
        <span class="nov-item-cliente">${item.cliente_nombre || item.cliente || '—'}</span>
        <button class="sob-item-remove nov-del-btn" data-id="${item.id}">✕</button>
      </div>
      <div class="nov-item-descrip">${item.descrip || item.cod_art || '—'}</div>
      <div class="nov-item-meta">
        <span class="nov-item-cant">${cantStr}</span>
        ${item.observaciones ? `<span class="nov-item-obs">${item.observaciones}</span>` : ''}
      </div>
    </div>`;
  }).join('');
  container.querySelectorAll('.nov-del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!await confirmar('¿Eliminar esta novedad?', 'Sí, eliminar')) return;
      try { await api.novDeleteItem(parseInt(btn.dataset.id)); await loadNovedades(); }
      catch (err) { showToast(err.message, 'error'); }
    });
  });
}

// ── Búsqueda de ítem ────────────────────────────────────────────────────────

document.getElementById('nov-barcode-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') novBuscarPorCodigo(e.target.value.trim());
});

async function novBuscarPorCodigo(cod) {
  if (!cod) return;
  document.getElementById('nov-barcode-input').value = '';
  try {
    const res = await api.novLookup(cod, _novSemana);
    if (res.found) {
      _setNovItem({ cod_bar: cod, cod_art: res.cod_art, descrip: res.descrip, uxb: res.uxb || 0 });
    } else {
      await confirmar(
        `Este artículo no está en el pick de la semana "${_novSemana || 'actual'}". Para registrar una novedad usá el botón ✏️ Manual.`,
        'Entendido', false
      );
    }
  } catch { showToast('Error en la búsqueda', 'error'); }
}

document.getElementById('nov-descrip-input').addEventListener('input', (e) => {
  clearTimeout(_novDescripTimer);
  const q = e.target.value.trim();
  const results = document.getElementById('nov-descrip-results');
  if (q.length < 2) { results.classList.add('hidden'); return; }
  _novDescripTimer = setTimeout(async () => {
    try {
      const items = await api.novSearch(q, _novSemana);
      if (!items.length) {
        results.innerHTML = '<div class="descrip-item-empty">Sin resultados</div>';
      } else {
        results.innerHTML = items.map(i => `
          <div class="descrip-item" data-bar="${i.cod_bar||''}" data-art="${i.cod_art||''}"
               data-descrip="${(i.descrip||'').replace(/"/g,'&quot;')}" data-uxb="${i.uxb||0}">
            <span class="descrip-item-name">${i.descrip||''}</span>
            <span class="descrip-item-code">${i.cod_art||''}</span>
          </div>`).join('');
        results.querySelectorAll('.descrip-item').forEach(el => {
          el.addEventListener('click', () => {
            document.getElementById('nov-descrip-input').value = '';
            results.classList.add('hidden');
            _setNovItem({ cod_bar: el.dataset.bar||null, cod_art: el.dataset.art||null, descrip: el.dataset.descrip||null, uxb: parseInt(el.dataset.uxb)||0 });
          });
        });
      }
      results.classList.remove('hidden');
    } catch { results.classList.add('hidden'); }
  }, 300);
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#nov-descrip-input') && !e.target.closest('#nov-descrip-results'))
    document.getElementById('nov-descrip-results')?.classList.add('hidden');
});

async function _setNovItem(item) {
  _novItem = item;
  _novClientesFiltrados = [];
  _novMaxUni = null;
  document.getElementById('nov-barcode-input').value = '';
  document.getElementById('nov-item-cod').textContent = item.cod_art || item.cod_bar || '';
  document.getElementById('nov-item-descrip').textContent = item.descrip || '';
  document.getElementById('nov-item-selected').classList.remove('hidden');
  const clienteBtn = document.getElementById('nov-cliente-btn');
  clienteBtn.disabled = false;
  clienteBtn.textContent = 'Elegir cliente...';
  // Para ítems manuales, usar siempre la lista completa de clientes
  if (!item.manual) {
    try {
      let picks = [];
      if (item.cod_art) picks = await api.getByCodArt(item.cod_art, _novSemana).catch(() => []);
      if (!picks.length && item.cod_bar) picks = await api.getByBarcode(item.cod_bar, _novSemana).catch(() => []);
      const seen = new Set();
      _novClientesFiltrados = picks
        .filter(p => p.nombre && !seen.has(p.nombre) && seen.add(p.nombre))
        .map(p => ({ nombre: p.nombre, id_yaguar: p.cliente, uni: p.uni, bul: p.bul, uxb: p.uxb }));
    } catch {
      _novClientesFiltrados = _novClientes;
    }
  }
  // Si ya hay cliente seleccionado, actualizar el máximo
  if (_novCliente) _novActualizarMax();
}
document.getElementById('nov-item-clear').addEventListener('click', () => {
  _novItem = null;
  _novClientesFiltrados = [];
  document.getElementById('nov-item-selected').classList.add('hidden');
  document.getElementById('nov-barcode-input').value = '';
  // Deshabilitar cliente y limpiar si estaba seleccionado
  const clienteBtn = document.getElementById('nov-cliente-btn');
  clienteBtn.disabled = true;
  clienteBtn.textContent = 'Elegir cliente (primero seleccioná un artículo)';
  _novCliente = null;
  document.getElementById('nov-cliente-selected').classList.add('hidden');
  document.getElementById('nov-cliente-btn').classList.remove('hidden');
});

// ── Fallback: artículo no encontrado en catálogo ─────────────────────────────

let _fallbackArtCallback = null;

function _abrirFallbackModal(codBar, onConfirm) {
  document.getElementById('fallback-art-codbar').value = codBar || '';
  document.getElementById('fallback-art-descrip').value = '';
  document.getElementById('fallback-art-uxb').value = '';
  _fallbackArtCallback = onConfirm;
  document.getElementById('fallback-art-modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('fallback-art-descrip').focus(), 50);
}

function _cerrarFallbackModal() {
  document.getElementById('fallback-art-modal').classList.add('hidden');
  _fallbackArtCallback = null;
}

document.getElementById('fallback-art-cancel').addEventListener('click', _cerrarFallbackModal);
document.getElementById('fallback-art-modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) _cerrarFallbackModal();
});

document.getElementById('fallback-art-confirm').addEventListener('click', async () => {
  const descrip = document.getElementById('fallback-art-descrip').value.trim();
  if (!descrip) { showToast('La descripción es obligatoria', 'error'); return; }
  const uxb = parseInt(document.getElementById('fallback-art-uxb').value);
  if (!uxb || uxb <= 0) { showToast('El UxB es obligatorio', 'error'); return; }
  const codBar = document.getElementById('fallback-art-codbar').value || null;
  const cb = _fallbackArtCallback;
  _cerrarFallbackModal();
  // Guardar en articulos_catalogo del mayorista actual
  if (codBar) {
    try { await api.crearArticuloManual({ cod_bar: codBar, descrip, uxb }); } catch {}
  }
  if (cb) cb({ cod_bar: codBar, cod_art: codBar, descrip, uxb, precio_unit: null });
});

// ── Buscar artículo por catálogo (reemplaza ingreso manual libre) ─────────────

let _novManualTimer = null;
let _novManualItems = [];
let _novManualScannerActive = false;
let _novManualCodeReader = null;

function _openNovManualModal() {
  document.getElementById('nov-manual-search').value = '';
  document.getElementById('nov-manual-results').innerHTML = '';
  _novManualItems = [];
  document.getElementById('nov-manual-modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('nov-manual-search').focus(), 50);
}

function _closeNovManualModal() {
  stopNovManualScanner();
  document.getElementById('nov-manual-modal').classList.add('hidden');
}

async function startNovManualScanner() {
  const container = document.getElementById('nov-manual-scanner-container');
  container.classList.remove('hidden');
  document.getElementById('nov-manual-scan-btn').textContent = 'Detener';
  _novManualScannerActive = true;
  const hints = new Map([[2, [ZXing.BarcodeFormat.EAN_13, ZXing.BarcodeFormat.EAN_8,
                              ZXing.BarcodeFormat.EAN_14, ZXing.BarcodeFormat.CODE_128,
                              ZXing.BarcodeFormat.CODE_39, ZXing.BarcodeFormat.UPC_A]], [3, true]]);
  _novManualCodeReader = new ZXing.BrowserMultiFormatReader(hints, 0);
  const targetId = localStorage.getItem('pick_last_camera') ?? null;
  await _novManualCodeReader.decodeFromVideoDevice(targetId, 'nov-manual-scanner-video', async (result) => {
    if (result) { stopNovManualScanner(); await _novManualBuscarPorBarcode(result.getText()); }
  });
}

function stopNovManualScanner() {
  if (!_novManualScannerActive) return;
  _novManualScannerActive = false;
  if (_novManualCodeReader) { _novManualCodeReader.reset(); _novManualCodeReader = null; }
  const video = document.getElementById('nov-manual-scanner-video');
  if (video?.srcObject) { video.srcObject.getTracks().forEach(t => t.stop()); video.srcObject = null; }
  document.getElementById('nov-manual-scanner-container').classList.add('hidden');
  document.getElementById('nov-manual-scan-btn').textContent = 'Escanear';
}

async function _novManualBuscarPorBarcode(barcode) {
  try {
    const items = await api.getArticulos(barcode, 10);
    const matches = items.filter(i => i.cod_bar === barcode || i.cod_bar_bulto === barcode);
    const lista = matches.length ? matches : items;
    if (!lista.length) { showToast('Artículo no encontrado en el catálogo', 'error'); return; }
    if (lista.length === 1) {
      const item = lista[0];
      _closeNovManualModal();
      await _setNovItem({ cod_art: item.cod_art, cod_bar: item.cod_bar || null,
        descrip: item.descrip || null, uxb: item.uxb || 0,
        precio_manual: item.precio_con_iva || null, manual: true });
      return;
    }
    _novManualItems = lista;
    const fmt = (v) => v != null ? '$' + Number(v).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
    document.getElementById('nov-manual-results').innerHTML = lista.map((item, idx) => `
      <div class="descrip-item" data-idx="${idx}" style="cursor:pointer">
        <div style="font-size:13px;font-weight:600">${item.descrip || '—'}</div>
        <div style="font-size:11px;color:var(--muted)">${item.cod_art}${item.uxb != null ? ' · UxB: ' + item.uxb : ''}${item.precio_con_iva != null ? ' · ' + fmt(item.precio_con_iva) : ''}</div>
      </div>`).join('');
  } catch { showToast('Error al buscar el artículo', 'error'); }
}

document.getElementById('nov-manual-scan-btn').addEventListener('click', async () => {
  if (_novManualScannerActive) stopNovManualScanner(); else await startNovManualScanner();
});

document.getElementById('nov-manual-btn').addEventListener('click', _openNovManualModal);
document.getElementById('nov-manual-cancel').addEventListener('click', _closeNovManualModal);
document.getElementById('nov-manual-modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) _closeNovManualModal();
});

document.getElementById('nov-manual-search').addEventListener('input', (e) => {
  clearTimeout(_novManualTimer);
  const q = e.target.value.trim();
  const results = document.getElementById('nov-manual-results');
  if (q.length < 2) { results.innerHTML = ''; return; }
  _novManualTimer = setTimeout(async () => {
    try {
      const items = await api.getArticulos(q, 50);
      _novManualItems = items;
      if (!items.length) {
        results.innerHTML = '<div class="descrip-item-empty">Sin resultados</div>';
        return;
      }
      const fmt = (v) => v != null ? '$' + Number(v).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
      results.innerHTML = items.map((item, idx) => `
        <div class="descrip-item" data-idx="${idx}" style="cursor:pointer">
          <div style="font-size:13px;font-weight:600">${item.descrip || '—'}</div>
          <div style="font-size:11px;color:var(--muted)">${item.cod_art}${item.uxb != null ? ' · UxB: ' + item.uxb : ''}${item.precio_con_iva != null ? ' · ' + fmt(item.precio_con_iva) : ''}</div>
        </div>
      `).join('');
    } catch { }
  }, 250);
});

document.getElementById('nov-manual-results').addEventListener('click', async (e) => {
  const el = e.target.closest('[data-idx]');
  if (!el) return;
  const item = _novManualItems[parseInt(el.dataset.idx)];
  if (!item) return;
  _closeNovManualModal();
  await _setNovItem({
    cod_art: item.cod_art,
    cod_bar: item.cod_bar || null,
    descrip: item.descrip || null,
    uxb: item.uxb || 0,
    precio_manual: item.precio_con_iva || null,
    manual: true,
  });

});

// ── Scanner ──────────────────────────────────────────────────────────────────

document.getElementById('nov-scan-btn').addEventListener('click', async () => {
  if (_novScannerActive) stopNovScanner(); else await startNovScanner();
});

async function startNovScanner(deviceId = null) {
  const container = document.getElementById('nov-scanner-container');
  container.classList.remove('hidden');
  container.classList.add('scanner-open');
  document.getElementById('nov-scan-btn').textContent = 'Detener';
  _novScannerActive = true;
  const hints = new Map([[2, [ZXing.BarcodeFormat.EAN_13, ZXing.BarcodeFormat.EAN_8, ZXing.BarcodeFormat.CODE_128, ZXing.BarcodeFormat.CODE_39, ZXing.BarcodeFormat.UPC_A]], [3, true]]);
  _novCodeReader = new ZXing.BrowserMultiFormatReader(hints, 0);
  const targetId = deviceId ?? localStorage.getItem('pick_last_camera') ?? null;
  await _novCodeReader.decodeFromVideoDevice(targetId, 'nov-scanner-video', async (result) => {
    if (result) { stopNovScanner(); await novBuscarPorCodigo(result.getText()); }
  });
  const novVideo = document.getElementById('nov-scanner-video');
  if (novVideo.srcObject) {
    const track = novVideo.srcObject.getVideoTracks()[0];
    if (track) {
      const caps = track.getCapabilities?.() || {};
      applyTorchPreference(track, 'nov-torch-btn');
    }
  }
}

function stopNovScanner() {
  if (!_novScannerActive) return;
  _novScannerActive = false;
  if (_novCodeReader) { _novCodeReader.reset(); _novCodeReader = null; }
  const video = document.getElementById('nov-scanner-video');
  if (video?.srcObject) { video.srcObject.getTracks().forEach(t => t.stop()); video.srcObject = null; }
  document.getElementById('nov-scanner-container').classList.remove('scanner-open');
  document.getElementById('nov-scanner-container').classList.add('hidden');
  document.getElementById('nov-scan-btn').textContent = '📷';
  const novTorchBtn = document.getElementById('nov-torch-btn');
  novTorchBtn.classList.add('hidden');
  novTorchBtn.dataset.torchOn = 'false';
  novTorchBtn.classList.remove('torch-active');
}

// ── Slide de cliente ─────────────────────────────────────────────────────────

document.getElementById('nov-cliente-btn').addEventListener('click', openNovClienteSlide);
document.getElementById('nov-cliente-modal-close').addEventListener('click', () => {
  document.getElementById('nov-cliente-modal').classList.add('hidden');
});
document.getElementById('nov-cliente-modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) document.getElementById('nov-cliente-modal').classList.add('hidden');
});
document.getElementById('nov-cliente-search').addEventListener('input', (e) => {
  renderNovClienteList(e.target.value.trim().toLowerCase());
});

function openNovClienteSlide() {
  document.getElementById('nov-cliente-search').value = '';
  renderNovClienteList('');
  document.getElementById('nov-cliente-modal').classList.remove('hidden');
}

function renderNovClienteList(q) {
  const list = document.getElementById('nov-cliente-list');
  const base = (_novItem && _novClientesFiltrados.length) ? _novClientesFiltrados : _novClientes;
  const filtered = q
    ? base.filter(c => (c.nombre||'').toLowerCase().includes(q) || (c.id_yaguar||'').toLowerCase().includes(q))
    : base;
  const esFiltrado = _novItem && _novClientesFiltrados.length > 0;
  const header = esFiltrado
    ? `<p style="padding:10px 16px 4px;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Clientes que pidieron este artículo (${_novClientesFiltrados.length})</p>`
    : '';
  if (!filtered.length) { list.innerHTML = header + '<p style="padding:8px 16px;color:var(--muted);font-size:13px">Sin resultados</p>'; return; }
  list.innerHTML = header + filtered.map(c => `
    <button class="nov-cliente-row" data-cod="${c.id_yaguar||''}" data-nombre="${(c.nombre||'').replace(/"/g,'&quot;')}">
      <span class="nov-cliente-row-nombre">${c.nombre||'—'}</span>
      <span class="nov-cliente-row-cod">${c.id_yaguar||''}</span>
    </button>`).join('');
  list.querySelectorAll('.nov-cliente-row').forEach(btn => {
    btn.addEventListener('click', () => {
      _setNovCliente(btn.dataset.cod, btn.dataset.nombre);
      document.getElementById('nov-cliente-modal').classList.add('hidden');
    });
  });
}

function _novSetSteppers(enabled) {
  document.querySelectorAll('.nov-step-btn').forEach(btn => { btn.disabled = !enabled; });
}

function _setNovCliente(codigo, nombre) {
  _novCliente = { codigo, nombre };
  document.getElementById('nov-cliente-cod').textContent = codigo;
  document.getElementById('nov-cliente-nombre').textContent = nombre;
  document.getElementById('nov-cliente-selected').classList.remove('hidden');
  document.getElementById('nov-cliente-btn').classList.add('hidden');
  _novSetSteppers(true);
  _novActualizarMax();
}
document.getElementById('nov-cliente-clear').addEventListener('click', () => {
  _novCliente = null;
  _novMaxUni = null;
  _novBultos = 0;
  _novUnidades = 0;
  document.getElementById('nov-val-bultos').textContent = '0';
  document.getElementById('nov-val-unidades').textContent = '0';
  document.getElementById('nov-cliente-selected').classList.add('hidden');
  document.getElementById('nov-cliente-btn').classList.remove('hidden');
  document.getElementById('nov-max-hint').classList.add('hidden');
  _novSetSteppers(false);
});

function _novActualizarMax() {
  const hint = document.getElementById('nov-max-hint');
  if (!_novItem || !_novCliente) { _novMaxUni = null; hint.classList.add('hidden'); return; }
  if (_novItem.manual) { _novMaxUni = null; hint.classList.add('hidden'); return; }
  // Buscar en los clientes filtrados (ya tienen los datos del pick)
  const entrada = _novClientesFiltrados.find(c => c.id_yaguar === _novCliente.codigo);
  if (entrada && entrada.uni) {
    _novMaxUni = entrada.uni;
    const uxb = entrada.uxb || 0;
    const bul = entrada.bul || 0;
    const uniSueltas = _novMaxUni - bul * uxb;
    const desc = uxb > 1
      ? `Pedido: ${bul} bul × ${uxb} uni${uniSueltas > 0 ? ` + ${uniSueltas} uni` : ''} = ${_novMaxUni} uni total`
      : `Pedido: ${_novMaxUni} uni`;
    hint.textContent = `Máx → ${desc}`;
    hint.classList.remove('hidden');
  } else {
    _novMaxUni = null;
    hint.classList.add('hidden');
  }
}

// ── Tipo ─────────────────────────────────────────────────────────────────────

document.querySelectorAll('.nov-tipo-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    _novTipo = btn.dataset.tipo;
    document.querySelectorAll('.nov-tipo-btn').forEach(b => b.classList.toggle('active', b.dataset.tipo === _novTipo));
  });
});

// ── Steppers ─────────────────────────────────────────────────────────────────

let _novLongPressTimer = null;

function _novApplyLongPress(btn) {
  const field = btn.dataset.novField;
  const isPlus = btn.classList.contains('btn-step-plus');
  const uxb = _novItem?.uxb || 0;

  if (isPlus && _novMaxUni !== null) {
    // Llenar al máximo posible
    if (field === 'bultos') {
      _novBultos = uxb > 0 ? Math.floor(_novMaxUni / uxb) : 0;
      _novUnidades = uxb > 0 ? _novMaxUni % uxb : _novMaxUni;
      document.getElementById('nov-val-unidades').textContent = _novUnidades;
    } else {
      _novUnidades = Math.max(0, _novMaxUni - _novBultos * uxb);
    }
    document.getElementById('nov-val-bultos').textContent = _novBultos;
    document.getElementById('nov-val-unidades').textContent = _novUnidades;
  } else if (!isPlus) {
    // Llevar a cero
    if (field === 'bultos') { _novBultos = 0; document.getElementById('nov-val-bultos').textContent = '0'; }
    else { _novUnidades = 0; document.getElementById('nov-val-unidades').textContent = '0'; }
  }
}

document.querySelectorAll('.nov-step-btn').forEach(btn => {
  // Long press (400ms)
  const startLong = () => {
    _novLongPressTimer = setTimeout(() => { _novLongPressTimer = null; _novApplyLongPress(btn); }, 400);
  };
  const cancelLong = () => { if (_novLongPressTimer) { clearTimeout(_novLongPressTimer); _novLongPressTimer = null; } };

  btn.addEventListener('mousedown', startLong);
  btn.addEventListener('touchstart', startLong, { passive: true });
  btn.addEventListener('mouseup', cancelLong);
  btn.addEventListener('mouseleave', cancelLong);
  btn.addEventListener('touchend', cancelLong);
  btn.addEventListener('touchcancel', cancelLong);

  // Click normal (paso a paso)
  btn.addEventListener('click', () => {
    if (_novLongPressTimer === null && document.getElementById('nov-val-bultos')) {
      // Si el long press ya se ejecutó, el click es redundante — ignorar
      // (el timer se pone en null cuando se dispara, así que no podemos distinguirlo del cancel)
      // En su lugar simplemente aplicamos el delta normal; el cap lo controla
    }
    const field = btn.dataset.novField;
    const delta = btn.classList.contains('btn-step-plus') ? 1 : -1;
    const uxb = _novItem?.uxb || 0;
    if (field === 'bultos') {
      const nuevo = Math.max(0, _novBultos + delta);
      if (_novMaxUni !== null && nuevo * uxb + _novUnidades > _novMaxUni) return;
      _novBultos = nuevo;
      document.getElementById('nov-val-bultos').textContent = _novBultos;
    } else {
      const nuevo = Math.max(0, _novUnidades + delta);
      if (_novMaxUni !== null && _novBultos * uxb + nuevo > _novMaxUni) return;
      _novUnidades = nuevo;
      document.getElementById('nov-val-unidades').textContent = _novUnidades;
    }
  });
});

// ── Agregar ───────────────────────────────────────────────────────────────────

document.getElementById('nov-agregar-btn').addEventListener('click', async () => {
  if (!_novItem) { showToast('Seleccioná un artículo primero', 'error'); return; }
  if (!_novCliente) { showToast('Seleccioná un cliente primero', 'error'); return; }
  if (!_novTipo) { showToast('Seleccioná el tipo de novedad (Devolución, Faltante o Cambio)', 'error'); return; }
  if (_novBultos === 0 && _novUnidades === 0) { showToast('Ingresá al menos 1 unidad o bulto', 'error'); return; }
  const uxbVal = _novItem.uxb || 0;
  const totalNov = _novBultos * uxbVal + _novUnidades;
  if (_novMaxUni !== null && totalNov > _novMaxUni) {
    showToast(`La cantidad supera lo pedido por el cliente (máx: ${_novMaxUni} uni)`, 'error');
    return;
  }
  try {
    await api.novAddItem({
      semana: _novSemana,
      cod_bar: _novItem.cod_bar,
      cod_art: _novItem.cod_art,
      descrip: _novItem.descrip,
      cliente: _novCliente.codigo,
      cliente_nombre: _novCliente.nombre,
      tipo: _novTipo,
      observaciones: document.getElementById('nov-observaciones').value.trim() || null,
      unidades: _novUnidades,
      bultos: _novBultos,
      uxb: _novItem.uxb || 0,
      precio: _novItem.precio_manual ?? null,
    });
    showToast('Novedad registrada', 'success');
    _resetNovForm();
    await loadNovedades();
  } catch (err) { showToast(err.message, 'error'); }
});

function _resetNovForm() {
  _novItem = null; _novCliente = null; _novTipo = 'devolucion'; _novBultos = 0; _novUnidades = 0; _novMaxUni = null;
  ['nov-barcode-input','nov-descrip-input','nov-observaciones','nov-manual-search'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  _closeNovManualModal();
  document.getElementById('nov-item-selected').classList.add('hidden');
  document.getElementById('nov-cliente-selected').classList.add('hidden');
  const clienteBtn = document.getElementById('nov-cliente-btn');
  clienteBtn.classList.remove('hidden');
  clienteBtn.disabled = true;
  clienteBtn.textContent = 'Elegir cliente (primero seleccioná un artículo)';
  document.getElementById('nov-val-bultos').textContent = '0';
  document.getElementById('nov-val-unidades').textContent = '0';
  document.getElementById('nov-max-hint').classList.add('hidden');
  _novSetSteppers(false);
  _novTipo = '';
  document.querySelectorAll('.nov-tipo-btn').forEach(b => b.classList.remove('active'));
}

document.getElementById('nov-back-btn').addEventListener('click', () => { stopNovScanner(); showHub(); });

// ══════════════════════════════════════════════════════════════════════════════
// ARTÍCULOS CATÁLOGO
// ══════════════════════════════════════════════════════════════════════════════

let _articulosTimer = null;
let _articulosData = [];
let _articulosSortCol = 'descrip';
let _articulosSortDir = 1;

const DETALLE_YAGUAR = [
  { label: 'Código',         field: 'cod_art' },
  { label: 'Barcode',        field: 'cod_bar' },
  { label: 'Fabricante',     field: 'fabricante' },
  { label: 'Unidad medida',  field: 'unidad_medida' },
  { label: '% IVA',          field: 'porc_iva',         money: false, num: true },
  { label: 'Costo',          field: 'precio_costo',     money: true },
  { label: '% Descuento',    field: 'descuento_default',money: false, num: true },
  { label: 'Imp. Monto',     field: 'impuestos_monto',  money: true },
  { label: 'Imp. %',         field: 'impuestos_porc',   money: false, num: true },
  { label: 'Subcategoría',   field: 'subcategoria' },
  { label: 'Stock',          field: 'stock',            money: false, num: true },
  { label: 'Estado',         field: 'estado' },
  { label: 'Observaciones',  field: 'observaciones' },
  { label: 'Folder',         field: 'folder' },
  { label: 'Usrdef 0',       field: 'usrdef_0',         money: false, num: true },
  { label: 'Usrdef 1',       field: 'usrdef_1',         money: false, num: true },
  { label: 'Usrdef 6',       field: 'usrdef_6',         money: false, num: true },
];

const DETALLE_DIARCO = [
  { label: 'Código',         field: 'cod_art' },
  { label: 'Barcode unidad', field: 'cod_bar' },
  { label: 'Barcode bulto',  field: 'cod_bar_bulto' },
  { label: 'Tipo unidad',    field: 'tipo_unidad' },
  { label: 'Costo',          field: 'precio_costo',     money: true },
  { label: 'P. Mayorista',   field: 'precio_mayorista', money: true },
  { label: 'Familia',        field: 'familia' },
  { label: 'Subcategoría',   field: 'subcategoria' },
  { label: 'Estado cat.',    field: 'tipo_estado' },
  { label: 'Stock',          field: 'stock',            money: false, num: true },
];

function _abrirDetalleArticulo(item) {
  const fmt = (v) => v != null ? Number(v).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : null;
  const modal = document.getElementById('art-detalle-modal');
  document.getElementById('art-detalle-title').textContent = item.descrip || item.cod_art;
  const body = document.getElementById('art-detalle-body');

  // Siempre muestra precio y uxb al tope
  const rows = [
    { label: 'Precio c/IVA', val: item.precio_con_iva != null ? `$${fmt(item.precio_con_iva)}` : '—' },
    { label: 'UxB',          val: item.uxb != null ? item.uxb : '—' },
  ];

  const detalle = getMayorista() === 'yaguar' ? DETALLE_YAGUAR : DETALLE_DIARCO;
  for (const d of detalle) {
    const v = item[d.field];
    if (v == null || v === '') continue;
    let display;
    if (d.money) display = `$${fmt(v)}`;
    else if (d.num) display = fmt(v);
    else display = String(v);
    rows.push({ label: d.label, val: display });
  }

  body.innerHTML = rows.map(r => `
    <div>
      <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;margin-bottom:2px">${r.label}</div>
      <div style="font-size:13px;font-weight:600">${r.val}</div>
    </div>
  `).join('');

  modal.classList.remove('hidden');
}

const ART_HEADERS = [
  { label: 'Código',       field: 'cod_art',       align: 'left'  },
  { label: 'Descripción',  field: 'descrip',        align: 'left'  },
  { label: 'UxB',          field: 'uxb',            align: 'center' },
  { label: 'Precio c/IVA', field: 'precio_con_iva', align: 'right' },
];

function renderArticulos() {
  const tbody = document.getElementById('articulos-tbody');
  const thead = document.getElementById('articulos-thead');

  // Headers con indicador de orden
  thead.innerHTML = `<tr>${ART_HEADERS.map(h => {
    const arrow = h.field === _articulosSortCol ? (_articulosSortDir === 1 ? ' ▲' : ' ▼') : '';
    return `<th data-sort="${h.field}" data-label="${h.label}" style="cursor:pointer;user-select:none;text-align:${h.align}">${h.label}${arrow}</th>`;
  }).join('')}</tr>`;

  const fmt = (v) => v != null ? Number(v).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';

  // Ordenar
  const data = [..._articulosData].sort((a, b) => {
    let va = a[_articulosSortCol], vb = b[_articulosSortCol];
    const na = parseFloat(va), nb = parseFloat(vb);
    if (!isNaN(na) && !isNaN(nb)) {
      va = na; vb = nb;
    } else {
      va = (va ?? '').toString().toLowerCase();
      vb = (vb ?? '').toString().toLowerCase();
    }
    if (va < vb) return -_articulosSortDir;
    if (va > vb) return  _articulosSortDir;
    return 0;
  });

  tbody.innerHTML = data.map((item, idx) => `
    <tr data-idx="${_articulosData.indexOf(item)}" style="cursor:pointer">
      <td>${item.cod_art ?? '—'}</td>
      <td>${item.descrip ?? '—'}</td>
      <td style="text-align:center">${item.uxb ?? '—'}</td>
      <td style="text-align:right">${item.precio_con_iva != null ? '$' + fmt(item.precio_con_iva) : '—'}</td>
    </tr>
  `).join('');
}

async function loadArticulos(q) {
  const tbody = document.getElementById('articulos-tbody');
  const thead = document.getElementById('articulos-thead');
  const count = document.getElementById('articulos-count');
  const exportBtn = document.getElementById('btn-exportar-articulos');

  tbody.innerHTML = '<tr><td colspan="4" class="loading">Cargando...</td></tr>';
  thead.innerHTML = '';

  try {
    const items = await api.getArticulos(q || '', 20000);
    _articulosData = items;

    if (!items.length) {
      thead.innerHTML = '';
      tbody.innerHTML = `<tr><td colspan="4" class="muted-text" style="text-align:center;padding:16px">${q ? 'Sin resultados para "' + q + '"' : 'Sin artículos cargados. Importá una semana primero.'}</td></tr>`;
      count.textContent = '';
      exportBtn.classList.add('hidden');
      return;
    }

    renderArticulos();
    count.textContent = `${items.length} artículo${items.length !== 1 ? 's' : ''}${q ? ` para "${q}"` : ''}`;
    exportBtn.classList.remove('hidden');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" class="error-msg">${err.message}</td></tr>`;
    exportBtn.classList.add('hidden');
  }
}

document.getElementById('articulos-tbody').addEventListener('click', (e) => {
  const row = e.target.closest('tr[data-idx]');
  if (!row) return;
  const item = _articulosData[parseInt(row.dataset.idx)];
  if (item) _abrirDetalleArticulo(item);
});

document.getElementById('art-detalle-close').addEventListener('click', () => {
  document.getElementById('art-detalle-modal').classList.add('hidden');
});

document.getElementById('art-detalle-modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
});

// Click en header → ordenar
document.addEventListener('click', (e) => {
  const th = e.target.closest('#articulos-table th[data-sort]');
  if (!th) return;
  const col = th.dataset.sort;
  if (_articulosSortCol === col) {
    _articulosSortDir *= -1;
  } else {
    _articulosSortCol = col;
    _articulosSortDir = 1;
  }
  renderArticulos();
});

document.getElementById('admin-articulos-search').addEventListener('input', (e) => {
  clearTimeout(_articulosTimer);
  _articulosTimer = setTimeout(() => loadArticulos(e.target.value.trim()), 300);
});

document.getElementById('btn-exportar-articulos')?.addEventListener('click', () => {
  window.location.href = api.exportArticulosUrl();
});

// ══════════════════════════════════════════════════════════════════════════════
// ROLES — ABM
// ══════════════════════════════════════════════════════════════════════════════

const _PERMS_UI = [
  { key: 'perm_pick',               label: 'Pick',                  group: 'Herramientas' },
  { key: 'perm_sobrantes',          label: 'Sobrantes',             group: 'Herramientas' },
  { key: 'perm_novedades',          label: 'Novedades',             group: 'Herramientas' },
  { key: 'perm_yaguar',             label: 'Yaguar',                group: 'Mayoristas' },
  { key: 'perm_diarco',             label: 'DIARCO',                group: 'Mayoristas' },
  { key: 'perm_admin_clientes',      label: 'Ver clientes (editar básico)',  group: 'Panel Admin' },
  { key: 'perm_admin_clientes_full', label: 'Editar clientes completo',    group: 'Panel Admin' },
  { key: 'perm_admin_semanas',      label: 'Importar semanas',      group: 'Panel Admin' },
  { key: 'perm_admin_zonas',        label: 'Zonas y repartos',      group: 'Panel Admin' },
  { key: 'perm_admin_auditoria',    label: 'Auditoría',             group: 'Panel Admin' },
  { key: 'perm_admin_articulos',    label: 'Catálogo de artículos', group: 'Panel Admin' },
  { key: 'perm_admin_usuarios',     label: 'Gestionar usuarios',    group: 'Administración' },
  { key: 'perm_admin_roles',        label: 'Gestionar roles',       group: 'Administración' },
];

let _rolesData = [];
let _editingRolNombre = null;

async function loadRoles() {
  const tbody = document.getElementById('roles-tbody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="99" class="loading">Cargando...</td></tr>';
  try {
    _rolesData = await api.getRoles();
    renderRoles();
  } catch (err) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="99" class="error-msg">${err.message}</td></tr>`;
  }
}

function renderRoles() {
  const panel = document.getElementById('gest-panel-roles');
  if (!panel) return;

  const esc = s => (s || '').replace(/</g,'&lt;');
  const tag = label =>
    `<span style="display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;background:color-mix(in srgb,var(--accent) 15%,transparent);color:var(--text);font-family:var(--font)">${label}</span>`;

  const groups = [
    { label: 'Herramientas', perms: ['perm_pick','perm_sobrantes','perm_novedades'] },
    { label: 'Mayoristas',   perms: ['perm_yaguar','perm_diarco'] },
    { label: 'Panel admin',   perms: ['perm_admin_clientes','perm_admin_clientes_full','perm_admin_semanas','perm_admin_zonas','perm_admin_auditoria','perm_admin_articulos'] },
    { label: 'Administración', perms: ['perm_admin_usuarios','perm_admin_roles'] },
  ];
  const permLabel = {};
  _PERMS_UI.forEach(p => { permLabel[p.key] = p.label; });

  // superadmin siempre arriba del todo
  const rolesOrdenados = [..._rolesData].sort((a, b) => {
    if (a.nombre === 'superadmin') return -1;
    if (b.nombre === 'superadmin') return  1;
    return (a.orden ?? 100) - (b.orden ?? 100);
  });

  const cardsHtml = rolesOrdenados.map(r => {
    const protegido = r.es_protegido ? ' <span style="font-size:11px">🔒</span>' : '';
    const colorDot = r.color
      ? `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${r.color};margin-right:6px;flex-shrink:0"></span>`
      : '';
    const handle = r.es_protegido ? '' :
      `<span class="rol-drag-handle" title="Arrastrar para reordenar" style="cursor:grab;font-size:16px;color:var(--muted);margin-right:6px;user-select:none">⠿</span>`;
    // Superadmin protegido: solo el caller superadmin puede editar (solo color)
    const btnEditarProtegido = (r.es_protegido && esSuperadmin())
      ? `<button class="btn-edit" onclick="_openRolModal('${esc(r.nombre)}')">Editar</button>` : '';
    const acciones = r.es_protegido
      ? btnEditarProtegido
      : `<button class="btn-edit" onclick="_openRolModal('${esc(r.nombre)}')">Editar</button>
         <button class="btn-del" onclick="_deleteRol('${esc(r.nombre)}')">Eliminar</button>`;
    const groupsHtml = groups.map(g => {
      const active = g.perms.filter(pk => r[pk]).map(pk => tag(permLabel[pk]));
      if (!active.length) return '';
      return `<div style="display:flex;align-items:baseline;gap:4px;flex-wrap:wrap;margin-top:4px">
        <span style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;flex-shrink:0">${g.label}:</span>
        ${active.join(' ')}
      </div>`;
    }).join('');
    const noPerms = groups.every(g => g.perms.every(pk => !r[pk]));
    return `<div data-rol="${esc(r.nombre)}" data-protegido="${r.es_protegido}"
               style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin-bottom:8px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <div style="display:flex;align-items:center">${handle}${colorDot}<strong style="font-size:14px">${esc(r.nombre)}${protegido}</strong></div>
        <div class="td-actions">${acciones}</div>
      </div>
      ${noPerms ? '<span style="font-size:12px;color:var(--muted)">Sin permisos asignados</span>' : groupsHtml}
    </div>`;
  }).join('');

  const cardsContainer = document.createElement('div');
  cardsContainer.id = 'roles-cards-container';
  cardsContainer.innerHTML = _rolesData.length ? cardsHtml : '<p class="muted-text" style="text-align:center;padding:20px">No hay roles cargados.</p>';

  panel.innerHTML = `<div style="display:flex;justify-content:flex-end;margin-bottom:12px">
    <button class="btn-search" onclick="_openRolModal(null)">+ Nuevo rol</button>
  </div>`;
  panel.appendChild(cardsContainer);

  // Drag-and-drop con Sortable.js
  if (_rolesData.length && typeof Sortable !== 'undefined') {
    Sortable.create(cardsContainer, {
      animation: 150,
      handle: '.rol-drag-handle',
      filter: '[data-protegido="true"]',
      onMove: (evt) => evt.related.dataset.protegido !== 'true',  // no mover encima de superadmin
      onEnd: async () => {
        const cards = cardsContainer.querySelectorAll('[data-rol]:not([data-protegido="true"])');
        const nombres = Array.from(cards).map(c => c.dataset.rol);
        try {
          await api.setRolesOrden(nombres);
          await loadRoles();
        } catch (err) { showToast(err.message, 'error'); }
      },
    });
  }
}

function _openRolModal(nombre) {
  _editingRolNombre = nombre || null;
  const rol = nombre ? _rolesData.find(r => r.nombre === nombre) : null;
  document.getElementById('rol-modal-title').textContent = nombre ? `Editar rol: ${nombre}` : 'Nuevo rol';
  document.getElementById('rol-nombre-input').value = rol ? rol.nombre : '';
  document.getElementById('rol-nombre-input').readOnly = !!(rol && rol.es_protegido);
  document.getElementById('rol-color-input').value = rol?.color || '#888888';
  _PERMS_UI.forEach(p => {
    const cb = document.getElementById(`rolperm-${p.key}`);
    if (!cb) return;
    cb.checked = rol ? !!rol[p.key] : false;
    // Roles protegidos: checkboxes siempre marcados y no editables
    const protegido = !!(rol && rol.es_protegido);
    cb.disabled = protegido;
    cb.dataset.permanentDisabled = protegido ? '1' : '';
    cb.closest('label').style.opacity = protegido ? '0.45' : '';
  });
  document.getElementById('rol-modal').classList.remove('hidden');
  _syncClientePerms();
}

function _closeRolModal() {
  document.getElementById('rol-modal').classList.add('hidden');
  _editingRolNombre = null;
}

document.getElementById('rol-modal-cancel')?.addEventListener('click', _closeRolModal);

// Dependencia: "editar completo" requiere "editar básico"
function _syncClientePerms() {
  const basico = document.getElementById('rolperm-perm_admin_clientes');
  const full   = document.getElementById('rolperm-perm_admin_clientes_full');
  if (!basico || !full) return;
  // No tocar si ya está permanentemente deshabilitado (rol protegido)
  if (basico.dataset.permanentDisabled || full.dataset.permanentDisabled) return;
  full.disabled = !basico.checked;
  if (!basico.checked) full.checked = false;
  full.closest('label').style.opacity = basico.checked ? '' : '0.4';
}
document.getElementById('rolperm-perm_admin_clientes')?.addEventListener('change', _syncClientePerms);
document.getElementById('rolperm-perm_admin_clientes_full')?.addEventListener('change', _syncClientePerms);
document.getElementById('rol-modal')?.addEventListener('click', e => { if (e.target === e.currentTarget) _closeRolModal(); });

document.getElementById('rol-form')?.addEventListener('submit', async e => {
  e.preventDefault();
  const nombre = document.getElementById('rol-nombre-input').value.trim();
  if (!nombre) { showToast('El nombre del rol es obligatorio', 'error'); return; }
  const data = { nombre, color: document.getElementById('rol-color-input').value || null };
  _PERMS_UI.forEach(p => { data[p.key] = !!document.getElementById(`rolperm-${p.key}`)?.checked; });
  try {
    if (_editingRolNombre) {
      await api.updateRolPerms(_editingRolNombre, data);
      showToast('Rol actualizado', 'success');
    } else {
      await api.createRol(data);
      showToast('Rol creado', 'success');
    }
    _closeRolModal();
    await loadRoles();
    await _recargarSelectsRoles();
    showHub(); // refrescar cards de mayoristas inmediatamente
  } catch (err) { showToast(err.message, 'error'); }
});

async function _deleteRol(nombre) {
  if (!await confirmar(`¿Eliminar el rol "${nombre}"? Esta acción no se puede deshacer.`, 'Sí, eliminar')) return;
  try {
    await api.deleteRol(nombre);
    showToast('Rol eliminado', 'success');
    await loadRoles();
    await _recargarSelectsRoles();
    showHub();
  } catch (err) { showToast(err.message, 'error'); }
}

async function _recargarSelectsRoles() {
  try {
    const roles = await api.getRoles();
    ['nu-rol','edit-rol'].forEach(id => {
      const sel = document.getElementById(id);
      if (!sel) return;
      const current = sel.value;
      sel.innerHTML = roles.map(r => `<option value="${r.nombre}">${r.nombre}</option>`).join('');
      if (roles.find(r => r.nombre === current)) sel.value = current;
    });
  } catch {}
}

// Cargar roles dinámicamente al abrir el modal de usuarios
const _origLoadUsers = typeof loadUsers !== 'undefined' ? loadUsers : null;
document.getElementById('hub-admin-btn')?.addEventListener('click', async () => {
  await _recargarSelectsRoles();
});