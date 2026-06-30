import uuid
import pytest


def _cod():
    """Genera un código de test único para no colisionar con datos reales."""
    return f"TST{uuid.uuid4().hex[:6].upper()}"


# ── helpers ───────────────────────────────────────────────────────────────────

def _crear(client, mayorista, extra=None):
    payload = {
        "nombre": "CLIENTE TEST",
        "localidad": "MERLO",
        "vendedor": "TEST",
        "id_yaguar": _cod(),
        **(extra or {}),
    }
    r = client.post(f"/api/{mayorista}/clientes/", json=payload)
    return r


def _borrar(client, mayorista, id_):
    client.delete(f"/api/{mayorista}/clientes/{id_}")


# ── tests health del endpoint ─────────────────────────────────────────────────

def test_listar_yaguar(client):
    r = client.get("/api/yaguar/clientes/")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


def test_listar_diarco(client):
    r = client.get("/api/diarco/clientes/")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


# ── tests creación ────────────────────────────────────────────────────────────

def test_crear_yaguar_basico(client):
    r = _crear(client, "yaguar")
    assert r.status_code == 200
    data = r.json()
    assert data["nombre"] == "CLIENTE TEST"
    assert data["id"] is not None
    _borrar(client, "yaguar", data["id"])


def test_crear_yaguar_flete_default(client):
    """El frontend envía 0.08 cuando el usuario deja el campo vacío."""
    r = _crear(client, "yaguar", {"flete": 0.08})
    assert r.status_code == 200
    data = r.json()
    assert data["flete"] == pytest.approx(0.08)
    _borrar(client, "yaguar", data["id"])


def test_crear_yaguar_flete_custom(client):
    r = _crear(client, "yaguar", {"flete": 0.05})
    assert r.status_code == 200
    assert r.json()["flete"] == pytest.approx(0.05)
    _borrar(client, "yaguar", r.json()["id"])


def test_crear_yaguar_sin_flete(client):
    """Sin flete explícito, el backend guarda None."""
    r = _crear(client, "yaguar")
    assert r.status_code == 200
    data = r.json()
    assert data["flete"] is None
    _borrar(client, "yaguar", data["id"])


def test_crear_diarco_basico(client):
    r = _crear(client, "diarco")
    assert r.status_code == 200
    data = r.json()
    assert data["nombre"] == "CLIENTE TEST"
    assert data["id"] is not None
    _borrar(client, "diarco", data["id"])


def test_crear_diarco_flete_default(client):
    r = _crear(client, "diarco", {"flete": 0.08})
    assert r.status_code == 200
    assert r.json()["flete"] == pytest.approx(0.08)
    _borrar(client, "diarco", r.json()["id"])


# ── tests unicidad ────────────────────────────────────────────────────────────

def test_codigo_existente_se_reutiliza(client):
    """Crear con un código ya existente hace UPDATE (no 409) — comportamiento intencional."""
    cod = _cod()
    payload = {"nombre": "TEST DUP", "localidad": "MERLO", "vendedor": "TEST", "id_yaguar": cod}
    r1 = client.post("/api/yaguar/clientes/", json=payload)
    assert r1.status_code == 200
    id_ = r1.json()["id"]

    payload2 = {**payload, "nombre": "TEST DUP EDITADO"}
    r2 = client.post("/api/yaguar/clientes/", json=payload2)
    assert r2.status_code == 200
    assert r2.json()["nombre"] == "TEST DUP EDITADO"
    assert r2.json()["id"] == id_  # mismo registro, no uno nuevo

    _borrar(client, "yaguar", id_)


def test_mismo_codigo_yaguar_y_diarco(client):
    """El mismo código puede existir en Yaguar y en DIARCO — son mayoristas distintos."""
    cod = _cod()
    payload = {"nombre": "TEST SHARED COD", "localidad": "MERLO", "vendedor": "TEST", "id_yaguar": cod}
    r1 = client.post("/api/yaguar/clientes/", json=payload)
    r2 = client.post("/api/diarco/clientes/", json=payload)
    assert r1.status_code == 200
    assert r2.status_code == 200
    _borrar(client, "yaguar", r1.json()["id"])
    _borrar(client, "diarco", r2.json()["id"])


# ── tests edición ─────────────────────────────────────────────────────────────

def test_editar_cliente(client):
    r = _crear(client, "yaguar", {"flete": 0.08})
    id_ = r.json()["id"]
    cod = r.json()["id_yaguar"]

    r2 = client.put(f"/api/yaguar/clientes/{id_}", json={
        "nombre": "CLIENTE EDITADO",
        "localidad": "MERLO",
        "vendedor": "TEST",
        "id_yaguar": cod,
        "flete": 0.10,
    })
    assert r2.status_code == 200
    data = r2.json()
    assert data["nombre"] == "CLIENTE EDITADO"
    assert data["flete"] == pytest.approx(0.10)
    _borrar(client, "yaguar", id_)


def test_editar_cliente_inexistente(client):
    r = client.put("/api/yaguar/clientes/999999999", json={
        "nombre": "GHOST",
        "localidad": "MERLO",
        "vendedor": "TEST",
    })
    assert r.status_code == 404


# ── tests eliminación ─────────────────────────────────────────────────────────

def test_eliminar_cliente(client):
    r = _crear(client, "yaguar")
    id_ = r.json()["id"]
    r2 = client.delete(f"/api/yaguar/clientes/{id_}")
    assert r2.status_code == 200


def test_eliminar_cliente_inexistente(client):
    r = client.delete("/api/yaguar/clientes/999999999")
    assert r.status_code == 404


# ── test normalización ────────────────────────────────────────────────────────

def test_nombre_se_guarda_en_mayusculas(client):
    r = _crear(client, "yaguar", {"nombre": "minúsculas mix"})
    assert r.status_code == 200
    data = r.json()
    assert data["nombre"] == "MINÚSCULAS MIX"
    _borrar(client, "yaguar", data["id"])
