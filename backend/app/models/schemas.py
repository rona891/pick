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
