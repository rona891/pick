from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.api import picks, auth, health, clientes, admin, semanas, zonas
from app.db.database import init_pool, get_db
from config import settings


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_pool()
    with get_db() as cur:
        cur.execute("ALTER TABLE clientes_yaguar ADD COLUMN IF NOT EXISTS id_yaguar VARCHAR")
        cur.execute("ALTER TABLE pick ADD COLUMN IF NOT EXISTS uxb INTEGER DEFAULT 0")
        cur.execute("ALTER TABLE pick ADD COLUMN IF NOT EXISTS importe_total NUMERIC DEFAULT 0")
        cur.execute("""
            CREATE TABLE IF NOT EXISTS zonas (
                id bigserial PRIMARY KEY,
                nombre varchar UNIQUE NOT NULL,
                al_final boolean DEFAULT false,
                created_at timestamptz DEFAULT now()
            )
        """)
        # Normalizar localidades en clientes_yaguar y pick
        cur.execute("UPDATE clientes_yaguar SET localidad = 'MERLO' WHERE localidad ILIKE '%merlo%'")
        cur.execute("UPDATE clientes_yaguar SET localidad = 'SANTA ROSA' WHERE localidad ILIKE 'santa rosa%'")
        cur.execute("UPDATE pick SET localidad = 'MERLO' WHERE localidad ILIKE '%merlo%'")
        cur.execute("UPDATE pick SET localidad = 'SANTA ROSA' WHERE localidad ILIKE 'santa rosa%'")
        # Poblar zonas desde las localidades existentes (solo si la tabla está vacía)
        cur.execute("SELECT COUNT(*) AS n FROM zonas")
        if cur.fetchone()["n"] == 0:
            cur.execute("""
                INSERT INTO zonas (nombre, al_final)
                SELECT DISTINCT UPPER(localidad), UPPER(localidad) = 'MERLO'
                FROM clientes_yaguar
                WHERE localidad IS NOT NULL
                ON CONFLICT (nombre) DO NOTHING
            """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS semanas (
                id        bigserial PRIMARY KEY,
                nombre    varchar UNIQUE NOT NULL,
                created_at timestamptz DEFAULT now()
            )
        """)
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
app.include_router(picks.router, prefix="/api")
app.include_router(auth.router, prefix="/api")
app.include_router(clientes.router, prefix="/api")
app.include_router(admin.router, prefix="/api")
app.include_router(semanas.router, prefix="/api")
app.include_router(zonas.router, prefix="/api")
