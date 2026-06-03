from fastapi import APIRouter, HTTPException, Header
from pydantic import BaseModel
from typing import Optional
from app.db.database import get_db
from app.auth.jwt import verify_token

router = APIRouter(prefix="/roles", tags=["Roles"])

ALL_PERMS = [
    "perm_pick", "perm_sobrantes", "perm_novedades",
    "perm_yaguar", "perm_diarco",
    "perm_admin_clientes", "perm_admin_semanas", "perm_admin_zonas",
    "perm_admin_auditoria", "perm_admin_articulos",
    "perm_admin_usuarios", "perm_admin_roles",
]


class RolIn(BaseModel):
    nombre: str
    perm_pick: bool = False
    perm_sobrantes: bool = False
    perm_novedades: bool = False
    perm_yaguar: bool = False
    perm_diarco: bool = False
    perm_admin_clientes: bool = False
    perm_admin_semanas: bool = False
    perm_admin_zonas: bool = False
    perm_admin_auditoria: bool = False
    perm_admin_articulos: bool = False
    perm_admin_usuarios: bool = False
    perm_admin_roles: bool = False


def _require_perm(authorization: str, perm: str):
    payload = verify_token(authorization)
    user_id = payload.get("sub")
    with get_db() as cur:
        cur.execute(
            f"SELECT r.{perm} FROM users u LEFT JOIN roles r ON r.nombre = u.rol WHERE u.id = %s",
            (user_id,),
        )
        row = cur.fetchone()
    if not row or not row[perm]:
        raise HTTPException(403, "Sin permiso para gestionar roles")
    return user_id


@router.get("/")
def list_roles():
    with get_db() as cur:
        cur.execute(f"""
            SELECT nombre, es_protegido, orden, {', '.join(ALL_PERMS)}, created_at
            FROM roles
            ORDER BY
                CASE WHEN nombre = 'superadmin' THEN 0 ELSE 1 END,
                orden ASC,
                nombre ASC
        """)
        return [dict(r) for r in cur.fetchall()]


class OrdenIn(BaseModel):
    nombres: list  # lista de nombres de roles en el orden deseado (sin superadmin)


@router.put("/orden")
def set_orden(data: OrdenIn, authorization: str = Header(...)):
    _require_perm(authorization, "perm_admin_roles")
    with get_db() as cur:
        for i, nombre in enumerate(data.nombres, start=1):
            cur.execute("UPDATE roles SET orden = %s WHERE nombre = %s AND nombre != 'superadmin'",
                        (i, nombre))
    return {"ok": True}


@router.post("/", status_code=201)
def create_rol(data: RolIn, authorization: str = Header(...)):
    _require_perm(authorization, "perm_admin_roles")
    nombre = data.nombre.strip()
    if not nombre:
        raise HTTPException(400, "El nombre del rol no puede estar vacío")
    cols = ", ".join(ALL_PERMS)
    placeholders = ", ".join(["%s"] * len(ALL_PERMS))
    vals = [getattr(data, p) for p in ALL_PERMS]
    with get_db() as cur:
        cur.execute("SELECT nombre FROM roles WHERE nombre = %s", (nombre,))
        if cur.fetchone():
            raise HTTPException(400, f"Ya existe un rol con el nombre '{nombre}'")
        cur.execute(
            f"INSERT INTO roles (nombre, {cols}) VALUES (%s, {placeholders}) RETURNING nombre",
            [nombre] + vals,
        )
        return {"ok": True, "nombre": nombre}


@router.put("/{nombre}")
def update_rol_perms(nombre: str, data: RolIn, authorization: str = Header(...)):
    _require_perm(authorization, "perm_admin_roles")
    with get_db() as cur:
        cur.execute("SELECT es_protegido FROM roles WHERE nombre = %s", (nombre,))
        rol = cur.fetchone()
        if not rol:
            raise HTTPException(404, "Rol no encontrado")
        # Protegido: no se puede renombrar, pero SÍ se pueden editar permisos
        nuevo_nombre = data.nombre.strip()
        if rol["es_protegido"] and nuevo_nombre != nombre:
            raise HTTPException(403, "No se puede renombrar un rol protegido")
        if nuevo_nombre != nombre:
            cur.execute("SELECT nombre FROM roles WHERE nombre = %s", (nuevo_nombre,))
            if cur.fetchone():
                raise HTTPException(400, f"Ya existe un rol con el nombre '{nuevo_nombre}'")
            # Actualizar referencias en users
            cur.execute("UPDATE users SET rol = %s WHERE rol = %s", (nuevo_nombre, nombre))
        sets = ", ".join([f"{p} = %s" for p in ALL_PERMS])
        if nuevo_nombre != nombre:
            sets = f"nombre = %s, {sets}"
            vals = [nuevo_nombre] + [getattr(data, p) for p in ALL_PERMS]
        else:
            vals = [getattr(data, p) for p in ALL_PERMS]
        cur.execute(f"UPDATE roles SET {sets} WHERE nombre = %s", vals + [nombre])
    return {"ok": True}


@router.delete("/{nombre}")
def delete_rol(nombre: str, authorization: str = Header(...)):
    _require_perm(authorization, "perm_admin_roles")
    with get_db() as cur:
        cur.execute("SELECT es_protegido FROM roles WHERE nombre = %s", (nombre,))
        rol = cur.fetchone()
        if not rol:
            raise HTTPException(404, "Rol no encontrado")
        if rol["es_protegido"]:
            raise HTTPException(403, "No se puede eliminar un rol protegido")
        cur.execute("SELECT COUNT(*) AS n FROM users WHERE rol = %s", (nombre,))
        if cur.fetchone()["n"] > 0:
            raise HTTPException(400, f"No se puede eliminar: hay usuarios asignados al rol '{nombre}'")
        cur.execute("DELETE FROM roles WHERE nombre = %s", (nombre,))
    return {"ok": True}
