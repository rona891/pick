from psycopg2.pool import ThreadedConnectionPool
from psycopg2.extras import RealDictCursor
from contextlib import contextmanager
from config import settings

_pool: ThreadedConnectionPool | None = None


def init_pool():
    global _pool
    _pool = ThreadedConnectionPool(1, 10, settings.DATABASE_URL)


@contextmanager
def get_db():
    conn = _pool.getconn()
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            yield cur
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        _pool.putconn(conn)
