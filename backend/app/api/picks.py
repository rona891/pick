from fastapi import APIRouter, HTTPException
from app.models.schemas import Pick, QuantityUpdate, StatsResponse
from app.db.supabase import get_client
from datetime import datetime, timezone
from typing import List

router = APIRouter(prefix="/picks", tags=["picks"])


@router.get("/stats", response_model=StatsResponse)
async def get_stats():
    client = get_client()
    try:
        result = client.table("pick").select("estado").execute()
        rows = result.data
        total = len(rows)
        completed = sum(1 for r in rows if (r.get("estado") or "").startswith("completado"))
        return {"total": total, "completed": completed, "pending": total - completed}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/barcode/{cod_bar}", response_model=List[Pick])
async def get_picks_by_barcode(cod_bar: str):
    client = get_client()
    try:
        result = client.table("pick").select("*").eq("cod_bar", cod_bar).execute()
        if not result.data:
            raise HTTPException(status_code=404, detail="No se encontraron picks para este código")
        return result.data
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/{id}/quantity")
async def update_quantity(id: int, update: QuantityUpdate):
    client = get_client()
    try:
        row = client.table("pick").select("uni").eq("id", id).single().execute()
        if not row.data:
            raise HTTPException(status_code=404, detail="Pick no encontrado")

        uni = row.data.get("uni") or 0
        cantidad = update.cantidad_pickeada

        if cantidad >= uni:
            estado = f"completado: {cantidad}/{uni} UNI"
        else:
            estado = f"pendiente: {cantidad}/{uni} UNI"

        client.table("pick").update({
            "cantidad_pickeada": cantidad,
            "estado": estado,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }).eq("id", id).execute()

        return {"id": id, "cantidad_pickeada": cantidad, "estado": estado}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/", response_model=List[Pick])
async def list_picks():
    client = get_client()
    try:
        result = client.table("pick").select("*").limit(200).execute()
        return result.data
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
