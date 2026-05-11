from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from app.db.database import get_db

router = APIRouter(prefix="/zonas", tags=["zonas"])


class ZonaIn(BaseModel):
    nombre: str
    reparto: str = ""
    mayorista: str = "yaguar"


@router.get("/")
def list_zonas(mayorista: str = Query("yaguar")):
    with get_db() as cur:
        cur.execute("""
            SELECT z.id, z.nombre, z.reparto, z.mayorista, COALESCE(r.orden, 99) AS orden
            FROM zonas z
            LEFT JOIN repartos r ON z.reparto = r.nombre AND r.mayorista = z.mayorista
            WHERE z.mayorista = %s
            ORDER BY orden ASC, z.nombre ASC
        """, (mayorista,))
        return [dict(r) for r in cur.fetchall()]


@router.get("/repartos")
def list_repartos(mayorista: str = Query("yaguar")):
    with get_db() as cur:
        cur.execute("SELECT id, nombre, orden, mayorista FROM repartos WHERE mayorista = %s ORDER BY orden ASC", (mayorista,))
        return [dict(r) for r in cur.fetchall()]


@router.put("/repartos/{id}/orden")
def update_reparto_orden(id: int, direccion: str):
    if direccion not in ("up", "down"):
        raise HTTPException(400, "direccion debe ser 'up' o 'down'")
    with get_db() as cur:
        cur.execute("SELECT id, orden, mayorista FROM repartos WHERE id = %s", (id,))
        actual = cur.fetchone()
        if not actual:
            raise HTTPException(404, "Reparto no encontrado")
        orden_actual = actual["orden"]
        mayorista = actual["mayorista"]
        if direccion == "up":
            cur.execute("SELECT id, orden FROM repartos WHERE orden < %s AND mayorista = %s ORDER BY orden DESC LIMIT 1", (orden_actual, mayorista))
        else:
            cur.execute("SELECT id, orden FROM repartos WHERE orden > %s AND mayorista = %s ORDER BY orden ASC LIMIT 1", (orden_actual, mayorista))
        vecino = cur.fetchone()
        if not vecino:
            return list_repartos(mayorista)
        cur.execute("UPDATE repartos SET orden = %s WHERE id = %s", (vecino["orden"], id))
        cur.execute("UPDATE repartos SET orden = %s WHERE id = %s", (orden_actual, vecino["id"]))
    return list_repartos(mayorista)


@router.post("/")
def create_zona(data: ZonaIn):
    nombre = data.nombre.strip().upper()
    if not nombre:
        raise HTTPException(400, "El nombre no puede estar vacío")
    with get_db() as cur:
        try:
            cur.execute(
                "INSERT INTO zonas (nombre, reparto, mayorista) VALUES (%s, %s, %s) RETURNING id, nombre, reparto, mayorista",
                (nombre, data.reparto or None, data.mayorista),
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
            "UPDATE zonas SET nombre=%s, reparto=%s WHERE id=%s RETURNING id, nombre, reparto, mayorista",
            (nombre, data.reparto or None, id),
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
