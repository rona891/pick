# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Zonas y Repartos — COMPARTIDOS entre Yaguar y Diarco.
# Las zonas físicas (MERLO, SANTA ROSA, etc.) y los repartos (Sur Abajo,
# Sur Arriba, etc.) son los mismos para ambos mayoristas.
# Endpoint: /api/zonas/
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from app.db.database import get_db

router = APIRouter(prefix="/zonas", tags=["Zonas y Repartos (compartido)"])


class ZonaIn(BaseModel):
    nombre: str
    reparto: str = ""


@router.get("/")
def list_zonas():
    with get_db() as cur:
        cur.execute("""
            SELECT z.id, z.nombre, z.reparto, COALESCE(r.orden, 99) AS orden
            FROM zonas z
            LEFT JOIN repartos r ON z.reparto = r.nombre
            ORDER BY orden ASC, z.nombre ASC
        """)
        return [dict(r) for r in cur.fetchall()]


@router.get("/repartos")
def list_repartos():
    with get_db() as cur:
        cur.execute("SELECT id, nombre, orden FROM repartos ORDER BY orden ASC")
        return [dict(r) for r in cur.fetchall()]


@router.put("/repartos/{id}/orden")
def update_reparto_orden(id: int, direccion: str):
    if direccion not in ("up", "down"):
        raise HTTPException(400, "direccion debe ser 'up' o 'down'")
    with get_db() as cur:
        cur.execute("SELECT id, orden FROM repartos WHERE id = %s", (id,))
        actual = cur.fetchone()
        if not actual:
            raise HTTPException(404, "Reparto no encontrado")
        orden_actual = actual["orden"]
        if direccion == "up":
            cur.execute("SELECT id, orden FROM repartos WHERE orden < %s ORDER BY orden DESC LIMIT 1", (orden_actual,))
        else:
            cur.execute("SELECT id, orden FROM repartos WHERE orden > %s ORDER BY orden ASC LIMIT 1", (orden_actual,))
        vecino = cur.fetchone()
        if not vecino:
            return list_repartos()
        cur.execute("UPDATE repartos SET orden = %s WHERE id = %s", (vecino["orden"], id))
        cur.execute("UPDATE repartos SET orden = %s WHERE id = %s", (orden_actual, vecino["id"]))
    return list_repartos()


@router.post("/")
def create_zona(data: ZonaIn):
    nombre = data.nombre.strip().upper()
    if not nombre:
        raise HTTPException(400, "El nombre no puede estar vacío")
    with get_db() as cur:
        cur.execute("SELECT id FROM zonas WHERE nombre = %s", (nombre,))
        if cur.fetchone():
            raise HTTPException(400, "Ya existe una zona con ese nombre")
        cur.execute(
            "INSERT INTO zonas (nombre, reparto) VALUES (%s, %s) RETURNING id, nombre, reparto",
            (nombre, data.reparto or None),
        )
        return dict(cur.fetchone())


@router.put("/{id}")
def update_zona(id: int, data: ZonaIn):
    nombre = data.nombre.strip().upper()
    if not nombre:
        raise HTTPException(400, "El nombre no puede estar vacío")
    with get_db() as cur:
        cur.execute(
            "UPDATE zonas SET nombre=%s, reparto=%s WHERE id=%s RETURNING id, nombre, reparto",
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
