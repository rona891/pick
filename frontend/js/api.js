const API_BASE = window.location.hostname === 'localhost'
  ? 'http://localhost:8000'
  : `${window.location.protocol}//${window.location.hostname}:8000`;

function getToken() {
  return localStorage.getItem('token');
}

function setToken(token) {
  localStorage.setItem('token', token);
}

function clearToken() {
  localStorage.removeItem('token');
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

  if (res.status === 401) {
    clearToken();
    window.location.reload();
    return;
  }

  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || 'Error del servidor');
  return data;
}

const api = {
  // Auth
  login: (email, password) => request('POST', '/api/auth/login', { email, password }),
  logout: () => request('POST', '/api/auth/logout'),

  // Picks
  getStats: () => request('GET', '/api/picks/stats'),
  getResumen: () => request('GET', '/api/picks/resumen'),
  getByBarcode: (cod_bar) => request('GET', `/api/picks/barcode/${encodeURIComponent(cod_bar)}`),
  updateQuantity: (id, cantidad_pickeada) => request('PUT', `/api/picks/${id}/quantity`, { cantidad_pickeada }),

  // Clientes
  getClientes: () => request('GET', '/api/clientes/'),
  createCliente: (data) => request('POST', '/api/clientes/', data),
  updateCliente: (id, data) => request('PUT', `/api/clientes/${id}`, data),
  deleteCliente: (id) => request('DELETE', `/api/clientes/${id}`),

  // Admin
  verifyAdmin: (password) => request('POST', '/api/admin/verify', { password }),
};
