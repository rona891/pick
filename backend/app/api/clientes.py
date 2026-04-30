from fastapi import APIRouter, HTTPException
from app.models.schemas import Cliente, ClienteCreate
from app.db.supabase import get_client
from typing import List

router = APIRouter(prefix="/clientes", tags=["clientes"])


@router.get("/", response_model=List[Cliente])
async def list_clientes():
    client = get_client()
    try:
        result = client.table("clientes_yaguar").select("*").order("nombre").execute()
        return result.data
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/", response_model=Cliente)
async def create_cliente(data: ClienteCreate):
    client = get_client()
    try:
        result = client.table("clientes_yaguar").insert(data.model_dump()).execute()
        return result.data[0]
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/{id}", response_model=Cliente)
async def update_cliente(id: int, data: ClienteCreate):
    client = get_client()
    try:
        result = client.table("clientes_yaguar").update(data.model_dump()).eq("id", id).execute()
        if not result.data:
            raise HTTPException(status_code=404, detail="Cliente no encontrado")
        return result.data[0]
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/{id}")
async def delete_cliente(id: int):
    client = get_client()
    try:
        result = client.table("clientes_yaguar").delete().eq("id", id).execute()
        if not result.data:
            raise HTTPException(status_code=404, detail="Cliente no encontrado")
        return {"message": "Cliente eliminado"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
