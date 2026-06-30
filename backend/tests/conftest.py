import os
import pytest
from fastapi.testclient import TestClient

# La DB y SECRET_KEY vienen del .env del container.
# Para correr localmente fuera de Docker, exportar las mismas variables.

from main import app


@pytest.fixture(scope="session")
def client():
    """TestClient con lifespan completo (pool + migraciones)."""
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="session")
def admin_token(client):
    password = os.getenv("ADMIN_PASSWORD", "hello2")
    r = client.post("/api/auth/login", json={"username": "ADMIN", "password": password})
    assert r.status_code == 200, f"Login falló: {r.text}"
    return r.json()["access_token"]


@pytest.fixture(scope="session")
def auth(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}
