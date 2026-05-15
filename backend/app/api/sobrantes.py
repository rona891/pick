import io
import openpyxl
from openpyxl.styles import PatternFill, Font, Alignment
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Optional
from app.db.database import get_db

router_yaguar = APIRouter(prefix="/yaguar/sobrantes", tags=["Yaguar - Sobrantes"])
router_diarco = APIRouter(prefix="/diarco/sobrantes", tags=["Diarco - Sobrantes"])
router_shared = APIRouter(prefix="/sobrantes", tags=["Sobrantes - Compartido"])


class ItemIn(BaseModel):
    cod_bar: Optional[str] = None
    cod_art: Optional[str] = None
    descrip: Optional[str] = None
    mayorista: Optional[str] = None

class CantidadIn(BaseModel):
    unidades: int = 0
    bultos: int = 0

class ListaIn(BaseModel):
    nombre: str


# ── helpers ───────────────────────────────────────────────────────────────────

def _list_listas(mayorista: str):
    with get_db() as cur:
        cur.execute("""
            SELECT lista, COUNT(*) AS items, MAX(created_at) AS ultima
            FROM sobrantes WHERE mayorista = %s
            GROUP BY lista ORDER BY ultima DESC
        """, (mayorista,))
        return [dict(r) for r in cur.fetchall()]


def _get_items(lista: str, mayorista: str):
    with get_db() as cur:
        cur.execute("""
            SELECT id, cod_bar, cod_art, descrip, unidades, bultos
            FROM sobrantes WHERE lista = %s AND mayorista = %s
            ORDER BY created_at DESC
        """, (lista, mayorista))
        return [dict(r) for r in cur.fetchall()]


def _add_item(lista: str, data: ItemIn, mayorista: str):
    cod_bar = (data.cod_bar or "").strip() or None
    cod_art = (data.cod_art or "").strip() or None
    descrip = (data.descrip or "").strip() or None
    if not cod_bar and not cod_art:
        raise HTTPException(400, "Se requiere cod_bar o cod_art")
    with get_db() as cur:
        # Si ya existe en esta lista, devolver el existente (frontend lo resalta)
        if cod_bar:
            cur.execute(
                "SELECT id, cod_bar, cod_art, descrip, unidades, bultos FROM sobrantes WHERE lista=%s AND mayorista=%s AND cod_bar=%s",
                (lista, mayorista, cod_bar)
            )
        else:
            cur.execute(
                "SELECT id, cod_bar, cod_art, descrip, unidades, bultos FROM sobrantes WHERE lista=%s AND mayorista=%s AND cod_art=%s",
                (lista, mayorista, cod_art)
            )
        existing = cur.fetchone()
        if existing:
            return {"action": "existing", **dict(existing)}
        cur.execute(
            "INSERT INTO sobrantes (cod_bar, cod_art, descrip, unidades, bultos, lista, mayorista) VALUES (%s,%s,%s,0,0,%s,%s) RETURNING id, cod_bar, cod_art, descrip, unidades, bultos",
            (cod_bar, cod_art, descrip, lista, mayorista)
        )
        return {"action": "added", **dict(cur.fetchone())}


def _update_item(lista: str, item_id: int, data: CantidadIn, mayorista: str):
    with get_db() as cur:
        cur.execute(
            "UPDATE sobrantes SET unidades=%s, bultos=%s WHERE id=%s AND lista=%s AND mayorista=%s RETURNING id, cod_bar, cod_art, descrip, unidades, bultos",
            (max(0, data.unidades), max(0, data.bultos), item_id, lista, mayorista)
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(404, "Item no encontrado")
        return dict(row)


def _delete_item(lista: str, item_id: int, mayorista: str):
    with get_db() as cur:
        cur.execute("DELETE FROM sobrantes WHERE id=%s AND lista=%s AND mayorista=%s", (item_id, lista, mayorista))
        if cur.rowcount == 0:
            raise HTTPException(404, "Item no encontrado")
    return {"ok": True}


def _delete_lista(lista: str, mayorista: str):
    with get_db() as cur:
        cur.execute("DELETE FROM sobrantes WHERE lista=%s AND mayorista=%s", (lista, mayorista))
    return {"ok": True}


def _lookup(cod_bar: str, mayorista: str):
    with get_db() as cur:
        for col in ("cod_bar", "cod_bar_bulto"):
            cur.execute(f"SELECT cod_art, descrip FROM pick WHERE {col}=%s AND mayorista=%s LIMIT 1", (cod_bar, mayorista))
            row = cur.fetchone()
            if row:
                return {"cod_art": row["cod_art"], "descrip": row["descrip"], "found": True}
    return {"cod_art": None, "descrip": None, "found": False}


def _search_descrip(q: str, mayorista: str):
    with get_db() as cur:
        cur.execute(
            "SELECT DISTINCT cod_bar, cod_art, descrip FROM pick WHERE descrip ILIKE %s AND mayorista=%s ORDER BY descrip LIMIT 20",
            (f"%{q}%", mayorista)
        )
        return [dict(r) for r in cur.fetchall()]


def _export(lista: str, mayorista: str):
    with get_db() as cur:
        cur.execute(
            "SELECT cod_bar, cod_art, descrip, unidades, bultos FROM sobrantes WHERE lista=%s AND mayorista=%s ORDER BY created_at DESC",
            (lista, mayorista)
        )
        rows = [dict(r) for r in cur.fetchall()]

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Sobrantes"

    hfill = PatternFill("solid", fgColor="E0FF4F")
    hfont = Font(bold=True, color="141414")
    headers = ["Cód. de Barra", "Cód. Artículo", "Descripción", "Unidades", "Bultos"]
    for c, h in enumerate(headers, 1):
        cell = ws.cell(1, c, h)
        cell.fill = hfill
        cell.font = hfont
        cell.alignment = Alignment(horizontal="center")

    alt = PatternFill("solid", fgColor="1E1E1E")
    for i, r in enumerate(rows, 2):
        vals = [r["cod_bar"], r["cod_art"], r["descrip"], r["unidades"], r["bultos"]]
        for c, v in enumerate(vals, 1):
            cell = ws.cell(i, c, v)
            cell.font = Font(color="FFFFFF")
            cell.alignment = Alignment(horizontal="center" if c > 3 else "left")
            if i % 2 == 0:
                cell.fill = alt

    ws.column_dimensions["A"].width = 18
    ws.column_dimensions["B"].width = 14
    ws.column_dimensions["C"].width = 42
    ws.column_dimensions["D"].width = 12
    ws.column_dimensions["E"].width = 12
    ws.freeze_panes = "A2"

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    fname = f"sobrantes_{lista.replace(' ', '_')}_{mayorista}.xlsx"
    return StreamingResponse(buf, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                             headers={"Content-Disposition": f"attachment; filename={fname}"})


# ── Yaguar routes ──────────────────────────────────────────────────────────────

@router_yaguar.get("/listas")
def yaguar_list_listas(): return _list_listas("yaguar")

@router_yaguar.post("/listas")
def yaguar_crear_lista(data: ListaIn):
    nombre = data.nombre.strip()
    if not nombre: raise HTTPException(400, "Nombre vacío")
    return {"lista": nombre}

@router_yaguar.delete("/listas/{lista}")
def yaguar_delete_lista(lista: str): return _delete_lista(lista, "yaguar")

@router_yaguar.get("/lookup/{cod_bar}")
def yaguar_lookup(cod_bar: str): return _lookup(cod_bar, "yaguar")

@router_yaguar.get("/search")
def yaguar_search(q: str): return _search_descrip(q, "yaguar")

@router_yaguar.get("/{lista}/export")
def yaguar_export(lista: str): return _export(lista, "yaguar")

@router_yaguar.get("/{lista}")
def yaguar_get_items(lista: str): return _get_items(lista, "yaguar")

@router_yaguar.post("/{lista}/item")
def yaguar_add_item(lista: str, data: ItemIn): return _add_item(lista, data, "yaguar")

@router_yaguar.put("/{lista}/item/{item_id}")
def yaguar_update_item(lista: str, item_id: int, data: CantidadIn): return _update_item(lista, item_id, data, "yaguar")

@router_yaguar.delete("/{lista}/item/{item_id}")
def yaguar_delete_item(lista: str, item_id: int): return _delete_item(lista, item_id, "yaguar")


# ── Diarco routes ──────────────────────────────────────────────────────────────

@router_diarco.get("/listas")
def diarco_list_listas(): return _list_listas("diarco")

@router_diarco.post("/listas")
def diarco_crear_lista(data: ListaIn):
    nombre = data.nombre.strip()
    if not nombre: raise HTTPException(400, "Nombre vacío")
    return {"lista": nombre}

@router_diarco.delete("/listas/{lista}")
def diarco_delete_lista(lista: str): return _delete_lista(lista, "diarco")

@router_diarco.get("/lookup/{cod_bar}")
def diarco_lookup(cod_bar: str): return _lookup(cod_bar, "diarco")

@router_diarco.get("/search")
def diarco_search(q: str): return _search_descrip(q, "diarco")

@router_diarco.get("/{lista}/export")
def diarco_export(lista: str): return _export(lista, "diarco")

@router_diarco.get("/{lista}")
def diarco_get_items(lista: str): return _get_items(lista, "diarco")

@router_diarco.post("/{lista}/item")
def diarco_add_item(lista: str, data: ItemIn): return _add_item(lista, data, "diarco")

@router_diarco.put("/{lista}/item/{item_id}")
def diarco_update_item(lista: str, item_id: int, data: CantidadIn): return _update_item(lista, item_id, data, "diarco")

@router_diarco.delete("/{lista}/item/{item_id}")
def diarco_delete_item(lista: str, item_id: int): return _delete_item(lista, item_id, "diarco")


# ── Shared helpers (sin filtro por mayorista) ──────────────────────────────────

def _list_listas_shared():
    with get_db() as cur:
        cur.execute("""
            SELECT lista, COUNT(*) AS items, MAX(created_at) AS ultima
            FROM sobrantes GROUP BY lista ORDER BY ultima DESC
        """)
        return [dict(r) for r in cur.fetchall()]


def _get_items_shared(lista: str):
    with get_db() as cur:
        cur.execute("""
            SELECT id, cod_bar, cod_art, descrip, unidades, bultos, mayorista
            FROM sobrantes WHERE lista = %s ORDER BY created_at DESC
        """, (lista,))
        return [dict(r) for r in cur.fetchall()]


def _lookup_shared(cod_bar: str):
    with get_db() as cur:
        for m in ("yaguar", "diarco"):
            for col in ("cod_bar", "cod_bar_bulto"):
                cur.execute(
                    f"SELECT cod_art, descrip FROM pick WHERE {col}=%s AND mayorista=%s LIMIT 1",
                    (cod_bar, m)
                )
                row = cur.fetchone()
                if row:
                    return {"cod_art": row["cod_art"], "descrip": row["descrip"], "mayorista": m, "found": True}
    return {"cod_art": None, "descrip": None, "mayorista": None, "found": False}


def _search_shared(q: str, mayorista: Optional[str] = None):
    with get_db() as cur:
        if mayorista:
            cur.execute("""
                SELECT DISTINCT ON (cod_art) cod_bar, cod_art, descrip, mayorista
                FROM pick WHERE descrip ILIKE %s AND mayorista = %s
                ORDER BY cod_art, descrip LIMIT 20
            """, (f"%{q}%", mayorista))
        else:
            cur.execute("""
                SELECT DISTINCT ON (cod_art) cod_bar, cod_art, descrip, mayorista
                FROM pick WHERE descrip ILIKE %s
                ORDER BY cod_art, descrip LIMIT 20
            """, (f"%{q}%",))
        return [dict(r) for r in cur.fetchall()]


def _add_item_shared(lista: str, data: ItemIn):
    cod_bar = (data.cod_bar or "").strip() or None
    cod_art = (data.cod_art or "").strip() or None
    descrip = (data.descrip or "").strip() or None
    mayorista = (data.mayorista or "yaguar").strip()
    if not cod_bar and not cod_art:
        raise HTTPException(400, "Se requiere cod_bar o cod_art")
    with get_db() as cur:
        if cod_bar:
            cur.execute(
                "SELECT id, cod_bar, cod_art, descrip, unidades, bultos, mayorista FROM sobrantes WHERE lista=%s AND cod_bar=%s",
                (lista, cod_bar)
            )
        else:
            cur.execute(
                "SELECT id, cod_bar, cod_art, descrip, unidades, bultos, mayorista FROM sobrantes WHERE lista=%s AND cod_art=%s",
                (lista, cod_art)
            )
        existing = cur.fetchone()
        if existing:
            return {"action": "existing", **dict(existing)}
        cur.execute(
            """INSERT INTO sobrantes (cod_bar, cod_art, descrip, unidades, bultos, lista, mayorista)
               VALUES (%s,%s,%s,0,0,%s,%s)
               RETURNING id, cod_bar, cod_art, descrip, unidades, bultos, mayorista""",
            (cod_bar, cod_art, descrip, lista, mayorista)
        )
        return {"action": "added", **dict(cur.fetchone())}


def _update_item_shared(lista: str, item_id: int, data: CantidadIn):
    with get_db() as cur:
        cur.execute(
            "UPDATE sobrantes SET unidades=%s, bultos=%s WHERE id=%s AND lista=%s RETURNING id, cod_bar, cod_art, descrip, unidades, bultos, mayorista",
            (max(0, data.unidades), max(0, data.bultos), item_id, lista)
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(404, "Item no encontrado")
        return dict(row)


def _export_shared(lista: str):
    with get_db() as cur:
        cur.execute("""
            SELECT s.mayorista, s.cod_bar, s.cod_art, s.descrip, s.unidades, s.bultos,
                   p.uxb, p.precio_unit
            FROM sobrantes s
            LEFT JOIN LATERAL (
                SELECT uxb, precio_unit FROM pick
                WHERE pick.cod_art = s.cod_art AND pick.mayorista = s.mayorista
                ORDER BY created_at DESC LIMIT 1
            ) p ON true
            WHERE s.lista = %s
            ORDER BY s.mayorista, s.created_at DESC
        """, (lista,))
        rows = [dict(r) for r in cur.fetchall()]

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Sobrantes"

    hfill = PatternFill("solid", fgColor="E0FF4F")
    hfont = Font(bold=True, color="141414")
    headers = ["Mayorista", "Cód. de Barra", "Cód. Artículo", "Descripción", "Unid.", "Bultos", "UxB", "Precio c/IVA"]
    for c, h in enumerate(headers, 1):
        cell = ws.cell(1, c, h)
        cell.fill = hfill; cell.font = hfont
        cell.alignment = Alignment(horizontal="center")

    alt = PatternFill("solid", fgColor="1E1E1E")
    for i, r in enumerate(rows, 2):
        precio = round(float(r["precio_unit"]), 2) if r["precio_unit"] is not None else ""
        vals = [r["mayorista"], r["cod_bar"], r["cod_art"], r["descrip"],
                r["unidades"], r["bultos"], r["uxb"] or "", precio]
        for c, v in enumerate(vals, 1):
            cell = ws.cell(i, c, v)
            cell.font = Font(color="FFFFFF")
            cell.alignment = Alignment(horizontal="center" if c > 4 else "left")
            if i % 2 == 0:
                cell.fill = alt

    ws.column_dimensions["A"].width = 12
    ws.column_dimensions["B"].width = 18
    ws.column_dimensions["C"].width = 14
    ws.column_dimensions["D"].width = 42
    ws.column_dimensions["E"].width = 10
    ws.column_dimensions["F"].width = 10
    ws.column_dimensions["G"].width = 8
    ws.column_dimensions["H"].width = 14
    ws.freeze_panes = "A2"

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    fname = f"sobrantes_{lista.replace(' ', '_')}.xlsx"
    return StreamingResponse(
        buf, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename={fname}"}
    )


# ── Shared routes ──────────────────────────────────────────────────────────────

@router_shared.get("/listas")
def shared_list_listas(): return _list_listas_shared()

@router_shared.post("/listas")
def shared_crear_lista(data: ListaIn):
    nombre = data.nombre.strip()
    if not nombre: raise HTTPException(400, "Nombre vacío")
    return {"lista": nombre}

@router_shared.delete("/listas/{lista}")
def shared_delete_lista(lista: str):
    with get_db() as cur:
        cur.execute("DELETE FROM sobrantes WHERE lista=%s", (lista,))
    return {"ok": True}

@router_shared.get("/lookup/{cod_bar}")
def shared_lookup(cod_bar: str): return _lookup_shared(cod_bar)

@router_shared.get("/search")
def shared_search(q: str, mayorista: Optional[str] = None): return _search_shared(q, mayorista)

@router_shared.get("/{lista}/export")
def shared_export(lista: str): return _export_shared(lista)

@router_shared.get("/{lista}")
def shared_get_items(lista: str): return _get_items_shared(lista)

@router_shared.post("/{lista}/item")
def shared_add_item(lista: str, data: ItemIn): return _add_item_shared(lista, data)

@router_shared.put("/{lista}/item/{item_id}")
def shared_update_item(lista: str, item_id: int, data: CantidadIn): return _update_item_shared(lista, item_id, data)

@router_shared.delete("/{lista}/item/{item_id}")
def shared_delete_item(lista: str, item_id: int):
    with get_db() as cur:
        cur.execute("DELETE FROM sobrantes WHERE id=%s AND lista=%s", (item_id, lista))
        if cur.rowcount == 0:
            raise HTTPException(404, "Item no encontrado")
    return {"ok": True}
