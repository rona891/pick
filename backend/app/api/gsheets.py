import os
import logging
import threading

logger = logging.getLogger(__name__)


def _upload_mod_bg(semana: str, mayorista: str):
    try:
        import gspread

        sa_path = os.environ.get("GOOGLE_SA_PATH")
        if not sa_path or not os.path.exists(sa_path):
            logger.warning("gsheets: GOOGLE_SA_PATH no configurado o no encontrado")
            return

        sheet_id = os.environ.get(f"GSHEET_ID_{mayorista.upper()}")
        if not sheet_id:
            logger.warning(f"gsheets: GSHEET_ID_{mayorista.upper()} no configurado")
            return

        gc = gspread.service_account(filename=sa_path)

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
            logger.info(f"gsheets: sin datos para {mayorista}/{semana}, omitiendo")
            return

        spreadsheet = gc.open_by_key(sheet_id)
        tab_name = semana[:100]
        try:
            ws = spreadsheet.worksheet(tab_name)
            ws.clear()
        except gspread.WorksheetNotFound:
            ws = spreadsheet.add_worksheet(title=tab_name, rows=str(len(rows) + 60), cols="20")

        is_yaguar = mayorista == "yaguar"
        cod_label   = "COD YAG"      if is_yaguar else "COD DRCO"
        total_label = "TOTAL YAGUAR" if is_yaguar else "TOTAL DRCO"

        n          = len(rows)
        first_data = 2          # primera fila de datos (row 1 = headers)
        last_data  = n + 1      # última fila de datos
        tr         = last_data + 1   # fila TOTAL
        vhdr       = tr + 2     # fila header vendedores
        vfirst     = vhdr + 1   # primera fila de vendedor

        headers = [
            "FECHA", cod_label, "COD SIS", "NOMBRE", "TELEFONO", "LOCALIDAD",
            total_label, "%", "COMISION EBD", "ALIMENTOS", "TOTAL",
            "FT", "BCO", "SALDO", "VENDEDOR",
        ]

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

        # Fila TOTAL
        data.append([
            "", "", "", "", "", "TOTAL",
            f"=SUM(G{first_data}:G{last_data})",
            "",
            f"=SUM(I{first_data}:I{last_data})",
            f"=SUM(J{first_data}:J{last_data})",
            f'=IFERROR(I{tr}+G{tr}+J{tr},"")',
            f"=SUM(L{first_data}:L{last_data})",
            f"=SUM(M{first_data}:M{last_data})",
            f"=SUM(N{first_data}:N{last_data})",
            "",
        ])

        # Separador + header vendedores
        data.append([])
        data.append(["VENDEDORES", "", "TOTAL", "", "%", "", "COMI 0.5%"])

        # Filas por vendedor
        unique_vendors = list(dict.fromkeys([r["vendedor"] for r in rows if r.get("vendedor")]))
        for vi, vendor in enumerate(unique_vendors):
            vrow = vfirst + vi
            data.append([
                vendor,
                "",
                f'=SUMIF($O${first_data}:$O${last_data},"{vendor}",$G${first_data}:$G${last_data})',
                "",
                f'=C{vrow}/G{tr}',
                "",
                f'=C{vrow}*0.005',
            ])

        ws.update("A1", data, value_input_option="USER_ENTERED")
        logger.info(f"gsheets: MOD {mayorista} subido — {semana} ({n} clientes)")

    except Exception as e:
        logger.error(f"gsheets: error subiendo MOD {mayorista}/{semana}: {e}")


def trigger_mod_upload(semana: str, mayorista: str):
    """Dispara el upload en background para no bloquear el endpoint de import."""
    threading.Thread(target=_upload_mod_bg, args=(semana, mayorista), daemon=True).start()
