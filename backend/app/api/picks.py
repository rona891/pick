from fastapi import APIRouter, HTTPException, Query
from app.models.schemas import Pick, QuantityUpdate, StatsResponse, PickResumen
from app.db.database import get_db
from datetime import datetime, timezone
from typing import List, Optional

router = APIRouter(prefix="/picks", tags=["picks"])


@router.get("/stats", response_model=StatsResponse)
def get_stats(semana: Optional[str] = Query(None)):
    with get_db() as cur:
        if semana:
            cur.execute("""
                SELECT
                    COUNT(*) AS total,
                    COUNT(*) FILTER (WHERE estado LIKE 'completado%%') AS completed
                FROM pick WHERE semana = %s
            """, (semana,))
        else:
            cur.execute("""
                SELECT
                    COUNT(*) AS total,
                    COUNT(*) FILTER (WHERE estado LIKE 'completado%%') AS completed
                FROM pick
            """)
        row = cur.fetchone()
        total = row["total"]
        completed = row["completed"]
        return {"total": total, "completed": completed, "pending": total - completed}


@router.get("/resumen", response_model=List[PickResumen])
def get_resumen(semana: Optional[str] = Query(None)):
    with get_db() as cur:
        if semana:
            cur.execute("""
                SELECT
                    nombre,
                    COUNT(*) AS total,
                    COUNT(*) FILTER (WHERE estado LIKE 'completado%%') AS completados,
                    MAX(importe_total) AS importe_total
                FROM pick
                WHERE nombre IS NOT NULL AND semana = %s
                GROUP BY nombre
                ORDER BY nombre
            """, (semana,))
        else:
            cur.execute("""
                SELECT
                    nombre,
                    COUNT(*) AS total,
                    COUNT(*) FILTER (WHERE estado LIKE 'completado%%') AS completados,
                    MAX(importe_total) AS importe_total
                FROM pick
                WHERE nombre IS NOT NULL
                GROUP BY nombre
                ORDER BY nombre
            """)
        rows = cur.fetchall()

    resumen = []
    for row in rows:
        total = row["total"]
        completados = row["completados"]
        pendientes = total - completados
        if completados == 0:
            estado_general = "pendiente"
        elif completados == total:
            estado_general = "completo"
        else:
            estado_general = "incompleto"
        resumen.append({
            "nombre": row["nombre"],
            "total": total,
            "completados": completados,
            "pendientes": pendientes,
            "estado_general": estado_general,
            "importe_total": float(row["importe_total"] or 0),
        })
    return resumen


@router.get("/por-cliente")
def get_picks_por_cliente(nombre: str = Query(...), semana: Optional[str] = Query(None)):
    with get_db() as cur:
        if semana:
            cur.execute(
                "SELECT * FROM pick WHERE nombre = %s AND semana = %s ORDER BY descrip",
                (nombre, semana),
            )
        else:
            cur.execute(
                "SELECT * FROM pick WHERE nombre = %s ORDER BY descrip",
                (nombre,),
            )
        return [dict(r) for r in cur.fetchall()]


@router.get("/buscar")
def buscar_por_descripcion(q: str = Query(..., min_length=2), semana: Optional[str] = Query(None)):
    with get_db() as cur:
        pattern = f"%{q}%"
        if semana:
            cur.execute("""
                SELECT DISTINCT cod_bar, cod_art, descrip
                FROM pick
                WHERE descrip ILIKE %s AND semana = %s AND cod_bar IS NOT NULL
                ORDER BY descrip
                LIMIT 25
            """, (pattern, semana))
        else:
            cur.execute("""
                SELECT DISTINCT cod_bar, cod_art, descrip
                FROM pick
                WHERE descrip ILIKE %s AND cod_bar IS NOT NULL
                ORDER BY descrip
                LIMIT 25
            """, (pattern,))
        return [dict(r) for r in cur.fetchall()]


@router.get("/barcode/{cod_bar}", response_model=List[Pick])
def get_picks_by_barcode(cod_bar: str, semana: Optional[str] = Query(None)):
    with get_db() as cur:
        if semana:
            cur.execute("SELECT * FROM pick WHERE cod_bar = %s AND semana = %s", (cod_bar, semana))
        else:
            cur.execute("SELECT * FROM pick WHERE cod_bar = %s", (cod_bar,))
        rows = cur.fetchall()
    if not rows:
        raise HTTPException(status_code=404, detail="No se encontraron picks para este código")
    return [dict(r) for r in rows]


@router.put("/{id}/quantity")
def update_quantity(id: int, update: QuantityUpdate):
    with get_db() as cur:
        cur.execute("SELECT uni FROM pick WHERE id = %s", (id,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Pick no encontrado")

        uni = row["uni"] or 0
        cantidad = update.cantidad_pickeada
        if cantidad >= uni:
            estado = f"completado: {cantidad}/{uni} UNI"
        else:
            estado = f"entregado: {cantidad}/{uni} UNI"

        cur.execute(
            "UPDATE pick SET cantidad_pickeada = %s, estado = %s, updated_at = %s WHERE id = %s",
            (cantidad, estado, datetime.now(timezone.utc), id),
        )

    return {"id": id, "cantidad_pickeada": cantidad, "estado": estado}


@router.get("/", response_model=List[Pick])
def list_picks(semana: Optional[str] = Query(None)):
    with get_db() as cur:
        if semana:
            cur.execute("SELECT * FROM pick WHERE semana = %s LIMIT 200", (semana,))
        else:
            cur.execute("SELECT * FROM pick LIMIT 200")
        return [dict(r) for r in cur.fetchall()]
