def test_login_exitoso(client):
    r = client.post("/api/auth/login", json={"username": "ADMIN", "password": "hello2"})
    assert r.status_code == 200
    data = r.json()
    assert "access_token" in data
    assert "rol" in data


def test_login_clave_incorrecta(client):
    r = client.post("/api/auth/login", json={"username": "ADMIN", "password": "clave-incorrecta"})
    assert r.status_code == 401


def test_login_usuario_inexistente(client):
    r = client.post("/api/auth/login", json={"username": "NOEXISTE", "password": "algo"})
    assert r.status_code == 401


def test_me_con_token_valido(client, auth):
    r = client.get("/api/auth/me", headers=auth)
    assert r.status_code == 200
    data = r.json()
    assert "rol" in data
    # Al menos un permiso de admin debe estar activo para ADMIN
    perms_admin = [
        "perm_pick", "perm_admin_clientes", "perm_admin_semanas",
        "perm_admin_usuarios", "perm_admin_roles",
    ]
    assert any(data.get(p) for p in perms_admin), f"ADMIN no tiene ningún permiso: {data}"


def test_me_sin_token(client):
    r = client.get("/api/auth/me")
    assert r.status_code == 422  # Header requerido


def test_me_token_invalido(client):
    r = client.get("/api/auth/me", headers={"Authorization": "Bearer token-falso"})
    assert r.status_code == 401


def test_logout(client):
    r = client.post("/api/auth/logout")
    assert r.status_code == 200
