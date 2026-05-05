from fastapi import APIRouter, HTTPException, Header
from app.models.schemas import LoginRequest, LoginResponse, ChangePasswordRequest, UserCreate, UserOut
from app.db.database import get_db
from app.auth.jwt import verify_password, create_access_token, hash_password, verify_token
from typing import List

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


@router.get("/users", response_model=List[UserOut])
def list_users():
    with get_db() as cur:
        cur.execute("SELECT id, email, created_at FROM users ORDER BY created_at")
        return [dict(r) for r in cur.fetchall()]


@router.post("/users", response_model=UserOut, status_code=201)
def create_user(data: UserCreate):
    with get_db() as cur:
        cur.execute("SELECT id FROM users WHERE email = %s", (data.email,))
        if cur.fetchone():
            raise HTTPException(status_code=400, detail="Email ya registrado")
        cur.execute(
            "INSERT INTO users (email, password_hash) VALUES (%s, %s) RETURNING id, email, created_at",
            (data.email, hash_password(data.password)),
        )
        return dict(cur.fetchone())


@router.delete("/users/{id}")
def delete_user(id: int):
    with get_db() as cur:
        cur.execute("SELECT COUNT(*) AS n FROM users")
        if cur.fetchone()["n"] <= 1:
            raise HTTPException(status_code=400, detail="No se puede eliminar el único usuario")
        cur.execute("DELETE FROM users WHERE id = %s RETURNING id", (id,))
        if not cur.fetchone():
            raise HTTPException(status_code=404, detail="Usuario no encontrado")
    return {"message": "Usuario eliminado"}
