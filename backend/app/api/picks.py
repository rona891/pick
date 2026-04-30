from fastapi import APIRouter, HTTPException
from app.models.schemas import Pick, QuantityUpdate, StatsResponse
from app.db.database import get_db
from datetime import datetime, timezone
from typing import List

router = APIRouter(prefix="/picks", tags=["picks"])


@router.get("/stats", response_model=StatsResponse)
def get_stats():
    with get_db() as cur:
        cur.execute("""
            SELECT
                COUNT(*) AS total,
                COUNT(*) FILTER (WHERE estado LIKE 'completado%') AS completed
            FROM pick
        """)
        row = cur.fetchone()
        total = row["total"]
        completed = row["completed"]
        return {"total": total, "completed": completed, "pending": total - completed}


@router.get("/barcode/{cod_bar}", response_model=List[Pick])
def get_picks_by_barcode(cod_bar: str):
    with get_db() as cur:
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
        estado = f"completado: {cantidad}/{uni} UNI" if cantidad >= uni else f"pendiente: {cantidad}/{uni} UNI"

        cur.execute(
            "UPDATE pick SET cantidad_pickeada = %s, estado = %s, updated_at = %s WHERE id = %s",
            (cantidad, estado, datetime.now(timezone.utc), id),
        )

    return {"id": id, "cantidad_pickeada": cantidad, "estado": estado}


@router.get("/", response_model=List[Pick])
def list_picks():
    with get_db() as cur:
        cur.execute("SELECT * FROM pick LIMIT 200")
        return [dict(r) for r in cur.fetchall()]
