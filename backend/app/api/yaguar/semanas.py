# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# YAGUAR — Importación de semanas/picks
# Lee archivos .db exportados por la app de Yaguar (SQLite con estructura
# propia: hpedidosCabecera, hpedidosDetalle, articulos, clientes).
# Endpoint: POST /api/yaguar/semanas/importar
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import sqlite3
import tempfile
import os
from fastapi import APIRouter, UploadFile, File, Form, HTTPException, Query
from typing import List, Optional
from pydantic import BaseModel
from app.db.database import get_db


class VisibleIn(BaseModel):
    visible: bool

router = APIRouter(prefix="/yaguar/semanas", tags=["Yaguar - Semanas"])

# Mismo SQL que se usaba manualmente, adaptado para Python (sqlite3 usa ? como placeholder)
EXTRACT_SQL = """
WITH PedidosFiltrados AS (
    SELECT *
    FROM hpedidosCabecera
    WHERE (SUBSTR(PED_FECHA_REG, 1, 4) || SUBSTR(PED_FECHA_REG, 6, 2) || SUBSTR(PED_FECHA_REG, 9, 2))
        BETWEEN ? AND ?
)
SELECT
    a.ART_CODEBAR                                    AS cod_bar,
    a.ART_ID                                         AS cod_art,
    CAST(pd.PEDD_CANTIDAD AS INTEGER)                AS uni,
    CASE
        WHEN a.ART_UNI_BULTO > 0 AND pd.PEDD_CANTIDAD >= a.ART_UNI_BULTO
        THEN CAST(pd.PEDD_CANTIDAD / a.ART_UNI_BULTO AS INTEGER)
        ELSE 0
    END                                              AS bul,
    CAST(a.ART_UNI_BULTO AS INTEGER)                 AS uxb,
    a.ART_DESCR                                      AS descrip,
    SUBSTR(c.CLI_ID, -6)                             AS cliente_id,
    CAST(a.ART_PRECIO_DEFAULT AS REAL)               AS precio_default,
    CAST(a.ART_PORC_IVA AS REAL)                     AS porc_iva
FROM hpedidosDetalle AS pd
JOIN PedidosFiltrados AS pc
    ON pd.PEDD_FECHA_REG = pc.PED_FECHA_REG AND pd.PEDD_USR_ID = pc.PED_USR_ID
JOIN clientes AS c ON pc.PED_CLI_ID = c.CLI_ID
JOIN articulos AS a ON pd.PEDD_ART_ID = a.ART_ID
ORDER BY pc.PED_FECHA_REG DESC
"""


TOTALES_SQL = """
WITH PedidosFiltrados AS (
    SELECT *
    FROM hpedidosCabecera
    WHERE (SUBSTR(PED_FECHA_REG, 1, 4) || SUBSTR(PED_FECHA_REG, 6, 2) || SUBSTR(PED_FECHA_REG, 9, 2))
        BETWEEN ? AND ?
)
SELECT SUBSTR(c.CLI_ID, -6) AS cliente_id,
       ROUND(SUM(pc.PED_IMPORTE_TOTAL), 2) AS total_importe
FROM PedidosFiltrados pc
JOIN clientes c ON pc.PED_CLI_ID = c.CLI_ID
GROUP BY c.CLI_ID
"""


def _query_db_file(db_bytes: bytes, fecha_desde: str, fecha_hasta: str):
    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
        f.write(db_bytes)
        tmp_path = f.name
    try:
        conn = sqlite3.connect(tmp_path)
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        cur.execute(EXTRACT_SQL, (fecha_desde, fecha_hasta))
        picks = [dict(r) for r in cur.fetchall()]
        cur.execute(TOTALES_SQL, (fecha_desde, fecha_hasta))
        totales = {r["cliente_id"]: float(r["total_importe"] or 0) for r in cur.fetchall()}
        # Códigos que Yaguar sabe que NO son consumidor final (RESP. INSC., MONOTRIBUTO, etc.)
        cur.execute("""
            SELECT SUBSTR(CLI_ID, -6) AS codigo
            FROM clientes
            WHERE CLI_COND_IVA NOT IN (2, 5)
        """)
        no_cf = {r["codigo"] for r in cur.fetchall()}
        conn.close()
        return picks, totales, no_cf
    finally:
        os.unlink(tmp_path)


@router.get("/")
def list_semanas(mayorista: str = "yaguar", all: Optional[bool] = Query(default=False)):
    with get_db() as cur:
        if all:
            cur.execute(
                "SELECT id, nombre, visible, created_at FROM semanas WHERE mayorista = %s ORDER BY created_at DESC",
                (mayorista,)
            )
        else:
            cur.execute(
                "SELECT id, nombre, visible, created_at FROM semanas WHERE mayorista = %s AND visible = true ORDER BY created_at DESC",
                (mayorista,)
            )
        return [dict(r) for r in cur.fetchall()]


@router.put("/{id}/visible")
def toggle_semana_visible(id: int, data: VisibleIn):
    with get_db() as cur:
        cur.execute("UPDATE semanas SET visible = %s WHERE id = %s RETURNING id", (data.visible, id))
        if not cur.fetchone():
            raise HTTPException(status_code=404, detail="Semana no encontrada")
    return {"ok": True}


@router.post("/importar")
async def importar_semana(
    nombre: str = Form(...),
    fecha_desde: str = Form(...),
    fecha_hasta: str = Form(...),
    archivos: List[UploadFile] = File(...),
    mayorista: str = Form("yaguar"),
):
    if len(fecha_desde) != 8 or not fecha_desde.isdigit():
        raise HTTPException(400, "fecha_desde debe estar en formato AAAAMMDD (ej: 20260422)")
    if len(fecha_hasta) != 8 or not fecha_hasta.isdigit():
        raise HTTPException(400, "fecha_hasta debe estar en formato AAAAMMDD (ej: 20260429)")

    all_rows: list = []
    totales_por_cliente: dict = {}
    codigos_no_cf: set = set()
    for archivo in archivos:
        content = await archivo.read()
        rows, totales, no_cf = _query_db_file(content, fecha_desde, fecha_hasta)
        all_rows.extend(rows)
        for cid, monto in totales.items():
            totales_por_cliente[cid] = totales_por_cliente.get(cid, 0) + monto
        codigos_no_cf.update(no_cf)

    if not all_rows:
        raise HTTPException(400, "No se encontraron picks en ese rango de fechas. Verificá las fechas.")

    with get_db() as cur:
        # Mapa de clientes por id_yaguar
        cur.execute(
            "SELECT id_yaguar, nombre, localidad FROM clientes_yaguar WHERE id_yaguar IS NOT NULL"
        )
        clientes = {str(r["id_yaguar"]): r for r in cur.fetchall()}

        # Crear semana (upsert — si ya existe la reemplaza)
        cur.execute(
            """
            INSERT INTO semanas (nombre, mayorista) VALUES (%s, %s)
            ON CONFLICT (nombre, mayorista) DO UPDATE SET nombre = EXCLUDED.nombre
            RETURNING id
            """,
            (nombre, mayorista),
        )
        cur.fetchone()

        # Borrar picks previos de esta semana para reimportar limpio
        cur.execute("DELETE FROM pick WHERE semana = %s", (nombre,))

        no_encontrados: set = set()
        inserted = 0

        for r in all_rows:
            cliente_id = str(r["cliente_id"])
            info = clientes.get(cliente_id)
            # Si el código existe pero es libre (sin nombre), tratar igual que no encontrado
            tiene_nombre = info and info["nombre"]
            nombre_cliente = info["nombre"] if tiene_nombre else cliente_id
            localidad = info["localidad"] if info else None

            if not tiene_nombre:
                no_encontrados.add(cliente_id)

            uni = int(r["uni"] or 0)

            importe_total = totales_por_cliente.get(cliente_id, 0)

            precio_default = float(r["precio_default"] or 0)
            porc_iva = float(r["porc_iva"] or 0)
            precio_unit = round(precio_default * (1 + porc_iva / 100), 4) if precio_default else None

            cur.execute(
                """
                INSERT INTO pick
                    (cod_bar, cod_art, descrip, nombre, cliente, localidad, uni, bul, uxb,
                     cantidad_pickeada, estado, semana, importe_total, mayorista, precio_unit)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, 0, %s, %s, %s, 'yaguar', %s)
                """,
                (
                    r["cod_bar"],
                    str(r["cod_art"]),
                    r["descrip"],
                    nombre_cliente,
                    cliente_id,
                    localidad,
                    uni,
                    int(r["bul"] or 0),
                    int(r["uxb"] or 0),
                    f"entregado: 0/{uni} UNI",
                    nombre,
                    importe_total,
                    precio_unit,
                ),
            )
            inserted += 1

    # Upsert de precios por artículo (tabla articulos_precios)
    with get_db() as cur:
        seen_arts = set()
        for r in all_rows:
            cod_art = str(r["cod_art"])
            if cod_art in seen_arts:
                continue
            precio_default = float(r["precio_default"] or 0)
            porc_iva = float(r["porc_iva"] or 0)
            if precio_default > 0:
                precio_con_iva = round(precio_default * (1 + porc_iva / 100), 4)
                uxb_art = int(r["uxb"] or 0)
                cur.execute("""
                    INSERT INTO articulos_precios (cod_art, mayorista, precio_con_iva, uxb)
                    VALUES (%s, 'yaguar', %s, %s)
                    ON CONFLICT (cod_art, mayorista) DO UPDATE
                    SET precio_con_iva = EXCLUDED.precio_con_iva, uxb = EXCLUDED.uxb
                """, (cod_art, precio_con_iva, uxb_art))
                seen_arts.add(cod_art)

    # Actualizar estado ocupado/libre.
    # Solo se tocan códigos que alguna vez aparecieron en picks
    # (los libres manuales y clientes nuevos sin picks no se modifican)
    with get_db() as cur:
        cur.execute("""
            WITH ultimas_semanas AS (
                SELECT nombre FROM semanas
                WHERE mayorista = 'yaguar'
                ORDER BY created_at DESC
                LIMIT 10
            ),
            codigos_activos AS (
                SELECT DISTINCT cliente FROM pick
                WHERE semana IN (SELECT nombre FROM ultimas_semanas)
                  AND mayorista = 'yaguar' AND cliente IS NOT NULL
            ),
            codigos_con_historial AS (
                SELECT DISTINCT cliente FROM pick
                WHERE mayorista = 'yaguar' AND cliente IS NOT NULL
            )
            UPDATE clientes_yaguar
            SET estado = CASE
                WHEN id_yaguar IN (SELECT cliente FROM codigos_activos) THEN 'ocupado'
                ELSE 'libre'
            END
            WHERE id_yaguar IS NOT NULL
              AND id_yaguar IN (SELECT cliente FROM codigos_con_historial)
        """)

    # Marcar como no_apto los códigos libres que Yaguar identifica como no consumidor final.
    # Solo se tocan códigos con estado='libre' — los ocupados no se modifican.
    marcados_no_apto = 0
    if codigos_no_cf:
        with get_db() as cur:
            cur.execute("""
                UPDATE clientes_yaguar
                SET estado = 'no_apto'
                WHERE mayorista = 'yaguar'
                  AND estado = 'libre'
                  AND id_yaguar = ANY(%s)
            """, (list(codigos_no_cf),))
            marcados_no_apto = cur.rowcount

    return {
        "picks_importados": inserted,
        "semana": nombre,
        "clientes_no_encontrados": sorted(no_encontrados),
        "no_encontrados_no_cf": sorted(no_encontrados & codigos_no_cf),
        "codigos_marcados_no_apto": marcados_no_apto,
    }


@router.delete("/{id}")
def delete_semana(id: int):
    with get_db() as cur:
        cur.execute("DELETE FROM semanas WHERE id = %s RETURNING nombre", (id,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Semana no encontrada")
    return {"message": "Semana eliminada", "nombre": row["nombre"]}
