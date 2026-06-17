import os
import time
import logging
import threading

logger = logging.getLogger(__name__)

# ── Paleta de colores (igual a excel_theme.py) ────────────────────────────────
_HDR_BG = {"red": 0.122, "green": 0.220, "blue": 0.392}  # #1F3864 NAVY
_HDR_FG = {"red": 1.0,   "green": 1.0,   "blue": 1.0}    # #FFFFFF blanco
_SEC_BG = {"red": 0.180, "green": 0.459, "blue": 0.714}  # #2E75B6 BLUE_MD (títulos sección)
_TOT_BG = {"red": 1.0,   "green": 0.976, "blue": 0.769}  # #FFF9C4 GOLD (filas TOTAL)
_BAND1  = {"red": 1.0,   "green": 1.0,   "blue": 1.0}    # #FFFFFF blanco
_BAND2  = {"red": 0.776, "green": 0.851, "blue": 0.945}  # #C6D9F1 ROW_ALT
_GREEN  = {"red": 0.204, "green": 0.659, "blue": 0.325}  # pestaña activa (verde)
_RED    = {"red": 0.800, "green": 0.267, "blue": 0.267}  # pestañas viejas (rojo)


def _get_spreadsheet(gc, mayorista: str):
    sheet_id = os.environ.get(f"GSHEET_ID_{mayorista.upper()}")
    if not sheet_id:
        logger.warning(f"gsheets: GSHEET_ID_{mayorista.upper()} no configurado")
        return None
    return gc.open_by_key(sheet_id)


def _get_or_clear_sheet(spreadsheet, tab_name: str, rows: int, cols: int):
    import gspread
    try:
        ws = spreadsheet.worksheet(tab_name)
        ws.clear()
    except gspread.WorksheetNotFound:
        ws = spreadsheet.add_worksheet(title=tab_name, rows=str(rows), cols=str(cols))
    # Mover siempre al índice 0 (pestaña más a la izquierda)
    spreadsheet.batch_update({"requests": [{"updateSheetProperties": {
        "properties": {"sheetId": ws.id, "index": 0},
        "fields": "index",
    }}]})
    return ws


def _update_tab_colors(spreadsheet, semana: str):
    """Pinta verde las pestañas del semana activo, rojo las demás."""
    try:
        requests = []
        for ws in spreadsheet.worksheets():
            color = _GREEN if semana in ws.title else _RED
            requests.append({"updateSheetProperties": {
                "properties": {"sheetId": ws.id,
                               "tabColorStyle": {"rgbColor": color}},
                "fields": "tabColorStyle",
            }})
        if requests:
            spreadsheet.batch_update({"requests": requests})
    except Exception as e:
        logger.warning(f"gsheets: no se pudieron actualizar colores de pestañas: {e}")


def _delete_filter_views(spreadsheet, sheet_id: int):
    """Elimina todos los filter views del sheet para evitar duplicados al re-subir."""
    try:
        resp = spreadsheet.client.request(
            "GET",
            f"https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet.id}",
            params={"fields": "sheets(properties/sheetId,filterViews/filterViewId)"},
        )
        data = resp.json()
        for sheet in data.get("sheets", []):
            if sheet.get("properties", {}).get("sheetId") == sheet_id:
                fvs = sheet.get("filterViews", [])
                if fvs:
                    spreadsheet.batch_update({"requests": [
                        {"deleteFilterView": {"filterId": fv["filterViewId"]}}
                        for fv in fvs
                    ]})
                return
    except Exception as e:
        logger.warning(f"gsheets: no se pudieron eliminar filter views: {e}")


def _delete_banded_ranges(spreadsheet, sheet_id: int):
    """Elimina todos los banded ranges del sheet para evitar duplicados al re-subir."""
    try:
        resp = spreadsheet.client.request(
            "GET",
            f"https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet.id}",
            params={"fields": "sheets(properties/sheetId,bandedRanges/bandedRangeId)"},
        )
        data = resp.json()
        for sheet in data.get("sheets", []):
            if sheet.get("properties", {}).get("sheetId") == sheet_id:
                banded = sheet.get("bandedRanges", [])
                if banded:
                    spreadsheet.batch_update({"requests": [
                        {"deleteBanding": {"bandedRangeId": br["bandedRangeId"]}}
                        for br in banded
                    ]})
                return
    except Exception as e:
        logger.warning(f"gsheets: no se pudieron eliminar banded ranges: {e}")


def _apply_table_format(spreadsheet, ws, num_data_rows: int, num_cols: int, col_formats: dict = None):
    """
    Filtro básico, freeze, header destacado, filas alternadas y auto-ajuste de ancho.

    col_formats: {0-indexed_col: format_pattern} para filas de datos (excluye header).
    Patrones con $ → CURRENCY, con % → PERCENT, resto → NUMBER.
    """
    sid = ws.id
    end_row = num_data_rows + 1  # 0-indexed exclusivo: header + datos

    # Limpiar banded ranges anteriores antes de agregar uno nuevo
    _delete_banded_ranges(spreadsheet, sid)

    requests = [
        # Filtro básico sobre la tabla
        {"setBasicFilter": {"filter": {"range": {
            "sheetId": sid,
            "startRowIndex": 0, "endRowIndex": end_row,
            "startColumnIndex": 0, "endColumnIndex": num_cols,
        }}}},
        # Congelar fila de header
        {"updateSheetProperties": {"properties": {
            "sheetId": sid,
            "gridProperties": {"frozenRowCount": 1},
        }, "fields": "gridProperties.frozenRowCount"}},
        # Header: navy, texto blanco, negrita, fuente 10
        {"repeatCell": {
            "range": {"sheetId": sid, "startRowIndex": 0, "endRowIndex": 1,
                      "startColumnIndex": 0, "endColumnIndex": num_cols},
            "cell": {"userEnteredFormat": {
                "backgroundColor": _HDR_BG,
                "textFormat": {
                    "bold": True,
                    "fontSize": 10,
                    "foregroundColor": _HDR_FG,
                },
                "horizontalAlignment": "CENTER",
            }},
            "fields": "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)",
        }},
        # Auto-ajuste de ancho de columnas
        {"autoResizeDimensions": {"dimensions": {
            "sheetId": sid,
            "dimension": "COLUMNS",
            "startIndex": 0,
            "endIndex": num_cols,
        }}},
        # Filas alternadas (banded range — los colores siguen la posición visual,
        # no los datos, así que sobreviven el ordenamiento)
        {"addBanding": {"bandedRange": {
            "range": {
                "sheetId": sid,
                "startRowIndex": 0, "endRowIndex": end_row,
                "startColumnIndex": 0, "endColumnIndex": num_cols,
            },
            "rowProperties": {
                "headerColor":     _HDR_BG,
                "firstBandColor":  _BAND1,
                "secondBandColor": _BAND2,
            },
        }}},
    ]

    # Formatos numéricos por columna (solo filas de datos, sin header)
    if col_formats:
        for col_idx, pattern in col_formats.items():
            if "%" in pattern:
                fmt_type = "PERCENT"
            elif "$" in pattern:
                fmt_type = "CURRENCY"
            else:
                fmt_type = "NUMBER"
            requests.append({"repeatCell": {
                "range": {
                    "sheetId": sid,
                    "startRowIndex": 1,
                    "endRowIndex": end_row,
                    "startColumnIndex": col_idx,
                    "endColumnIndex": col_idx + 1,
                },
                "cell": {"userEnteredFormat": {
                    "numberFormat": {"type": fmt_type, "pattern": pattern}
                }},
                "fields": "userEnteredFormat.numberFormat",
            }})

    # Fila TOTAL: fondo gold, negrita
    requests.append({"repeatCell": {
        "range": {"sheetId": sid,
                  "startRowIndex": end_row, "endRowIndex": end_row + 1,
                  "startColumnIndex": 0, "endColumnIndex": num_cols},
        "cell": {"userEnteredFormat": {
            "backgroundColor": _TOT_BG,
            "textFormat": {"bold": True},
        }},
        "fields": "userEnteredFormat(backgroundColor,textFormat)",
    }})

    spreadsheet.batch_update({"requests": requests})


def _apply_mod_sections_format(spreadsheet, ws, title_row: int, hdr_row: int,
                                   data_start: int, data_end: int, total_row: int):
    """Aplica formato a las secciones COMPROBANTES y NOVEDADES del MOD DIARCO.

    Todos los parámetros de fila son 1-indexed (como en Sheets UI).
    Google Sheets solo permite un setBasicFilter por hoja (ya usado en la tabla
    principal), así que las secciones usan Filter Views accesibles desde
    Menú → Ver → Vistas de filtro → COMPROBANTES / NOVEDADES.
    """
    sid  = ws.id
    ti   = title_row - 1
    hi   = hdr_row - 1
    di   = data_start - 1
    dend = total_row          # 0-indexed exclusivo (total_row - 1 + 1)

    def _brd():
        return {"style": "SOLID", "width": 1,
                "color": {"red": 0.788, "green": 0.788, "blue": 0.788}}

    # Limpiar filter views anteriores antes de crear los nuevos
    _delete_filter_views(spreadsheet, sid)

    def _no_brd():
        return {"style": "NONE"}

    requests = [
        # Borrar bordes viejos en toda la zona de secciones (desde el fin real de la tabla de clientes)
        # ws.clear() no borra formateo, así que bordes de subidas anteriores persisten
        {"updateBorders": {
            "range": {"sheetId": sid,
                      "startRowIndex": title_row - 12, "endRowIndex": 300,
                      "startColumnIndex": 0, "endColumnIndex": 5},
            "top": _no_brd(), "bottom": _no_brd(), "left": _no_brd(),
            "right": _no_brd(), "innerHorizontal": _no_brd(), "innerVertical": _no_brd(),
        }},
        {"updateBorders": {
            "range": {"sheetId": sid,
                      "startRowIndex": title_row - 12, "endRowIndex": 300,
                      "startColumnIndex": 6, "endColumnIndex": 18},
            "top": _no_brd(), "bottom": _no_brd(), "left": _no_brd(),
            "right": _no_brd(), "innerHorizontal": _no_brd(), "innerVertical": _no_brd(),
        }},
        # Título "COMPROBANTES" — solo A:E (sin azul en col F), BLUE_MD como en Excel
        {"repeatCell": {
            "range": {"sheetId": sid,
                      "startRowIndex": ti, "endRowIndex": ti + 1,
                      "startColumnIndex": 0, "endColumnIndex": 5},
            "cell": {"userEnteredFormat": {
                "backgroundColor": _SEC_BG,
                "textFormat": {"bold": True, "fontSize": 10, "foregroundColor": _HDR_FG},
            }},
            "fields": "userEnteredFormat(backgroundColor,textFormat)",
        }},
        # Título "NOVEDADES" — solo G:R (sin azul en col F), BLUE_MD como en Excel
        {"repeatCell": {
            "range": {"sheetId": sid,
                      "startRowIndex": ti, "endRowIndex": ti + 1,
                      "startColumnIndex": 6, "endColumnIndex": 18},
            "cell": {"userEnteredFormat": {
                "backgroundColor": _SEC_BG,
                "textFormat": {"bold": True, "fontSize": 10, "foregroundColor": _HDR_FG},
            }},
            "fields": "userEnteredFormat(backgroundColor,textFormat)",
        }},
        # Headers COMPROBANTES (A:E) — NAVY como tabla principal
        {"repeatCell": {
            "range": {"sheetId": sid,
                      "startRowIndex": hi, "endRowIndex": hi + 1,
                      "startColumnIndex": 0, "endColumnIndex": 5},
            "cell": {"userEnteredFormat": {
                "backgroundColor": _HDR_BG,
                "textFormat": {"bold": True, "fontSize": 10, "foregroundColor": _HDR_FG},
                "horizontalAlignment": "CENTER",
            }},
            "fields": "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)",
        }},
        # Headers NOVEDADES (G:R) — NAVY como tabla principal
        {"repeatCell": {
            "range": {"sheetId": sid,
                      "startRowIndex": hi, "endRowIndex": hi + 1,
                      "startColumnIndex": 6, "endColumnIndex": 18},
            "cell": {"userEnteredFormat": {
                "backgroundColor": _HDR_BG,
                "textFormat": {"bold": True, "fontSize": 10, "foregroundColor": _HDR_FG},
                "horizontalAlignment": "CENTER",
            }},
            "fields": "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)",
        }},
        # Banded range COMPROBANTES (A:E)
        {"addBanding": {"bandedRange": {
            "range": {"sheetId": sid,
                      "startRowIndex": hi, "endRowIndex": dend,
                      "startColumnIndex": 0, "endColumnIndex": 5},
            "rowProperties": {
                "headerColor":     _HDR_BG,
                "firstBandColor":  _BAND1,
                "secondBandColor": _BAND2,
            },
        }}},
        # Banded range NOVEDADES (G:R)
        {"addBanding": {"bandedRange": {
            "range": {"sheetId": sid,
                      "startRowIndex": hi, "endRowIndex": dend,
                      "startColumnIndex": 6, "endColumnIndex": 18},
            "rowProperties": {
                "headerColor":     _HDR_BG,
                "firstBandColor":  _BAND1,
                "secondBandColor": _BAND2,
            },
        }}},
        # Bordes COMPROBANTES (A:E, header → total)
        {"updateBorders": {
            "range": {"sheetId": sid,
                      "startRowIndex": hi, "endRowIndex": dend,
                      "startColumnIndex": 0, "endColumnIndex": 5},
            "top": _brd(), "bottom": _brd(), "left": _brd(), "right": _brd(),
            "innerHorizontal": _brd(), "innerVertical": _brd(),
        }},
        # Bordes NOVEDADES (G:R, header → total)
        {"updateBorders": {
            "range": {"sheetId": sid,
                      "startRowIndex": hi, "endRowIndex": dend,
                      "startColumnIndex": 6, "endColumnIndex": 18},
            "top": _brd(), "bottom": _brd(), "left": _brd(), "right": _brd(),
            "innerHorizontal": _brd(), "innerVertical": _brd(),
        }},
        # Filter view CLIENTES — tabla principal (permite volver desde NOVEDADES/COMPROBANTES)
        {"addFilterView": {"filter": {
            "title": "CLIENTES",
            "range": {"sheetId": sid,
                      "startRowIndex": 0, "endRowIndex": title_row - 12,
                      "startColumnIndex": 0, "endColumnIndex": 18},
        }}},
        # Filter view COMPROBANTES (ordenar/filtrar: Ver → Vistas de filtro → COMPROBANTES)
        {"addFilterView": {"filter": {
            "title": "COMPROBANTES",
            "range": {"sheetId": sid,
                      "startRowIndex": hi, "endRowIndex": dend,
                      "startColumnIndex": 0, "endColumnIndex": 5},
        }}},
        # Filter view NOVEDADES
        {"addFilterView": {"filter": {
            "title": "NOVEDADES",
            "range": {"sheetId": sid,
                      "startRowIndex": hi, "endRowIndex": dend,
                      "startColumnIndex": 6, "endColumnIndex": 18},
        }}},
        # Col E (MONTO COMPROBANTES) — moneda, datos + total
        {"repeatCell": {
            "range": {"sheetId": sid, "startRowIndex": di, "endRowIndex": dend,
                      "startColumnIndex": 4, "endColumnIndex": 5},
            "cell": {"userEnteredFormat": {"numberFormat": {"type": "CURRENCY", "pattern": "$#,##0.00"}}},
            "fields": "userEnteredFormat.numberFormat",
        }},
        # Col L (UNID. NOVEDADES) — entero, solo filas de datos
        {"repeatCell": {
            "range": {"sheetId": sid, "startRowIndex": di, "endRowIndex": dend - 1,
                      "startColumnIndex": 11, "endColumnIndex": 12},
            "cell": {"userEnteredFormat": {"numberFormat": {"type": "NUMBER", "pattern": "#,##0"}}},
            "fields": "userEnteredFormat.numberFormat",
        }},
        # Col M ($ x UNID NOVEDADES) — moneda, solo filas de datos
        {"repeatCell": {
            "range": {"sheetId": sid, "startRowIndex": di, "endRowIndex": dend - 1,
                      "startColumnIndex": 12, "endColumnIndex": 13},
            "cell": {"userEnteredFormat": {"numberFormat": {"type": "CURRENCY", "pattern": "$#,##0.00"}}},
            "fields": "userEnteredFormat.numberFormat",
        }},
        # Col N (TOTAL NOVEDADES) — moneda, datos + total
        {"repeatCell": {
            "range": {"sheetId": sid, "startRowIndex": di, "endRowIndex": dend,
                      "startColumnIndex": 13, "endColumnIndex": 14},
            "cell": {"userEnteredFormat": {"numberFormat": {"type": "CURRENCY", "pattern": "$#,##0.00"}}},
            "fields": "userEnteredFormat.numberFormat",
        }},
        # Fila TOTAL COMPROBANTES (A:E) — gold, negrita
        {"repeatCell": {
            "range": {"sheetId": sid,
                      "startRowIndex": dend - 1, "endRowIndex": dend,
                      "startColumnIndex": 0, "endColumnIndex": 5},
            "cell": {"userEnteredFormat": {
                "backgroundColor": _TOT_BG,
                "textFormat": {"bold": True},
            }},
            "fields": "userEnteredFormat(backgroundColor,textFormat)",
        }},
        # Fila TOTAL NOVEDADES (G:R) — gold, negrita
        {"repeatCell": {
            "range": {"sheetId": sid,
                      "startRowIndex": dend - 1, "endRowIndex": dend,
                      "startColumnIndex": 6, "endColumnIndex": 18},
            "cell": {"userEnteredFormat": {
                "backgroundColor": _TOT_BG,
                "textFormat": {"bold": True},
            }},
            "fields": "userEnteredFormat(backgroundColor,textFormat)",
        }},
        # Auto-ajuste ancho A:T
        {"autoResizeDimensions": {"dimensions": {
            "sheetId": sid, "dimension": "COLUMNS",
            "startIndex": 0, "endIndex": 20,
        }}},
    ]
    spreadsheet.batch_update({"requests": requests})


def _auth():
    import gspread
    sa_path = os.environ.get("GOOGLE_SA_PATH")
    if not sa_path or not os.path.exists(sa_path):
        logger.warning("gsheets: GOOGLE_SA_PATH no configurado o no encontrado")
        return None
    return gspread.service_account(filename=sa_path)


# Formatos de columna para MOD (0-indexed)
# 6=TOTAL YAG/DRCO, 7=%, 8=COMISION EBD, 9=ALIMENTOS,
# 10=FERNET, 11=TABACO, 12=TOTAL, 13=FT, 14=BCO, 15=NOVEDADES, 16=SALDO, 17=VENDEDOR
_MOD_COL_FORMATS = {
    6:  "$#,##0.00",  # TOTAL YAG/DRCO
    7:  "0%",         # %
    8:  "$#,##0.00",  # COMISION EBD
    9:  "$#,##0.00",  # ALIMENTOS
    10: "$#,##0.00",  # FERNET
    11: "$#,##0.00",  # TABACO
    12: "$#,##0.00",  # TOTAL
    13: "$#,##0.00",  # FT
    14: "$#,##0.00",  # BCO
    15: "$#,##0.00",  # NOVEDADES
    16: "$#,##0.00",  # SALDO
}

# Formatos de columna para PICK (0-indexed)
# 7=Uni pedidas, 8=Bultos, 9=Uni x bulto, 10=Uni entregadas,
# 11=% entregado (valor decimal, ej. 0.755 → muestra 75.5%), 13=Importe pedido
_PICK_COL_FORMATS = {
    7:  "#,##0",
    8:  "#,##0",
    9:  "#,##0",
    10: "#,##0",
    11: "0.0%",
    13: "$#,##0.00",
}


# ── Sync novedades ────────────────────────────────────────────────────────────

def _compute_nov_section_pos(mayorista: str, semana: str):
    """Calcula posición de la sección NOVEDADES en el sheet MOD a partir de la DB."""
    try:
        from app.db.database import get_db
        with get_db() as cur:
            cur.execute("""
                SELECT COUNT(DISTINCT p.cliente) AS n
                FROM pick p
                JOIN clientes_yaguar cy ON cy.id_yaguar = p.cliente AND cy.mayorista = %s
                WHERE p.semana = %s AND p.mayorista = %s
                  AND cy.nombre IS NOT NULL AND cy.nombre <> ''
            """, (mayorista, semana, mayorista))
            counts = dict(cur.fetchone())
        n  = int(counts.get("n") or 0)
        last_data      = max(n + 11, 49)  # debe coincidir con _upload_mod_bg (10 filas extra)
        sec_title_row  = last_data + 12   # tr(+1) + bloque TOTALES/VENDEDORES(min 8) + gap + 1
        sec_hdr_row    = sec_title_row + 1
        sec_data_start = sec_hdr_row + 1
        sec_data_end   = sec_data_start + 89
        return {
            "sec_title_row":  sec_title_row,
            "sec_hdr_row":    sec_hdr_row,
            "sec_data_start": sec_data_start,
            "sec_data_end":   sec_data_end,
        }
    except Exception as e:
        logger.warning(f"gsheets: _compute_nov_section_pos {mayorista}/{semana}: {e}")
        return None


def _build_nov_row(nv_row: dict, r_num: int, id_to_price: dict, is_yaguar: bool) -> list:
    """Construye la lista de 13 valores (G:S) para una fila de novedad."""
    uxb_val   = nv_row["uxb"] or 0
    uni_tot   = (nv_row["bultos"] or 0) * uxb_val + (nv_row["unidades"] or 0)
    fecha     = nv_row["created_at"].strftime("%d/%m/%Y") if nv_row["created_at"] else ""
    es_fa     = nv_row.get("es_factura_a", False)
    zona_v    = ("A" if es_fa else "CF") if is_yaguar else ("53" if es_fa else "52")
    formula_n = f'=IF(L{r_num}*M{r_num}<>0,L{r_num}*M{r_num},"")'
    return [
        fecha,
        nv_row["cliente"] or "",
        "",
        nv_row["cod_art"] or "",
        nv_row["descrip"] or "",
        uni_tot if uni_tot > 0 else "",
        id_to_price.get(nv_row["id"], ""),
        formula_n,
        (nv_row["tipo"] or "").upper(),
        nv_row["cliente_nombre"] or "",
        zona_v,
        nv_row["observaciones"] or "",
        nv_row["id"],
    ]


def sync_novedades_to_sheet(mayorista: str, semana: str):
    """Sincroniza sección NOVEDADES del MOD sheet con la DB.

    Usa col S (oculta) como discriminador:
    - Fila con ID en col S  → propiedad de la app → actualizar libremente
    - Fila con datos sin ID → entrada manual     → no tocar nunca
    - Fila completamente vacía                   → slot libre para nuevas novedades
    """
    try:
        gc = _auth()
        if not gc:
            return
        spreadsheet = _get_spreadsheet(gc, mayorista)
        if not spreadsheet:
            return

        import gspread as _gs
        tab_name = f"MOD {semana}"[:100]
        try:
            ws = spreadsheet.worksheet(tab_name)
        except _gs.WorksheetNotFound:
            logger.info(f"gsheets: tab '{tab_name}' no existe, sync novedades omitido")
            return

        pos = _compute_nov_section_pos(mayorista, semana)
        if pos is None:
            return
        sec_data_start = pos["sec_data_start"]
        sec_data_end   = pos["sec_data_end"]
        is_yaguar      = mayorista == "yaguar"

        # Leer estado actual completo (G:S = 13 cols) con fórmulas para preservarlas
        try:
            raw = ws.get(
                f"G{sec_data_start}:S{sec_data_end}",
                value_render_option="FORMULA",
            )
        except Exception:
            raw = []

        def _norm(r):
            r = list(r) if r else []
            while len(r) < 13:
                r.append("")
            return r[:13]

        current = [_norm(raw[i] if i < len(raw) else []) for i in range(90)]

        # Clasificar cada fila y extraer precios preservados (col M = índice 6)
        id_to_price = {}
        statuses = []
        for row in current:
            col_s = str(row[12]).strip()
            if col_s:
                try:
                    app_id = int(float(col_s))
                    price  = str(row[6]).strip()
                    if price:
                        id_to_price[app_id] = price
                    statuses.append(("app", app_id))
                    continue
                except (ValueError, TypeError):
                    pass
            # Excluir índice 7 (col N = TOTAL, siempre fórmula automática):
            # filas "vacías" tienen esa fórmula y serían mal-clasificadas como "manual"
            if any(str(v).strip() for idx, v in enumerate(row[:12]) if idx != 7):
                statuses.append(("manual", None))
            else:
                statuses.append(("free", None))

        # Novedades de DB
        from app.db.database import get_db
        with get_db() as cur:
            cur.execute("""
                SELECT n.id, n.cod_art, n.descrip, n.cliente, n.cliente_nombre,
                       n.tipo, n.observaciones, n.unidades, n.bultos, n.uxb, n.created_at,
                       COALESCE(cy.es_factura_a, false) AS es_factura_a
                FROM novedades n
                LEFT JOIN clientes_yaguar cy
                    ON cy.id_yaguar = n.cliente AND cy.mayorista = n.mayorista
                WHERE n.mayorista = %s AND n.semana = %s
                ORDER BY n.created_at ASC LIMIT 90
            """, (mayorista, semana))
            novs = [dict(r) for r in cur.fetchall()]

        db_ids   = {nv["id"]: nv for nv in novs}
        placed   = {app_id for kind, app_id in statuses if kind == "app" and app_id in db_ids}
        unplaced = [nv for nv in novs if nv["id"] not in placed]

        rows_90 = []
        for i, (kind, app_id) in enumerate(statuses):
            r_num     = sec_data_start + i
            formula_n = f'=IF(L{r_num}*M{r_num}<>0,L{r_num}*M{r_num},"")'

            if kind == "manual":
                rows_90.append(current[i])
            elif kind == "app" and app_id in db_ids:
                rows_90.append(_build_nov_row(db_ids[app_id], r_num, id_to_price, is_yaguar))
            else:
                # Slot liberado (novedad eliminada) o slot libre
                if unplaced:
                    rows_90.append(_build_nov_row(unplaced.pop(0), r_num, id_to_price, is_yaguar))
                else:
                    rows_90.append([""] * 7 + [formula_n] + [""] * 4 + [""])

        ws.update(
            f"G{sec_data_start}:S{sec_data_end}",
            rows_90,
            value_input_option="USER_ENTERED",
        )
        logger.info(f"gsheets: novedades sync OK — {mayorista}/{semana} ({len(novs)} items)")

    except Exception as e:
        logger.error(f"gsheets: error sync novedades {mayorista}/{semana}: {e}")


def sync_novedades_to_sheet_bg(mayorista: str, semana: str):
    threading.Thread(
        target=sync_novedades_to_sheet,
        args=(mayorista, semana),
        daemon=True,
    ).start()


# ── MOD upload ────────────────────────────────────────────────────────────────

def _upload_mod_bg(semana: str, mayorista: str):
    try:
        gc = _auth()
        if not gc:
            return

        spreadsheet = _get_spreadsheet(gc, mayorista)
        if not spreadsheet:
            return

        from app.db.database import get_db
        with get_db() as cur:
            cur.execute("""
                SELECT cy.id_yaguar AS cod, cy.cod_sis, cy.nombre,
                       cy.telefono, cy.localidad,
                       MAX(p.importe_total) AS total,
                       COALESCE(cy.flete, 0) AS pct_flete, cy.vendedor
                FROM pick p
                JOIN clientes_yaguar cy
                    ON cy.id_yaguar = p.cliente AND cy.mayorista = %s
                WHERE p.semana = %s AND p.mayorista = %s
                  AND cy.nombre IS NOT NULL AND cy.nombre <> ''
                GROUP BY cy.id_yaguar, cy.cod_sis, cy.nombre,
                         cy.telefono, cy.localidad, cy.flete, cy.vendedor
                ORDER BY cy.nombre
            """, (mayorista, semana, mayorista))
            rows = [dict(r) for r in cur.fetchall()]

        if not rows:
            logger.info(f"gsheets: sin datos MOD para {mayorista}/{semana}, omitiendo")
            return

        tab_name   = f"MOD {semana}"[:100]
        sheet_rows = len(rows) + 200
        ws = _get_or_clear_sheet(spreadsheet, tab_name, sheet_rows, 20)

        is_yaguar  = mayorista == "yaguar"
        cod_label  = "COD YAG"      if is_yaguar else "COD DRCO"
        tot_label  = "TOTAL YAGUAR" if is_yaguar else "TOTAL DRCO"
        zona_label = "CF/A"         if is_yaguar else "ZONA"

        # Calcular posiciones temprano — necesarias para fórmulas SUMIF en tabla principal
        unique_vendors = list(dict.fromkeys([r["vendedor"] for r in rows if r.get("vendedor")]))
        n          = len(rows)
        nv         = len(unique_vendors)
        nv_block   = max(nv, 5)          # mínimo 5 filas para el bloque de vendedores
        first_data = 2
        last_data  = max(n + 11, 49)     # siempre 10 filas extra para ingreso manual
        tr         = last_data + 1
        saldo_row  = tr + nv_block + 3   # fila SALDO / TOTAL vendedores
        sec_title_row  = max(saldo_row + 3, tr + 11)
        sec_hdr_row    = sec_title_row + 1
        sec_data_start = sec_hdr_row + 1
        sec_data_end   = sec_data_start + 89
        sec_total_row  = sec_data_end + 1

        # Novedades existentes para pre-rellenar la sección al subir
        with get_db() as cur:
            cur.execute("""
                SELECT n.id, n.cod_art, n.descrip, n.cliente, n.cliente_nombre,
                       n.tipo, n.observaciones, n.unidades, n.bultos, n.uxb, n.created_at,
                       COALESCE(cy.es_factura_a, false) AS es_factura_a
                FROM novedades n
                LEFT JOIN clientes_yaguar cy
                    ON cy.id_yaguar = n.cliente AND cy.mayorista = n.mayorista
                WHERE n.mayorista = %s AND n.semana = %s
                ORDER BY n.created_at ASC LIMIT 90
            """, (mayorista, semana))
            novedades_rows = [dict(r) for r in cur.fetchall()]

        # ── Tabla principal (A:R = 18 cols) ────────────────────────────────────
        headers = ["FECHA", cod_label, "COD SIS", "NOMBRE", "TELEFONO", "LOCALIDAD",
                   tot_label, "%", "COMISION EBD", "ALIMENTOS", "FERNET", "TABACO", "TOTAL",
                   "FT", "BCO", "NOVEDADES", "SALDO", "VENDEDOR"]
        data = [headers]

        def _nov_formula(rn):
            return (
                f'=IFERROR(SUMIFS($P${sec_data_start}:$P${sec_data_end},'
                f'$H${sec_data_start}:$H${sec_data_end},B{rn},'
                f'$O${sec_data_start}:$O${sec_data_end},"<>CAMBIO"),"")'
            )

        for i, r in enumerate(rows):
            rn = first_data + i
            data.append([
                semana,
                r["cod"] or "",
                r["cod_sis"] or "",
                (r["nombre"]    or "").strip(),
                (r["telefono"]  or "").strip(),
                (r["localidad"] or "").strip(),
                float(r["total"]     or 0),          # G: TOTAL YAG/DRCO
                float(r["pct_flete"] or 0),          # H: %
                f'=IFERROR(G{rn}*H{rn},"")',        # I: COMISION EBD
                "",                                   # J: ALIMENTOS
                "",                                   # K: FERNET
                "",                                   # L: TABACO
                f'=IFERROR(I{rn}+G{rn}+J{rn}+K{rn}+L{rn},"")',  # M: TOTAL
                "",                                   # N: FT
                "",                                   # O: BCO
                _nov_formula(rn),                    # P: NOVEDADES
                f'=M{rn}-N{rn}-O{rn}-P{rn}',       # Q: SALDO
                (r["vendedor"] or "").strip(),       # R: VENDEDOR
            ])

        for j in range(last_data - (n + 1)):
            rn = first_data + n + j
            data.append([
                "", "", "", "", "", "",
                "",                                   # G: TOTAL (usuario rellena)
                "",                                   # H: %
                f'=IFERROR(G{rn}*H{rn},"")',        # I: COMISION EBD
                "", "", "",                           # J-L: ALIMENTOS, FERNET, TABACO
                f'=IFERROR(I{rn}+G{rn}+J{rn}+K{rn}+L{rn},"")',  # M: TOTAL
                "", "",                               # N-O: FT, BCO
                _nov_formula(rn),                    # P: NOVEDADES
                f'=M{rn}-N{rn}-O{rn}-P{rn}',       # Q: SALDO
                "",                                   # R: VENDEDOR
            ])

        data.append(["", "", "", "", "", "TOTAL",
                     f"=SUM(G{first_data}:G{last_data})", "",
                     f"=SUM(I{first_data}:I{last_data})",
                     f"=SUM(J{first_data}:J{last_data})",
                     f"=SUM(K{first_data}:K{last_data})",
                     f"=SUM(L{first_data}:L{last_data})",
                     f'=IFERROR(I{tr}+G{tr}+J{tr}+K{tr}+L{tr},"")',
                     f"=SUM(N{first_data}:N{last_data})",
                     f"=SUM(O{first_data}:O{last_data})",
                     f"=SUM(P{first_data}:P{last_data})",
                     f"=SUM(Q{first_data}:Q{last_data})",
                     ""])
        ws.update("A1", data, value_input_option="USER_ENTERED")

        # ── Bloque TOTALES (A:F) + VENDEDORES (G:J) — side-by-side ──────────────
        def _vrow(vi):
            if vi >= nv:
                return ["", "", "", ""]
            v = unique_vendors[vi]
            r = tr + 3 + vi
            return [
                v,
                f'=SUMIF($R${first_data}:$R${last_data},"{v}",$G${first_data}:$G${last_data})',
                f'=H{r}/G{tr}',
                f'=H{r}*0.005',
            ]

        tot_label_str = "TOTAL YAGUAR" if is_yaguar else "TOTAL DIARCO"
        dev_tot_formula = (
            f'=IFERROR(SUMIF($O${sec_data_start}:$O${sec_data_end},"DEVOLUCION",'
            f'$N${sec_data_start}:$N${sec_data_end}),"")'
        )
        saldo_c = f'=IFERROR(C{tr+3}-C{tr+4}-C{tr+5}-C{tr+6}-C{tr+7},"")'
        saldo_e = f'=IFERROR(E{tr+6}-E{tr+7},"")'

        # Lado TOTALES (A:F): siempre 5 filas fijas; se rellena con vacíos si hay más vendedores
        totales_rows = [
            [tot_label_str,   "", f"=G{tr}",          "", "",        ""],
            ["COMPROBANTES",  "", f"=O{tr}",           "", "",        ""],
            ["DEVOLUCIONES",  "", dev_tot_formula,     "", "FT",      ""],
            ["FT A DEPOSITAR","", f"=E{tr+7}",         "", f"=N{tr}", ""],
            ["CREDITO",       "", "",                   "", "",        ""],
        ]
        while len(totales_rows) < nv_block:
            totales_rows.append(["", "", "", "", "", ""])

        block = (
            [["TOTALES", "", "", "", "", "", "VENDEDORES", "", "", "COMI x VTA 0.5%"]]
            + [totales_rows[i] + _vrow(i) for i in range(nv_block)]
            + [["", "SALDO", saldo_c, "", saldo_e, "",
                "TOTAL",
                f'=IFERROR(SUM(H{tr+3}:H{tr+2+nv}),"")',
                f'=IFERROR(SUM(I{tr+3}:I{tr+2+nv}),"")',
                f'=IFERROR(SUM(J{tr+3}:J{tr+2+nv}),"")']
            ]
        )
        ws.update(f"A{tr+2}", block, value_input_option="USER_ENTERED")
        _apply_table_format(spreadsheet, ws, last_data - 1, len(headers), _MOD_COL_FORMATS)

        # Resaltar en rojo las filas de clientes con flete = 0%
        zero_flete_rows = [
            first_data + i
            for i, r in enumerate(rows)
            if not r.get("pct_flete")
        ]
        if zero_flete_rows:
            _RED_BG = {"red": 1.0, "green": 0.800, "blue": 0.800}  # #FFCCCC
            spreadsheet.batch_update({"requests": [
                {"repeatCell": {
                    "range": {"sheetId": ws.id,
                              "startRowIndex": rn - 1, "endRowIndex": rn,
                              "startColumnIndex": 0, "endColumnIndex": len(headers)},
                    "cell": {"userEnteredFormat": {"backgroundColor": _RED_BG}},
                    "fields": "userEnteredFormat.backgroundColor",
                }}
                for rn in zero_flete_rows
            ]})

        # ── Formateo visual bloque TOTALES + VENDEDORES ─────────────────────────
        sid = ws.id

        def _rc(r1, r2, c1, c2, fmt, fields):
            """repeatCell helper (r1/r2 son 1-indexed, r2 es inclusivo)."""
            return {"repeatCell": {
                "range": {"sheetId": sid,
                          "startRowIndex": r1 - 1, "endRowIndex": r2,
                          "startColumnIndex": c1,  "endColumnIndex": c2},
                "cell": {"userEnteredFormat": fmt},
                "fields": fields,
            }}

        def _num(r1, r2, col, pattern, ftype):
            return _rc(r1, r2, col, col + 1,
                       {"numberFormat": {"type": ftype, "pattern": pattern}},
                       "userEnteredFormat.numberFormat")

        blk_reqs = [
            # Limpiar formato residual (fondo + texto + alineación) — cubre todo el bloque
            _rc(tr+2, saldo_row+1, 0, 20,
                {"backgroundColor": {"red": 1.0, "green": 1.0, "blue": 1.0},
                 "textFormat": {"foregroundColor": {"red": 0.0, "green": 0.0, "blue": 0.0},
                                "bold": False, "fontSize": 10},
                 "horizontalAlignment": "LEFT"},
                "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)"),
            # ── TOTALES ────────────────────────────────────────────────────────
            # Título "TOTALES" (tr+2, A:C) — navy
            _rc(tr+2, tr+2, 0, 3,
                {"backgroundColor": _HDR_BG,
                 "textFormat": {"bold": True, "fontSize": 10, "foregroundColor": _HDR_FG}},
                "userEnteredFormat(backgroundColor,textFormat)"),
            # Bandas alternadas datos TOTALES (tr+3:tr+7, A:C) — siempre 5 filas fijas
            *[_rc(r, r, 0, 3, {"backgroundColor": _BAND1 if i % 2 == 0 else _BAND2},
                  "userEnteredFormat.backgroundColor")
              for i, r in enumerate(range(tr+3, tr+8))],
            # Labels col A (tr+3:tr+7) — negrita
            _rc(tr+3, tr+7, 0, 1,
                {"textFormat": {"bold": True}},
                "userEnteredFormat.textFormat"),
            # Fila SALDO (saldo_row, A:C) — gold, negrita
            _rc(saldo_row, saldo_row, 0, 3,
                {"backgroundColor": _TOT_BG, "textFormat": {"bold": True}},
                "userEnteredFormat(backgroundColor,textFormat)"),
            # ── Col E: mini-sección FT ─────────────────────────────────────────
            # Header "FT" (tr+5, E) — navy
            _rc(tr+5, tr+5, 4, 5,
                {"backgroundColor": _HDR_BG,
                 "textFormat": {"bold": True, "foregroundColor": _HDR_FG}},
                "userEnteredFormat(backgroundColor,textFormat)"),
            # FT COBRADO (tr+6, E) — banda
            _rc(tr+6, tr+6, 4, 5, {"backgroundColor": _BAND2},
                "userEnteredFormat.backgroundColor"),
            # CREDITO (tr+7, E) — banda
            _rc(tr+7, tr+7, 4, 5, {"backgroundColor": _BAND1},
                "userEnteredFormat.backgroundColor"),
            # SALDO (saldo_row, E) — gold
            _rc(saldo_row, saldo_row, 4, 5,
                {"backgroundColor": _TOT_BG, "textFormat": {"bold": True}},
                "userEnteredFormat(backgroundColor,textFormat)"),
            # ── VENDEDORES ────────────────────────────────────────────────────
            # Header VENDEDORES (tr+2, G:J) — navy, blanco, negrita, centrado
            _rc(tr+2, tr+2, 6, 10,
                {"backgroundColor": _HDR_BG,
                 "textFormat": {"bold": True, "fontSize": 10, "foregroundColor": _HDR_FG},
                 "horizontalAlignment": "CENTER"},
                "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)"),
            # Bandas alternadas datos VENDEDORES (dinámico según nv_block)
            *[_rc(r, r, 6, 10, {"backgroundColor": _BAND1 if i % 2 == 0 else _BAND2},
                  "userEnteredFormat.backgroundColor")
              for i, r in enumerate(range(tr+3, tr+3+nv_block))],
            # Fila TOTAL vendedores (saldo_row, G:J) — gold, negrita
            _rc(saldo_row, saldo_row, 6, 10,
                {"backgroundColor": _TOT_BG, "textFormat": {"bold": True}},
                "userEnteredFormat(backgroundColor,textFormat)"),
            # ── Formatos numéricos ─────────────────────────────────────────────
            _num(tr+3, saldo_row, 2, "$#,##0.00", "CURRENCY"),  # TOTALES col C
            _num(tr+6, saldo_row, 4, "$#,##0.00", "CURRENCY"),  # TOTALES col E (FT/SALDO)
            _num(tr+3, saldo_row, 7, "$#,##0.00", "CURRENCY"),  # VENDEDORES col H
            _num(tr+3, saldo_row, 8, "0.0%",      "PERCENT"),   # VENDEDORES col I
            _num(tr+3, saldo_row, 9, "$#,##0.00", "CURRENCY"),  # VENDEDORES col J
        ]
        spreadsheet.batch_update({"requests": blk_reqs})

        # ── Secciones COMPROBANTES + NOVEDADES ─────────────────────────────────
        nov_data = (
            [["COMPROBANTES", "", "", "", ""]]
            + [["FECHA", "CLIENTE", "CUIT DEPOSITO", zona_label, "MONTO"]]
            + [["", "", "", "", ""] for _ in range(90)]
            + [["TOTAL", "", "", "", f"=SUM(E{sec_data_start}:E{sec_data_end})"]]
        )

        # NOVEDADES (cols G:S = 13 cols): col N = fórmula TOTAL, col S = ID oculto
        dev_rows = []
        for i in range(90):
            r_num     = sec_data_start + i
            formula_n = f'=IF(L{r_num}*M{r_num}<>0,L{r_num}*M{r_num},"")'
            if i < len(novedades_rows):
                nv_row  = novedades_rows[i]
                uxb_val = nv_row["uxb"] or 0
                uni_tot = (nv_row["bultos"] or 0) * uxb_val + (nv_row["unidades"] or 0)
                fecha   = nv_row["created_at"].strftime("%d/%m/%Y") if nv_row["created_at"] else ""
                es_fa   = nv_row.get("es_factura_a", False)
                zona_v  = ("A" if es_fa else "CF") if is_yaguar else ("53" if es_fa else "52")
                dev_rows.append([
                    fecha,
                    nv_row["cliente"] or "",
                    "",
                    nv_row["cod_art"] or "",
                    nv_row["descrip"] or "",
                    uni_tot if uni_tot > 0 else "",
                    "",
                    formula_n,
                    (nv_row["tipo"] or "").upper(),
                    nv_row["cliente_nombre"] or "",
                    zona_v,
                    nv_row["observaciones"] or "",
                    nv_row["id"],
                ])
            else:
                dev_rows.append([""] * 7 + [formula_n] + [""] * 4 + [""])

        dev_total = [""] * 12 + [""]
        dev_total[7] = f"=SUM(N{sec_data_start}:N{sec_data_end})"
        dev_data = (
            [["NOVEDADES"] + [""] * 12]
            + [["FECHA", "CLIENTE", "FACTURA", "COD", "DESCRIPCION",
                "UNID.", "$ x UNID", "TOTAL", "ESTADO",
                "NOMBRE CLIENTE", zona_label, "OBSERVACIONES", ""]]
            + dev_rows
            + [dev_total]
        )

        ws.update(f"A{sec_title_row}", nov_data, value_input_option="USER_ENTERED")
        ws.update(f"G{sec_title_row}", dev_data, value_input_option="USER_ENTERED")
        _apply_mod_sections_format(
            spreadsheet, ws,
            sec_title_row, sec_hdr_row, sec_data_start, sec_data_end, sec_total_row,
        )

        # Ocultar col S (índice 18) — tracking de IDs, no debe verse
        spreadsheet.batch_update({"requests": [{"updateDimensionProperties": {
            "range": {"sheetId": ws.id, "dimension": "COLUMNS",
                      "startIndex": 18, "endIndex": 19},
            "properties": {"hiddenByUser": True},
            "fields": "hiddenByUser",
        }}]})

        # Formato numérico para la fila TOTAL (tr) + auto-resize completo (A:S)
        final_reqs = []
        for col_idx, pattern in _MOD_COL_FORMATS.items():
            fmt_type = "PERCENT" if "%" in pattern else ("CURRENCY" if "$" in pattern else "NUMBER")
            final_reqs.append({"repeatCell": {
                "range": {"sheetId": ws.id,
                          "startRowIndex": tr - 1, "endRowIndex": tr,
                          "startColumnIndex": col_idx, "endColumnIndex": col_idx + 1},
                "cell": {"userEnteredFormat": {
                    "numberFormat": {"type": fmt_type, "pattern": pattern}
                }},
                "fields": "userEnteredFormat.numberFormat",
            }})
        final_reqs.append({"autoResizeDimensions": {"dimensions": {
            "sheetId": ws.id, "dimension": "COLUMNS", "startIndex": 0, "endIndex": 19,
        }}})
        spreadsheet.batch_update({"requests": final_reqs})

        _update_tab_colors(spreadsheet, semana)
        logger.info(f"gsheets: MOD {mayorista} subido — {tab_name} ({n} clientes)")

    except Exception as e:
        logger.error(f"gsheets: error subiendo MOD {mayorista}/{semana}: {e}")


# ── PICK upload ───────────────────────────────────────────────────────────────

def _upload_pick_bg(semana: str, mayorista: str):
    try:
        gc = _auth()
        if not gc:
            return

        spreadsheet = _get_spreadsheet(gc, mayorista)
        if not spreadsheet:
            return

        from app.db.database import get_db
        with get_db() as cur:
            cur.execute("""
                SELECT p.semana, p.cod_bar, p.cod_art, p.descrip, p.nombre,
                       p.localidad, COALESCE(z.reparto, '') AS reparto,
                       p.uni, p.bul, p.uxb, p.cantidad_pickeada, p.estado,
                       p.importe_total
                FROM pick p
                LEFT JOIN zonas z ON UPPER(p.localidad) = z.nombre
                LEFT JOIN repartos r ON z.reparto = r.nombre
                WHERE p.semana = %s AND p.mayorista = %s
                ORDER BY COALESCE(r.orden, 99) ASC, p.localidad ASC,
                         p.nombre ASC, p.descrip ASC
            """, (semana, mayorista))
            rows = [dict(r) for r in cur.fetchall()]

        if not rows:
            logger.info(f"gsheets: sin datos PICK para {mayorista}/{semana}, omitiendo")
            return

        tab_name = f"PICK {semana}"[:100]
        ws = _get_or_clear_sheet(spreadsheet, tab_name, len(rows) + 5, 14)

        headers = ["Semana", "Código barra", "Código art.", "Descripción",
                   "Cliente", "Zona", "Reparto", "Uni pedidas", "Bultos",
                   "Uni x bulto", "Uni entregadas", "% entregado", "Estado",
                   "Importe pedido"]
        data = [headers]

        for r in rows:
            uni      = r.get("uni") or 0
            pickeada = r.get("cantidad_pickeada") or 0
            # Valor decimal (ej. 0.755) para que el formato "0.0%" muestre 75.5%
            pct = round(pickeada / uni, 4) if uni > 0 else 0
            data.append([
                r.get("semana") or "",
                r.get("cod_bar") or "",
                r.get("cod_art") or "",
                r.get("descrip") or "",
                r.get("nombre") or "",
                r.get("localidad") or "",
                r.get("reparto") or "",
                uni,
                r.get("bul") or 0,
                r.get("uxb") or 0,
                pickeada,
                pct,
                r.get("estado") or "",
                float(r.get("importe_total") or 0),
            ])

        ws.update("A1", data, value_input_option="USER_ENTERED")
        _apply_table_format(spreadsheet, ws, len(rows), len(headers), _PICK_COL_FORMATS)
        spreadsheet.batch_update({"requests": [{"autoResizeDimensions": {"dimensions": {
            "sheetId": ws.id, "dimension": "COLUMNS", "startIndex": 0, "endIndex": 14,
        }}}]})
        _update_tab_colors(spreadsheet, semana)
        logger.info(f"gsheets: PICK {mayorista} subido — {tab_name} ({len(rows)} filas)")

    except Exception as e:
        logger.error(f"gsheets: error subiendo PICK {mayorista}/{semana}: {e}")


# ── Triggers públicos ─────────────────────────────────────────────────────────

def trigger_mod_upload(semana: str, mayorista: str):
    threading.Thread(target=_upload_mod_bg, args=(semana, mayorista), daemon=True).start()


def trigger_pick_upload(semana: str, mayorista: str):
    threading.Thread(target=_upload_pick_bg, args=(semana, mayorista), daemon=True).start()


def trigger_client_update(id_yaguar: str, mayorista: str):
    """Re-sube MOD y PICK únicamente de la última semana donde existe este cliente."""
    def _run():
        try:
            from app.db.database import get_db
            with get_db() as cur:
                cur.execute(
                    "SELECT p.semana FROM pick p "
                    "JOIN semanas s ON s.nombre = p.semana AND s.mayorista = p.mayorista "
                    "WHERE p.cliente = %s AND p.mayorista = %s ORDER BY s.id DESC LIMIT 1",
                    (id_yaguar, mayorista),
                )
                row = cur.fetchone()
            if not row:
                return
            semana = row["semana"]
            _upload_mod_bg(semana, mayorista)
            _upload_pick_bg(semana, mayorista)
        except Exception as e:
            logger.error(f"gsheets: error actualizando sheets cliente {id_yaguar}: {e}")
    threading.Thread(target=_run, daemon=True).start()


def _delete_sheets_bg(semana: str, mayorista: str):
    try:
        gc = _auth()
        if not gc:
            return
        spreadsheet = _get_spreadsheet(gc, mayorista)
        if not spreadsheet:
            return
        import gspread as _gs
        for prefix in ("MOD", "PICK"):
            try:
                ws = spreadsheet.worksheet(f"{prefix} {semana}"[:100])
                spreadsheet.del_worksheet(ws)
            except _gs.WorksheetNotFound:
                pass
        # Recolorear: detectar la semana más reciente (primer tab) y colorear
        # verde todos sus tabs (MOD + PICK) con _update_tab_colors
        remaining = spreadsheet.worksheets()
        if remaining:
            first_title = remaining[0].title
            if first_title.startswith("MOD "):
                new_semana = first_title[4:]
            elif first_title.startswith("PICK "):
                new_semana = first_title[5:]
            else:
                new_semana = first_title
            _update_tab_colors(spreadsheet, new_semana)
        logger.info(f"gsheets: hojas eliminadas — {mayorista}/{semana}")
    except Exception as e:
        logger.error(f"gsheets: error eliminando sheets {mayorista}/{semana}: {e}")


def trigger_delete_sheets(semana: str, mayorista: str):
    threading.Thread(target=_delete_sheets_bg, args=(semana, mayorista), daemon=True).start()
