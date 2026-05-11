from fastapi import APIRouter, HTTPException, Query
from app.models.schemas import Cliente, ClienteCreate
from app.db.database import get_db
from typing import List

router = APIRouter(prefix="/clientes", tags=["clientes"])


@router.get("/", response_model=List[Cliente])
def list_clientes(mayorista: str = Query("yaguar")):
    with get_db() as cur:
        cur.execute("SELECT * FROM clientes_yaguar WHERE mayorista = %s ORDER BY nombre", (mayorista,))
        return [dict(r) for r in cur.fetchall()]


@router.post("/", response_model=Cliente)
def create_cliente(data: ClienteCreate):
    with get_db() as cur:
        cur.execute(
            """INSERT INTO clientes_yaguar (nombre, localidad, direccion, telefono, contacto, vendedor, mayorista)
               VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING *""",
            (data.nombre, data.localidad, data.direccion, data.telefono, data.contacto, data.vendedor, data.mayorista),
        )
        return dict(cur.fetchone())


@router.put("/{id}", response_model=Cliente)
def update_cliente(id: int, data: ClienteCreate):
    with get_db() as cur:
        cur.execute(
            """UPDATE clientes_yaguar
               SET nombre=%s, localidad=%s, direccion=%s, telefono=%s, contacto=%s, vendedor=%s
               WHERE id=%s RETURNING *""",
            (data.nombre, data.localidad, data.direccion, data.telefono, data.contacto, data.vendedor, id),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Cliente no encontrado")
        return dict(row)


@router.delete("/{id}")
def delete_cliente(id: int):
    with get_db() as cur:
        cur.execute("DELETE FROM clientes_yaguar WHERE id=%s RETURNING id", (id,))
        if not cur.fetchone():
            raise HTTPException(status_code=404, detail="Cliente no encontrado")
    return {"message": "Cliente eliminado"}
