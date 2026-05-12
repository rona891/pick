# CLAUDE.md — Picking App

Leer este archivo al inicio de cada sesión. Contiene todo el contexto necesario para retomar el trabajo sin re-analizar el proyecto.

---

## Descripción del proyecto

**Picking App** es una aplicación web para operarios de depósito que realizan picking de mercadería para dos mayoristas: **Yaguar** y **DIARCO**. Los operarios la usan desde el celular durante su turno.

Al abrir la app, el usuario elige con qué mayorista trabaja. Cada mayorista tiene sus propios picks, clientes y semanas — completamente separados. Zonas, repartos y usuarios son compartidos.

---

## Arquitectura

```
frontend/ (HTML/CSS/JS + nginx)  ──►  backend/ (FastAPI Python)  ──►  db (PostgreSQL)
        puerto 3000                         puerto 8000                  puerto 5432
```

Todo corre en Docker. Hay tres entornos: dev, qa, prod.

### Estructura de archivos clave

```
pick/
├── frontend/
│   ├── index.html              # SPA completa
│   ├── css/styles.css          # Estilos + temas Yaguar/Diarco + modo claro/oscuro
│   ├── js/
│   │   ├── api.js              # Cliente HTTP — todas las rutas usan getMayorista()
│   │   └── app.js              # Lógica UI, selector de mayorista, temas
│   ├── yaguar.png              # Logo Yaguar (topbar + selector)
│   ├── diarco.png              # Logo DIARCO sin fondo
│   └── nginx.conf              # client_max_body_size 100M
├── backend/
│   ├── main.py                 # FastAPI: routers, migraciones al arrancar
│   ├── app/api/
│   │   ├── yaguar/
│   │   │   └── semanas.py      # Import .db de Yaguar → /api/yaguar/semanas/
│   │   ├── diarco/
│   │   │   └── semanas.py      # Import MobileAssistantBU.db → /api/diarco/semanas/
│   │   ├── picks.py            # Dos routers: router_yaguar + router_diarco
│   │   ├── clientes.py         # Dos routers: router_yaguar + router_diarco
│   │   ├── export.py           # Dos routers: exportar Excel por mayorista
│   │   ├── zonas.py            # Compartido: zonas y repartos
│   │   ├── auth.py             # Usuarios, roles (operario/admin/superadmin)
│   │   └── admin.py            # Verificación contraseña admin (legacy)
│   └── requirements.txt        # incluye openpyxl
└── database/
    ├── init.sql                # DDL completo
    └── seed.sql                # Usuarios MIA y NAHU (pass: hello), ADMIN (pass: hello2)
```

---

## Separación por mayorista

### Rutas API
```
/api/yaguar/picks/...      /api/diarco/picks/...
/api/yaguar/clientes/...   /api/diarco/clientes/...
/api/yaguar/semanas/...    /api/diarco/semanas/...
/api/yaguar/export/picks   /api/diarco/export/picks
/api/zonas/...             (compartido)
/api/auth/...              (compartido)
```

### Tabla `pick`
Columna `mayorista = 'yaguar' | 'diarco'` — los picks nunca se mezclan.

### Frontend
`getMayorista()` en `api.js` retorna `'yaguar'` o `'diarco'` desde localStorage. Todas las llamadas API usan esta función. El selector aparece al iniciar (o tras 30 min de inactividad). Tocar el logo del topbar cambia de mayorista.

---

## Temas visuales

- `body.theme-yaguar` → amarillo `#F2E205`, negro `#0D0D0D`
- `body.theme-diarco` → rojo `#F22233`, naranja `#F2A516`
- `body.light-mode` → fondo claro, superficies blancas
- Botón ☀/🌙 en el topbar para cambiar modo (se guarda en localStorage)

---

## Sistema de roles

| Rol | Ve Admin | Puede cambiar roles | Se puede eliminar |
|-----|----------|--------------------|--------------------|
| `operario` | ✗ | — | ✓ |
| `admin` | ✓ | ✗ | ✓ |
| `superadmin` | ✓ | ✓ | ✗ |

- Usuario `ADMIN` (superadmin) se crea automáticamente al arrancar con contraseña = `ADMIN_PASSWORD` del `.env`
- Solo el superadmin puede cambiar roles de otros usuarios
- Toggle switch en Admin → Usuarios para promover/degradar

---

## Importación Yaguar

Archivos `.db` exportados de la app Yaguar (SQLite con `hpedidosCabecera`, `hpedidosDetalle`, `articulos`, `clientes`). Un archivo por vendedor. Endpoint: `POST /api/yaguar/semanas/importar`.

---

## Importación DIARCO

Archivo `MobileAssistantBU.db` de la app DIARCO (SQLite con `mWTATrx`, `mWTAMTrx`, `mWTARep`).

### Campos extraídos de `mWTATrx`
- `CTE` → nombre oficial del cliente en DIARCO
- `OBSERVACION` → nombre propio del local (ej: `"GAUCHITO CORTADERAS.MERLO"`)
- `DIR` → localidad fallback si OBSERVACION no tiene zona
- `GWS` → total con IVA (`Value3`) y código de cliente (`STEPDesc`)
- `GWS.ELEM` → artículos: `STEPUID`=cod_art, `Value2`=qty, `Value4`=factor, `Formula`=precio sin IVA

### Zona desde OBSERVACION (Opción B)
El vendedor escribe la zona como sufijo en la observación: `"NOMBRE.ZONA"`, `"NOMBRE-zona"`, `"NOMBRE_ZONA"`. El importer normaliza (mayúsculas, sin acentos) y busca match en la tabla de zonas. Fallback al paso DIR si no hay sufijo.

### Barcodes
- `mWTARep WHERE Key1='CDB'`: `STEPUID`=barcode, `Value1`=cod_art DIARCO
- EAN-13 (13 dígitos) → `pick.cod_bar`
- EAN-14 (14 dígitos) → `pick.cod_bar_bulto`
- Buscar por cualquiera de los dos da el mismo resultado

### Ítems excluidos
- `STEPUID` no numérico (ej: `'Semaforo'`) → sistema interno, sin precio
- Descripción contiene `"heladera exhibidora"` → equipamiento, sin pickear
- `PRECIO_HELADERA_CON_IVA = 1375796.713` se resta del total por unidad pedida

### Lógica de bultos DIARCO
- `fp: X/YB` en descripción: si X==Y → factor=1 (qty en unidades), si X>Y → factor=X/Y (qty en bultos)
- `uni = qty * uxb` cuando factor>1, `uni = qty` cuando factor=1

### STATUS en mWTAMTrx
- `'1'` = pedido tomado, `'S'` = sincronizado — ambos se importan

---

## Tabla `pick` — campos principales

| Campo | Descripción |
|-------|-------------|
| `cod_bar` | Barcode EAN-13 (unidad) |
| `cod_bar_bulto` | Barcode EAN-14 (bulto cerrado) — solo DIARCO |
| `cod_art` | Código del artículo |
| `descrip` | Descripción limpia (sin `fp:`) |
| `nombre` | Nombre del cliente (OBSERVACION para DIARCO, lookup para Yaguar) |
| `localidad` | Ciudad/zona — determina el orden por reparto |
| `uni` | Unidades totales requeridas |
| `bul` | Bultos completos |
| `uxb` | Unidades por bulto |
| `cantidad_pickeada` | Actualizado por el operario |
| `estado` | `entregado: X/Y UNI` o `completado: X/Y UNI` |
| `semana` | Nombre de la semana de picking |
| `importe_total` | Total del pedido del cliente con IVA (sin heladera) |
| `mayorista` | `'yaguar'` o `'diarco'` |

---

## Zonas y Repartos

- Tabla `zonas`: nombres de localidades, asignadas a un reparto
- Tabla `repartos`: Sur Abajo, Sur Arriba, Merlo, Córdoba, San Luis — con orden editable desde Admin → Zonas
- Los picks se ordenan por `repartos.orden ASC, localidad ASC, nombre ASC`
- Zonas nuevas se crean automáticamente al importar; asignar reparto desde Admin → Zonas

---

## Estado actual — branch activa

**Branch:** `feature/diarco-fase2-barcodes` (basada en `qa`)
**Próximo paso:** Testeo el viernes con picks reales y sufijos `.zona` en OBSERVACION de DIARCO

### Funcionalidades completadas en esta rama
- Selector de mayorista con logos + timeout 30 min
- Temas visuales por mayorista + modo claro/oscuro
- Sistema de roles (operario/admin/superadmin)
- Nombre de usuario en topbar
- Importador DIARCO con barcodes EAN-13/EAN-14
- Nombre de cliente desde campo OBSERVACION
- Zona desde sufijo en OBSERVACION con normalización y fuzzy match
- Importe con IVA (GWS.Value3 - heladera × $1,375,796.713)
- Tab Clientes oculta en admin modo DIARCO
- Stepper con input editable para cantidades
- Resaltado naranja en cards con entrega parcial
- Checkbox "papel separado" en tab Clientes (localStorage)
- Ordenado por reparto al escanear
- Export Excel por semana y mayorista

---

## Flujo de trabajo Git — REGLAS ESTRICTAS

> **NUNCA hacer commits ni push directamente a `main` o `qa`. Son ramas protegidas.**

```bash
# Para cada tarea nueva:
git checkout qa && git pull origin qa
git checkout -b feature/nombre-funcionalidad

# Al terminar:
git push origin feature/nombre-funcionalidad
gh pr create --base qa ...
# Esperar aprobación. NUNCA mergear uno mismo.
```

---

## Setup del entorno de desarrollo

```bash
# Levantar
docker compose up --build

# Frontend: https://localhost:3000 (aceptar cert autofirmado)
# API docs: http://localhost:8000/docs

# Usuarios seed:
#   MIA / hello
#   NAHU / hello
#   ADMIN / hello2 (superadmin)

# Rebuild tras cambios:
docker compose up --build backend -d
docker compose up --build frontend -d
```

---

## Variables de entorno requeridas

| Variable | Descripción |
|----------|-------------|
| `DATABASE_URL` | Connection string PostgreSQL |
| `SECRET_KEY` | Secreto JWT |
| `ADMIN_PASSWORD` | Contraseña del panel admin Y del usuario ADMIN (superadmin) |
| `ENVIRONMENT` | `development` / `qa` / `production` |

---

## Contexto de negocio

Operarios de depósito de una distribuidora (Yaguar + DIARCO). Caminan por el galpón con el celular, escanean artículos y registran unidades separadas por cliente. Al final del día los bultos quedan listos para despacho.

**Diseño mobile-first:** botones grandes, una mano, WiFi inestable, pantallas en luz solar.
