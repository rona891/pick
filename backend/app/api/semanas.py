import sqlite3
import tempfile
import os
from fastapi import APIRouter, UploadFile, File, Form, HTTPException
from typing import List
from app.db.database import get_db

router = APIRouter(prefix="/semanas", tags=["semanas"])

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
    SUBSTR(c.CLI_ID, -6)                             AS cliente_id
FROM hpedidosDetalle AS pd
JOIN PedidosFiltrados AS pc
    ON pd.PEDD_FECHA_REG = pc.PED_FECHA_REG AND pd.PEDD_USR_ID = pc.PED_USR_ID
JOIN clientes AS c ON pc.PED_CLI_ID = c.CLI_ID
JOIN articulos AS a ON pd.PEDD_ART_ID = a.ART_ID
ORDER BY pc.PED_FECHA_REG DESC
"""


def _query_db_file(db_bytes: bytes, fecha_desde: str, fecha_hasta: str) -> list:
    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
        f.write(db_bytes)
        tmp_path = f.name
    try:
        conn = sqlite3.connect(tmp_path)
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        cur.execute(EXTRACT_SQL, (fecha_desde, fecha_hasta))
        rows = [dict(r) for r in cur.fetchall()]
        conn.close()
        return rows
    finally:
        os.unlink(tmp_path)


@router.get("/")
def list_semanas():
    with get_db() as cur:
        cur.execute("SELECT id, nombre, created_at FROM semanas ORDER BY created_at DESC")
        return [dict(r) for r in cur.fetchall()]


@router.post("/importar")
async def importar_semana(
    nombre: str = Form(...),
    fecha_desde: str = Form(...),
    fecha_hasta: str = Form(...),
    archivos: List[UploadFile] = File(...),
):
    if len(fecha_desde) != 8 or not fecha_desde.isdigit():
        raise HTTPException(400, "fecha_desde debe estar en formato AAAAMMDD (ej: 20260422)")
    if len(fecha_hasta) != 8 or not fecha_hasta.isdigit():
        raise HTTPException(400, "fecha_hasta debe estar en formato AAAAMMDD (ej: 20260429)")

    all_rows: list = []
    for archivo in archivos:
        content = await archivo.read()
        rows = _query_db_file(content, fecha_desde, fecha_hasta)
        all_rows.extend(rows)

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
            INSERT INTO semanas (nombre) VALUES (%s)
            ON CONFLICT (nombre) DO UPDATE SET nombre = EXCLUDED.nombre
            RETURNING id
            """,
            (nombre,),
        )
        cur.fetchone()

        # Borrar picks previos de esta semana para reimportar limpio
        cur.execute("DELETE FROM pick WHERE semana = %s", (nombre,))

        no_encontrados: set = set()
        inserted = 0

        for r in all_rows:
            cliente_id = str(r["cliente_id"])
            info = clientes.get(cliente_id)
            nombre_cliente = info["nombre"] if info else cliente_id
            localidad = info["localidad"] if info else None

            if not info:
                no_encontrados.add(cliente_id)

            uni = int(r["uni"] or 0)

            cur.execute(
                """
                INSERT INTO pick
                    (cod_bar, cod_art, descrip, nombre, cliente, localidad, uni, bul, uxb,
                     cantidad_pickeada, estado, semana)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, 0, %s, %s)
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
                    f"pendiente: 0/{uni} UNI",
                    nombre,
                ),
            )
            inserted += 1

    return {
        "picks_importados": inserted,
        "semana": nombre,
        "clientes_no_encontrados": sorted(no_encontrados),
    }
