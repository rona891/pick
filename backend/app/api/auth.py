from fastapi import APIRouter, HTTPException, Header
from app.models.schemas import LoginRequest, LoginResponse, ChangePasswordRequest, ChangeUsernameRequest, UserCreate, UserOut
from app.db.database import get_db
from app.auth.jwt import verify_password, create_access_token, hash_password, verify_token
from typing import List

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login", response_model=LoginResponse)
def login(request: LoginRequest):
    with get_db() as cur:
        cur.execute(
            "SELECT id, username, password_hash FROM users WHERE username = %s",
            (request.username,),
        )
        user = cur.fetchone()

    if not user or not verify_password(request.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Credenciales inválidas")

    return {"access_token": create_access_token(user["id"], user["username"])}


@router.post("/logout")
def logout():
    return {"message": "Sesión cerrada"}


@router.put("/password")
def change_password(request: ChangePasswordRequest, authorization: str = Header(...)):
    payload = verify_token(authorization)
    username = payload.get("username")

    with get_db() as cur:
        cur.execute("SELECT id, password_hash FROM users WHERE username = %s", (username,))
        user = cur.fetchone()

    if not user or not verify_password(request.current_password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Contraseña actual incorrecta")

    new_hash = hash_password(request.new_password)
    with get_db() as cur:
        cur.execute("UPDATE users SET password_hash = %s WHERE id = %s", (new_hash, user["id"]))

    return {"message": "Contraseña actualizada"}


@router.put("/username")
def change_username(request: ChangeUsernameRequest, authorization: str = Header(...)):
    payload = verify_token(authorization)
    user_id = payload.get("sub")

    with get_db() as cur:
        cur.execute("SELECT id, password_hash FROM users WHERE id = %s", (user_id,))
        user = cur.fetchone()

    if not user or not verify_password(request.current_password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Contraseña incorrecta")

    with get_db() as cur:
        cur.execute("SELECT id FROM users WHERE username = %s AND id != %s", (request.new_username, user_id))
        if cur.fetchone():
            raise HTTPException(status_code=400, detail="Ese nombre ya está en uso")
        cur.execute("UPDATE users SET username = %s WHERE id = %s", (request.new_username, user_id))

    return {"message": "Nombre actualizado"}


@router.get("/users", response_model=List[UserOut])
def list_users():
    with get_db() as cur:
        cur.execute("SELECT id, username, created_at FROM users ORDER BY created_at")
        return [dict(r) for r in cur.fetchall()]


@router.post("/users", response_model=UserOut, status_code=201)
def create_user(data: UserCreate):
    with get_db() as cur:
        cur.execute("SELECT id FROM users WHERE username = %s", (data.username,))
        if cur.fetchone():
            raise HTTPException(status_code=400, detail="Usuario ya registrado")
        cur.execute(
            "INSERT INTO users (username, password_hash) VALUES (%s, %s) RETURNING id, username, created_at",
            (data.username, hash_password(data.password)),
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
