import os
import pytest
from pathlib import Path
from fastapi.testclient import TestClient
from main import app

FIXTURES = Path(__file__).parent / "fixtures"


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


# ── Fixtures de semanas (requieren .db en tests/fixtures/) ────────────────────

def _get_semana_id(client, mayorista: str, nombre: str) -> int | None:
    url = f"/api/{mayorista}/semanas/?all=true"
    semanas = client.get(url).json()
    row = next((s for s in semanas if s["nombre"] == nombre), None)
    return row["id"] if row else None


@pytest.fixture(scope="session")
def semana_yaguar(client):
    db_path = FIXTURES / "yaguar.db"
    if not db_path.exists():
        pytest.skip("Fixture yaguar.db no encontrado — copiarlo a backend/tests/fixtures/")

    NOMBRE = "TEST-YAG-2026"
    with open(db_path, "rb") as f:
        r = client.post(
            "/api/yaguar/semanas/importar",
            data={"nombre": NOMBRE, "fecha_desde": "20260228", "fecha_hasta": "20260526", "mayorista": "yaguar"},
            files={"archivos": ("yaguar.db", f, "application/octet-stream")},
        )
    assert r.status_code == 200, f"Import Yaguar falló: {r.text}"

    semana_id = _get_semana_id(client, "yaguar", NOMBRE)
    yield {**r.json(), "id": semana_id, "nombre": NOMBRE}

    if semana_id:
        client.delete(f"/api/yaguar/semanas/{semana_id}")


@pytest.fixture(scope="session")
def semana_diarco(client):
    db_path = FIXTURES / "diarco.db"
    if not db_path.exists():
        pytest.skip("Fixture diarco.db no encontrado — copiarlo a backend/tests/fixtures/")

    NOMBRE = "TEST-DRC-2026"
    with open(db_path, "rb") as f:
        r = client.post(
            "/api/diarco/semanas/importar",
            data={"nombre": NOMBRE, "fecha_desde": "20260518", "fecha_hasta": "20260527"},
            files={"archivos": ("diarco.db", f, "application/octet-stream")},
        )
    assert r.status_code == 200, f"Import DIARCO falló: {r.text}"

    semana_id = _get_semana_id(client, "diarco", NOMBRE)
    yield {**r.json(), "id": semana_id, "nombre": NOMBRE}

    if semana_id:
        client.delete(f"/api/diarco/semanas/{semana_id}")
