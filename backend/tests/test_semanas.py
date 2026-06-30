import pytest


# ── Yaguar ────────────────────────────────────────────────────────────────────

def test_import_yaguar_genera_picks(semana_yaguar):
    assert semana_yaguar["picks_importados"] > 0


def test_import_yaguar_nombre_correcto(semana_yaguar):
    assert semana_yaguar["semana"] == "TEST-YAG-2026"


def test_import_yaguar_semana_aparece_en_lista(client, semana_yaguar):
    r = client.get("/api/yaguar/semanas/?all=true")
    assert r.status_code == 200
    nombres = [s["nombre"] for s in r.json()]
    assert "TEST-YAG-2026" in nombres


def test_import_yaguar_idempotente(client, semana_yaguar):
    """Re-importar la misma semana remplaza los picks sin duplicar."""
    from pathlib import Path
    db_path = Path(__file__).parent / "fixtures" / "yaguar.db"
    if not db_path.exists():
        pytest.skip("Fixture no disponible")

    picks_antes = semana_yaguar["picks_importados"]
    with open(db_path, "rb") as f:
        r = client.post(
            "/api/yaguar/semanas/importar",
            data={"nombre": "TEST-YAG-2026", "fecha_desde": "20260228", "fecha_hasta": "20260526", "mayorista": "yaguar"},
            files={"archivos": ("yaguar.db", f, "application/octet-stream")},
        )
    assert r.status_code == 200
    assert r.json()["picks_importados"] == picks_antes  # misma cantidad, no duplicados


def test_import_yaguar_fechas_sin_datos_falla(client):
    from pathlib import Path
    db_path = Path(__file__).parent / "fixtures" / "yaguar.db"
    if not db_path.exists():
        pytest.skip("Fixture no disponible")

    with open(db_path, "rb") as f:
        r = client.post(
            "/api/yaguar/semanas/importar",
            data={"nombre": "TEST-VACIO", "fecha_desde": "19990101", "fecha_hasta": "19990131", "mayorista": "yaguar"},
            files={"archivos": ("yaguar.db", f, "application/octet-stream")},
        )
    assert r.status_code == 400


# ── DIARCO ────────────────────────────────────────────────────────────────────

def test_import_diarco_genera_picks(semana_diarco):
    assert semana_diarco["picks_importados"] > 0


def test_import_diarco_nombre_correcto(semana_diarco):
    assert semana_diarco["semana"] == "TEST-DRC-2026"


def test_import_diarco_semana_aparece_en_lista(client, semana_diarco):
    r = client.get("/api/diarco/semanas/?all=true")
    assert r.status_code == 200
    nombres = [s["nombre"] for s in r.json()]
    assert "TEST-DRC-2026" in nombres


def test_import_diarco_fechas_sin_datos_falla(client):
    from pathlib import Path
    db_path = Path(__file__).parent / "fixtures" / "diarco.db"
    if not db_path.exists():
        pytest.skip("Fixture no disponible")

    with open(db_path, "rb") as f:
        r = client.post(
            "/api/diarco/semanas/importar",
            data={"nombre": "TEST-VACIO-DRC", "fecha_desde": "19990101", "fecha_hasta": "19990131"},
            files={"archivos": ("diarco.db", f, "application/octet-stream")},
        )
    assert r.status_code == 400
