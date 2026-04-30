// ── State ──────────────────────────────────────────────────────────────────
let codeReader = null;
let scannerActive = false;
let adminUnlocked = false;
let editingClienteId = null;

// ── Init ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  if (getToken()) {
    showApp();
  } else {
    showLogin();
  }
});

// ── Views ──────────────────────────────────────────────────────────────────
function showLogin() {
  document.getElementById('login-view').classList.remove('hidden');
  document.getElementById('app-view').classList.add('hidden');
}

function showApp() {
  document.getElementById('login-view').classList.add('hidden');
  document.getElementById('app-view').classList.remove('hidden');
  loadStats();
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

// ── Stats ──────────────────────────────────────────────────────────────────
async function loadStats() {
  try {
    const stats = await api.getStats();
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
    const picks = await api.getByBarcode(codBar);
    renderPicks(picks);
  } catch (err) {
    results.innerHTML = `<p class="error-msg">${err.message}</p>`;
  }
}

function renderPicks(picks) {
  const results = document.getElementById('results');
  results.innerHTML = '';

  picks.forEach((pick) => {
    const card = document.createElement('div');
    card.className = 'pick-card';
    card.dataset.id = pick.id;

    const isCompleted = (pick.estado || '').startsWith('completado');
    if (isCompleted) card.classList.add('completed');

    const cantidad = pick.cantidad_pickeada ?? 0;
    const uni = pick.uni ?? 0;

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
      <div class="pick-estado ${isCompleted ? 'estado-ok' : 'estado-pend'}">${pick.estado ?? 'sin estado'}</div>
      <div class="pick-controls">
        <div class="stepper">
          <button class="step-btn" data-action="dec">−</button>
          <input class="step-input" type="number" min="0" max="${uni}" value="${cantidad}" />
          <button class="step-btn" data-action="inc">+</button>
        </div>
        <div class="pick-actions">
          <button class="btn-save">Guardar</button>
          <button class="btn-undo">Desmarcar</button>
        </div>
      </div>
    `;

    const input = card.querySelector('.step-input');
    card.querySelector('[data-action="dec"]').addEventListener('click', () => {
      input.value = Math.max(0, parseInt(input.value || 0) - 1);
    });
    card.querySelector('[data-action="inc"]').addEventListener('click', () => {
      input.value = Math.min(uni, parseInt(input.value || 0) + 1);
    });
    card.querySelector('.btn-save').addEventListener('click', () => saveQuantity(pick.id, parseInt(input.value || 0), card));
    card.querySelector('.btn-undo').addEventListener('click', () => saveQuantity(pick.id, 0, card));

    results.appendChild(card);
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
    showToast(isCompleted ? '✓ Completado' : 'Actualizado', isCompleted ? 'success' : 'info');
    loadStats();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ── Camera scanner ─────────────────────────────────────────────────────────
document.getElementById('scan-btn').addEventListener('click', () => {
  scannerActive ? stopScanner() : startScanner();
});

function startScanner() {
  document.getElementById('scanner-container').classList.remove('hidden');
  document.getElementById('scan-btn').textContent = 'Detener';
  scannerActive = true;

  codeReader = new ZXing.BrowserMultiFormatReader();
  codeReader.decodeFromVideoDevice(null, 'scanner-video', (result) => {
    if (result) {
      const code = result.getText();
      document.getElementById('barcode-input').value = code;
      stopScanner();
      searchBarcode(code);
    }
  });
}

function stopScanner() {
  if (codeReader) { codeReader.reset(); codeReader = null; }
  scannerActive = false;
  document.getElementById('scanner-container').classList.add('hidden');
  document.getElementById('scan-btn').textContent = 'Escanear';
}

// ── Tab: Clientes ──────────────────────────────────────────────────────────
let resumenData = [];
let filtroActivo = 'todos';

async function loadResumen() {
  const container = document.getElementById('resumen-list');
  container.innerHTML = '<p class="loading">Cargando...</p>';
  try {
    resumenData = await api.getResumen();
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
    <div class="resumen-card estado-${r.estado_general}">
      <div class="resumen-nombre">${r.nombre}</div>
      <div class="resumen-stats">
        <span class="tag-ok">${r.completados} ✓</span>
        <span class="tag-pend">${r.pendientes} pend.</span>
        <span class="tag-total">${r.total} total</span>
      </div>
      <div class="resumen-badge badge-${r.estado_general}">${r.estado_general}</div>
    </div>
  `).join('');
}

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

// ── Toast ──────────────────────────────────────────────────────────────────
function showToast(msg, type = 'info') {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = `toast toast-${type} show`;
  setTimeout(() => toast.classList.remove('show'), 2800);
}
