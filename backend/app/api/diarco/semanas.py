# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# DIARCO — Importación de semanas/picks
# Lee archivos MobileAssistantBU.db generados por la app de DIARCO (SQLite
# con estructura propia: mWTAMTrx, mWTATrx).
#
# Estructura relevante del .db de DIARCO:
#   mWTAMTrx  → una fila por pedido: TRANSID, DATE (YYYYMMDDHHMMSS), STATUS
#   mWTATrx   → pasos de cada pedido:
#     STEPCode='CTE'      → STEPSelDesc = nombre del cliente
#     STEPCode='GWS'      → STEPDesc = "Pedido para: {cod} {nombre}", Value3 = total $
#     STEPCode='DIR'      → Value3 = "CIUDAD, Provincia" (localidad del cliente)
#     STEPCode='GWS.ELEM' → STEPUID = código DIARCO del artículo,
#                           STEPSelDesc = descripción con "(fp: X / YB)",
#                           Value2 = cantidad pedida,
#                           Value3 = precio unitario
#
# Endpoint: POST /api/diarco/semanas/importar
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import sqlite3
import tempfile
import os
import re
from fastapi import APIRouter, UploadFile, File, Form, HTTPException

# Items que DIARCO usa internamente y no forman parte del picking real.
# - cod_art no numérico: items de sistema (ej: 'Semaforo')
# - descripciones excluidas: equipamiento que no se pickea (heladeras exhibidoras, etc.)
DESCRIP_EXCLUIDAS = [
    "heladera exhibidora",
]

def _es_item_real(cod_art: str, descrip: str) -> bool:
    """Devuelve False para items de sistema o equipamiento de DIARCO que no se pickean."""
    if not cod_art.strip().lstrip('-').isdigit():
        return False
    descrip_lower = (descrip or "").lower()
    return not any(excluida in descrip_lower for excluida in DESCRIP_EXCLUIDAS)
from typing import List
from app.db.database import get_db

router = APIRouter(prefix="/diarco/semanas", tags=["Diarco - Semanas"])

MAYORISTA = "diarco"


def _parse_pack(descrip: str):
    """
    Extrae info de pack del formato '(fp: X / YB)' en la descripción DIARCO.
    Retorna (uxb, bul_from_qty_fn, descrip_limpia).
    uxb = unidades por bulto = X / Y
    """
    match = re.search(r'\(fp:\s*(\d+)\s*/\s*(\d+)B\)', descrip or "")
    if match:
        total = int(match.group(1))
        boxes = int(match.group(2))
        uxb = total // boxes if boxes > 0 else total
        clean = descrip[:match.start()].strip()
        return uxb, clean
    return 0, (descrip or "").strip()


def _extract_city(location_str: str):
    """'MERLO, S.Luis' → 'MERLO'"""
    if not location_str:
        return None
    return location_str.split(",")[0].strip().upper() or None


def _query_diarco_db(db_bytes: bytes, fecha_desde: str, fecha_hasta: str):
    """
    Lee un MobileAssistantBU.db de DIARCO y extrae todos los picks
    dentro del rango de fechas dado (formato YYYYMMDD).

    Retorna:
        picks   → lista de dicts con los campos necesarios para la tabla pick
        totales → dict {nombre_cliente: total_importe}
    """
    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
        f.write(db_bytes)
        tmp_path = f.name

    picks = []
    totales: dict = {}

    try:
        conn = sqlite3.connect(tmp_path)
        conn.row_factory = sqlite3.Row

        # Obtener todos los pedidos dentro del rango de fechas
        trans_rows = conn.execute(
            "SELECT TRANSID FROM mWTAMTrx WHERE SUBSTR(DATE,1,8) BETWEEN ? AND ? AND STATUS='1'",
            (fecha_desde, fecha_hasta),
        ).fetchall()

        for tr in trans_rows:
            transid = tr["TRANSID"]

            # Nombre del cliente (paso CTE)
            cte = conn.execute(
                "SELECT STEPSelDesc FROM mWTATrx WHERE TRANSID=? AND STEPCode='CTE' LIMIT 1",
                (transid,),
            ).fetchone()
            if not cte:
                continue
            nombre_cliente = (cte["STEPSelDesc"] or "").strip()

            # Localidad (paso DIR → Value3 = "CIUDAD, Provincia")
            dir_row = conn.execute(
                "SELECT Value3 FROM mWTATrx WHERE TRANSID=? AND STEPCode='DIR' LIMIT 1",
                (transid,),
            ).fetchone()
            localidad = _extract_city(dir_row["Value3"] if dir_row else None)

            # Total del pedido y código de cliente (paso GWS)
            gws = conn.execute(
                "SELECT STEPDesc, Value3 FROM mWTATrx WHERE TRANSID=? AND STEPCode='GWS' LIMIT 1",
                (transid,),
            ).fetchone()
            total_pedido = 0.0
            cod_cliente = ""
            if gws:
                try:
                    total_pedido = float(gws["Value3"] or 0)
                except (ValueError, TypeError):
                    pass
                # STEPDesc = "Pedido para: 744017 xu liyu"
                desc_parts = (gws["STEPDesc"] or "").replace("Pedido para:", "").strip().split(" ", 1)
                cod_cliente = desc_parts[0] if desc_parts else ""

            totales[nombre_cliente] = totales.get(nombre_cliente, 0.0) + total_pedido

            # Artículos del pedido (pasos GWS.ELEM)
            items = conn.execute(
                "SELECT STEPUID, STEPSelDesc, Value2, Value3 FROM mWTATrx WHERE TRANSID=? AND STEPCode='GWS.ELEM'",
                (transid,),
            ).fetchall()

            for item in items:
                cod_art = (item["STEPUID"] or "").strip()
                if not cod_art:
                    continue
                uxb, descrip_limpia = _parse_pack(item["STEPSelDesc"])
                if not _es_item_real(cod_art, descrip_limpia):
                    continue
                try:
                    uni = int(float(item["Value2"] or 0))
                except (ValueError, TypeError):
                    uni = 0
                if uni <= 0:
                    continue
                bul = uni // uxb if uxb > 0 else 0

                picks.append({
                    "cod_bar":  None,           # Sin barcode en Fase 1
                    "cod_art":  cod_art,
                    "descrip":  descrip_limpia,
                    "nombre":   nombre_cliente,
                    "cliente":  cod_cliente,
                    "localidad": localidad,
                    "uni":      uni,
                    "bul":      bul,
                    "uxb":      uxb,
                })

        conn.close()
    finally:
        os.unlink(tmp_path)

    return picks, totales


@router.get("/")
def list_semanas_diarco():
    with get_db() as cur:
        cur.execute(
            "SELECT id, nombre, created_at FROM semanas WHERE mayorista = %s ORDER BY created_at DESC",
            (MAYORISTA,),
        )
        return [dict(r) for r in cur.fetchall()]


@router.post("/importar")
async def importar_semana_diarco(
    nombre: str = Form(...),
    fecha_desde: str = Form(...),
    fecha_hasta: str = Form(...),
    archivos: List[UploadFile] = File(...),
):
    if len(fecha_desde) != 8 or not fecha_desde.isdigit():
        raise HTTPException(400, "fecha_desde debe estar en formato AAAAMMDD (ej: 20260501)")
    if len(fecha_hasta) != 8 or not fecha_hasta.isdigit():
        raise HTTPException(400, "fecha_hasta debe estar en formato AAAAMMDD (ej: 20260508)")

    all_picks: list = []
    totales_por_cliente: dict = {}

    for archivo in archivos:
        content = await archivo.read()
        picks, totales = _query_diarco_db(content, fecha_desde, fecha_hasta)
        all_picks.extend(picks)
        for cliente, monto in totales.items():
            totales_por_cliente[cliente] = totales_por_cliente.get(cliente, 0.0) + monto

    if not all_picks:
        raise HTTPException(400, "No se encontraron pedidos en ese rango de fechas. Verificá las fechas.")

    with get_db() as cur:
        # Lookup de todas las zonas (compartidas entre mayoristas)
        cur.execute("SELECT nombre FROM zonas")
        zonas_diarco = {r["nombre"] for r in cur.fetchall()}

        # Crear o reemplazar la semana
        cur.execute(
            """
            INSERT INTO semanas (nombre, mayorista) VALUES (%s, %s)
            ON CONFLICT (nombre, mayorista) DO UPDATE SET nombre = EXCLUDED.nombre
            RETURNING id
            """,
            (nombre, MAYORISTA),
        )
        cur.fetchone()

        # Borrar picks previos de esta semana
        cur.execute("DELETE FROM pick WHERE semana = %s", (nombre,))

        # Agregar zonas nuevas que no existan en DIARCO
        localidades_nuevas = {
            p["localidad"] for p in all_picks
            if p["localidad"] and p["localidad"] not in zonas_diarco
        }
        for loc in localidades_nuevas:
            cur.execute(
                "INSERT INTO zonas (nombre) VALUES (%s) ON CONFLICT (nombre) DO NOTHING",
                (loc,),
            )

        inserted = 0
        for p in all_picks:
            uni = p["uni"]
            importe_total = totales_por_cliente.get(p["nombre"], 0.0)
            cur.execute(
                """
                INSERT INTO pick
                    (cod_bar, cod_art, descrip, nombre, cliente, localidad,
                     uni, bul, uxb, cantidad_pickeada, estado, semana, importe_total, mayorista)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, 0, %s, %s, %s, 'diarco')
                """,
                (
                    p["cod_bar"],
                    p["cod_art"],
                    p["descrip"],
                    p["nombre"],
                    p["cliente"],
                    p["localidad"],
                    uni,
                    p["bul"],
                    p["uxb"],
                    f"entregado: 0/{uni} UNI",
                    nombre,
                    round(importe_total, 2),
                ),
            )
            inserted += 1

    return {
        "picks_importados": inserted,
        "semana": nombre,
        "mayorista": MAYORISTA,
        "clientes": len(totales_por_cliente),
    }


@router.delete("/{id}")
def delete_semana_diarco(id: int):
    with get_db() as cur:
        cur.execute(
            "DELETE FROM semanas WHERE id = %s AND mayorista = %s RETURNING nombre",
            (id, MAYORISTA),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Semana DIARCO no encontrada")
    return {"message": "Semana eliminada", "nombre": row["nombre"]}
