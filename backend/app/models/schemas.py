from pydantic import BaseModel
from typing import Optional


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
    updated_at: Optional[str] = None


class QuantityUpdate(BaseModel):
    cantidad_pickeada: int


class LoginRequest(BaseModel):
    email: str
    password: str


class LoginResponse(BaseModel):
    access_token: str


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


class Cliente(BaseModel):
    id: Optional[int] = None
    nombre: Optional[str] = None
    localidad: Optional[str] = None
    direccion: Optional[str] = None
    telefono: Optional[str] = None
    contacto: Optional[str] = None
    vendedor: Optional[str] = None
    id_yaguar: Optional[str] = None


class ClienteCreate(BaseModel):
    nombre: str
    localidad: Optional[str] = None
    direccion: Optional[str] = None
    telefono: Optional[str] = None
    contacto: Optional[str] = None
    vendedor: Optional[str] = None


class AdminVerify(BaseModel):
    password: str


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str
