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
    acceso_sobrantes: bool = False
    acceso_novedades: bool = False
    acceso_pick: bool = True


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


class UserOut(BaseModel):
    id: int
    username: str
    rol: str = 'operario'
    acceso_sobrantes: bool = False
    acceso_novedades: bool = False
    acceso_pick: bool = True
    created_at: Optional[datetime] = None


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


class ChangeUsernameRequest(BaseModel):
    current_password: str
    new_username: str
