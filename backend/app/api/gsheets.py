import os
import logging
import threading

logger = logging.getLogger(__name__)


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


def _apply_table_format(spreadsheet, ws, num_data_rows: int, num_cols: int, col_formats: dict = None):
    """Filtro básico, freeze, bold en headers, auto-ajuste de ancho y formatos por columna.

    col_formats: {0-indexed_col: format_pattern} para filas de datos (excluye header).
    Patrones con $ → CURRENCY, con % → PERCENT, resto → NUMBER.
    """
    sid = ws.id
    end_row = num_data_rows + 1  # 0-indexed exclusivo: header + datos

    requests = [
        {"setBasicFilter": {"filter": {"range": {
            "sheetId": sid,
            "startRowIndex": 0, "endRowIndex": end_row,
            "startColumnIndex": 0, "endColumnIndex": num_cols,
        }}}},
        {"updateSheetProperties": {"properties": {
            "sheetId": sid,
            "gridProperties": {"frozenRowCount": 1},
        }, "fields": "gridProperties.frozenRowCount"}},
        {"repeatCell": {
            "range": {"sheetId": sid, "startRowIndex": 0, "endRowIndex": 1,
                      "startColumnIndex": 0, "endColumnIndex": num_cols},
            "cell": {"userEnteredFormat": {"textFormat": {"bold": True}}},
            "fields": "userEnteredFormat.textFormat.bold",
        }},
        {"autoResizeDimensions": {"dimensions": {
            "sheetId": sid,
            "dimension": "COLUMNS",
            "startIndex": 0,
            "endIndex": num_cols,
        }}},
    ]

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

    spreadsheet.batch_update({"requests": requests})


def _auth():
    import gspread
    sa_path = os.environ.get("GOOGLE_SA_PATH")
    if not sa_path or not os.path.exists(sa_path):
        logger.warning("gsheets: GOOGLE_SA_PATH no configurado o no encontrado")
        return None
    return gspread.service_account(filename=sa_path)


# Formatos de columna para MOD (0-indexed)
# 6=TOTAL YAG/DRCO, 7=%, 8=COMISION EBD, 9=ALIMENTOS, 10=TOTAL, 11=FT, 12=BCO, 13=SALDO
_MOD_COL_FORMATS = {
    6:  "$#,##0.00",
    7:  "0%",
    8:  "$#,##0.00",
    9:  "$#,##0.00",
    10: "$#,##0.00",
    11: "$#,##0.00",
    12: "$#,##0.00",
    13: "$#,##0.00",
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

        tab_name = f"MOD {semana}"[:100]
        ws = _get_or_clear_sheet(spreadsheet, tab_name, len(rows) + 60, 20)

        is_yaguar  = mayorista == "yaguar"
        cod_label  = "COD YAG"      if is_yaguar else "COD DRCO"
        tot_label  = "TOTAL YAGUAR" if is_yaguar else "TOTAL DRCO"

        n          = len(rows)
        first_data = 2
        last_data  = n + 1
        tr         = last_data + 1
        vfirst     = tr + 3        # header vendedores en tr+2, datos desde tr+3

        headers = ["FECHA", cod_label, "COD SIS", "NOMBRE", "TELEFONO", "LOCALIDAD",
                   tot_label, "%", "COMISION EBD", "ALIMENTOS", "TOTAL",
                   "FT", "BCO", "SALDO", "VENDEDOR"]
        data = [headers]

        for i, r in enumerate(rows):
            rn = first_data + i
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
                f'=K{rn}-L{rn}-M{rn}',
                (r["vendedor"] or "").strip(),
            ])

        data.append(["", "", "", "", "", "TOTAL",
                     f"=SUM(G{first_data}:G{last_data})", "",
                     f"=SUM(I{first_data}:I{last_data})",
                     f"=SUM(J{first_data}:J{last_data})",
                     f'=IFERROR(I{tr}+G{tr}+J{tr},"")',
                     f"=SUM(L{first_data}:L{last_data})",
                     f"=SUM(M{first_data}:M{last_data})",
                     f"=SUM(N{first_data}:N{last_data})", ""])
        data.append([])
        data.append(["VENDEDORES", "", "TOTAL", "", "%", "", "COMI 0.5%"])

        unique_vendors = list(dict.fromkeys([r["vendedor"] for r in rows if r.get("vendedor")]))
        for vi, vendor in enumerate(unique_vendors):
            vrow = vfirst + vi
            data.append([
                vendor, "",
                f'=SUMIF($O${first_data}:$O${last_data},"{vendor}",$G${first_data}:$G${last_data})',
                "", f'=C{vrow}/G{tr}', "", f'=C{vrow}*0.005',
            ])

        ws.update("A1", data, value_input_option="USER_ENTERED")
        _apply_table_format(spreadsheet, ws, n, len(headers), _MOD_COL_FORMATS)
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
