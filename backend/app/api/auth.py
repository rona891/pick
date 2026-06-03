from fastapi import APIRouter, HTTPException, Header
from app.models.schemas import LoginRequest, LoginResponse, ChangePasswordRequest, ChangeUsernameRequest, UserCreate, UserOut, UserUpdate
from app.db.database import get_db
from app.auth.jwt import verify_password, create_access_token, hash_password, verify_token
from typing import List
from pydantic import BaseModel

router = APIRouter(prefix="/auth", tags=["auth"])

_PERM_COLS = (
    "perm_pick", "perm_sobrantes", "perm_novedades", "perm_yaguar", "perm_diarco",
    "perm_admin_clientes", "perm_admin_semanas", "perm_admin_zonas",
    "perm_admin_auditoria", "perm_admin_articulos", "perm_admin_usuarios", "perm_admin_roles",
)
_PERM_SEL = ", ".join(f"COALESCE(r.{p}, false) AS {p}" for p in _PERM_COLS)


def _get_perms(user_id: int) -> dict:
    with get_db() as cur:
        cur.execute(
            f"SELECT u.rol, {_PERM_SEL} FROM users u LEFT JOIN roles r ON r.nombre = u.rol WHERE u.id = %s",
            (user_id,),
        )
        return dict(cur.fetchone() or {})


def _caller_has_perm(authorization: str, perm: str) -> bool:
    payload = verify_token(authorization)
    perms = _get_perms(payload.get("sub"))
    return bool(perms.get(perm))


class RolUpdate(BaseModel):
    rol: str


@router.post("/login", response_model=LoginResponse)
def login(request: LoginRequest):
    with get_db() as cur:
        cur.execute(
            f"SELECT u.id, u.username, u.password_hash, u.rol, {_PERM_SEL} "
            "FROM users u LEFT JOIN roles r ON r.nombre = u.rol "
            "WHERE LOWER(u.username) = LOWER(%s)",
            (request.username,),
        )
        user = cur.fetchone()

    if not user or not verify_password(request.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Credenciales inválidas")

    result = {
        "access_token": create_access_token(user["id"], user["username"]),
        "rol": user["rol"],
    }
    for p in _PERM_COLS:
        result[p] = bool(user[p])
    return result


@router.post("/logout")
def logout():
    return {"message": "Sesión cerrada"}


@router.get("/me")
def get_me(authorization: str = Header(...)):
    payload = verify_token(authorization)
    perms = _get_perms(payload.get("sub"))
    if not perms:
        raise HTTPException(404, "Usuario no encontrado")
    result = {"rol": perms["rol"]}
    for p in _PERM_COLS:
        result[p] = bool(perms.get(p, False))
    return result


@router.put("/password")
def change_password(request: ChangePasswordRequest, authorization: str = Header(...)):
    payload = verify_token(authorization)
    username = payload.get("username")

    with get_db() as cur:
        cur.execute("SELECT id, password_hash FROM users WHERE username = %s", (username,))
        user = cur.fetchone()

    if not user or not verify_password(request.current_password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Contraseña actual incorrecta")

    with get_db() as cur:
        cur.execute("UPDATE users SET password_hash = %s WHERE id = %s", (hash_password(request.new_password), user["id"]))

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
        cur.execute("""
            SELECT id, username, rol, acceso_sobrantes, acceso_novedades, acceso_pick, created_at FROM users
            ORDER BY username
        """)
        return [dict(r) for r in cur.fetchall()]


@router.post("/users", response_model=UserOut, status_code=201)
def create_user(data: UserCreate, authorization: str = Header(...)):
    if not _caller_has_perm(authorization, "perm_admin_usuarios"):
        raise HTTPException(403, "Sin permiso para gestionar usuarios")
    # Validar que el rol existe
    with get_db() as cur:
        cur.execute("SELECT nombre FROM roles WHERE nombre = %s", (data.rol,))
        if not cur.fetchone():
            raise HTTPException(400, f"Rol inválido: '{data.rol}'")
        cur.execute("SELECT id FROM users WHERE username = %s", (data.username,))
        if cur.fetchone():
            raise HTTPException(status_code=400, detail="Usuario ya registrado")
        cur.execute(
            "INSERT INTO users (username, password_hash, rol) VALUES (%s, %s, %s) RETURNING id, username, rol, acceso_sobrantes, acceso_novedades, acceso_pick, created_at",
            (data.username, hash_password(data.password), data.rol),
        )
        return dict(cur.fetchone())


@router.put("/users/{id}/rol")
def update_rol(id: int, data: RolUpdate, authorization: str = Header(...)):
    payload = verify_token(authorization)
    with get_db() as cur:
        cur.execute("SELECT rol FROM users WHERE id = %s", (payload.get("sub"),))
        caller = cur.fetchone()
    if not caller or caller["rol"] != "superadmin":
        raise HTTPException(403, "Solo el superadmin puede cambiar roles")
    # Validar que el rol existe
    with get_db() as cur:
        cur.execute("SELECT nombre FROM roles WHERE nombre = %s", (data.rol,))
        if not cur.fetchone():
            raise HTTPException(400, f"Rol inválido: '{data.rol}'")
    with get_db() as cur:
        cur.execute("SELECT rol FROM users WHERE id = %s", (id,))
        user = cur.fetchone()
        if not user:
            raise HTTPException(404, "Usuario no encontrado")
        if user["rol"] == "superadmin":
            raise HTTPException(403, "No se puede modificar el rol del superadmin")
        cur.execute("UPDATE users SET rol = %s WHERE id = %s RETURNING id, username, rol, created_at", (data.rol, id))
        return dict(cur.fetchone())


@router.delete("/users/{id}")
def delete_user(id: int, authorization: str = Header(...)):
    if not _caller_has_perm(authorization, "perm_admin_usuarios"):
        raise HTTPException(403, "Sin permiso para gestionar usuarios")
    with get_db() as cur:
        cur.execute("SELECT rol FROM users WHERE id = %s", (id,))
        user = cur.fetchone()
        if not user:
            raise HTTPException(status_code=404, detail="Usuario no encontrado")
        if user["rol"] == "superadmin":
            raise HTTPException(status_code=403, detail="No se puede eliminar al superadmin")
        cur.execute("SELECT COUNT(*) AS n FROM users")
        if cur.fetchone()["n"] <= 1:
            raise HTTPException(status_code=400, detail="No se puede eliminar el único usuario")
        cur.execute("DELETE FROM users WHERE id = %s", (id,))
    return {"message": "Usuario eliminado"}


@router.put("/users/{id}", response_model=UserOut)
def update_user(id: int, data: UserUpdate, authorization: str = Header(...)):
    if not _caller_has_perm(authorization, "perm_admin_usuarios"):
        raise HTTPException(403, "Sin permiso para gestionar usuarios")
    with get_db() as cur:
        cur.execute("SELECT rol FROM users WHERE id = %s", (id,))
        target = cur.fetchone()
    if not target:
        raise HTTPException(404, "Usuario no encontrado")
    if target["rol"] == "superadmin":
        raise HTTPException(403, "No se puede editar al superadmin")
    if data.rol is not None:
        with get_db() as cur:
            cur.execute("SELECT nombre FROM roles WHERE nombre = %s", (data.rol,))
            if not cur.fetchone():
                raise HTTPException(400, f"Rol inválido: '{data.rol}'")
    updates, values = [], []
    if data.username is not None:
        username = data.username.strip()
        if not username:
            raise HTTPException(400, "El nombre de usuario no puede estar vacío")
        updates.append("username = %s"); values.append(username)
    if data.rol is not None:
        updates.append("rol = %s"); values.append(data.rol)
    if data.acceso_sobrantes is not None:
        updates.append("acceso_sobrantes = %s"); values.append(data.acceso_sobrantes)
    if data.acceso_novedades is not None:
        updates.append("acceso_novedades = %s"); values.append(data.acceso_novedades)
    if data.acceso_pick is not None:
        updates.append("acceso_pick = %s"); values.append(data.acceso_pick)
    if not updates:
        raise HTTPException(400, "Nada que actualizar")
    with get_db() as cur:
        if data.username:
            cur.execute("SELECT id FROM users WHERE username = %s AND id != %s", (data.username.strip(), id))
            if cur.fetchone():
                raise HTTPException(400, "Ese nombre de usuario ya está en uso")
        values.append(id)
        cur.execute(
            f"UPDATE users SET {', '.join(updates)} WHERE id = %s RETURNING id, username, rol, acceso_sobrantes, acceso_novedades, acceso_pick, created_at",
            values
        )
        return dict(cur.fetchone())


class SobrantesAcceso(BaseModel):
    acceso: bool

@router.put("/users/{id}/sobrantes")
def update_sobrantes_acceso(id: int, data: SobrantesAcceso, authorization: str = Header(...)):
    if not _caller_has_perm(authorization, "perm_admin_usuarios"):
        raise HTTPException(403, "Sin permiso para gestionar usuarios")
    with get_db() as cur:
        cur.execute("SELECT rol FROM users WHERE id = %s", (id,))
        user = cur.fetchone()
        if not user:
            raise HTTPException(404, "Usuario no encontrado")
        if user["rol"] == "superadmin":
            raise HTTPException(403, "El superadmin siempre tiene acceso a sobrantes")
        cur.execute(
            "UPDATE users SET acceso_sobrantes = %s WHERE id = %s RETURNING id, username, rol, acceso_sobrantes, created_at",
            (data.acceso, id)
        )
        return dict(cur.fetchone())
