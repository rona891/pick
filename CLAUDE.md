# CLAUDE.md — Picking App

Leer este archivo al inicio de cada sesión. Contiene todo el contexto necesario para retomar el trabajo sin re-analizar el proyecto.

---

## Descripción del proyecto

**Picking App** es una aplicación web para operarios de depósito que realizan el proceso de *picking*: separación de mercadería por cliente para su despacho.

- Los operarios la usan desde el **celular** durante su turno de trabajo.
- Escanean o ingresan el código de barras de un artículo y ven los items a pickear para ese código.
- Registran la cantidad pickeada y la app calcula si el item está completo o pendiente.
- También tienen una vista de resumen por operario para ver el avance general de la jornada.
- El panel de Admin (protegido por contraseña secundaria) permite gestionar el directorio de clientes.

**Premisa de diseño**: la UI debe ser simple, rápida y funcionar bien en pantallas chicas. Siempre tener esto presente al tomar decisiones técnicas.

---

## Arquitectura

```
frontend/ (HTML/CSS/JS + nginx)  ──►  backend/ (FastAPI Python)  ──►  db (PostgreSQL)
        puerto 3000                         puerto 8000                  puerto 5432
```

Todo corre en Docker. Hay tres entornos: dev, qa, prod.

### Estructura de archivos

```
pick/
├── frontend/
│   ├── index.html              # SPA — toda la UI en un solo archivo HTML
│   ├── css/styles.css          # Todos los estilos
│   ├── js/
│   │   ├── api.js              # Cliente HTTP (wrapper de fetch con JWT)
│   │   └── app.js              # Toda la lógica de UI y estado
│   ├── nginx.conf              # Sirve el frontend en puerto 3000
│   └── Dockerfile              # nginx:alpine
├── backend/
│   ├── main.py                 # App FastAPI: CORS, lifespan, include_router
│   ├── config.py               # Settings vía pydantic-settings (lee .env)
│   ├── requirements.txt
│   ├── Dockerfile              # python:3.12-slim + uvicorn
│   ├── .env.example            # Variables de entorno requeridas
│   ├── app/
│   │   ├── api/
│   │   │   ├── auth.py         # POST /api/auth/login, /logout, PUT /password
│   │   │   ├── picks.py        # GET /api/picks/stats, /resumen, /barcode/{cod}, PUT /{id}/quantity
│   │   │   ├── clientes.py     # CRUD /api/clientes/ (PostgreSQL)
│   │   │   ├── semanas.py      # GET /api/semanas/, POST /importar (importa .db de Yaguar)
│   │   │   ├── admin.py        # POST /api/admin/verify (verifica contraseña de admin)
│   │   │   └── health.py       # GET /health
│   │   ├── auth/
│   │   │   └── jwt.py          # hash_password, verify_password, create_access_token, verify_token
│   │   ├── db/
│   │   │   └── database.py     # Pool psycopg2 (ThreadedConnectionPool 1–10), context manager get_db()
│   │   └── models/
│   │       └── schemas.py      # Modelos Pydantic: Pick, QuantityUpdate, LoginRequest/Response, etc.
├── database/
│   ├── init.sql                # DDL: crea tablas users, pick, semanas, clientes_yaguar
│   └── seed.sql                # Datos iniciales: clientes, picks de ejemplo, usuario admin
├── docker-compose.yml          # Entorno dev (db + backend + frontend)
├── docker-compose.qa.yml       # Overrides para QA (extiende docker-compose.yml)
├── docker-compose.prod.yml     # Overrides para producción
└── .gitignore
```

### Stack tecnológico

| Capa | Tecnología | Versión |
|------|-----------|---------|
| Frontend | HTML / CSS / JavaScript puro | — |
| Frontend server | nginx | alpine |
| Barcode scanner | ZXing `@zxing/library` | 0.21.3 (CDN) |
| Backend | Python | 3.12 |
| Backend framework | FastAPI | 0.115.6 |
| ASGI server | Uvicorn | 0.32.1 |
| Settings | pydantic-settings | 2.7.0 |
| DB driver | psycopg2-binary | 2.9.10 |
| Auth | python-jose (JWT) + bcrypt | 3.3.0 / 4.2.1 |
| Base de datos | PostgreSQL | 16 (Alpine) |
| Infraestructura | Docker + Docker Compose | — |

---

## Lógica de negocio

### Tabla `pick`
Cada fila es un artículo que debe ser pickeado para un cliente.

| Campo | Descripción |
|-------|-------------|
| `cod_bar` | Código de barras del artículo (llave de búsqueda) |
| `cod_art` | Código interno del artículo |
| `descrip` | Descripción del artículo |
| `nombre` | Nombre del cliente (display name, ej: "SUPER EL MORENO 619464") |
| `cliente` | ID del cliente en Yaguar (ej: "619464") |
| `localidad` | Localidad del cliente |
| `uni` | Unidades requeridas (objetivo) |
| `bul` | Bultos |
| `uxb` | Unidades por bulto (ART_UNI_BULTO de Yaguar) |
| `cantidad_pickeada` | Unidades ya pickeadas (actualizado por operario) |
| `estado` | Calculado: `completado: X/Y UNI` o `pendiente: X/Y UNI` |
| `semana` | Semana de despacho |

### Flujo principal del operario
1. Login con email/contraseña → recibe JWT → guardado en `localStorage`.
2. Escanea o ingresa código de barras → `GET /api/picks/barcode/{cod_bar}`.
3. Ve cards con los items de ese código → ajusta cantidad con stepper → `PUT /api/picks/{id}/quantity`.
4. El backend calcula el `estado` y lo guarda.
5. El frontend actualiza la card y recarga las stats del header.

### Resumen (tab "Clientes")
- `GET /api/picks/resumen` agrupa por `nombre` (cliente) y calcula cuántos items tiene completos/pendientes.
- Estados posibles: `completo`, `incompleto`, `pendiente`.
- Filtrable por estado en el frontend.

---

## Estado actual del proyecto

### Funcionalidades implementadas
- Login/logout con JWT (expira en 24h)
- Búsqueda de picks por código de barras (manual y por cámara con ZXing)
- Cards de picks con stepper para actualizar cantidad
- Stats globales (total / completados / pendientes)
- Vista resumen por operario con filtros
- Panel admin con CRUD completo de `clientes_yaguar` (protegido por contraseña secundaria)
- Health check: `GET /health`
- Tres entornos Docker: dev / qa / prod
- **Importación de picks desde archivos `.db` de Yaguar** (Admin → Nueva Semana): sube los .db de cada vendedor, ingresá el rango de fechas y nombre de semana, el sistema corre el SQL de extracción y crea todos los picks automáticamente
- **Selector de semana** en la pantalla principal para filtrar picks, stats y resumen por semana
- **Búsqueda por descripción** en la tab Pick (campo de texto con autocompletado)
- **Botón "Entregado"** en cada pick card + display inteligente de bultos vs unidades
- **Vista de picks por cliente** en la tab Clientes: tap en un cliente → bottom-sheet con todos sus items
- **HTTPS** en el frontend (certificado autofirmado en nginx) para permitir uso de cámara desde celular
- **Scanner de cámara** mejorado: pantalla completa, cámara trasera por defecto, tap-to-focus, cambio de cámara, persiste última cámara usada

### Deuda técnica conocida

1. **Rutas sin autenticación**: `verify_token()` existe en `jwt.py` pero **no se usa como dependencia** en ninguna ruta. Todos los endpoints de picks, stats y resumen son públicos (el cliente envía el JWT pero el backend no lo valida).

2. **Límite duro de 200 filas**: `list_picks()` usa `LIMIT 200` sin paginación.

---

## Flujo de trabajo Git — REGLAS ESTRICTAS

> **NUNCA hacer commits ni push directamente a `main` o `qa`. Son ramas protegidas.**

### Para cada tarea nueva:
```bash
# 1. Pararse sobre qa actualizado
git checkout qa
git pull origin qa

# 2. Crear branch nueva
git checkout -b feature/nombre-funcionalidad
# o
git checkout -b fix/descripcion-del-bug

# 3. Trabajar, commitear con mensajes claros
git add <archivos>
git commit -m "feat: descripción clara de qué hace este commit"

# 4. Push al remote
git push origin feature/nombre-funcionalidad

# 5. Abrir Pull Request hacia qa (nunca hacia main)
gh pr create --base qa --title "..." --body "..."

# 6. Esperar aprobación del equipo. NUNCA mergear el PR uno mismo.
```

### Convención de nombres de branches
- `feature/nombre-funcionalidad` — nueva funcionalidad
- `fix/descripcion-bug` — corrección de bug
- `refactor/descripcion` — refactors sin cambio de comportamiento
- `chore/descripcion` — tareas de mantenimiento (deps, config, etc.)

---

## Setup del entorno de desarrollo

### Requisitos previos
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) instalado y corriendo
- Git

### Pasos

**1. Clonar el repo y pararse en la branch correcta**
```bash
git clone https://github.com/mia-m64/pick.git
cd pick
git checkout qa          # o la branch de feature en la que vas a trabajar
```

**2. Levantar el proyecto**
```bash
docker compose up --build
```

El primer arranque descarga imágenes, instala dependencias, crea el schema y carga los datos de seed. Puede tardar un par de minutos.

**3. Verificar que todo funciona**
- Frontend: **https://localhost:3000** (aceptar el certificado autofirmado la primera vez)
- Backend API docs: http://localhost:8000/docs
- Health check: https://localhost:3000/health

> **Desde celular** usar `https://<IP-local>:3000`. Aceptar el aviso de certificado autofirmado la primera vez.

El seed ya incluye:
- Usuario de acceso: `admin@picking.local` / `admin123`
- Directorio completo de clientes de Yaguar
- Semana de ejemplo: "PICK 28-04-2026" con picks reales

**4. Importar una semana nueva (cuando sea necesario)**

Desde Admin → Nueva Semana: subir los archivos `.db` de cada vendedor, completar nombre y fechas, y presionar "Importar picks".

### Comandos útiles

```bash
# Ver logs en tiempo real
docker compose logs -f

# Solo logs del backend
docker compose logs -f backend

# ⚠️ IMPORTANTE: restart NO reconstruye la imagen
# Para aplicar cambios en código Python o frontend usar --build:
docker compose up --build backend -d
docker compose up --build frontend -d
# O ambos:
docker compose up --build -d

# restart solo reinicia el contenedor sin copiar código nuevo (NO usar para desplegar cambios)
docker compose restart backend

# Destruir todo (incluyendo datos de la DB)
docker compose down -v

# Entrar al contenedor del backend
docker compose exec backend bash

# Entrar a PostgreSQL
docker compose exec db psql -U picking -d picking
```

### Entornos QA y producción

```bash
# QA (usa backend/.env.qa)
docker compose -f docker-compose.yml -f docker-compose.qa.yml up --build

# Producción (usa backend/.env.prod)
docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build
```

---

## Variables de entorno requeridas

| Variable | Requerida | Descripción |
|----------|-----------|-------------|
| `DATABASE_URL` | Sí | Connection string PostgreSQL |
| `SECRET_KEY` | Sí | Secreto para firmar JWT |
| `ENVIRONMENT` | No | `development` / `qa` / `production` |
| `DEBUG` | No | `True` / `False` |
| `API_PORT` | No | Puerto del backend (default: 8000) |
| `ADMIN_PASSWORD` | Sí | Contraseña del panel admin |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | No | Expiración JWT (default: 1440) |

> El archivo `backend/.env` está versionado con valores de desarrollo. Solo `backend/.env.qa` y `backend/.env.prod` son gitignoreados (tienen credenciales reales).

---

## Convenciones del proyecto

### Código Python (backend)
- Sin type hints explícitos en funciones simples; sí en las que los tienen actualmente.
- Endpoints sincrónicos (`def`) — toda la DB es psycopg2 síncrono.
- El context manager `get_db()` maneja automáticamente commit/rollback.
- Los schemas Pydantic van todos en `models/schemas.py`.
- Sin comentarios excepto cuando el `por qué` no es obvio.

### Código JavaScript (frontend)
- Vanilla JS, sin frameworks ni bundlers.
- Todo el estado de la app en variables globales al tope de `app.js`.
- El objeto `api` en `api.js` es el único punto de contacto con el backend.
- El token JWT se guarda en `localStorage` como `'token'`.
- Los toasts se muestran con `showToast(mensaje, tipo)` donde tipo es `'success'`, `'error'` o `'info'`.

### Estilos
- Un solo archivo CSS (`frontend/css/styles.css`).
- Tipografías: Bebas Neue (títulos) y DM Mono (datos/código).
- Mobile-first. Sin media queries complejos — la app es para celular.

### Base de datos
- `database/init.sql` define el schema completo para setups frescos.
- `main.py` (`lifespan`) también aplica las migraciones con `ALTER TABLE IF NOT EXISTS` al arrancar, lo que permite actualizar volúmenes existentes sin necesidad de `down -v`.
- Para agregar una columna nueva: actualizá `init.sql` Y agregá el `ALTER TABLE` en el lifespan de `main.py`.
- No hay ORM — todas las queries son SQL directo con psycopg2.

---

## Contexto de negocio

La app es para **operarios de depósito** de una empresa distribuidora (Yaguar). El proceso de picking es físico: el operario camina por el depósito con el celular, escanea artículos y registra cuántas unidades separa para cada cliente. Al final del día, los bultos pickeados están listos para ser despachados.

**Implicaciones de diseño que siempre hay que tener en cuenta:**
- La UI debe funcionar con una mano, en movimiento, con guantes si es necesario.
- Los botones deben ser grandes y fáciles de tocar.
- El flujo principal (escanear → ver items → guardar cantidad) debe ser el mínimo de pasos posible.
- La app debe funcionar aunque la conexión sea lenta o inestable (operarios en galpones con WiFi débil).
- Los textos deben ser legibles en pantallas con brillo bajo o luz solar directa.
