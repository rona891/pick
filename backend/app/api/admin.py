from fastapi import APIRouter, HTTPException
from app.models.schemas import AdminVerify
from config import settings

router = APIRouter(prefix="/admin", tags=["admin"])


@router.post("/verify")
async def verify_admin(data: AdminVerify):
    if data.password != settings.ADMIN_PASSWORD:
        raise HTTPException(status_code=403, detail="Contraseña incorrecta")
    return {"ok": True}
