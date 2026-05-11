const API_BASE = '';

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

async function request(method, path, body = null) {
  const token = getToken();
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null,
  });

  if (res.status === 401 && getToken()) {
    clearToken();
    window.location.href = '/';
    return;
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

  // Picks (todos aceptan semana opcional)
  getStats: (semana) => request('GET', `/api/picks/stats${semanaParam(semana)}`),
  getResumen: (semana) => request('GET', `/api/picks/resumen${semanaParam(semana)}`),
  getByBarcode: (cod_bar, semana) => request('GET', `/api/picks/barcode/${encodeURIComponent(cod_bar)}${semanaParam(semana)}`),
  buscarPorDescrip: (q, semana) => request('GET', `/api/picks/buscar?q=${encodeURIComponent(q)}${semana ? `&semana=${encodeURIComponent(semana)}` : ''}`),
  getPicksPorCliente: (nombre, semana) => request('GET', `/api/picks/por-cliente?nombre=${encodeURIComponent(nombre)}${semana ? `&semana=${encodeURIComponent(semana)}` : ''}`),
  updateQuantity: (id, cantidad_pickeada) => request('PUT', `/api/picks/${id}/quantity`, { cantidad_pickeada }),

  // Clientes
  getClientes: () => request('GET', `/api/clientes/?mayorista=${getMayorista()}`),
  createCliente: (data) => request('POST', '/api/clientes/', { ...data, mayorista: getMayorista() }),
  updateCliente: (id, data) => request('PUT', `/api/clientes/${id}`, data),
  deleteCliente: (id) => request('DELETE', `/api/clientes/${id}`),

  // Admin
  verifyAdmin: (password) => request('POST', '/api/admin/verify', { password }),

  // Password
  changePassword: (current_password, new_password) =>
    request('PUT', '/api/auth/password', { current_password, new_password }),
  changeUsername: (current_password, new_username) =>
    request('PUT', '/api/auth/username', { current_password, new_username }),

  // Usuarios (admin)
  getUsers: () => request('GET', '/api/auth/users'),
  createUser: (username, password) => request('POST', '/api/auth/users', { username, password }),
  deleteUser: (id) => request('DELETE', `/api/auth/users/${id}`),
  updateRol: (id, rol) => request('PUT', `/api/auth/users/${id}/rol`, { rol }),

  // Zonas
  getZonas: () => request('GET', `/api/zonas/?mayorista=${getMayorista()}`),
  getRepartos: () => request('GET', `/api/zonas/repartos?mayorista=${getMayorista()}`),
  moverReparto: (id, direccion) => request('PUT', `/api/zonas/repartos/${id}/orden?direccion=${direccion}`),
  createZona: (nombre, reparto) => request('POST', '/api/zonas/', { nombre, reparto }),
  updateZona: (id, nombre, reparto) => request('PUT', `/api/zonas/${id}`, { nombre, reparto }),
  deleteZona: (id) => request('DELETE', `/api/zonas/${id}`),

  // Export
  exportPicksUrl: (semana) => `/api/export/picks?semana=${encodeURIComponent(semana)}&mayorista=${getMayorista()}`,

  // Semanas
  getSemanas: () => request('GET', `/api/semanas/?mayorista=${getMayorista()}`),
  deleteSemana: (id) => request('DELETE', `/api/semanas/${id}`),
  importarSemana: async (formData) => {
    const token = getToken();
    const res = await fetch(`${API_BASE}/api/semanas/importar`, {
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
};
