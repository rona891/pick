import uuid


def _nombre():
    return f"ZONA-TEST-{uuid.uuid4().hex[:6].upper()}"


def test_listar_zonas(client):
    r = client.get("/api/zonas/")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


def test_listar_repartos(client):
    r = client.get("/api/zonas/repartos")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


def test_crear_zona(client):
    nombre = _nombre()
    r = client.post("/api/zonas/", json={"nombre": nombre, "reparto": ""})
    assert r.status_code == 200
    data = r.json()
    assert data["nombre"] == nombre
    zona_id = data["id"]

    # Cleanup
    client.delete(f"/api/zonas/{zona_id}")


def test_crear_zona_nombre_se_guarda_en_mayusculas(client):
    nombre_lower = _nombre().lower()
    r = client.post("/api/zonas/", json={"nombre": nombre_lower, "reparto": ""})
    assert r.status_code == 200
    data = r.json()
    assert data["nombre"] == nombre_lower.upper()
    client.delete(f"/api/zonas/{data['id']}")


def test_actualizar_zona(client):
    nombre = _nombre()
    r = client.post("/api/zonas/", json={"nombre": nombre, "reparto": ""})
    zona_id = r.json()["id"]

    nuevo_nombre = _nombre()
    r2 = client.put(f"/api/zonas/{zona_id}", json={"nombre": nuevo_nombre, "reparto": ""})
    assert r2.status_code == 200
    assert r2.json()["nombre"] == nuevo_nombre

    client.delete(f"/api/zonas/{zona_id}")


def test_eliminar_zona(client):
    nombre = _nombre()
    r = client.post("/api/zonas/", json={"nombre": nombre, "reparto": ""})
    zona_id = r.json()["id"]

    r2 = client.delete(f"/api/zonas/{zona_id}")
    assert r2.status_code == 200

    # Verificar que no aparece más
    zonas = client.get("/api/zonas/").json()
    assert not any(z["id"] == zona_id for z in zonas)


def test_eliminar_zona_inexistente(client):
    r = client.delete("/api/zonas/999999999")
    assert r.status_code == 404
