import io
from fastapi import APIRouter, Query
from fastapi.responses import StreamingResponse
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter
from app.db.database import get_db

router = APIRouter(prefix="/export", tags=["export"])

HEADERS = [
    ("Semana",           "semana"),
    ("Código barra",     "cod_bar"),
    ("Código art.",      "cod_art"),
    ("Descripción",      "descrip"),
    ("Cliente",          "nombre"),
    ("Zona",             "localidad"),
    ("Reparto",          None),
    ("Uni pedidas",      "uni"),
    ("Bultos",           "bul"),
    ("Uni x bulto",      "uxb"),
    ("Uni entregadas",   "cantidad_pickeada"),
    ("% entregado",      None),
    ("Estado",           "estado"),
    ("Importe pedido",   "importe_total"),
]

ACCENT   = "E0FF4F"
DARK_BG  = "141414"
HEADER_BG = "1A1A1A"
GREEN    = "4FFF91"
ORANGE   = "FFB347"
MUTED    = "666666"


def _thin_border():
    s = Side(style="thin", color="333333")
    return Border(left=s, right=s, top=s, bottom=s)


@router.get("/picks")
def export_picks(semana: str = Query(...)):
    with get_db() as cur:
        cur.execute("""
            SELECT p.*, COALESCE(z.reparto, '') AS reparto_zona
            FROM pick p
            LEFT JOIN zonas z ON UPPER(p.localidad) = z.nombre
            LEFT JOIN repartos r ON z.reparto = r.nombre
            WHERE p.semana = %s
            ORDER BY COALESCE(r.orden, 99) ASC, p.localidad ASC, p.nombre ASC, p.descrip ASC
        """, (semana,))
        rows = cur.fetchall()

    wb = Workbook()
    ws = wb.active
    ws.title = semana[:31]

    # — Encabezado —
    header_font   = Font(name="Calibri", bold=True, color=DARK_BG, size=10)
    header_fill   = PatternFill("solid", fgColor=ACCENT)
    header_align  = Alignment(horizontal="center", vertical="center", wrap_text=True)

    for col, (label, _) in enumerate(HEADERS, start=1):
        cell = ws.cell(row=1, column=col, value=label)
        cell.font   = header_font
        cell.fill   = header_fill
        cell.alignment = header_align
        cell.border = _thin_border()

    ws.row_dimensions[1].height = 30

    # — Datos —
    data_font  = Font(name="Calibri", size=10, color="E8E8E8")
    alt_fill   = PatternFill("solid", fgColor="1C1C1C")
    base_fill  = PatternFill("solid", fgColor=HEADER_BG)
    ok_font    = Font(name="Calibri", size=10, color=GREEN)
    pend_font  = Font(name="Calibri", size=10, color=ORANGE)
    center     = Alignment(horizontal="center", vertical="center")
    left       = Alignment(horizontal="left",   vertical="center")

    for row_idx, row in enumerate(rows, start=2):
        r = dict(row)
        fill = alt_fill if row_idx % 2 == 0 else base_fill

        uni = r.get("uni") or 0
        pickeada = r.get("cantidad_pickeada") or 0
        pct = round(pickeada / uni * 100, 1) if uni > 0 else 0
        reparto = r.get("reparto_zona") or ""

        values = []
        for _, field in HEADERS:
            if field == "estado":
                values.append(r.get("estado") or "")
            elif field is None:
                # columnas calculadas
                if _ == "Reparto":
                    values.append(reparto)
                else:
                    values.append(pct)
            else:
                values.append(r.get(field))

        estado_str = (r.get("estado") or "").lower()

        for col_idx, value in enumerate(values, start=1):
            cell = ws.cell(row=row_idx, column=col_idx, value=value)
            cell.fill   = fill
            cell.border = _thin_border()

            label = HEADERS[col_idx - 1][0]
            if label in ("Uni pedidas", "Bultos", "Uni x bulto", "Uni entregadas", "% entregado", "Importe pedido"):
                cell.alignment = center
                if label == "% entregado":
                    cell.number_format = '0.0"%"'
                elif label == "Importe pedido":
                    cell.number_format = '"$"#,##0.00'
            else:
                cell.alignment = left

            if label == "Estado":
                if "completado" in estado_str:
                    cell.font = ok_font
                elif "entregado" in estado_str:
                    cell.font = Font(name="Calibri", size=10, color=ORANGE)
                else:
                    cell.font = Font(name="Calibri", size=10, color=MUTED)
            else:
                cell.font = data_font

    # — Anchos de columna —
    col_widths = [18, 16, 12, 40, 35, 18, 14, 12, 10, 12, 14, 12, 22, 16]
    for i, width in enumerate(col_widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = width

    # — Freeze header row —
    ws.freeze_panes = "A2"

    # — Auto-filter —
    ws.auto_filter.ref = ws.dimensions

    output = io.BytesIO()
    wb.save(output)
    output.seek(0)

    filename = f"picks_{semana.replace(' ', '_')}.xlsx"
    return StreamingResponse(
        output,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
