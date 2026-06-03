from fastapi import APIRouter, Query
from typing import Optional
from app.db.database import get_db

router_yaguar = APIRouter(prefix="/yaguar/articulos", tags=["Yaguar - Artículos"])
router_diarco = APIRouter(prefix="/diarco/articulos", tags=["Diarco - Artículos"])

_COLS = """
    cod_art, cod_bar, cod_bar_bulto, descrip, fabricante, unidad_medida,
    uxb, precio_con_iva, precio_costo, precio_mayorista, porc_iva,
    descuento_default, impuestos_monto, impuestos_porc,
    familia, subcategoria, tipo_unidad, tipo_estado,
    estado, stock, observaciones, folder,
    usrdef_0, usrdef_1, usrdef_6, updated_at
"""


def _list(mayorista: str, q: Optional[str], limit: int):
    with get_db() as cur:
        if q:
            pattern = f"%{q}%"
            cur.execute(f"""
                SELECT {_COLS}
                FROM articulos_catalogo
                WHERE mayorista = %s
                  AND (descrip ILIKE %s OR cod_art ILIKE %s
                       OR cod_bar ILIKE %s OR fabricante ILIKE %s)
                ORDER BY descrip
                LIMIT %s
            """, (mayorista, pattern, pattern, pattern, pattern, limit))
        else:
            cur.execute(f"""
                SELECT {_COLS}
                FROM articulos_catalogo
                WHERE mayorista = %s
                ORDER BY descrip
                LIMIT %s
            """, (mayorista, limit))
        return [dict(r) for r in cur.fetchall()]


@router_yaguar.get("/")
def yaguar_list(q: Optional[str] = Query(default=None),
                limit: int = Query(default=20000, ge=1, le=50000)):
    return _list("yaguar", q, limit)


@router_diarco.get("/")
def diarco_list(q: Optional[str] = Query(default=None),
                limit: int = Query(default=20000, ge=1, le=50000)):
    return _list("diarco", q, limit)
