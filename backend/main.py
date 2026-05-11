from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.api import picks, auth, health, clientes, admin, zonas, export
from app.api.yaguar import semanas as yaguar_semanas
from app.api.diarco import semanas as diarco_semanas
# picks, clientes y export tienen routers dobles (uno por mayorista)
from app.auth.jwt import hash_password
from app.db.database import init_pool, get_db
from config import settings


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_pool()
    with get_db() as cur:
        cur.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS rol VARCHAR NOT NULL DEFAULT 'operario'")
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
        cur.execute("CREATE INDEX IF NOT EXISTS idx_pick_semana ON pick(semana)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_clientes_yaguar_id_yaguar ON clientes_yaguar(id_yaguar)")
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
