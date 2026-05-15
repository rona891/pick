from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.api import picks, auth, health, clientes, admin, zonas, export
from app.api.yaguar import semanas as yaguar_semanas
from app.api.diarco import semanas as diarco_semanas
from app.api.sobrantes import router_yaguar as sob_yaguar, router_diarco as sob_diarco, router_shared as sob_shared
from app.api.asignaciones import router_yaguar as asig_yaguar, router_diarco as asig_diarco
# picks, clientes y export tienen routers dobles (uno por mayorista)
from app.auth.jwt import hash_password
from app.db.database import init_pool, get_db
from config import settings


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_pool()
    with get_db() as cur:
        cur.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS rol VARCHAR NOT NULL DEFAULT 'operario'")
        cur.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS acceso_sobrantes BOOLEAN NOT NULL DEFAULT false")
        # Crear superadmin si no existe ninguno
        cur.execute("SELECT COUNT(*) AS n FROM users WHERE rol = 'superadmin'")
        if cur.fetchone()["n"] == 0:
            cur.execute(
                """INSERT INTO users (username, password_hash, rol) VALUES (%s, %s, 'superadmin')
                   ON CONFLICT (username) DO UPDATE SET rol = 'superadmin', password_hash = EXCLUDED.password_hash""",
                ("ADMIN", hash_password(settings.ADMIN_PASSWORD)),
            )
        cur.execute("ALTER TABLE clientes_yaguar ADD COLUMN IF NOT EXISTS id_yaguar VARCHAR")
        cur.execute("ALTER TABLE clientes_yaguar ADD COLUMN IF NOT EXISTS mayorista VARCHAR NOT NULL DEFAULT 'yaguar'")
        cur.execute("ALTER TABLE pick ADD COLUMN IF NOT EXISTS uxb INTEGER DEFAULT 0")
        cur.execute("ALTER TABLE pick ADD COLUMN IF NOT EXISTS importe_total NUMERIC DEFAULT 0")
        cur.execute("ALTER TABLE pick ADD COLUMN IF NOT EXISTS mayorista VARCHAR NOT NULL DEFAULT 'yaguar'")
        cur.execute("ALTER TABLE pick ADD COLUMN IF NOT EXISTS cod_bar_bulto VARCHAR")
        cur.execute("ALTER TABLE pick ADD COLUMN IF NOT EXISTS updated_by VARCHAR")
        # Tabla repartos con mayorista
        cur.execute("""
            CREATE TABLE IF NOT EXISTS repartos (
                id bigserial PRIMARY KEY,
                nombre varchar NOT NULL,
                orden integer NOT NULL DEFAULT 99,
                mayorista varchar NOT NULL DEFAULT 'yaguar',
                UNIQUE (nombre, mayorista)
            )
        """)
        cur.execute("ALTER TABLE repartos ADD COLUMN IF NOT EXISTS mayorista VARCHAR NOT NULL DEFAULT 'yaguar'")
        # Poblar repartos de Yaguar si no existen
        cur.execute("SELECT COUNT(*) AS n FROM repartos WHERE mayorista = 'yaguar'")
        if cur.fetchone()["n"] == 0:
            cur.execute("""
                INSERT INTO repartos (nombre, orden, mayorista) VALUES
                ('Sur Abajo', 1, 'yaguar'), ('Sur Arriba', 2, 'yaguar'), ('Merlo', 3, 'yaguar'),
                ('Córdoba', 4, 'yaguar'), ('San Luis', 5, 'yaguar')
                ON CONFLICT (nombre, mayorista) DO NOTHING
            """)
        # Tabla zonas con mayorista
        cur.execute("""
            CREATE TABLE IF NOT EXISTS zonas (
                id bigserial PRIMARY KEY,
                nombre varchar NOT NULL,
                al_final boolean DEFAULT false,
                reparto varchar,
                mayorista varchar NOT NULL DEFAULT 'yaguar',
                created_at timestamptz DEFAULT now(),
                UNIQUE (nombre, mayorista)
            )
        """)
        cur.execute("ALTER TABLE zonas ADD COLUMN IF NOT EXISTS reparto varchar")
        cur.execute("ALTER TABLE zonas ADD COLUMN IF NOT EXISTS mayorista VARCHAR NOT NULL DEFAULT 'yaguar'")
        # Zonas son compartidas: eliminar duplicados por nombre y dejar solo una fila por zona
        cur.execute("""
            DELETE FROM zonas WHERE id NOT IN (
                SELECT MIN(id) FROM zonas GROUP BY nombre
            )
        """)
        # Normalizar localidades en clientes_yaguar y pick
        cur.execute("UPDATE clientes_yaguar SET localidad = 'MERLO' WHERE localidad ILIKE '%merlo%'")
        cur.execute("UPDATE clientes_yaguar SET localidad = 'SANTA ROSA' WHERE localidad ILIKE 'santa rosa%'")
        cur.execute("UPDATE pick SET localidad = 'MERLO' WHERE localidad ILIKE '%merlo%'")
        cur.execute("UPDATE pick SET localidad = 'SANTA ROSA' WHERE localidad ILIKE 'santa rosa%'")
        # Poblar zonas de Yaguar desde localidades existentes
        cur.execute("SELECT COUNT(*) AS n FROM zonas WHERE mayorista = 'yaguar'")
        if cur.fetchone()["n"] == 0:
            cur.execute("""
                INSERT INTO zonas (nombre, mayorista)
                SELECT DISTINCT UPPER(localidad), 'yaguar'
                FROM clientes_yaguar
                WHERE localidad IS NOT NULL AND mayorista = 'yaguar'
                ON CONFLICT (nombre, mayorista) DO NOTHING
            """)
        # Asignar repartos a las zonas de Yaguar
        zona_reparto = [
            ('CARPINTERIA', 'Sur Arriba'), ('CERRO DE ORO', 'Merlo'), ('CONCARAN', 'Sur Abajo'),
            ('CORTADERAS', 'Sur Arriba'), ('CRUZ DE CAÑA', 'Córdoba'), ('LA PAZ', 'Córdoba'),
            ('LA TOMA', 'San Luis'), ('LAS CHACRAS', 'Córdoba'), ('LOS MOLLES', 'Sur Arriba'),
            ('MERLO', 'Merlo'), ('NASCHEL', 'San Luis'), ('PAPAGAYOS', 'Sur Arriba'),
            ('SANTA ROSA', 'Sur Abajo'), ('TILISARAO', 'Sur Abajo'), ('VILLA DEL CARMEN', 'Sur Arriba'),
            ('VILLA LARCA', 'Sur Arriba'),
        ]
        for zona, reparto in zona_reparto:
            cur.execute(
                "UPDATE zonas SET reparto = %s WHERE nombre = %s AND mayorista = 'yaguar' AND (reparto IS NULL OR reparto = '')",
                (reparto, zona)
            )
        # Tabla semanas con mayorista
        cur.execute("""
            CREATE TABLE IF NOT EXISTS semanas (
                id bigserial PRIMARY KEY,
                nombre varchar NOT NULL,
                mayorista varchar NOT NULL DEFAULT 'yaguar',
                created_at timestamptz DEFAULT now(),
                UNIQUE (nombre, mayorista)
            )
        """)
        cur.execute("ALTER TABLE semanas ADD COLUMN IF NOT EXISTS mayorista VARCHAR NOT NULL DEFAULT 'yaguar'")
        # Migrar constraint de semanas: UNIQUE(nombre) → UNIQUE(nombre, mayorista)
        cur.execute("""
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM pg_constraint WHERE conname = 'semanas_nombre_key'
                ) THEN
                    ALTER TABLE semanas DROP CONSTRAINT semanas_nombre_key;
                    ALTER TABLE semanas ADD CONSTRAINT semanas_nombre_mayorista_key UNIQUE (nombre, mayorista);
                END IF;
            END$$;
        """)
        cur.execute("CREATE INDEX IF NOT EXISTS idx_pick_semana ON pick(semana)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_clientes_yaguar_id_yaguar ON clientes_yaguar(id_yaguar)")
        cur.execute("""
            CREATE TABLE IF NOT EXISTS asignaciones_reparto (
                id bigserial PRIMARY KEY,
                semana varchar NOT NULL,
                mayorista varchar NOT NULL DEFAULT 'yaguar',
                reparto varchar NOT NULL,
                user_id bigint REFERENCES users(id) ON DELETE SET NULL,
                username varchar NOT NULL,
                created_at timestamptz DEFAULT now(),
                UNIQUE (semana, mayorista, reparto)
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS sobrantes (
                id bigserial PRIMARY KEY,
                cod_bar varchar,
                cod_art varchar,
                descrip varchar,
                unidades integer DEFAULT 0,
                bultos integer DEFAULT 0,
                mayorista varchar NOT NULL DEFAULT 'yaguar',
                lista varchar NOT NULL,
                created_at timestamptz DEFAULT now()
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS pick_auditoria (
                id bigserial PRIMARY KEY,
                pick_id bigint NOT NULL,
                cod_art varchar,
                descrip varchar,
                nombre varchar,
                mayorista varchar NOT NULL,
                semana varchar NOT NULL,
                uni integer,
                cantidad_entregada integer NOT NULL,
                estado varchar,
                updated_by varchar NOT NULL,
                created_at timestamptz DEFAULT now()
            )
        """)
        # Estado de códigos Yaguar (ocupado/libre/no_apto según últimas 10 semanas)
        cur.execute("ALTER TABLE clientes_yaguar ADD COLUMN IF NOT EXISTS estado VARCHAR")
        cur.execute("ALTER TABLE clientes_yaguar ADD COLUMN IF NOT EXISTS flete NUMERIC")
        # Marcar códigos conocidos como no aptos para factura B
        cur.execute("""
            UPDATE clientes_yaguar SET estado = 'no_apto'
            WHERE mayorista = 'yaguar'
              AND nombre IN ('NO ASIGNAR ES MONOTRIBUBTO', 'NO SE UTILIZA', 'NO ASIGNAR ES MONOTRIBUTO')
        """)
        # Unique constraint en id_yaguar — primero eliminar duplicados (queda el de mayor id)
        cur.execute("""
            DELETE FROM clientes_yaguar
            WHERE id_yaguar IS NOT NULL
              AND id NOT IN (
                SELECT MAX(id) FROM clientes_yaguar
                WHERE id_yaguar IS NOT NULL
                GROUP BY id_yaguar
              )
        """)
        cur.execute("""
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM pg_constraint
                    WHERE conname = 'clientes_yaguar_id_yaguar_key'
                ) THEN
                    ALTER TABLE clientes_yaguar
                    ADD CONSTRAINT clientes_yaguar_id_yaguar_key UNIQUE (id_yaguar);
                END IF;
            END $$;
        """)
    yield


app = FastAPI(title="Picking App", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(auth.router, prefix="/api")
app.include_router(admin.router, prefix="/api")
app.include_router(zonas.router, prefix="/api")           # zonas y repartos son compartidos
# ── Yaguar ────────────────────────────────────────────────────────────────
app.include_router(yaguar_semanas.router, prefix="/api")
app.include_router(picks.router_yaguar, prefix="/api")
app.include_router(clientes.router_yaguar, prefix="/api")
app.include_router(export.router_yaguar, prefix="/api")
# ── Diarco ────────────────────────────────────────────────────────────────
app.include_router(diarco_semanas.router, prefix="/api")
app.include_router(picks.router_diarco, prefix="/api")
app.include_router(clientes.router_diarco, prefix="/api")
app.include_router(export.router_diarco, prefix="/api")
# ── Sobrantes ─────────────────────────────────────────────────────────────────
app.include_router(sob_shared, prefix="/api")
app.include_router(sob_yaguar, prefix="/api")
app.include_router(sob_diarco, prefix="/api")
# ── Asignaciones de reparto ────────────────────────────────────────────────────
app.include_router(asig_yaguar, prefix="/api")
app.include_router(asig_diarco, prefix="/api")
