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

Todo corre en Docker. Hay tres entornos: dev, qa, prod. Se usa **ngrok** para exponer el puerto 3000 al exterior (nginx usa HTTPS con cert autofirmado, ngrok debe tunelizar a `https://localhost:3000`).

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
│   └── nginx.conf              # SSL en puerto 3000, client_max_body_size 100M
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
    ├── init.sql                # DDL base
    └── seed.sql                # Usuarios MIA y NAHU (pass: hello), ADMIN (pass: hello2)
```

---

## Separación por mayorista

### Rutas API
```
/api/yaguar/picks/...           /api/diarco/picks/...
/api/yaguar/clientes/...        /api/diarco/clientes/...
/api/yaguar/semanas/...         /api/diarco/semanas/...
/api/yaguar/export/picks        /api/diarco/export/picks
/api/yaguar/export/clientes     (exporta códigos libres Yaguar)
/api/zonas/...                  (compartido)
/api/auth/...                   (compartido)
```

### Tabla `pick`
Columna `mayorista = 'yaguar' | 'diarco'` — los picks nunca se mezclan.
`pick.cliente` = código del cliente (id_yaguar para Yaguar, cod DIARCO para DIARCO).

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

---

## Importación Yaguar

Archivos `.db` exportados de la app Yaguar (SQLite con `hpedidosCabecera`, `hpedidosDetalle`, `articulos`, `clientes`). Un archivo por vendedor. Endpoint: `POST /api/yaguar/semanas/importar`.

### Matching de clientes
Al importar, se busca el código de cliente (`SUBSTR(c.CLI_ID, -6)`) en `clientes_yaguar WHERE id_yaguar IS NOT NULL`. Si el cliente no tiene nombre asignado (estado=libre) o no existe, va a `clientes_no_encontrados`. Después del import salta el modal para cargar datos del cliente.

### Estado de códigos Yaguar (`clientes_yaguar.estado`)
- `'ocupado'` — tiene cliente asignado y apareció en alguna de las últimas 10 semanas
- `'libre'` — disponible para asignar a un nuevo cliente
- `'no_apto'` — código de factura A (no Consumidor Final), nunca se usa

**Reglas:**
- Al crear cliente nuevo: modal de verificación pregunta si el código es Consumidor Final. Si no → se marca `no_apto` y se elige otro automáticamente.
- Códigos `no_apto` nunca aparecen en la lista de libres ni en la UI de clientes.
- El status update post-import SOLO modifica códigos que tienen historial en picks (no toca libres manuales ni clientes nuevos sin picks aún).
- Códigos ya marcados `no_apto`: `609608` (NO SE UTILIZA), `605212` (NO ASIGNAR ES MONOTRIBUBTO).

### Export de códigos libres
`GET /api/yaguar/export/clientes` → Excel con códigos `estado='libre'`: Código, Cliente, Zona, Vendedor.

---

## Importación DIARCO

Archivo `MobileAssistantBU.db` de la app DIARCO (SQLite con `mWTATrx`, `mWTAMTrx`, `mWTARep`).

### Campos extraídos de `mWTATrx`
- `CTE` → nombre oficial del cliente en DIARCO (**nunca se usa**, es incorrecto)
- `OBSERVACION` → nombre real del local puesto por el vendedor (ej: `"GAUCHITO CORTADERAS.MERLO"`)
- `GWS.STEPDesc` → código de cliente DIARCO (formato: `"Pedido para: {cod} {nombre}"`)
- `GWS.Value3` → total con IVA del pedido
- `GWS.Formula` → total sin IVA del pedido
- `GWS.ELEM` → artículos: `STEPUID`=cod_art, `Value2`=qty, `Value4`=factor, `Formula`=precio sin IVA
- `DIR` → localidad — **SIEMPRE INCORRECTA, nunca usar**

### Matching de clientes DIARCO
Al importar, se busca el cod_cliente en `clientes_yaguar WHERE mayorista='diarco' AND id_yaguar=cod`. Si hay match con nombre → se usa el nombre y localidad del admin. Si no hay match → se usa OBSERVACION como nombre temporal y localidad=NULL. Los sin match van a `clientes_sin_datos` y salta el modal post-import.

**Importante:** La localidad del DB de DIARCO (campo DIR) es siempre incorrecta. Solo se usa la localidad ingresada manualmente por el admin en la tabla de clientes. Para clientes sin registrar, localidad=NULL hasta que el admin la asigne.

### Zona desde OBSERVACION
El vendedor escribe la zona como sufijo: `"NOMBRE.ZONA"`, `"NOMBRE-zona"`, `"NOMBRE_ZONA"`. El importer normaliza y busca match en zonas existentes. Fallback: localidad=NULL (nunca usar DIR).

### Ítems excluidos
- `STEPUID` no numérico (ej: `'Semaforo'`) → sistema interno, sin precio
- Descripción contiene `"heladera exhibidora"` → equipamiento, sin pickear

### Cálculo de importe con IVA (excluyendo ítems excluidos)
```
excluidos_sin_iva = sum(Formula × Value2 × Value4) para ítems excluidos con cod_art numérico
ratio_iva = GWS.Value3 / GWS.Formula
excluidos_con_iva = excluidos_sin_iva × ratio_iva
importe_neto = GWS.Value3 - excluidos_con_iva
```
Garantizado no-negativo: los excluidos son parte del total, nunca pueden superarlo.

### Barcodes
- `mWTARep WHERE Key1='CDB'`: `STEPUID`=barcode, `Value1`=cod_art DIARCO
- EAN-13 (13 dígitos) → `pick.cod_bar`
- EAN-14 (14 dígitos) → `pick.cod_bar_bulto`

### Lógica de bultos DIARCO
- `fp: X/YB` en descripción: si X==Y → factor=1 (qty en unidades); si X>Y → factor=X/Y (qty en bultos)
- `uni = qty * uxb` cuando factor>1, `uni = qty` cuando factor=1

---

## Tabla `clientes_yaguar` — campos principales

| Campo | Descripción |
|-------|-------------|
| `id_yaguar` | Código del cliente (UNIQUE). Para Yaguar: código del pool de Yaguar. Para DIARCO: cod de GWS.STEPDesc |
| `nombre` | Nombre del negocio |
| `localidad` | Zona asignada manualmente por el admin |
| `direccion` | Dirección |
| `telefono` | Teléfono |
| `contacto` | Persona de contacto |
| `vendedor` | Vendedor asignado |
| `flete` | Porcentaje de flete (ej: 0.08 = 8%) |
| `estado` | `'ocupado'` / `'libre'` / `'no_apto'` (solo Yaguar) |
| `mayorista` | `'yaguar'` o `'diarco'` |

**Al editar un cliente, los picks existentes se actualizan automáticamente** con el nuevo nombre y localidad (via `UPDATE pick SET nombre=... WHERE cliente=id_yaguar AND mayorista=...`).

---

## Tabla `pick` — campos principales

| Campo | Descripción |
|-------|-------------|
| `cod_bar` | Barcode EAN-13 (unidad) |
| `cod_bar_bulto` | Barcode EAN-14 (bulto cerrado) — solo DIARCO |
| `cod_art` | Código del artículo |
| `descrip` | Descripción limpia (sin `fp:`) |
| `nombre` | Nombre del cliente |
| `cliente` | Código del cliente (id_yaguar para Yaguar, cod DIARCO para DIARCO) |
| `localidad` | Ciudad/zona — determina el orden por reparto |
| `uni` | Unidades totales requeridas |
| `bul` | Bultos completos |
| `uxb` | Unidades por bulto |
| `cantidad_pickeada` | Actualizado por el operario |
| `estado` | `entregado: X/Y UNI` o `completado: X/Y UNI` |
| `semana` | Nombre de la semana de picking |
| `importe_total` | Total del pedido con IVA, sin ítems excluidos |
| `mayorista` | `'yaguar'` o `'diarco'` |

---

## Admin → Clientes (ambos mayoristas)

### Tabla de clientes
- Columnas Yaguar: Código, Nombre, Localidad, Teléfono, Contacto, Vendedor, Flete (en %), Acciones
- Columnas DIARCO: Nombre, Localidad, Teléfono, Contacto, Vendedor, Acciones
- Click en fila → abre formulario de edición con todos los datos
- Los clientes `libre` y `no_apto` no aparecen en la lista (solo `ocupado`)

### Sección "Sin registrar"
Aparece sobre la tabla cuando hay picks importados cuyo código de cliente no tiene nombre asignado. Permite hacer clic en "Registrar" para cargar los datos y asociar el código al cliente. Una vez registrado, desaparece de esta sección.

### Crear nuevo cliente — Yaguar
1. Clic en `+ Nuevo` → abre modal de verificación con un código libre auto-asignado
2. El admin verifica en la app Yaguar si ese código es **Consumidor Final**
3. Si NO es CF → botón rojo "Este cod. NO ES cons. final" → marca como `no_apto`, asigna otro
4. Si SÍ es CF → "Continuar" → abre formulario con el código pre-cargado (readonly)

### Crear nuevo cliente — DIARCO
- Clic en `+ Nuevo` → abre formulario directamente
- El campo "Código DIARCO" es editable (el admin ingresa el código manualmente)

### Modal post-import (clientes sin datos)
Salta automáticamente al terminar el import si hay clientes sin datos. Muestra código + nombre del pick (OBSERVACION para DIARCO, código para Yaguar). Para DIARCO el nombre viene pre-rellenado con OBSERVACION. Zona y vendedor son obligatorios. Botón "Cargar más tarde" para posponer.

**Yaguar:** incluye aviso de verificar monotributo.
**DIARCO:** no incluye aviso de monotributo. Si el código no es Consumidor Final, hay que hablar con Yaguar para regularizar.

---

## Zonas y Repartos

- Tabla `zonas`: nombres de localidades, asignadas a un reparto
- Tabla `repartos`: Sur Abajo, Sur Arriba, Merlo, Córdoba, San Luis — con orden editable desde Admin → Zonas
- Los picks se ordenan por `repartos.orden ASC, localidad ASC, nombre ASC`
- Zonas nuevas se crean automáticamente al importar; asignar reparto desde Admin → Zonas

---

## Estado actual — branch activa

**Branch:** `feature/diarco-fase2-barcodes` (basada en `qa`)

### Funcionalidades completadas en esta rama
- Selector de mayorista con logos + timeout 30 min
- Temas visuales por mayorista + modo claro/oscuro
- Sistema de roles (operario/admin/superadmin)
- Nombre de usuario en topbar
- Importador DIARCO con barcodes EAN-13/EAN-14
- Nombre de cliente desde OBSERVACION (nunca CTE)
- Zona desde sufijo en OBSERVACION con normalización y fuzzy match
- Importe con IVA proporcional (excluyendo heladera exhibidora)
- Gestión completa de clientes Yaguar: códigos libre/ocupado/no_apto, flete, verificación CF
- Gestión de clientes DIARCO: tab en admin, campo id, sección sin-registrar
- Modal post-import para registrar clientes desconocidos (Yaguar y DIARCO)
- Propagación automática de cambios de nombre/zona de cliente a todos sus picks
- Sección "Sin registrar" en Admin → Clientes para ambos mayoristas
- Export Excel de códigos libres Yaguar
- Stepper con input editable para cantidades
- Resaltado naranja en cards con entrega parcial
- Checkbox "papel separado" en tab Clientes (localStorage)
- Ordenado siempre por importe descendente en tab Clientes
- Clientes siempre ordenados por mayor importe
- Confirmaciones con modal personalizado (no browser nativo)

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
# Ngrok: ngrok http https://localhost:3000  (para acceso externo)
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
