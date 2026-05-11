CREATE TABLE IF NOT EXISTS users (
    id bigserial PRIMARY KEY,
    username varchar UNIQUE NOT NULL,
    password_hash varchar NOT NULL,
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
    importe_total numeric DEFAULT 0
);

CREATE TABLE IF NOT EXISTS semanas (
    id bigserial PRIMARY KEY,
    nombre varchar UNIQUE NOT NULL,
    created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS clientes_yaguar (
    id bigserial PRIMARY KEY,
    nombre varchar,
    localidad varchar,
    direccion varchar,
    telefono varchar,
    contacto varchar,
    vendedor varchar,
    created_at timestamptz DEFAULT now(),
    id_yaguar varchar
);
