"""
Import DIARCOCLIENTES.csv into clientes_yaguar (mayorista='diarco').

Reglas:
  - VENDEDOR=NO ASIG + CODIGO presente  → estado='libre', es_factura_a=false
  - ZONA=52 + vendedor real             → estado='ocupado', es_factura_a=false
  - ZONA=53 + vendedor real             → estado='ocupado', es_factura_a=true
  - Sin CODIGO o ZONA=N/A con vendedor  → skip

Run: docker compose exec backend python scripts/import_diarco_clientes.py
"""

import csv
import re
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.db.database import init_pool, get_db

LOC_SUFFIX = re.compile(r',\s*(S\.?Luis|SAN LUIS|San Luis).*$', re.IGNORECASE)


def normalize_loc(s):
    return LOC_SUFFIX.sub('', s or '').strip().upper() or None


CSV_PATH = '/data/DIARCOCLIENTES.csv'

init_pool()

with open(CSV_PATH, encoding='utf-8-sig', newline='') as f:
    rows = list(csv.reader(f))

if not rows:
    print("CSV vacío")
    sys.exit(1)

header = rows[0]
print(f"Columnas CSV: {header}")
print(f"Total filas (sin encabezado): {len(rows) - 1}")

stats = {'libre': 0, 'cf': 0, 'fa': 0, 'skip_no_codigo': 0, 'skip_zona_na': 0}

with get_db() as cur:
    for r in rows[1:]:
        if len(r) < 16:
            stats['skip_no_codigo'] += 1
            continue

        codigo = r[0].strip()
        if not codigo:
            stats['skip_no_codigo'] += 1
            continue

        zona = r[12].strip()
        vendedor_raw = r[11].strip()

        if vendedor_raw == 'NO ASIG':
            estado = 'libre'
            es_fa = False
            stats['libre'] += 1
        elif zona == '52':
            estado = 'ocupado'
            es_fa = False
            stats['cf'] += 1
        elif zona == '53':
            estado = 'ocupado'
            es_fa = True
            stats['fa'] += 1
        else:
            # ZONA=N/A con vendedor real → skip
            stats['skip_zona_na'] += 1
            continue

        nombre = (r[2].strip() or r[1].strip()) or None
        loc = normalize_loc(r[15]) if len(r) > 15 else None
        telefono = r[8].strip() or None if len(r) > 8 else None

        try:
            flete = float(r[10]) if len(r) > 10 and r[10].strip() else None
        except ValueError:
            flete = None

        cuit_dep_raw = r[6].strip() if len(r) > 6 else ''
        cuit_dep = cuit_dep_raw if cuit_dep_raw not in ('', '00-00000000-0') else None

        vend_val = vendedor_raw if vendedor_raw != 'NO ASIG' else None

        cur.execute("""
            INSERT INTO clientes_yaguar
                (id_yaguar, mayorista, nombre, localidad, telefono, flete, vendedor,
                 cuit_deposito, estado, es_factura_a)
            VALUES (%s, 'diarco', %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (id_yaguar, mayorista) DO UPDATE SET
                nombre         = EXCLUDED.nombre,
                localidad      = EXCLUDED.localidad,
                telefono       = EXCLUDED.telefono,
                flete          = EXCLUDED.flete,
                vendedor       = EXCLUDED.vendedor,
                cuit_deposito  = EXCLUDED.cuit_deposito,
                estado         = EXCLUDED.estado,
                es_factura_a   = EXCLUDED.es_factura_a
        """, (codigo, nombre, loc, telefono, flete, vend_val, cuit_dep, estado, es_fa))

print(f"\nResultado:")
print(f"  {stats['libre']} códigos libres CF")
print(f"  {stats['cf']} clientes CF ocupados (ZONA=52)")
print(f"  {stats['fa']} clientes FA ocupados (ZONA=53)")
print(f"  {stats['skip_no_codigo']} filas sin CODIGO (ignoradas)")
print(f"  {stats['skip_zona_na']} filas ZONA=N/A con vendedor (ignoradas)")
print(f"\nTotal importados: {stats['libre'] + stats['cf'] + stats['fa']}")
