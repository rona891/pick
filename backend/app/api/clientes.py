# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Clientes — rutas separadas por mayorista.
#   Yaguar → /api/yaguar/clientes/...
#   Diarco → /api/diarco/clientes/...
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
from fastapi import APIRouter, HTTPException, Query
from app.models.schemas import Cliente, ClienteCreate, MarcarNoAptoIn
from app.db.database import get_db
from typing import List
import psycopg2

router_yaguar = APIRouter(prefix="/yaguar/clientes", tags=["Yaguar - Clientes"])
router_diarco = APIRouter(prefix="/diarco/clientes", tags=["Diarco - Clientes"])


def _list(mayorista: str):
    with get_db() as cur:
        if mayorista == 'yaguar':
            # Solo clientes ocupados; libres y no_apto no aparecen en la lista
            cur.execute(
                "SELECT * FROM clientes_yaguar WHERE mayorista = %s AND (estado = 'ocupado' OR estado IS NULL) ORDER BY nombre",
                (mayorista,)
            )
        else:
            cur.execute("SELECT * FROM clientes_yaguar WHERE mayorista = %s ORDER BY nombre", (mayorista,))
        return [dict(r) for r in cur.fetchall()]


def _normalizar(data: ClienteCreate) -> ClienteCreate:
    if data.nombre:
        data.nombre = data.nombre.strip().upper()
    if data.localidad:
        data.localidad = data.localidad.strip().upper()
    return data


def _create(mayorista: str, data: ClienteCreate):
    data = _normalizar(data)
    try:
        with get_db() as cur:
            estado = 'ocupado' if mayorista == 'yaguar' else None
            result = None
            if data.id_yaguar:
                # Si ya existe un registro con ese código (libre), reutilizarlo
                cur.execute("SELECT id FROM clientes_yaguar WHERE id_yaguar = %s", (data.id_yaguar,))
                existing = cur.fetchone()
                if existing:
                    cur.execute(
                        """UPDATE clientes_yaguar
                           SET nombre=%s, localidad=%s, direccion=%s, telefono=%s,
                               contacto=%s, vendedor=%s, mayorista=%s, flete=%s, estado=%s
                           WHERE id=%s RETURNING *""",
                        (data.nombre, data.localidad, data.direccion, data.telefono,
                         data.contacto, data.vendedor, mayorista, data.flete, estado, existing['id']),
                    )
                    result = dict(cur.fetchone())
            if result is None:
                cur.execute(
                    """INSERT INTO clientes_yaguar
                       (nombre, localidad, direccion, telefono, contacto, vendedor, mayorista, id_yaguar, flete, estado)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING *""",
                    (data.nombre, data.localidad, data.direccion, data.telefono,
                     data.contacto, data.vendedor, mayorista, data.id_yaguar, data.flete, estado),
                )
                result = dict(cur.fetchone())
            # Actualizar picks que usaban el código como nombre placeholder
            if data.id_yaguar and data.nombre:
                cur.execute(
                    """UPDATE pick SET nombre = %s, localidad = %s
                       WHERE cliente = %s AND mayorista = %s
                         AND (nombre = %s OR nombre IS NULL OR nombre = '')""",
                    (data.nombre, data.localidad, data.id_yaguar, mayorista, data.id_yaguar),
                )
            return result
    except psycopg2.errors.UniqueViolation:
        raise HTTPException(status_code=409, detail=f"Ya existe un cliente con el código Yaguar '{data.id_yaguar}'")


def _update(id: int, data: ClienteCreate, mayorista: str = 'yaguar'):
    data = _normalizar(data)
    try:
        with get_db() as cur:
            cur.execute(
                """UPDATE clientes_yaguar
                   SET nombre=%s, localidad=%s, direccion=%s, telefono=%s, contacto=%s,
                       vendedor=%s, id_yaguar=%s, flete=%s
                   WHERE id=%s RETURNING *""",
                (data.nombre, data.localidad, data.direccion, data.telefono,
                 data.contacto, data.vendedor, data.id_yaguar, data.flete, id),
            )
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Cliente no encontrado")
            result = dict(row)
            # Propagar nombre y localidad a todos los picks de este cliente
            if data.id_yaguar and data.nombre:
                cur.execute(
                    """UPDATE pick SET nombre = %s, localidad = %s
                       WHERE cliente = %s AND mayorista = %s""",
                    (data.nombre, data.localidad, data.id_yaguar, mayorista),
                )
            return result
    except psycopg2.errors.UniqueViolation:
        raise HTTPException(status_code=409, detail=f"Ya existe un cliente con el código Yaguar '{data.id_yaguar}'")


def _delete(id: int):
    with get_db() as cur:
        cur.execute("DELETE FROM clientes_yaguar WHERE id=%s RETURNING id", (id,))
        if not cur.fetchone():
            raise HTTPException(status_code=404, detail="Cliente no encontrado")
    return {"message": "Cliente eliminado"}


# ── Rutas Yaguar ──────────────────────────────────────────────────────────

def _sin_registrar(mayorista: str):
    with get_db() as cur:
        cur.execute("""
            SELECT DISTINCT ON (p.cliente) p.cliente AS id, p.nombre AS nombre_obs
            FROM pick p
            LEFT JOIN clientes_yaguar c
                ON c.id_yaguar = p.cliente AND c.mayorista = %s
            WHERE p.mayorista = %s
              AND p.cliente IS NOT NULL AND p.cliente <> ''
              AND (c.id IS NULL OR c.nombre IS NULL OR c.nombre = '')
            ORDER BY p.cliente
        """, (mayorista, mayorista))
        return [dict(r) for r in cur.fetchall()]


@router_yaguar.get("/sin-registrar")
def yaguar_sin_registrar(): return _sin_registrar("yaguar")

@router_diarco.get("/sin-registrar")
def diarco_sin_registrar(): return _sin_registrar("diarco")


@router_yaguar.get("/vendedores")
@router_diarco.get("/vendedores")
def get_vendedores():
    with get_db() as cur:
        cur.execute("""
            SELECT DISTINCT vendedor FROM clientes_yaguar
            WHERE vendedor IS NOT NULL AND vendedor <> ''
            ORDER BY vendedor
        """)
        return [r["vendedor"] for r in cur.fetchall()]


@router_yaguar.get("/codigo-libre")
def yaguar_codigo_libre():
    with get_db() as cur:
        cur.execute("""
            SELECT id_yaguar FROM clientes_yaguar
            WHERE estado = 'libre' AND id_yaguar IS NOT NULL
            ORDER BY id_yaguar
            LIMIT 1
        """)
        row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="No hay códigos libres disponibles")
    return {"codigo": row["id_yaguar"]}


@router_yaguar.put("/marcar-no-apto")
def yaguar_marcar_no_apto(payload: MarcarNoAptoIn):
    with get_db() as cur:
        cur.execute(
            """UPDATE clientes_yaguar SET estado = 'no_apto', nombre = NULL,
               localidad = NULL, direccion = NULL, telefono = NULL,
               contacto = NULL, vendedor = NULL, flete = NULL
               WHERE id_yaguar = %s AND mayorista = 'yaguar'""",
            (payload.codigo,)
        )
        if cur.rowcount == 0:
            cur.execute(
                "INSERT INTO clientes_yaguar (id_yaguar, mayorista, estado) VALUES (%s, 'yaguar', 'no_apto')",
                (payload.codigo,)
            )
        # Siguiente código libre disponible
        cur.execute(
            """SELECT id_yaguar FROM clientes_yaguar
               WHERE estado = 'libre' AND id_yaguar IS NOT NULL
               ORDER BY id_yaguar LIMIT 1"""
        )
        row = cur.fetchone()
    return {"nuevo_codigo": row["id_yaguar"] if row else None}


@router_yaguar.get("/", response_model=List[Cliente])
def yaguar_list(): return _list("yaguar")

@router_yaguar.post("/", response_model=Cliente)
def yaguar_create(data: ClienteCreate): return _create("yaguar", data)

@router_yaguar.put("/{id}", response_model=Cliente)
def yaguar_update(id: int, data: ClienteCreate): return _update(id, data, 'yaguar')

@router_yaguar.delete("/{id}")
def yaguar_delete(id: int): return _delete(id)


# ── Rutas Diarco ──────────────────────────────────────────────────────────

@router_diarco.get("/", response_model=List[Cliente])
def diarco_list(): return _list("diarco")

@router_diarco.post("/", response_model=Cliente)
def diarco_create(data: ClienteCreate): return _create("diarco", data)

@router_diarco.put("/{id}", response_model=Cliente)
def diarco_update(id: int, data: ClienteCreate): return _update(id, data, 'diarco')

@router_diarco.delete("/{id}")
def diarco_delete(id: int): return _delete(id)
