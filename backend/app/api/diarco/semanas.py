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
import unicodedata
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


def _norm(texto: str) -> str:
    """Normaliza texto para comparación: mayúsculas, sin acentos, sin puntuación."""
    texto = texto.strip().upper()
    texto = ''.join(
        c for c in unicodedata.normalize('NFD', texto)
        if unicodedata.category(c) != 'Mn'
    )
    return re.sub(r'\s+', ' ', re.sub(r'[^A-Z0-9 ]', ' ', texto)).strip()


def _extraer_zona_obs(obs: str, zonas_norm: dict) -> tuple:
    """
    Intenta extraer la zona del campo OBSERVACION si el vendedor la anotó
    con un separador al final (ej: 'GAUCHITO.MERLO', 'MOCHO-merlo', 'FAMA_CARP').

    Separadores aceptados: . - _ / (se usa el último que aparezca).
    La zona se normaliza y se busca entre las zonas existentes:
      1. Match exacto (normalizado)
      2. Match parcial: la zona conocida empieza con el candidato o viceversa

    Retorna: (nombre_cliente, zona_nombre | None)
      zona_nombre = None si no hay separador o no se puede determinar la zona.
    """
    match = re.search(r'[.\-_/]([^.\-_/]{1,20})$', obs)
    if not match:
        return obs.strip(), None

    candidato = _norm(match.group(1))
    nombre = obs[:match.start()].strip()

    if not candidato or len(candidato) < 2:
        return obs.strip(), None

    # 1. Match exacto
    if candidato in zonas_norm:
        return nombre, zonas_norm[candidato]

    # 2. Match parcial: alguna zona conocida empieza con el candidato o viceversa
    for zona_norm, zona_orig in zonas_norm.items():
        if zona_norm.startswith(candidato) or candidato.startswith(zona_norm):
            return nombre, zona_orig

    # No encontrada → devolver el candidato como zona nueva (se creará al importar)
    return nombre, candidato


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


def _query_diarco_db(db_bytes: bytes, fecha_desde: str, fecha_hasta: str, zonas_norm: dict = None):
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

            # Localidad: intentar extraer del sufijo en OBSERVACION (ej: "GAUCHITO.MERLO")
            # Si no hay sufijo o no matchea, usar el paso DIR como fallback
            zona_desde_obs = None
            nombre_obs_limpio = ""  # OBSERVACION sin sufijo de zona (nunca CTE)
            if nombre_obs and zonas_norm is not None:
                nombre_cliente, zona_desde_obs = _extraer_zona_obs(nombre_obs, zonas_norm)
                nombre_obs_limpio = nombre_cliente  # OBSERVACION con zona removida
            else:
                # Si OBSERVACION está vacía usamos CTE como nombre de display,
                # pero nombre_obs_limpio queda vacío (no queremos mostrar el CTE en sin-registrar)
                nombre_cliente = nombre_obs if nombre_obs else nombre_cte
                nombre_obs_limpio = nombre_obs  # puede ser ""

            if zona_desde_obs:
                localidad = zona_desde_obs
            else:
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

            importe_excluidos_sin_iva = 0.0  # acumula sin IVA de ítems excluidos
            trans_start = len(picks)          # índice donde empiezan los picks de esta transacción

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
                    # Ítem excluido: acumular su precio SIN IVA usando Formula × V2 × V4
                    if cod_art.isdigit():
                        try:
                            excl_sin_iva = (float(item["Formula"] or 0)
                                            * float(item["Value2"] or 0)
                                            * float(item["Value4"] or 1))
                            importe_excluidos_sin_iva += excl_sin_iva
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

                try:
                    formula_sin_iva = float(item["Formula"] or 0)
                except (ValueError, TypeError):
                    formula_sin_iva = 0.0

                picks.append({
                    "cod_bar":         barcodes_13.get(cod_art),
                    "cod_bar_bulto":   barcodes_14.get(cod_art),
                    "cod_art":         cod_art,
                    "descrip":         descrip_limpia,
                    "nombre":          nombre_cliente,
                    "nombre_obs":      nombre_obs_limpio,
                    "cliente":         cod_cliente,
                    "localidad":       localidad,
                    "uni":             uni,
                    "bul":             bul,
                    "uxb":             uxb,
                    "_formula_sin_iva": formula_sin_iva,  # temporal, se reemplaza abajo
                    "precio_unit":     None,
                })
            trans_end = len(picks)

            # Convertir excluidos a con-IVA proporcionalmente:
            if total_orden_sin_iva > 0 and importe_excluidos_sin_iva > 0:
                iva_ratio = total_orden_con_iva / total_orden_sin_iva
                importe_excluidos_con_iva = importe_excluidos_sin_iva * iva_ratio
            else:
                iva_ratio = (total_orden_con_iva / total_orden_sin_iva) if total_orden_sin_iva > 0 else 1.0
                importe_excluidos_con_iva = 0.0
            importe_trans_con_iva = total_orden_con_iva - importe_excluidos_con_iva
            totales[cod_cliente] = totales.get(cod_cliente, 0.0) + importe_trans_con_iva

            # Aplicar iva_ratio a los picks de esta transacción
            for i in range(trans_start, trans_end):
                f = picks[i].pop("_formula_sin_iva", 0.0)
                picks[i]["precio_unit"] = round(f * iva_ratio, 4) if f else None

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

    # Cargar zonas existentes para el matching del sufijo en OBSERVACION
    with get_db() as cur:
        cur.execute("SELECT nombre FROM zonas")
        zonas_existentes = [r["nombre"] for r in cur.fetchall()]
    zonas_norm = {_norm(z): z for z in zonas_existentes}

    all_picks: list = []
    totales_por_cliente: dict = {}

    for archivo in archivos:
        content = await archivo.read()
        picks, totales = _query_diarco_db(content, fecha_desde, fecha_hasta, zonas_norm)
        all_picks.extend(picks)
        for cliente, monto in totales.items():
            totales_por_cliente[cliente] = totales_por_cliente.get(cliente, 0.0) + monto

    if not all_picks:
        raise HTTPException(400, "No se encontraron pedidos en ese rango de fechas. Verificá las fechas.")

    with get_db() as cur:
        zonas_diarco = set(zonas_existentes)

        # Mapa de clientes DIARCO registrados: cod → {nombre, localidad}
        cur.execute(
            "SELECT id_yaguar, nombre, localidad FROM clientes_yaguar WHERE id_yaguar IS NOT NULL AND mayorista = 'diarco'"
        )
        clientes_diarco = {str(r["id_yaguar"]): r for r in cur.fetchall()}

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

        # Resolver nombre y localidad por cliente
        # La localidad del DB de DIARCO es incorrecta — solo se usa la que ingresó el admin.
        sin_datos: dict = {}  # {cod: nombre_observacion} — clientes sin nombre en nuestra DB
        for p in all_picks:
            cod = str(p["cliente"]) if p["cliente"] else ""
            info = clientes_diarco.get(cod)
            if info and info["nombre"]:
                p["nombre"] = info["nombre"]
                p["localidad"] = info["localidad"]  # localidad ingresada por admin (correcta)
            else:
                # Cliente sin registrar: usar OBSERVACION como nombre temporal.
                # Localidad = NULL hasta que el admin la asigne (la del DIARCO es incorrecta).
                p["nombre"] = p["nombre_obs"]
                p["localidad"] = None
                if cod and cod not in sin_datos:
                    sin_datos[cod] = p["nombre_obs"]

        # Agregar zonas nuevas que no existan
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
            cod = str(p["cliente"]) if p["cliente"] else ""
            importe_total = totales_por_cliente.get(cod, 0.0)
            cur.execute(
                """
                INSERT INTO pick
                    (cod_bar, cod_bar_bulto, cod_art, descrip, nombre, cliente, localidad,
                     uni, bul, uxb, cantidad_pickeada, estado, semana, importe_total, mayorista, precio_unit)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 0, %s, %s, %s, 'diarco', %s)
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
                    p.get("precio_unit"),
                ),
            )
            inserted += 1

    clientes_sin_datos = [{"id": cod, "nombre": obs} for cod, obs in sin_datos.items()]

    return {
        "picks_importados": inserted,
        "semana": nombre,
        "mayorista": MAYORISTA,
        "clientes": len(totales_por_cliente),
        "clientes_sin_datos": clientes_sin_datos,
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
