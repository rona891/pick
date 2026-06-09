from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from app.db.database import get_db

router_yaguar  = APIRouter(prefix="/yaguar/asignaciones",  tags=["Yaguar - Asignaciones Reparto"])
router_diarco  = APIRouter(prefix="/diarco/asignaciones",  tags=["Diarco - Asignaciones Reparto"])
router_shared  = APIRouter(prefix="/asignaciones",         tags=["Asignaciones Reparto"])


class AsignacionIn(BaseModel):
    semana: str
    reparto: str
    user_id: int


# ── Shared (universal, sin filtro de mayorista) ────────────────────────────────

def _get_asig(semana: str):
    with get_db() as cur:
        cur.execute("""
            SELECT id, semana, reparto, user_id, username, created_at
            FROM asignaciones_reparto
            WHERE semana = %s
            ORDER BY reparto ASC
        """, (semana,))
        return [dict(r) for r in cur.fetchall()]


def _set_asig(data: AsignacionIn):
    with get_db() as cur:
        cur.execute("SELECT username FROM users WHERE id = %s", (data.user_id,))
        user = cur.fetchone()
        if not user:
            raise HTTPException(404, "Usuario no encontrado")
        cur.execute("""
            INSERT INTO asignaciones_reparto (semana, reparto, user_id, username)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (semana, reparto, user_id) DO UPDATE
                SET username = EXCLUDED.username
            RETURNING id, semana, reparto, user_id, username
        """, (data.semana, data.reparto, data.user_id, user["username"]))
        return dict(cur.fetchone())


def _delete_asig(id: int):
    with get_db() as cur:
        cur.execute("DELETE FROM asignaciones_reparto WHERE id = %s RETURNING id", (id,))
        if not cur.fetchone():
            raise HTTPException(404, "Asignación no encontrada")
    return {"ok": True}


@router_shared.get("/")
def get_asignaciones(semana: str = Query(...)):
    return _get_asig(semana)


@router_shared.put("/")
def set_asignacion(data: AsignacionIn):
    return _set_asig(data)


@router_shared.delete("/{id}")
def delete_asignacion(id: int):
    return _delete_asig(id)


# ── Legacy mayorista-específico (mantener por compatibilidad) ──────────────────

def _get_asignaciones(mayorista: str, semana: str):
    return _get_asig(semana)

def _set_asignacion(mayorista: str, data: AsignacionIn):
    return _set_asig(data)

def _delete_asignacion(mayorista: str, id: int):
    return _delete_asig(id)


@router_yaguar.get("/")
def get_asignaciones_yaguar(semana: str = Query(...)):
    return _get_asig(semana)

@router_yaguar.put("/")
def set_asignacion_yaguar(data: AsignacionIn):
    return _set_asig(data)

@router_yaguar.delete("/{id}")
def delete_asignacion_yaguar(id: int):
    return _delete_asig(id)


@router_diarco.get("/")
def get_asignaciones_diarco(semana: str = Query(...)):
    return _get_asig(semana)

@router_diarco.put("/")
def set_asignacion_diarco(data: AsignacionIn):
    return _set_asig(data)

@router_diarco.delete("/{id}")
def delete_asignacion_diarco(id: int):
    return _delete_asig(id)
