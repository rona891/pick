import os
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
        return ws
    except gspread.WorksheetNotFound:
        return spreadsheet.add_worksheet(title=tab_name, rows=str(rows), cols=str(cols))


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
        # Borrar bordes viejos en toda la zona de secciones (filas 50-300)
        # ws.clear() no borra formateo, así que bordes de subidas anteriores persisten
        {"updateBorders": {
            "range": {"sheetId": sid,
                      "startRowIndex": 49, "endRowIndex": 300,
                      "startColumnIndex": 0, "endColumnIndex": 5},
            "top": _no_brd(), "bottom": _no_brd(), "left": _no_brd(),
            "right": _no_brd(), "innerHorizontal": _no_brd(), "innerVertical": _no_brd(),
        }},
        {"updateBorders": {
            "range": {"sheetId": sid,
                      "startRowIndex": 49, "endRowIndex": 300,
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
        # Auto-ajuste ancho A:R
        {"autoResizeDimensions": {"dimensions": {
            "sheetId": sid, "dimension": "COLUMNS",
            "startIndex": 0, "endIndex": 18,
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
# 6=TOTAL YAG/DRCO, 7=%, 8=COMISION EBD, 9=ALIMENTOS, 10=TOTAL, 11=FT, 12=BCO,
# 13=NOVEDADES, 14=SALDO  (VENDEDOR movió a col P = 15)
_MOD_COL_FORMATS = {
    6:  "$#,##0.00",
    7:  "0%",
    8:  "$#,##0.00",
    9:  "$#,##0.00",
    10: "$#,##0.00",
    11: "$#,##0.00",
    12: "$#,##0.00",
    13: "$#,##0.00",  # NOVEDADES (nuevo)
    14: "$#,##0.00",  # SALDO (movido de 13)
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
                SELECT COUNT(DISTINCT p.cliente) AS n,
                       COUNT(DISTINCT CASE WHEN cy.vendedor IS NOT NULL AND cy.vendedor <> ''
                                           THEN cy.vendedor END) AS nv
                FROM pick p
                JOIN clientes_yaguar cy ON cy.id_yaguar = p.cliente AND cy.mayorista = %s
                WHERE p.semana = %s AND p.mayorista = %s
                  AND cy.nombre IS NOT NULL AND cy.nombre <> ''
            """, (mayorista, semana, mayorista))
            counts = dict(cur.fetchone())
        n  = int(counts.get("n") or 0)
        nv = int(counts.get("nv") or 0)
        last_data      = max(n + 1, 49)
        sec_title_row  = last_data + 1 + 3 + nv + 2  # tr + vfirst-offset + nv + gap
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


def sync_novedades_to_sheet(mayorista: str, semana: str):
    """Sincroniza sección NOVEDADES del MOD sheet con la DB.

    Preserva precios manuales de col M usando col S (oculta) como tracking de ID.
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

        # Leer precios manuales (col M) y IDs (col S) para preservar precios
        try:
            m_vals = ws.get(f"M{sec_data_start}:M{sec_data_end}")
            s_vals = ws.get(f"S{sec_data_start}:S{sec_data_end}")
        except Exception:
            m_vals, s_vals = [], []

        from itertools import zip_longest
        id_to_price = {}
        for m_row, s_row in zip_longest(m_vals, s_vals, fillvalue=[]):
            price  = m_row[0] if m_row else ""
            nov_id = s_row[0] if s_row else ""
            if nov_id and price:
                try:
                    id_to_price[int(float(str(nov_id)))] = price
                except (ValueError, TypeError):
                    pass

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

        rows_90 = []
        for i in range(90):
            r_num     = sec_data_start + i
            formula_n = f'=IF(L{r_num}*M{r_num}<>0,L{r_num}*M{r_num},"")'
            if i < len(novs):
                nv_row  = novs[i]
                uxb_val = nv_row["uxb"] or 0
                uni_tot = (nv_row["bultos"] or 0) * uxb_val + (nv_row["unidades"] or 0)
                fecha   = nv_row["created_at"].strftime("%d/%m/%Y") if nv_row["created_at"] else ""
                es_fa   = nv_row.get("es_factura_a", False)
                zona_v  = ("A" if es_fa else "CF") if is_yaguar else ("53" if es_fa else "52")
                rows_90.append([
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
                ])
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
        first_data = 2
        last_data  = max(n + 1, 49)
        tr         = last_data + 1
        vfirst     = tr + 3
        nv_count   = len(unique_vendors)
        sec_title_row  = vfirst + nv_count + 2
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

        # ── Tabla principal (A:P = 16 cols) ────────────────────────────────────
        headers = ["FECHA", cod_label, "COD SIS", "NOMBRE", "TELEFONO", "LOCALIDAD",
                   tot_label, "%", "COMISION EBD", "ALIMENTOS", "TOTAL",
                   "FT", "BCO", "NOVEDADES", "SALDO", "VENDEDOR"]
        data = [headers]

        for i, r in enumerate(rows):
            rn = first_data + i
            nov_formula = (
                f'=IFERROR(SUMIF($H${sec_data_start}:$H${sec_data_end},'
                f'B{rn},$N${sec_data_start}:$N${sec_data_end}),"")'
            )
            data.append([
                semana,
                r["cod"] or "",
                r["cod_sis"] or "",
                (r["nombre"]    or "").strip(),
                (r["telefono"]  or "").strip(),
                (r["localidad"] or "").strip(),
                float(r["total"]     or 0),
                float(r["pct_flete"] or 0),
                f'=IFERROR(G{rn}*H{rn},"")',
                "",
                f'=IFERROR(I{rn}+G{rn}+J{rn},"")',
                "",
                "",
                nov_formula,
                f'=K{rn}-L{rn}-M{rn}-N{rn}',
                (r["vendedor"] or "").strip(),
            ])

        for _ in range(last_data - (n + 1)):
            data.append([""] * len(headers))

        data.append(["", "", "", "", "", "TOTAL",
                     f"=SUM(G{first_data}:G{last_data})", "",
                     f"=SUM(I{first_data}:I{last_data})",
                     f"=SUM(J{first_data}:J{last_data})",
                     f'=IFERROR(I{tr}+G{tr}+J{tr},"")',
                     f"=SUM(L{first_data}:L{last_data})",
                     f"=SUM(M{first_data}:M{last_data})",
                     f"=SUM(N{first_data}:N{last_data})",
                     f"=SUM(O{first_data}:O{last_data})",
                     ""])
        data.append([])
        data.append(["VENDEDORES", "", "TOTAL", "", "%", "", "COMI 0.5%"])

        for vi, vendor in enumerate(unique_vendors):
            vrow = vfirst + vi
            data.append([
                vendor, "",
                f'=SUMIF($P${first_data}:$P${last_data},"{vendor}",$G${first_data}:$G${last_data})',
                "", f'=C{vrow}/G{tr}', "", f'=C{vrow}*0.005',
            ])

        ws.update("A1", data, value_input_option="USER_ENTERED")
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

        if unique_vendors:
            sid  = ws.id
            v0   = vfirst - 1
            vend = v0 + len(unique_vendors)

            def _col_fmt(col, pattern, ftype):
                return {"repeatCell": {
                    "range": {"sheetId": sid,
                              "startRowIndex": v0, "endRowIndex": vend,
                              "startColumnIndex": col, "endColumnIndex": col + 1},
                    "cell": {"userEnteredFormat": {
                        "numberFormat": {"type": ftype, "pattern": pattern}
                    }},
                    "fields": "userEnteredFormat.numberFormat",
                }}

            spreadsheet.batch_update({"requests": [
                _col_fmt(2, "$#,##0.00", "CURRENCY"),
                _col_fmt(4, "0.0%",      "PERCENT"),
                _col_fmt(6, "$#,##0.00", "CURRENCY"),
            ]})

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
        logger.info(f"gsheets: PICK {mayorista} subido — {tab_name} ({len(rows)} filas)")

    except Exception as e:
        logger.error(f"gsheets: error subiendo PICK {mayorista}/{semana}: {e}")


# ── Triggers públicos ─────────────────────────────────────────────────────────

def trigger_mod_upload(semana: str, mayorista: str):
    threading.Thread(target=_upload_mod_bg, args=(semana, mayorista), daemon=True).start()


def trigger_pick_upload(semana: str, mayorista: str):
    threading.Thread(target=_upload_pick_bg, args=(semana, mayorista), daemon=True).start()
