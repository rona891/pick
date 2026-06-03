from fastapi import APIRouter, Query
from typing import Optional
from pydantic import BaseModel
from app.db.database import get_db


class ArticuloManualIn(BaseModel):
    cod_bar: str
    descrip: str
    uxb: int = 0

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
                       OR cod_bar ILIKE %s OR cod_bar_bulto ILIKE %s
                       OR fabricante ILIKE %s)
                ORDER BY descrip
                LIMIT %s
            """, (mayorista, pattern, pattern, pattern, pattern, pattern, limit))
        else:
            cur.execute(f"""
                SELECT {_COLS}
                FROM articulos_catalogo
                WHERE mayorista = %s
                ORDER BY descrip
                LIMIT %s
            """, (mayorista, limit))
        return [dict(r) for r in cur.fetchall()]


def _guardar_manual(mayorista: str, data: ArticuloManualIn):
    with get_db() as cur:
        # Si ya existe una entrada con ese barcode, actualizarla
        cur.execute(
            "SELECT cod_art FROM articulos_catalogo WHERE cod_bar = %s AND mayorista = %s LIMIT 1",
            (data.cod_bar, mayorista)
        )
        existing = cur.fetchone()
        if existing:
            cur.execute(
                "UPDATE articulos_catalogo SET descrip=%s, uxb=%s, updated_at=NOW() WHERE cod_art=%s AND mayorista=%s",
                (data.descrip, data.uxb, existing["cod_art"], mayorista)
            )
        else:
            # Usar el barcode como cod_art (identificador temporal hasta que se importe la semana)
            cur.execute("""
                INSERT INTO articulos_catalogo (cod_art, mayorista, cod_bar, descrip, uxb, updated_at)
                VALUES (%s, %s, %s, %s, %s, NOW())
                ON CONFLICT (cod_art, mayorista) DO UPDATE SET
                    descrip=EXCLUDED.descrip, cod_bar=EXCLUDED.cod_bar,
                    uxb=EXCLUDED.uxb, updated_at=NOW()
            """, (data.cod_bar, mayorista, data.cod_bar, data.descrip, data.uxb))
    return {"ok": True}


@router_yaguar.get("/")
def yaguar_list(q: Optional[str] = Query(default=None),
                limit: int = Query(default=20000, ge=1, le=50000)):
    return _list("yaguar", q, limit)


@router_diarco.get("/")
def diarco_list(q: Optional[str] = Query(default=None),
                limit: int = Query(default=20000, ge=1, le=50000)):
    return _list("diarco", q, limit)


@router_yaguar.post("/manual")
def yaguar_guardar_manual(data: ArticuloManualIn):
    return _guardar_manual("yaguar", data)


@router_diarco.post("/manual")
def diarco_guardar_manual(data: ArticuloManualIn):
    return _guardar_manual("diarco", data)
