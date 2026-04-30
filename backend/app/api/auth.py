from fastapi import APIRouter, HTTPException
from app.models.schemas import LoginRequest, LoginResponse
from app.db.database import get_db
from app.auth.jwt import verify_password, create_access_token

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login", response_model=LoginResponse)
def login(request: LoginRequest):
    with get_db() as cur:
        cur.execute(
            "SELECT id, email, password_hash FROM users WHERE email = %s",
            (request.email,),
        )
        user = cur.fetchone()

    if not user or not verify_password(request.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Credenciales inválidas")

    return {"access_token": create_access_token(user["id"], user["email"])}


@router.post("/logout")
def logout():
    return {"message": "Sesión cerrada"}
