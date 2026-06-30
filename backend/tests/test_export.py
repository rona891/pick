def test_export_picks_yaguar_devuelve_excel(client, semana_yaguar):
    r = client.get(f"/api/yaguar/export/picks?semana={semana_yaguar['nombre']}")
    assert r.status_code == 200
    assert "spreadsheet" in r.headers.get("content-type", "")
    assert len(r.content) > 0


def test_export_picks_diarco_devuelve_excel(client, semana_diarco):
    r = client.get(f"/api/diarco/export/picks?semana={semana_diarco['nombre']}")
    assert r.status_code == 200
    assert "spreadsheet" in r.headers.get("content-type", "")
    assert len(r.content) > 0


def test_export_mod_yaguar_devuelve_excel(client, semana_yaguar):
    r = client.get(f"/api/yaguar/export/mod?semana={semana_yaguar['nombre']}")
    assert r.status_code == 200
    assert "spreadsheet" in r.headers.get("content-type", "")


def test_export_clientes_yaguar_devuelve_excel(client):
    r = client.get("/api/yaguar/export/clientes")
    assert r.status_code == 200
    assert "spreadsheet" in r.headers.get("content-type", "")


def test_export_semana_inexistente(client):
    r = client.get("/api/yaguar/export/picks?semana=SEMANA-QUE-NO-EXISTE")
    # Puede devolver 200 con Excel vacío o 404 — cualquiera es válido, no debe crashear
    assert r.status_code in (200, 404)
