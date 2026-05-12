# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Picks — rutas compartidas con lógica interna, separadas por mayorista.
#
# Cada mayorista tiene su propio prefijo de ruta:
#   Yaguar → /api/yaguar/picks/...
#   Diarco → /api/diarco/picks/...
#
# La lógica de DB es idéntica; solo cambia el filtro WHERE mayorista = '...'
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
from fastapi import APIRouter, HTTPException, Query
from app.models.schemas import Pick, QuantityUpdate, StatsResponse, PickResumen
from app.db.database import get_db
from datetime import datetime, timezone
from typing import List, Optional

router_yaguar = APIRouter(prefix="/yaguar/picks", tags=["Yaguar - Picks"])
router_diarco = APIRouter(prefix="/diarco/picks", tags=["Diarco - Picks"])


# ── Funciones internas (usan el parámetro mayorista) ──────────────────────

def _stats(mayorista: str, semana: Optional[str]):
    with get_db() as cur:
        if semana:
            cur.execute("""
                SELECT COUNT(*) AS total,
                       COUNT(*) FILTER (WHERE estado LIKE 'completado%%') AS completed
                FROM pick WHERE semana = %s AND mayorista = %s
            """, (semana, mayorista))
        else:
            cur.execute("""
                SELECT COUNT(*) AS total,
                       COUNT(*) FILTER (WHERE estado LIKE 'completado%%') AS completed
                FROM pick WHERE mayorista = %s
            """, (mayorista,))
        row = cur.fetchone()
        total, completed = row["total"], row["completed"]
    return {"total": total, "completed": completed, "pending": total - completed}


def _resumen(mayorista: str, semana: Optional[str]):
    with get_db() as cur:
        if semana:
            cur.execute("""
                SELECT nombre,
                       COUNT(*) AS total,
                       COUNT(*) FILTER (WHERE estado LIKE 'completado%%') AS completados,
                       MAX(importe_total) AS importe_total
                FROM pick
                WHERE nombre IS NOT NULL AND semana = %s AND mayorista = %s
                GROUP BY nombre ORDER BY nombre
            """, (semana, mayorista))
        else:
            cur.execute("""
                SELECT nombre,
                       COUNT(*) AS total,
                       COUNT(*) FILTER (WHERE estado LIKE 'completado%%') AS completados,
                       MAX(importe_total) AS importe_total
                FROM pick
                WHERE nombre IS NOT NULL AND mayorista = %s
                GROUP BY nombre ORDER BY nombre
            """, (mayorista,))
        rows = cur.fetchall()

    resultado = []
    for row in rows:
        total, completados = row["total"], row["completados"]
        pendientes = total - completados
        if completados == 0:
            estado_general = "pendiente"
        elif completados == total:
            estado_general = "completo"
        else:
            estado_general = "incompleto"
        resultado.append({
            "nombre": row["nombre"], "total": total,
            "completados": completados, "pendientes": pendientes,
            "estado_general": estado_general,
            "importe_total": float(row["importe_total"] or 0),
        })
    return resultado


def _por_cliente(mayorista: str, nombre: str, semana: Optional[str]):
    with get_db() as cur:
        if semana:
            cur.execute(
                "SELECT * FROM pick WHERE nombre = %s AND semana = %s AND mayorista = %s ORDER BY descrip",
                (nombre, semana, mayorista),
            )
        else:
            cur.execute(
                "SELECT * FROM pick WHERE nombre = %s AND mayorista = %s ORDER BY descrip",
                (nombre, mayorista),
            )
        return [dict(r) for r in cur.fetchall()]


def _buscar(mayorista: str, q: str, semana: Optional[str]):
    with get_db() as cur:
        pattern = f"%{q}%"
        if semana:
            cur.execute("""
                SELECT DISTINCT cod_bar, cod_art, descrip FROM pick
                WHERE descrip ILIKE %s AND semana = %s AND mayorista = %s
                ORDER BY descrip LIMIT 25
            """, (pattern, semana, mayorista))
        else:
            cur.execute("""
                SELECT DISTINCT cod_bar, cod_art, descrip FROM pick
                WHERE descrip ILIKE %s AND mayorista = %s
                ORDER BY descrip LIMIT 25
            """, (pattern, mayorista))
        return [dict(r) for r in cur.fetchall()]


def _by_art(mayorista: str, cod_art: str, semana: Optional[str]):
    """Búsqueda por código de artículo — usado por DIARCO (sin barcodes)."""
    with get_db() as cur:
        if semana:
            cur.execute("""
                SELECT p.*, COALESCE(r.orden, 99) AS _reparto_orden
                FROM pick p
                LEFT JOIN zonas z ON UPPER(p.localidad) = z.nombre
                LEFT JOIN repartos r ON z.reparto = r.nombre
                WHERE p.cod_art = %s AND p.semana = %s AND p.mayorista = %s
                ORDER BY _reparto_orden ASC, p.localidad ASC, p.nombre ASC
            """, (cod_art, semana, mayorista))
        else:
            cur.execute("""
                SELECT p.*, COALESCE(r.orden, 99) AS _reparto_orden
                FROM pick p
                LEFT JOIN zonas z ON UPPER(p.localidad) = z.nombre
                LEFT JOIN repartos r ON z.reparto = r.nombre
                WHERE p.cod_art = %s AND p.mayorista = %s
                ORDER BY _reparto_orden ASC, p.localidad ASC, p.nombre ASC
            """, (cod_art, mayorista))
        rows = cur.fetchall()
    if not rows:
        raise HTTPException(status_code=404, detail="No se encontraron picks para este artículo")
    return [{k: v for k, v in dict(r).items() if k != "_reparto_orden"} for r in rows]


def _by_barcode(mayorista: str, cod_bar: str, semana: Optional[str]):
    with get_db() as cur:
        if semana:
            cur.execute("""
                SELECT p.*, COALESCE(r.orden, 99) AS _reparto_orden
                FROM pick p
                LEFT JOIN zonas z ON UPPER(p.localidad) = z.nombre
                LEFT JOIN repartos r ON z.reparto = r.nombre
                WHERE p.cod_bar = %s AND p.semana = %s AND p.mayorista = %s
                ORDER BY _reparto_orden ASC, p.localidad ASC, p.nombre ASC
            """, (cod_bar, semana, mayorista))
        else:
            cur.execute("""
                SELECT p.*, COALESCE(r.orden, 99) AS _reparto_orden
                FROM pick p
                LEFT JOIN zonas z ON UPPER(p.localidad) = z.nombre
                LEFT JOIN repartos r ON z.reparto = r.nombre
                WHERE p.cod_bar = %s AND p.mayorista = %s
                ORDER BY _reparto_orden ASC, p.localidad ASC, p.nombre ASC
            """, (cod_bar, mayorista))
        rows = cur.fetchall()
    if not rows:
        raise HTTPException(status_code=404, detail="No se encontraron picks para este código")
    return [{k: v for k, v in dict(r).items() if k != "_reparto_orden"} for r in rows]


def _update_quantity(id: int, update: QuantityUpdate):
    with get_db() as cur:
        cur.execute("SELECT uni FROM pick WHERE id = %s", (id,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Pick no encontrado")
        uni = row["uni"] or 0
        cantidad = update.cantidad_pickeada
        estado = f"completado: {cantidad}/{uni} UNI" if cantidad >= uni else f"entregado: {cantidad}/{uni} UNI"
        cur.execute(
            "UPDATE pick SET cantidad_pickeada = %s, estado = %s, updated_at = %s WHERE id = %s",
            (cantidad, estado, datetime.now(timezone.utc), id),
        )
    return {"id": id, "cantidad_pickeada": cantidad, "estado": estado}


# ── Rutas Yaguar ──────────────────────────────────────────────────────────

@router_yaguar.get("/stats", response_model=StatsResponse)
def yaguar_stats(semana: Optional[str] = Query(None)):
    return _stats("yaguar", semana)

@router_yaguar.get("/resumen", response_model=List[PickResumen])
def yaguar_resumen(semana: Optional[str] = Query(None)):
    return _resumen("yaguar", semana)

@router_yaguar.get("/por-cliente")
def yaguar_por_cliente(nombre: str = Query(...), semana: Optional[str] = Query(None)):
    return _por_cliente("yaguar", nombre, semana)

@router_yaguar.get("/buscar")
def yaguar_buscar(q: str = Query(..., min_length=2), semana: Optional[str] = Query(None)):
    return _buscar("yaguar", q, semana)

@router_yaguar.get("/barcode/{cod_bar}", response_model=List[Pick])
def yaguar_by_barcode(cod_bar: str, semana: Optional[str] = Query(None)):
    return _by_barcode("yaguar", cod_bar, semana)

@router_yaguar.get("/art/{cod_art}", response_model=List[Pick])
def yaguar_by_art(cod_art: str, semana: Optional[str] = Query(None)):
    return _by_art("yaguar", cod_art, semana)

@router_yaguar.put("/{id}/quantity")
def yaguar_update_quantity(id: int, update: QuantityUpdate):
    return _update_quantity(id, update)


# ── Rutas Diarco ──────────────────────────────────────────────────────────

@router_diarco.get("/stats", response_model=StatsResponse)
def diarco_stats(semana: Optional[str] = Query(None)):
    return _stats("diarco", semana)

@router_diarco.get("/resumen", response_model=List[PickResumen])
def diarco_resumen(semana: Optional[str] = Query(None)):
    return _resumen("diarco", semana)

@router_diarco.get("/por-cliente")
def diarco_por_cliente(nombre: str = Query(...), semana: Optional[str] = Query(None)):
    return _por_cliente("diarco", nombre, semana)

@router_diarco.get("/buscar")
def diarco_buscar(q: str = Query(..., min_length=2), semana: Optional[str] = Query(None)):
    return _buscar("diarco", q, semana)

@router_diarco.get("/barcode/{cod_bar}", response_model=List[Pick])
def diarco_by_barcode(cod_bar: str, semana: Optional[str] = Query(None)):
    return _by_barcode("diarco", cod_bar, semana)

@router_diarco.get("/art/{cod_art}", response_model=List[Pick])
def diarco_by_art(cod_art: str, semana: Optional[str] = Query(None)):
    return _by_art("diarco", cod_art, semana)

@router_diarco.put("/{id}/quantity")
def diarco_update_quantity(id: int, update: QuantityUpdate):
    return _update_quantity(id, update)
