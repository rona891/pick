#!/usr/bin/env python3
"""
Migra datos de Supabase a PostgreSQL local.

Uso:
  docker-compose run --rm backend python scripts/migrate_from_supabase.py

Requiere en .env: SUPABASE_URL, SUPABASE_KEY, DATABASE_URL
"""
import os
import sys
import psycopg2
from psycopg2.extras import RealDictCursor, execute_values
from supabase import create_client
import bcrypt as _bcrypt

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")
DATABASE_URL = os.environ.get("DATABASE_URL")
DEFAULT_PASSWORD = os.environ.get("MIGRATION_DEFAULT_PASSWORD", "CambiarEsta2024!")

if not all([SUPABASE_URL, SUPABASE_KEY, DATABASE_URL]):
    print("Error: faltan SUPABASE_URL, SUPABASE_KEY o DATABASE_URL en el entorno.")
    sys.exit(1)

sb = create_client(SUPABASE_URL, SUPABASE_KEY)
pg = psycopg2.connect(DATABASE_URL, cursor_factory=RealDictCursor)
cur = pg.cursor()


def migrate_picks():
    print("→ Migrando tabla pick...", end=" ", flush=True)
    rows = sb.table("pick").select("*").execute().data
    if not rows:
        print("vacía.")
        return

    cols = ["id", "cod_bar", "cod_art", "descrip", "nombre", "cliente",
            "localidad", "uni", "bul", "cantidad_pickeada", "estado", "semana", "updated_at"]
    values = [[row.get(c) for c in cols] for row in rows]

    execute_values(cur, f"""
        INSERT INTO pick ({', '.join(cols)}) VALUES %s
        ON CONFLICT (id) DO UPDATE SET
            cod_bar = EXCLUDED.cod_bar, cod_art = EXCLUDED.cod_art,
            descrip = EXCLUDED.descrip, nombre = EXCLUDED.nombre,
            cliente = EXCLUDED.cliente, localidad = EXCLUDED.localidad,
            uni = EXCLUDED.uni, bul = EXCLUDED.bul,
            cantidad_pickeada = EXCLUDED.cantidad_pickeada,
            estado = EXCLUDED.estado, semana = EXCLUDED.semana,
            updated_at = EXCLUDED.updated_at
    """, values)

    cur.execute("SELECT setval('pick_id_seq', COALESCE((SELECT MAX(id) FROM pick), 1))")
    print(f"{len(rows)} registros.")


def migrate_clientes():
    print("→ Migrando tabla clientes_yaguar...", end=" ", flush=True)
    rows = sb.table("clientes_yaguar").select("*").execute().data
    if not rows:
        print("vacía.")
        return

    cols = ["id", "nombre", "localidad", "direccion", "telefono", "contacto", "vendedor"]
    values = [[row.get(c) for c in cols] for row in rows]

    execute_values(cur, f"""
        INSERT INTO clientes_yaguar ({', '.join(cols)}) VALUES %s
        ON CONFLICT (id) DO UPDATE SET
            nombre = EXCLUDED.nombre, localidad = EXCLUDED.localidad,
            direccion = EXCLUDED.direccion, telefono = EXCLUDED.telefono,
            contacto = EXCLUDED.contacto, vendedor = EXCLUDED.vendedor
    """, values)

    cur.execute("SELECT setval('clientes_yaguar_id_seq', COALESCE((SELECT MAX(id) FROM clientes_yaguar), 1))")
    print(f"{len(rows)} registros.")


def migrate_users():
    print("→ Migrando usuarios...", end=" ", flush=True)
    try:
        response = sb.auth.admin.list_users()
        users = response if isinstance(response, list) else []
    except Exception as e:
        print(f"no se pudo obtener usuarios: {e}")
        return

    if not users:
        print("ninguno encontrado.")
        return

    hashed = _bcrypt.hashpw(DEFAULT_PASSWORD.encode(), _bcrypt.gensalt()).decode()
    inserted = 0
    for user in users:
        email = getattr(user, "email", None) or (user.get("email") if isinstance(user, dict) else None)
        if not email:
            continue
        cur.execute(
            "INSERT INTO users (email, password_hash) VALUES (%s, %s) ON CONFLICT (email) DO NOTHING",
            (email, hashed),
        )
        inserted += 1

    print(f"{inserted} usuarios creados con contraseña temporal: '{DEFAULT_PASSWORD}'")
    print("  ⚠️  Cambiá las contraseñas después de migrar.")


try:
    print("\n=== Migración Supabase → PostgreSQL ===\n")
    migrate_picks()
    migrate_clientes()
    migrate_users()
    pg.commit()
    print("\n✓ Migración completada.\n")
except Exception as e:
    pg.rollback()
    print(f"\n✗ Error durante la migración: {e}")
    sys.exit(1)
finally:
    cur.close()
    pg.close()
