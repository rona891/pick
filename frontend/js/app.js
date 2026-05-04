// ── State ──────────────────────────────────────────────────────────────────
let codeReader = null;
let scannerActive = false;
let adminUnlocked = false;
let editingClienteId = null;
let semanaActual = '';

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
    });
  });
});

// ── Views ──────────────────────────────────────────────────────────────────
function showLogin() {
  document.getElementById('login-view').classList.remove('hidden');
  document.getElementById('app-view').classList.add('hidden');
}

function showApp() {
  document.getElementById('login-view').classList.add('hidden');
  document.getElementById('app-view').classList.remove('hidden');
  loadSemanas().then(() => loadStats());
  switchTab('pick');
}

// ── Auth ───────────────────────────────────────────────────────────────────
document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  const btn = document.getElementById('login-btn');

  btn.disabled = true;
  btn.textContent = 'Entrando...';

  try {
    const res = await api.login(email, password);
    setToken(res.access_token);
    showApp();
  } catch (err) {
    showToast(err.message || 'Error al iniciar sesión', 'error');
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
  } catch (_) {}
}

// ── Tabs ───────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== tab));

  if (tab === 'clientes') loadResumen(semanaActual);
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
    renderPicks(picks);
  } catch (err) {
    results.innerHTML = `<p class="error-msg">${err.message}</p>`;
  }
}

function formatCantidad(uni, bul, uxb) {
  uni = uni || 0;
  bul = bul || 0;
  uxb = uxb || 0;
  if (uxb > 1 && bul > 0 && uni === bul * uxb) {
    return { main: `${bul} bulto${bul !== 1 ? 's' : ''}`, sub: `×${uxb} uni/bulto` };
  }
  return { main: `${uni} uni`, sub: uxb > 1 ? `×${uxb} uni/bulto` : null };
}

function renderPicks(picks, container = document.getElementById('results')) {
  container.innerHTML = '';

  picks.forEach((pick) => {
    const card = document.createElement('div');
    card.className = 'pick-card';
    card.dataset.id = pick.id;

    const isCompleted = (pick.estado || '').startsWith('completado');
    if (isCompleted) card.classList.add('completed');

    const cantidad = pick.cantidad_pickeada ?? 0;
    const uni = pick.uni ?? 0;
    const qty = formatCantidad(uni, pick.bul, pick.uxb);

    card.innerHTML = `
      <div class="pick-header">
        <span class="pick-art">${pick.cod_art ?? ''}</span>
        <span class="pick-semana">${pick.semana ?? ''}</span>
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
      <div class="pick-estado ${isCompleted ? 'estado-ok' : 'estado-pend'}">${pick.estado ?? 'sin estado'}</div>
      <div class="pick-controls">
        ${!isCompleted ? `<button class="btn-entregado">✓ Entregado</button>` : ''}
        <div class="pick-qty-row">
          <input class="step-input" type="number" min="0" max="${uni}" value="${cantidad}" />
          <button class="btn-save">Guardar</button>
          <button class="btn-undo">Desmarcar</button>
        </div>
      </div>
    `;

    const input = card.querySelector('.step-input');
    if (!isCompleted) {
      card.querySelector('.btn-entregado').addEventListener('click', () => saveQuantity(pick.id, uni, card));
    }
    card.querySelector('.btn-save').addEventListener('click', () => saveQuantity(pick.id, parseInt(input.value || 0), card));
    card.querySelector('.btn-undo').addEventListener('click', () => saveQuantity(pick.id, 0, card));

    container.appendChild(card);
  });
}

async function saveQuantity(id, cantidad, card) {
  try {
    const res = await api.updateQuantity(id, cantidad);
    const isCompleted = res.estado.startsWith('completado');
    card.classList.toggle('completed', isCompleted);
    card.querySelector('.pick-estado').textContent = res.estado;
    card.querySelector('.pick-estado').className = `pick-estado ${isCompleted ? 'estado-ok' : 'estado-pend'}`;
    card.querySelector('.step-input').value = cantidad;
    // Ocultar/mostrar botón Entregado según estado
    const btnEnt = card.querySelector('.btn-entregado');
    if (btnEnt) btnEnt.style.display = isCompleted ? 'none' : '';
    showToast(isCompleted ? '✓ Completado' : 'Actualizado', isCompleted ? 'success' : 'info');
    loadStats();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ── Búsqueda por descripción ───────────────────────────────────────────────
let descripTimer = null;

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
let cameras = [];
let currentCameraIndex = 0;

document.getElementById('scan-btn').addEventListener('click', async () => {
  if (scannerActive) stopScanner();
  else await startScanner();
});

function onScanResult(result) {
  if (!result) return;
  const code = result.getText();
  document.getElementById('barcode-input').value = code;
  stopScanner();
  searchBarcode(code);
}

async function startScanner(deviceId = null) {
  const container = document.getElementById('scanner-container');
  container.classList.remove('hidden');
  document.getElementById('scan-btn').textContent = 'Detener';
  scannerActive = true;

  // Última cámara guardada, o null (ZXing usa facingMode:environment con null)
  const targetId = deviceId ?? localStorage.getItem('pick_last_camera') ?? null;

  const hints = new Map([[3, true]]); // TRY_HARDER
  codeReader = new ZXing.BrowserMultiFormatReader(hints, 300);
  await codeReader.decodeFromVideoDevice(targetId, 'scanner-video', onScanResult);

  container.classList.add('scanner-open');

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

// Tap para enfocar en el punto tocado
document.getElementById('scanner-video').addEventListener('click', async (e) => {
  const video = e.currentTarget;
  if (!video.srcObject || !scannerActive) return;

  const rect = video.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width;
  const y = (e.clientY - rect.top) / rect.height;

  // Indicador visual
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
  } catch {}
});


async function switchCamera() {
  if (cameras.length <= 1) return;
  currentCameraIndex = (currentCameraIndex + 1) % cameras.length;
  if (codeReader) { codeReader.reset(); codeReader = null; }
  const video = document.getElementById('scanner-video');
  if (video.srcObject) { video.srcObject.getTracks().forEach((t) => t.stop()); video.srcObject = null; }
  await startScanner(cameras[currentCameraIndex].deviceId);
}

function stopScanner() {
  if (!scannerActive) return;
  scannerActive = false;

  document.getElementById('scanner-container').classList.remove('scanner-open');

  if (codeReader) { codeReader.reset(); codeReader = null; }
  const video = document.getElementById('scanner-video');
  if (video.srcObject) { video.srcObject.getTracks().forEach((t) => t.stop()); video.srcObject = null; }

  cameras = [];
  currentCameraIndex = 0;
  document.getElementById('scanner-container').classList.add('hidden');
  document.getElementById('scan-btn').textContent = 'Escanear';
  document.getElementById('switch-camera-btn').classList.add('hidden');
}

// ── Tab: Clientes ──────────────────────────────────────────────────────────
let resumenData = [];
let filtroActivo = 'todos';

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

function renderResumen() {
  const container = document.getElementById('resumen-list');
  const filtered = filtroActivo === 'todos'
    ? resumenData
    : resumenData.filter((r) => r.estado_general === filtroActivo);

  if (!filtered.length) {
    container.innerHTML = '<p class="loading">Sin resultados</p>';
    return;
  }

  container.innerHTML = filtered.map((r) => `
    <div class="resumen-card estado-${r.estado_general}" data-nombre="${encodeURIComponent(r.nombre)}">
      <div class="resumen-nombre">${r.nombre}</div>
      <div class="resumen-stats">
        <span class="tag-ok">${r.completados} ✓</span>
        <span class="tag-pend">${r.pendientes} pend.</span>
        <span class="tag-total">${r.total} total</span>
      </div>
      <div class="resumen-badge badge-${r.estado_general}">${r.estado_general}</div>
      <button class="btn-ver-picks">›</button>
    </div>
  `).join('');

  container.querySelectorAll('.resumen-card').forEach((card) => {
    card.addEventListener('click', () => {
      const nombre = decodeURIComponent(card.dataset.nombre);
      abrirPicksCliente(nombre);
    });
  });
}

// ── Picks por cliente (bottom-sheet) ──────────────────────────────────────
async function abrirPicksCliente(nombre) {
  document.getElementById('cliente-picks-title').textContent = nombre;
  const content = document.getElementById('cliente-picks-content');
  content.innerHTML = '<p class="loading">Cargando...</p>';
  document.getElementById('cliente-picks-overlay').classList.remove('hidden');

  try {
    const picks = await api.getPicksPorCliente(nombre, semanaActual);
    if (!picks.length) {
      content.innerHTML = '<p class="loading">Sin items</p>';
    } else {
      renderPicks(picks, content);
    }
  } catch (err) {
    content.innerHTML = `<p class="error-msg">${err.message}</p>`;
  }
}

document.getElementById('cliente-picks-close').addEventListener('click', () => {
  document.getElementById('cliente-picks-overlay').classList.add('hidden');
  // Recargar resumen por si cambió algún estado
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
  try {
    await api.verifyAdmin(pw);
    adminUnlocked = true;
    document.getElementById('admin-lock').classList.add('hidden');
    document.getElementById('admin-panel').classList.remove('hidden');
    loadClientes();
  } catch {
    showToast('Contraseña incorrecta', 'error');
  }
});

document.getElementById('btn-nuevo-cliente').addEventListener('click', () => openClienteForm(null));

async function loadClientes() {
  const tbody = document.getElementById('clientes-tbody');
  tbody.innerHTML = '<tr><td colspan="6" class="loading">Cargando...</td></tr>';
  try {
    const clientes = await api.getClientes();
    tbody.innerHTML = clientes.map((c) => `
      <tr>
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
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="error-msg">${err.message}</td></tr>`;
  }
}

function openClienteForm(id) {
  editingClienteId = id;
  const modal = document.getElementById('cliente-modal');
  const title = document.getElementById('modal-title');
  title.textContent = id ? 'Editar cliente' : 'Nuevo cliente';

  ['nombre', 'localidad', 'direccion', 'telefono', 'contacto', 'vendedor'].forEach((f) => {
    document.getElementById(`cf-${f}`).value = '';
  });

  if (id) {
    api.getClientes().then((list) => {
      const c = list.find((x) => x.id === id);
      if (c) {
        ['nombre', 'localidad', 'direccion', 'telefono', 'contacto', 'vendedor'].forEach((f) => {
          document.getElementById(`cf-${f}`).value = c[f] ?? '';
        });
      }
    });
  }

  modal.classList.remove('hidden');
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
        Los siguientes IDs de cliente no están registrados en la tabla de clientes.
        Anotalos y andá a la tab <strong>Clientes</strong> para agregarlos con su nombre y localidad:
        <div class="import-missing-list">${tags}</div>
      `;
    }
  } catch (err) {
    resultPanel.className = 'import-result result-warn';
    resultPanel.innerHTML = `<div class="import-result-title warn">Error</div>${err.message}`;
  } finally {
    btn.disabled = files.length === 0;
    btn.textContent = 'Importar picks';
  }
});

// ── Cambiar contraseña ─────────────────────────────────────────────────────
document.getElementById('change-pw-btn').addEventListener('click', () => {
  document.getElementById('pw-form').reset();
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

// ── Toast ──────────────────────────────────────────────────────────────────
function showToast(msg, type = 'info') {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = `toast toast-${type} show`;
  setTimeout(() => toast.classList.remove('show'), 2800);
}
