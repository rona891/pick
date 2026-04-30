from fastapi import APIRouter, HTTPException
from app.models.schemas import LoginRequest, LoginResponse
from app.db.supabase import get_client

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login", response_model=LoginResponse)
async def login(request: LoginRequest):
    client = get_client()
    try:
        result = client.auth.sign_in_with_password({
            "email": request.email,
            "password": request.password,
        })
        if not result.session:
            raise HTTPException(status_code=401, detail="Credenciales inválidas")
        return {"access_token": result.session.access_token}
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=401, detail="Credenciales inválidas")


@router.post("/logout")
async def logout():
    client = get_client()
    try:
        client.auth.sign_out()
    except Exception:
        pass
    return {"message": "Sesión cerrada"}
