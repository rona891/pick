from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from app.db.database import get_db

router = APIRouter(prefix="/zonas", tags=["zonas"])


class ZonaIn(BaseModel):
    nombre: str
    al_final: bool = False


@router.get("/")
def list_zonas():
    with get_db() as cur:
        cur.execute("SELECT id, nombre, al_final FROM zonas ORDER BY al_final ASC, nombre ASC")
        return [dict(r) for r in cur.fetchall()]


@router.post("/")
def create_zona(data: ZonaIn):
    nombre = data.nombre.strip().upper()
    if not nombre:
        raise HTTPException(400, "El nombre no puede estar vacío")
    with get_db() as cur:
        try:
            cur.execute(
                "INSERT INTO zonas (nombre, al_final) VALUES (%s, %s) RETURNING id, nombre, al_final",
                (nombre, data.al_final),
            )
            return dict(cur.fetchone())
        except Exception:
            raise HTTPException(400, "Ya existe una zona con ese nombre")


@router.put("/{id}")
def update_zona(id: int, data: ZonaIn):
    nombre = data.nombre.strip().upper()
    if not nombre:
        raise HTTPException(400, "El nombre no puede estar vacío")
    with get_db() as cur:
        cur.execute(
            "UPDATE zonas SET nombre=%s, al_final=%s WHERE id=%s RETURNING id, nombre, al_final",
            (nombre, data.al_final, id),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(404, "Zona no encontrada")
        return dict(row)


@router.delete("/{id}")
def delete_zona(id: int):
    with get_db() as cur:
        cur.execute("DELETE FROM zonas WHERE id=%s RETURNING nombre", (id,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(404, "Zona no encontrada")
    return {"message": "Zona eliminada", "nombre": row["nombre"]}
