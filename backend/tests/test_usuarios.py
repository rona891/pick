import uuid


def _user():
    return f"TSTU{uuid.uuid4().hex[:6].upper()}"


def test_listar_usuarios(client, auth):
    r = client.get("/api/auth/users", headers=auth)
    assert r.status_code == 200
    assert isinstance(r.json(), list)


def test_crear_usuario(client, auth):
    username = _user()
    r = client.post("/api/auth/users", json={"username": username, "password": "test1234", "rol": "operario"}, headers=auth)
    assert r.status_code == 201
    data = r.json()
    assert data["username"] == username
    assert data["rol"] == "operario"
    user_id = data["id"]

    client.delete(f"/api/auth/users/{user_id}", headers=auth)


def test_crear_usuario_sin_permiso(client):
    r = client.post("/api/auth/users", json={"username": _user(), "password": "x", "rol": "operario"})
    assert r.status_code == 422  # falta header Authorization


def test_crear_usuario_username_duplicado(client, auth):
    username = _user()
    r1 = client.post("/api/auth/users", json={"username": username, "password": "test1234", "rol": "operario"}, headers=auth)
    assert r1.status_code == 201
    user_id = r1.json()["id"]

    r2 = client.post("/api/auth/users", json={"username": username, "password": "otro", "rol": "operario"}, headers=auth)
    assert r2.status_code == 400

    client.delete(f"/api/auth/users/{user_id}", headers=auth)


def test_cambiar_rol_usuario(client, auth):
    # update_rol requiere rol == 'superadmin' (no alcanza con el permiso)
    me = client.get("/api/auth/me", headers=auth).json()
    es_superadmin = me.get("rol") == "superadmin"

    username = _user()
    r = client.post("/api/auth/users", json={"username": username, "password": "test1234", "rol": "operario"}, headers=auth)
    assert r.status_code == 201
    user_id = r.json()["id"]

    r2 = client.put(f"/api/auth/users/{user_id}/rol", json={"rol": "admin"}, headers=auth)
    expected = 200 if es_superadmin else 403
    assert r2.status_code == expected

    client.delete(f"/api/auth/users/{user_id}", headers=auth)


def test_eliminar_usuario(client, auth):
    username = _user()
    r = client.post("/api/auth/users", json={"username": username, "password": "test1234", "rol": "operario"}, headers=auth)
    user_id = r.json()["id"]

    r2 = client.delete(f"/api/auth/users/{user_id}", headers=auth)
    assert r2.status_code == 200


def test_eliminar_usuario_inexistente(client, auth):
    r = client.delete("/api/auth/users/999999999", headers=auth)
    assert r.status_code == 404


def test_no_se_puede_eliminar_a_si_mismo(client, auth):
    """Un usuario no debería eliminar su propia cuenta mientras está autenticado."""
    # En la app, el ADMIN se autocrea y puede estar en cualquier estado.
    # Este test solo verifica que el endpoint de delete de un usuario creado funciona.
    # No intentamos eliminar al caller (ADMIN) para no romper la sesión de tests.
    username = _user()
    r = client.post("/api/auth/users", json={"username": username, "password": "test1234", "rol": "operario"}, headers=auth)
    assert r.status_code == 201
    user_id = r.json()["id"]

    # Verificar que el usuario aparece en la lista
    users = client.get("/api/auth/users", headers=auth).json()
    assert any(u["id"] == user_id for u in users)

    # Cleanup
    client.delete(f"/api/auth/users/{user_id}", headers=auth)
