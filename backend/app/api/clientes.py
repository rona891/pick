# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Clientes — rutas separadas por mayorista.
#   Yaguar → /api/yaguar/clientes/...
#   Diarco → /api/diarco/clientes/...
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
from fastapi import APIRouter, HTTPException, Query
from app.models.schemas import Cliente, ClienteCreate
from app.db.database import get_db
from typing import List

router_yaguar = APIRouter(prefix="/yaguar/clientes", tags=["Yaguar - Clientes"])
router_diarco = APIRouter(prefix="/diarco/clientes", tags=["Diarco - Clientes"])


def _list(mayorista: str):
    with get_db() as cur:
        cur.execute("SELECT * FROM clientes_yaguar WHERE mayorista = %s ORDER BY nombre", (mayorista,))
        return [dict(r) for r in cur.fetchall()]


def _create(mayorista: str, data: ClienteCreate):
    with get_db() as cur:
        cur.execute(
            """INSERT INTO clientes_yaguar
               (nombre, localidad, direccion, telefono, contacto, vendedor, mayorista)
               VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING *""",
            (data.nombre, data.localidad, data.direccion, data.telefono,
             data.contacto, data.vendedor, mayorista),
        )
        return dict(cur.fetchone())


def _update(id: int, data: ClienteCreate):
    with get_db() as cur:
        cur.execute(
            """UPDATE clientes_yaguar
               SET nombre=%s, localidad=%s, direccion=%s, telefono=%s, contacto=%s, vendedor=%s
               WHERE id=%s RETURNING *""",
            (data.nombre, data.localidad, data.direccion, data.telefono,
             data.contacto, data.vendedor, id),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Cliente no encontrado")
        return dict(row)


def _delete(id: int):
    with get_db() as cur:
        cur.execute("DELETE FROM clientes_yaguar WHERE id=%s RETURNING id", (id,))
        if not cur.fetchone():
            raise HTTPException(status_code=404, detail="Cliente no encontrado")
    return {"message": "Cliente eliminado"}


# ── Rutas Yaguar ──────────────────────────────────────────────────────────

@router_yaguar.get("/", response_model=List[Cliente])
def yaguar_list(): return _list("yaguar")

@router_yaguar.post("/", response_model=Cliente)
def yaguar_create(data: ClienteCreate): return _create("yaguar", data)

@router_yaguar.put("/{id}", response_model=Cliente)
def yaguar_update(id: int, data: ClienteCreate): return _update(id, data)

@router_yaguar.delete("/{id}")
def yaguar_delete(id: int): return _delete(id)


# ── Rutas Diarco ──────────────────────────────────────────────────────────

@router_diarco.get("/", response_model=List[Cliente])
def diarco_list(): return _list("diarco")

@router_diarco.post("/", response_model=Cliente)
def diarco_create(data: ClienteCreate): return _create("diarco", data)

@router_diarco.put("/{id}", response_model=Cliente)
def diarco_update(id: int, data: ClienteCreate): return _update(id, data)

@router_diarco.delete("/{id}")
def diarco_delete(id: int): return _delete(id)
