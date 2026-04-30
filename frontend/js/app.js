// ── State ──────────────────────────────────────────────────────────────────
let codeReader = null;
let scannerActive = false;

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

// ── Search ─────────────────────────────────────────────────────────────────
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

// ── Render picks ───────────────────────────────────────────────────────────
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
  if (scannerActive) {
    stopScanner();
  } else {
    startScanner();
  }
});

function startScanner() {
  const container = document.getElementById('scanner-container');
  container.classList.remove('hidden');
  document.getElementById('scan-btn').textContent = 'Detener cámara';
  scannerActive = true;

  codeReader = new ZXing.BrowserMultiFormatReader();
  codeReader.decodeFromVideoDevice(null, 'scanner-video', (result, err) => {
    if (result) {
      const code = result.getText();
      document.getElementById('barcode-input').value = code;
      stopScanner();
      searchBarcode(code);
    }
  });
}

function stopScanner() {
  if (codeReader) {
    codeReader.reset();
    codeReader = null;
  }
  scannerActive = false;
  document.getElementById('scanner-container').classList.add('hidden');
  document.getElementById('scan-btn').textContent = 'Escanear';
}

// ── Toast ──────────────────────────────────────────────────────────────────
function showToast(msg, type = 'info') {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = `toast toast-${type} show`;
  setTimeout(() => toast.classList.remove('show'), 2800);
}
