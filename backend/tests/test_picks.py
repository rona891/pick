import pytest


# ── Yaguar ────────────────────────────────────────────────────────────────────

def test_yaguar_stats_tiene_picks(client, semana_yaguar):
    r = client.get(f"/api/yaguar/picks/stats?semana={semana_yaguar['nombre']}")
    assert r.status_code == 200
    data = r.json()
    assert data["total"] > 0
    assert data["total"] == data["completed"] + data["pending"]


def test_yaguar_resumen_lista_clientes(client, semana_yaguar):
    r = client.get(f"/api/yaguar/picks/resumen?semana={semana_yaguar['nombre']}")
    assert r.status_code == 200
    data = r.json()
    assert isinstance(data, list)
    assert len(data) > 0
    assert "nombre" in data[0]
    assert "total" in data[0]


def test_yaguar_picks_por_cliente(client, semana_yaguar):
    resumen = client.get(f"/api/yaguar/picks/resumen?semana={semana_yaguar['nombre']}").json()
    primer_cliente = resumen[0]["nombre"]

    r = client.get(f"/api/yaguar/picks/por-cliente?nombre={primer_cliente}&semana={semana_yaguar['nombre']}")
    assert r.status_code == 200
    picks = r.json()
    assert isinstance(picks, list)
    assert len(picks) > 0
    assert picks[0]["nombre"] == primer_cliente


def test_yaguar_actualizar_cantidad(client, semana_yaguar):
    resumen = client.get(f"/api/yaguar/picks/resumen?semana={semana_yaguar['nombre']}").json()
    primer_cliente = resumen[0]["nombre"]
    picks = client.get(f"/api/yaguar/picks/por-cliente?nombre={primer_cliente}&semana={semana_yaguar['nombre']}").json()
    pick_id = picks[0]["id"]
    uni = picks[0]["uni"]

    r = client.put(f"/api/yaguar/picks/{pick_id}/quantity", json={"cantidad_pickeada": uni})
    assert r.status_code == 200
    data = r.json()
    assert data["cantidad_pickeada"] == uni
    assert data["estado"].startswith("completado:")

    # Resetear a 0
    client.put(f"/api/yaguar/picks/{pick_id}/quantity", json={"cantidad_pickeada": 0})


def test_yaguar_actualizar_cantidad_parcial(client, semana_yaguar):
    resumen = client.get(f"/api/yaguar/picks/resumen?semana={semana_yaguar['nombre']}").json()
    primer_cliente = resumen[0]["nombre"]
    picks = client.get(f"/api/yaguar/picks/por-cliente?nombre={primer_cliente}&semana={semana_yaguar['nombre']}").json()
    pick = next((p for p in picks if p["uni"] > 1), picks[0])
    pick_id = pick["id"]

    r = client.put(f"/api/yaguar/picks/{pick_id}/quantity", json={"cantidad_pickeada": 1})
    assert r.status_code == 200
    assert r.json()["estado"].startswith("entregado:")

    client.put(f"/api/yaguar/picks/{pick_id}/quantity", json={"cantidad_pickeada": 0})


def test_yaguar_pick_inexistente(client):
    r = client.put("/api/yaguar/picks/999999999/quantity", json={"cantidad_pickeada": 1})
    assert r.status_code == 404


def test_yaguar_stats_sin_semana(client, semana_yaguar):
    r = client.get("/api/yaguar/picks/stats")
    assert r.status_code == 200
    data = r.json()
    assert data["total"] >= semana_yaguar["picks_importados"]


# ── DIARCO ────────────────────────────────────────────────────────────────────

def test_diarco_stats_tiene_picks(client, semana_diarco):
    r = client.get(f"/api/diarco/picks/stats?semana={semana_diarco['nombre']}")
    assert r.status_code == 200
    data = r.json()
    assert data["total"] > 0


def test_diarco_resumen_lista_clientes(client, semana_diarco):
    r = client.get(f"/api/diarco/picks/resumen?semana={semana_diarco['nombre']}")
    assert r.status_code == 200
    data = r.json()
    assert isinstance(data, list)
    assert len(data) > 0


def test_diarco_picks_por_cliente(client, semana_diarco):
    resumen = client.get(f"/api/diarco/picks/resumen?semana={semana_diarco['nombre']}").json()
    primer_cliente = resumen[0]["nombre"]

    r = client.get(f"/api/diarco/picks/por-cliente?nombre={primer_cliente}&semana={semana_diarco['nombre']}")
    assert r.status_code == 200
    picks = r.json()
    assert len(picks) > 0


def test_diarco_actualizar_cantidad(client, semana_diarco):
    resumen = client.get(f"/api/diarco/picks/resumen?semana={semana_diarco['nombre']}").json()
    primer_cliente = resumen[0]["nombre"]
    picks = client.get(f"/api/diarco/picks/por-cliente?nombre={primer_cliente}&semana={semana_diarco['nombre']}").json()
    pick_id = picks[0]["id"]
    uni = picks[0]["uni"]

    r = client.put(f"/api/diarco/picks/{pick_id}/quantity", json={"cantidad_pickeada": uni})
    assert r.status_code == 200
    assert r.json()["cantidad_pickeada"] == uni

    client.put(f"/api/diarco/picks/{pick_id}/quantity", json={"cantidad_pickeada": 0})
