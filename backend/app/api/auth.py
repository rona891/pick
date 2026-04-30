from fastapi import APIRouter, HTTPException, Header
from app.models.schemas import LoginRequest, LoginResponse, ChangePasswordRequest
from app.db.database import get_db
from app.auth.jwt import verify_password, create_access_token, hash_password, verify_token

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


@router.put("/password")
def change_password(request: ChangePasswordRequest, authorization: str = Header(...)):
    payload = verify_token(authorization)
    email = payload.get("email")

    with get_db() as cur:
        cur.execute("SELECT id, password_hash FROM users WHERE email = %s", (email,))
        user = cur.fetchone()

    if not user or not verify_password(request.current_password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Contraseña actual incorrecta")

    new_hash = hash_password(request.new_password)
    with get_db() as cur:
        cur.execute("UPDATE users SET password_hash = %s WHERE id = %s", (new_hash, user["id"]))

    return {"message": "Contraseña actualizada"}
