from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    DATABASE_URL: str
    SECRET_KEY: str
    ENVIRONMENT: str = "development"
    DEBUG: bool = True
    API_PORT: int = 8000
    FRONTEND_URL: str = "http://localhost:3000"
    ADMIN_PASSWORD: str = "changeme"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 1440

    class Config:
        env_file = ".env"
        extra = "ignore"


settings = Settings()
