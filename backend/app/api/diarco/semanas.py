# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# DIARCO — Importación de semanas/picks
# Lee archivos MobileAssistantBU.db generados por la app de DIARCO (SQLite
# con estructura propia: mWTAMTrx, mWTATrx, mWTARep).
#
# Estructura relevante del .db de DIARCO:
#   mWTAMTrx  → una fila por pedido: TRANSID, DATE (YYYYMMDDHHMMSS), STATUS
#   mWTATrx   → pasos de cada pedido:
#     STEPCode='CTE'         → STEPSelDesc = nombre oficial del cliente en DIARCO
#     STEPCode='OBSERVACION' → STEPSelDesc = nombre propio del local (ej: 'PARAVATTI "A"')
#                              Se usa como nombre en el pick; fallback a CTE si está vacío.
#     STEPCode='GWS'         → STEPDesc = "Pedido para: {cod} {nombre}", Value3 = total $
#     STEPCode='DIR'         → Value3 = "CIUDAD, Provincia" (localidad del cliente)
#     STEPCode='GWS.ELEM'    → STEPUID = código DIARCO del artículo,
#                              STEPSelDesc = descripción con "(fp: X / YB)",
#                              Value2 = cantidad pedida
#   mWTARep WHERE Key1='CDB' → barcodes por artículo:
#     STEPUID (13 dígitos) = EAN-13 de la unidad  → pick.cod_bar
#     STEPUID (14 dígitos) = EAN-14 del bulto cerrado → pick.cod_bar_bulto
#     Value1 = código DIARCO del artículo (STEPUID de GWS.ELEM)
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
    Extrae uxb y el flag 'valor en bultos' del formato '(fp: X / YB)' en la descripción DIARCO.

    Reglas del campo Value2 en mWTATrx GWS.ELEM:
      - X == Y → factor=1 (no hay caja madre): Value2 está en UNIDADES, uxb = X
                  Ej: fp: 24/24B → uxb=24, Value2=24 → uni=24 (1 bulto)
      - X >  Y → factor>1: Value2 está en BULTOS, uxb = X ÷ Y
                  Ej: fp: 72/6B  → uxb=12, Value2=3 → uni=3×12=36 (3 bultos)

    Retorna: (uxb, qty_en_bultos, descrip_limpia)
      qty_en_bultos=True  → multiplicar Value2 × uxb para obtener uni
      qty_en_bultos=False → Value2 ya es uni
    """
    match = re.search(r'\(fp:\s*(\d+)\s*/\s*(\d+)B\)', descrip or "")
    if match:
        x = int(match.group(1))
        y = int(match.group(2))
        factor_mayor_a_uno = x > y
        uxb = x if not factor_mayor_a_uno else (x // y if y > 0 else x)
        clean = descrip[:match.start()].strip()
        return uxb, factor_mayor_a_uno, clean
    return 0, False, (descrip or "").strip()


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

        # ── Barcodes: construir lookup cod_art → (EAN-13, EAN-14) ──────────
        # mWTARep con Key1='CDB': STEPUID = barcode, Value1 = cod_art DIARCO
        barcodes_13: dict = {}  # cod_art → EAN-13 (unidad)
        barcodes_14: dict = {}  # cod_art → EAN-14 (bulto cerrado)
        for row in conn.execute(
            "SELECT TRIM(STEPUID) AS ean, TRIM(Value1) AS cod FROM mWTARep WHERE Key1='CDB'"
        ).fetchall():
            ean, cod = row["ean"], row["cod"]
            if not ean or not ean.isdigit() or int(ean) == 0:
                continue
            if len(ean) == 13 and cod not in barcodes_13:
                barcodes_13[cod] = ean
            elif len(ean) == 14 and cod not in barcodes_14:
                barcodes_14[cod] = ean

        # Obtener todos los pedidos dentro del rango de fechas
        # STATUS='1' = pedido tomado, STATUS='S' = sincronizado (enviado al servidor)
        # Ambos representan pedidos válidos y completos
        trans_rows = conn.execute(
            "SELECT TRANSID FROM mWTAMTrx WHERE SUBSTR(DATE,1,8) BETWEEN ? AND ? AND STATUS != ''",
            (fecha_desde, fecha_hasta),
        ).fetchall()

        for tr in trans_rows:
            transid = tr["TRANSID"]

            # Nombre oficial del cliente (paso CTE)
            cte = conn.execute(
                "SELECT STEPSelDesc FROM mWTATrx WHERE TRANSID=? AND STEPCode='CTE' LIMIT 1",
                (transid,),
            ).fetchone()
            if not cte:
                continue
            nombre_cte = (cte["STEPSelDesc"] or "").strip()

            # Nombre propio del local (paso OBSERVACION) — puesto por el vendedor.
            # Ej: 'PARAVATTI "A"', 'GAUCHITO CORTADERAS "A"'. Fallback al nombre de CTE.
            obs = conn.execute(
                "SELECT STEPSelDesc FROM mWTATrx WHERE TRANSID=? AND STEPCode='OBSERVACION' LIMIT 1",
                (transid,),
            ).fetchone()
            nombre_obs = (obs["STEPSelDesc"] or "").strip() if obs else ""
            nombre_cliente = nombre_obs if nombre_obs else nombre_cte

            # Localidad (paso DIR → Value3 = "CIUDAD, Provincia")
            dir_row = conn.execute(
                "SELECT Value3 FROM mWTATrx WHERE TRANSID=? AND STEPCode='DIR' LIMIT 1",
                (transid,),
            ).fetchone()
            localidad = _extract_city(dir_row["Value3"] if dir_row else None)

            # Código de cliente (paso GWS) + total sin IVA de la orden completa
            gws = conn.execute(
                "SELECT STEPDesc, Formula FROM mWTATrx WHERE TRANSID=? AND STEPCode='GWS' LIMIT 1",
                (transid,),
            ).fetchone()
            cod_cliente = ""
            total_orden_sin_iva = 0.0
            if gws:
                desc_parts = (gws["STEPDesc"] or "").replace("Pedido para:", "").strip().split(" ", 1)
                cod_cliente = desc_parts[0] if desc_parts else ""
                try:
                    total_orden_sin_iva = float(gws["Formula"] or 0)
                except (ValueError, TypeError):
                    pass

            # Total con IVA de la orden completa (paso GWS.Value3)
            gws_v3_row = conn.execute(
                "SELECT Value3 FROM mWTATrx WHERE TRANSID=? AND STEPCode='GWS' LIMIT 1",
                (transid,),
            ).fetchone()
            total_orden_con_iva = 0.0
            if gws_v3_row:
                try:
                    total_orden_con_iva = float(gws_v3_row["Value3"] or 0)
                except (ValueError, TypeError):
                    pass

            importe_excluidos_con_iva = 0.0  # acumula el con-IVA de ítems excluidos (heladera, etc.)

            # Artículos del pedido (pasos GWS.ELEM)
            # Formula × V2 × V4 = total sin IVA del ítem
            items = conn.execute(
                "SELECT STEPUID, STEPSelDesc, Value2, Value4, Formula FROM mWTATrx WHERE TRANSID=? AND STEPCode='GWS.ELEM'",
                (transid,),
            ).fetchall()

            for item in items:
                cod_art = (item["STEPUID"] or "").strip()
                if not cod_art:
                    continue
                uxb, qty_en_bultos, descrip_limpia = _parse_pack(item["STEPSelDesc"])
                if not _es_item_real(cod_art, descrip_limpia):
                    # Ítem excluido del pick (heladera exhibidora, semáforo, etc.)
                    # Por cada unidad pedida se resta su precio con IVA del total del cliente.
                    # Solo aplica a ítems con cod_art numérico (los de sistema como Semaforo = 0 precio).
                    if cod_art.isdigit():
                        try:
                            qty_excluido = int(float(item["Value2"] or 0))
                        except (ValueError, TypeError):
                            qty_excluido = 0
                        if qty_excluido > 0:
                            # Precio con IVA por unidad: buscar en mWTARep del cliente.
                            # mWTARep.Value1 = precio sin IVA, Value9 = cat. IVA ('2'→10.5%, '1'→21%)
                            rep = conn.execute(
                                "SELECT Value1, Value9 FROM mWTARep "
                                "WHERE TRIM(STEPUID)=? AND TRIM(Key2)=? "
                                "AND CAST(TRIM(Value1) AS REAL) > 0 LIMIT 1",
                                (cod_art, cod_cliente.strip()),
                            ).fetchone()
                            if rep:
                                try:
                                    precio_sin_iva = float(rep["Value1"])
                                    iva_factor = 1.105 if str(rep["Value9"] or "").strip() == "2" else 1.21
                                    importe_excluidos_con_iva += precio_sin_iva * iva_factor * qty_excluido
                                except (ValueError, TypeError):
                                    pass
                    continue
                try:
                    qty = int(float(item["Value2"] or 0))
                except (ValueError, TypeError):
                    qty = 0
                if qty <= 0:
                    continue
                # Si factor>1: Value2 está en bultos → multiplicar por uxb para obtener unidades
                uni = qty * uxb if qty_en_bultos and uxb > 0 else qty
                bul = uni // uxb if uxb > 0 else 0

                pass  # el total real se calcula al final por diferencia con los excluidos

                picks.append({
                    "cod_bar":       barcodes_13.get(cod_art),   # EAN-13 (unidad)
                    "cod_bar_bulto": barcodes_14.get(cod_art),   # EAN-14 (bulto cerrado)
                    "cod_art":       cod_art,
                    "descrip":       descrip_limpia,
                    "nombre":        nombre_cliente,
                    "cliente":       cod_cliente,
                    "localidad":     localidad,
                    "uni":           uni,
                    "bul":           bul,
                    "uxb":           uxb,
                })

            # Total real con IVA = total_orden_con_iva − excluidos_con_iva
            # Los precios de ítems excluidos se obtienen de mWTARep (precio catálogo × factor IVA)
            # Esto replica exactamente: importe_total + IVA - heladera_c_iva
            importe_trans_con_iva = total_orden_con_iva - importe_excluidos_con_iva
            totales[nombre_cliente] = totales.get(nombre_cliente, 0.0) + importe_trans_con_iva

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
                    (cod_bar, cod_bar_bulto, cod_art, descrip, nombre, cliente, localidad,
                     uni, bul, uxb, cantidad_pickeada, estado, semana, importe_total, mayorista)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 0, %s, %s, %s, 'diarco')
                """,
                (
                    p["cod_bar"],
                    p["cod_bar_bulto"],
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
