from pydantic import BaseModel
from typing import Optional
from datetime import datetime


class Pick(BaseModel):
    id: int
    cod_bar: Optional[str] = None
    cod_art: Optional[str] = None
    descrip: Optional[str] = None
    nombre: Optional[str] = None
    cliente: Optional[str] = None
    localidad: Optional[str] = None
    uni: Optional[int] = None
    bul: Optional[int] = None
    uxb: Optional[int] = None
    cantidad_pickeada: Optional[int] = 0
    estado: Optional[str] = None
    semana: Optional[str] = None
    updated_at: Optional[datetime] = None


class QuantityUpdate(BaseModel):
    cantidad_pickeada: int


class LoginRequest(BaseModel):
    username: str
    password: str


class LoginResponse(BaseModel):
    access_token: str
    rol: str
    es_rol_protegido: bool = False
    # Herramientas operativas
    perm_pick: bool = True
    perm_sobrantes: bool = False
    perm_novedades: bool = False
    perm_yaguar: bool = True
    perm_diarco: bool = True
    # Panel admin
    perm_admin_clientes: bool = False
    perm_admin_clientes_full: bool = False
    perm_admin_semanas: bool = False
    perm_admin_zonas: bool = False
    perm_admin_auditoria: bool = False
    perm_admin_articulos: bool = False
    perm_admin_usuarios: bool = False
    perm_admin_roles: bool = False


class StatsResponse(BaseModel):
    total: int
    completed: int
    pending: int


class PickResumen(BaseModel):
    nombre: str
    total: int
    completados: int
    pendientes: int
    estado_general: str  # "completo" | "incompleto" | "pendiente"
    importe_total: float = 0


class Cliente(BaseModel):
    id: Optional[int] = None
    nombre: Optional[str] = None
    localidad: Optional[str] = None
    direccion: Optional[str] = None
    telefono: Optional[str] = None
    contacto: Optional[str] = None
    vendedor: Optional[str] = None
    id_yaguar: Optional[str] = None
    flete: Optional[float] = None
    cod_sis: Optional[str] = None
    cuit_deposito: Optional[str] = None
    es_factura_a: bool = False


class ClienteCreate(BaseModel):
    nombre: Optional[str] = None
    localidad: Optional[str] = None
    direccion: Optional[str] = None
    telefono: Optional[str] = None
    contacto: Optional[str] = None
    vendedor: Optional[str] = None
    mayorista: str = 'yaguar'
    id_yaguar: Optional[str] = None
    flete: Optional[float] = None
    cod_sis: Optional[str] = None
    cuit_deposito: Optional[str] = None
    es_factura_a: bool = False


class MarcarNoAptoIn(BaseModel):
    codigo: str


class AdminVerify(BaseModel):
    password: str


class UserCreate(BaseModel):
    username: str
    password: str
    rol: str = 'operario'


class UserUpdate(BaseModel):
    username: Optional[str] = None
    rol: Optional[str] = None
    acceso_sobrantes: Optional[bool] = None
    acceso_novedades: Optional[bool] = None
    acceso_pick: Optional[bool] = None
    acceso_reparto: Optional[bool] = None


class UserOut(BaseModel):
    id: int
    username: str
    rol: str = 'operario'
    acceso_sobrantes: bool = False
    acceso_novedades: bool = False
    acceso_pick: bool = True
    created_at: Optional[datetime] = None
    perm_reparto: bool = False
    acceso_reparto: bool = False


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


class ChangeUsernameRequest(BaseModel):
    current_password: str
    new_username: str
