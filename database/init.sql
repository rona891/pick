CREATE TABLE IF NOT EXISTS users (
    id bigserial PRIMARY KEY,
    username varchar UNIQUE NOT NULL,
    password_hash varchar NOT NULL,
    rol varchar NOT NULL DEFAULT 'operario',
    created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pick (
    id bigserial PRIMARY KEY,
    cod_bar varchar,
    cod_art varchar,
    descrip varchar,
    nombre varchar,
    cliente varchar,
    localidad varchar,
    uni integer,
    bul integer,
    cantidad_pickeada integer DEFAULT 0,
    estado varchar,
    semana varchar,
    updated_at timestamptz,
    created_at timestamptz DEFAULT now(),
    uxb integer DEFAULT 0,
    importe_total numeric DEFAULT 0,
    mayorista varchar NOT NULL DEFAULT 'yaguar',
    cod_bar_bulto varchar
);

CREATE TABLE IF NOT EXISTS semanas (
    id bigserial PRIMARY KEY,
    nombre varchar NOT NULL,
    mayorista varchar NOT NULL DEFAULT 'yaguar',
    created_at timestamptz DEFAULT now(),
    UNIQUE (nombre, mayorista)
);

CREATE TABLE IF NOT EXISTS repartos (
    id bigserial PRIMARY KEY,
    nombre varchar NOT NULL,
    orden integer NOT NULL DEFAULT 99,
    mayorista varchar NOT NULL DEFAULT 'yaguar',
    UNIQUE (nombre, mayorista)
);

CREATE TABLE IF NOT EXISTS zonas (
    id bigserial PRIMARY KEY,
    nombre varchar NOT NULL,
    reparto varchar,
    mayorista varchar NOT NULL DEFAULT 'yaguar',
    created_at timestamptz DEFAULT now(),
    UNIQUE (nombre, mayorista)
);

CREATE TABLE IF NOT EXISTS clientes_yaguar (
    id bigserial PRIMARY KEY,
    nombre varchar,
    localidad varchar,
    direccion varchar,
    telefono varchar,
    contacto varchar,
    vendedor varchar,
    mayorista varchar NOT NULL DEFAULT 'yaguar',
    created_at timestamptz DEFAULT now(),
    id_yaguar varchar
);
