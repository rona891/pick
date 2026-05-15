const API_BASE = '';

// ── Notificaciones de red ────────────────────────────────────────────────────
let _toastTimer = null;
let _lastNetErrAt = 0;
const NET_ERR_COOLDOWN = 8000; // ms entre toasts de error de red

function showNetToast(msg, tipo = 'error') {
  const el = document.getElementById('net-toast');
  const msgEl = document.getElementById('net-toast-msg');
  const icon = document.getElementById('net-toast-icon');
  if (!el || !msgEl) return;
  msgEl.textContent = msg;
  el.className = `net-toast${tipo === 'ok' ? ' net-toast-ok' : tipo === 'warn' ? ' net-toast-warn' : ''}`;
  icon.textContent = tipo === 'ok' ? '✓' : tipo === 'warn' ? '⚡' : '⚠';
  clearTimeout(_toastTimer);
  if (tipo === 'ok') {
    _toastTimer = setTimeout(hideNetToast, 3000);
  } else if (tipo !== 'persistent') {
    _toastTimer = setTimeout(hideNetToast, 6000);
  }
}

function hideNetToast() {
  const el = document.getElementById('net-toast');
  if (el) el.classList.add('hidden');
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('net-toast-close')?.addEventListener('click', hideNetToast);
});

window.addEventListener('offline', () =>
  showNetToast('Sin WiFi — los cambios no se están guardando', 'persistent')
);
window.addEventListener('online', () =>
  showNetToast('Conexión restaurada', 'ok')
);

function getToken() {
  return localStorage.getItem('token');
}

function setToken(token) {
  localStorage.setItem('token', token);
}

function clearToken() {
  localStorage.removeItem('token');
  localStorage.removeItem('rol');
  localStorage.removeItem('username');
  localStorage.removeItem('acceso_sobrantes');
}

function getMayorista() {
  return localStorage.getItem('mayorista') || 'yaguar';
}

function setMayorista(m) {
  localStorage.setItem('mayorista', m);
  localStorage.setItem('mayorista_ts', Date.now().toString());
}

function mayoristaCaducado() {
  const ts = parseInt(localStorage.getItem('mayorista_ts') || '0');
  return Date.now() - ts > 30 * 60 * 1000;
}

function getRol() {
  return localStorage.getItem('rol') || 'operario';
}

function setRol(rol) {
  localStorage.setItem('rol', rol);
}

function esAdmin() {
  const r = getRol();
  return r === 'admin' || r === 'superadmin';
}

function esVendedor() {
  return getRol() === 'vendedor';
}

function esAdminOVendedor() {
  return esAdmin() || esVendedor();
}

function tieneSobrantes() {
  return localStorage.getItem('acceso_sobrantes') === '1';
}

async function request(method, path, body = null) {
  const token = getToken();
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : null,
    });
  } catch (_) {
    // fetch lanzó una excepción → sin conexión al servidor
    const now = Date.now();
    if (now - _lastNetErrAt > NET_ERR_COOLDOWN) {
      _lastNetErrAt = now;
      showNetToast('Sin conexión al servidor. Revisá el WiFi.');
    }
    throw new Error('Sin conexión');
  }

  if (res.status === 401 && getToken()) {
    clearToken();
    window.location.href = '/';
    return;
  }

  if (res.status >= 500) {
    const now = Date.now();
    if (now - _lastNetErrAt > NET_ERR_COOLDOWN) {
      _lastNetErrAt = now;
      showNetToast('Error interno del servidor. Avisale al admin.');
    }
  }

  // Si llega respuesta, la conexión está bien → limpiar error si estaba visible
  if (res.ok) {
    _lastNetErrAt = 0;
    const el = document.getElementById('net-toast');
    if (el && !el.classList.contains('hidden') && !el.classList.contains('net-toast-ok')) {
      showNetToast('Conexión restaurada', 'ok');
    }
  }

  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || 'Error del servidor');
  return data;
}

function semanaParam(semana) {
  return semana ? `?semana=${encodeURIComponent(semana)}` : '';
}

const api = {
  // Auth
  login: (username, password) => request('POST', '/api/auth/login', { username, password }),
  logout: () => request('POST', '/api/auth/logout'),

  // Picks — rutas separadas por mayorista (/api/yaguar/picks/ o /api/diarco/picks/)
  getStats: (semana) => request('GET', `/api/${getMayorista()}/picks/stats${semanaParam(semana)}`),
  getResumen: (semana) => request('GET', `/api/${getMayorista()}/picks/resumen${semanaParam(semana)}`),
  getByBarcode: (cod_bar, semana) => request('GET', `/api/${getMayorista()}/picks/barcode/${encodeURIComponent(cod_bar)}${semanaParam(semana)}`),
  getByCodArt: (cod_art, semana) => request('GET', `/api/${getMayorista()}/picks/art/${encodeURIComponent(cod_art)}${semanaParam(semana)}`),
  buscarPorDescrip: (q, semana) => request('GET', `/api/${getMayorista()}/picks/buscar?q=${encodeURIComponent(q)}${semana ? `&semana=${encodeURIComponent(semana)}` : ''}`),
  getPicksPorCliente: (nombre, semana) => request('GET', `/api/${getMayorista()}/picks/por-cliente?nombre=${encodeURIComponent(nombre)}${semana ? `&semana=${encodeURIComponent(semana)}` : ''}`),
  updateQuantity: (id, cantidad_pickeada) => request('PUT', `/api/${getMayorista()}/picks/${id}/quantity`, { cantidad_pickeada }),

  // Clientes — rutas separadas por mayorista (/api/yaguar/clientes/ o /api/diarco/clientes/)
  getClientes: () => request('GET', `/api/${getMayorista()}/clientes/`),
  createCliente: (data) => request('POST', `/api/${getMayorista()}/clientes/`, data),
  updateCliente: (id, data) => request('PUT', `/api/${getMayorista()}/clientes/${id}`, data),
  deleteCliente: (id) => request('DELETE', `/api/${getMayorista()}/clientes/${id}`),
  getVendedoresYaguar: () => request('GET', `/api/${getMayorista()}/clientes/vendedores`),
  getSinRegistrar: () => request('GET', `/api/${getMayorista()}/clientes/sin-registrar`),
  getCodigoLibreYaguar: () => request('GET', '/api/yaguar/clientes/codigo-libre'),
  marcarNoApto: (codigo) => request('PUT', '/api/yaguar/clientes/marcar-no-apto', { codigo }),

  // Admin
  verifyAdmin: (password) => request('POST', '/api/admin/verify', { password }),

  // Password
  changePassword: (current_password, new_password) =>
    request('PUT', '/api/auth/password', { current_password, new_password }),
  changeUsername: (current_password, new_username) =>
    request('PUT', '/api/auth/username', { current_password, new_username }),

  // Usuarios (admin)
  getUsers: () => request('GET', '/api/auth/users'),
  createUser: (username, password, rol = 'operario') => request('POST', '/api/auth/users', { username, password, rol }),
  deleteUser: (id) => request('DELETE', `/api/auth/users/${id}`),
  updateRol: (id, rol) => request('PUT', `/api/auth/users/${id}/rol`, { rol }),
  updateSobrantesAcceso: (id, acceso) => request('PUT', `/api/auth/users/${id}/sobrantes`, { acceso }),
  updateUser: (id, data) => request('PUT', `/api/auth/users/${id}`, data),
  getMe: () => request('GET', '/api/auth/me'),

  // Zonas y Repartos — compartidos entre mayoristas
  getZonas: () => request('GET', '/api/zonas/'),
  getRepartos: () => request('GET', '/api/zonas/repartos'),
  moverReparto: (id, direccion) => request('PUT', `/api/zonas/repartos/${id}/orden?direccion=${direccion}`),
  createZona: (nombre, reparto) => request('POST', '/api/zonas/', { nombre, reparto }),
  updateZona: (id, nombre, reparto) => request('PUT', `/api/zonas/${id}`, { nombre, reparto }),
  deleteZona: (id) => request('DELETE', `/api/zonas/${id}`),

  // Export — rutas separadas por mayorista (/api/yaguar/export/ o /api/diarco/export/)
  exportPicksUrl: (semana) => `/api/${getMayorista()}/export/picks?semana=${encodeURIComponent(semana)}`,

  // Semanas (rutas separadas por mayorista)
  getSemanas: () => request('GET', `/api/${getMayorista()}/semanas/`),
  deleteSemana: (id) => request('DELETE', `/api/${getMayorista()}/semanas/${id}`),
  importarSemana: async (formData) => {
    const token = getToken();
    const res = await fetch(`${API_BASE}/api/${getMayorista()}/semanas/importar`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      throw new Error(`Error del servidor (${res.status}). El archivo puede ser demasiado grande.`);
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Error del servidor');
    return data;
  },

  // Historial
  getHistorial: (semana) => request('GET', `/api/${getMayorista()}/picks/historial${semanaParam(semana)}`),

  // Asignaciones de reparto
  getAsignaciones: (semana) => request('GET', `/api/${getMayorista()}/asignaciones/?semana=${encodeURIComponent(semana)}`),
  setAsignacion: (data) => request('PUT', `/api/${getMayorista()}/asignaciones/`, data),
  deleteAsignacion: (id) => request('DELETE', `/api/${getMayorista()}/asignaciones/${id}`),

  // Sobrantes (compartido entre mayoristas)
  sobGetListas: () => request('GET', '/api/sobrantes/listas'),
  sobCrearLista: (nombre) => request('POST', '/api/sobrantes/listas', { nombre }),
  sobDeleteLista: (lista) => request('DELETE', `/api/sobrantes/listas/${encodeURIComponent(lista)}`),
  sobLookup: (codBar) => request('GET', `/api/sobrantes/lookup/${encodeURIComponent(codBar)}`),
  sobSearch: (q) => request('GET', `/api/sobrantes/search?q=${encodeURIComponent(q)}&mayorista=${getMayorista()}`),
  sobGetItems: (lista) => request('GET', `/api/sobrantes/${encodeURIComponent(lista)}?mayorista=${getMayorista()}`),
  sobAddItem: (lista, item) => request('POST', `/api/sobrantes/${encodeURIComponent(lista)}/item`, item),
  sobUpdateItem: (lista, id, unidades, bultos) => request('PUT', `/api/sobrantes/${encodeURIComponent(lista)}/item/${id}`, { unidades, bultos }),
  sobDeleteItem: (lista, id) => request('DELETE', `/api/sobrantes/${encodeURIComponent(lista)}/item/${id}`),
  sobExportUrl: (lista) => `/api/sobrantes/${encodeURIComponent(lista)}/export`,
};
