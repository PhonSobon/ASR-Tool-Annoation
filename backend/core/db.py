"""The database (PostgreSQL; SQLite for tests and a quick local try): users, tasks, audio and imported datasets.

Audio itself stays on disk (AUDIO_DIR/<id>/full.wav, DATASETS_DIR/<id>/clips/*.wav); the database keeps what
describes it. Nested data that is always read and written as a whole (the segments of an audio, the clips of a
dataset batch, task members) is one JSON column (JSONB on PostgreSQL).

    with db.transaction() as s:          # commits at the end, rolls back on an error
        row = db.locked(s, Task, task_id)  # SELECT ... FOR UPDATE: nobody else changes it meanwhile

Tables are created at start-up when missing (create_all); columns added to a model later are added to the existing
table (nullable, so old rows stay valid). Times are text "YYYY-MM-DD HH:MM:SS", as in the API.
"""
from contextlib import contextmanager

from flask import current_app
from sqlalchemy import JSON, Boolean, Float, ForeignKey, Integer, String, create_engine, event, inspect, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column

Json = JSON().with_variant(JSONB(), "postgresql")
Stamp = String(19)   # "2026-11-01 15:40:12"


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"
    username: Mapped[str] = mapped_column(String(32), primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    role: Mapped[str] = mapped_column(String(20), index=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    sv: Mapped[int] = mapped_column(Integer, default=1)          # session version: +1 logs the user out everywhere
    created: Mapped[str] = mapped_column(Stamp)
    updated: Mapped[str] = mapped_column(Stamp)
    must_change: Mapped[bool | None] = mapped_column(Boolean, nullable=True)   # still the default password from the admin
    last_login: Mapped[str | None] = mapped_column(Stamp, nullable=True)
    last_seen: Mapped[str | None] = mapped_column(Stamp, nullable=True)        # last API request (about once a minute)


class Activity(Base):
    """The activity log: who signed in and what they changed (see backend/auth/activity.py)."""
    __tablename__ = "activity"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    at: Mapped[str] = mapped_column(Stamp, index=True)
    username: Mapped[str] = mapped_column(String(32), index=True)
    role: Mapped[str] = mapped_column(String(20), default="")
    action: Mapped[str] = mapped_column(String(40), index=True)     # "login", "task.review", ...
    detail: Mapped[str] = mapped_column(String(500), default="")
    ok: Mapped[bool] = mapped_column(Boolean, default=True)          # False: refused or failed
    ip: Mapped[str] = mapped_column(String(64), default="")
    count: Mapped[int] = mapped_column(Integer, default=1)           # the same action on the same thing, repeated within minutes


class Task(Base):
    __tablename__ = "tasks"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    name: Mapped[str] = mapped_column(String(300))
    created: Mapped[str] = mapped_column(Stamp, index=True)
    created_by: Mapped[str] = mapped_column(String(32), default="")
    members: Mapped[dict] = mapped_column(Json, default=dict)    # {"annotator": [...], "inspector": [...], ...}
    last_push: Mapped[dict | None] = mapped_column(Json, nullable=True)


class Audio(Base):
    __tablename__ = "audios"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    name: Mapped[str] = mapped_column(String(300))
    duration: Mapped[float] = mapped_column(Float)
    created: Mapped[str] = mapped_column(Stamp)
    chunk_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)
    task_id: Mapped[str | None] = mapped_column(ForeignKey("tasks.id", ondelete="SET NULL"), nullable=True, index=True)
    segments: Mapped[list | None] = mapped_column(Json, nullable=True)   # None = never edited (fixed-length cuts)
    updated: Mapped[str | None] = mapped_column(Stamp, nullable=True)


class Dataset(Base):
    """One imported batch of a Hugging Face split. `meta` holds every setting of the import (as the API returns
    it); the columns repeat what the list and the batch overlap checks search by."""
    __tablename__ = "datasets"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    repo: Mapped[str] = mapped_column(String(200), index=True)
    config: Mapped[str] = mapped_column(String(200))
    split: Mapped[str] = mapped_column(String(100))
    created: Mapped[str] = mapped_column(Stamp)
    meta: Mapped[dict] = mapped_column(Json)
    items: Mapped[list] = mapped_column(Json, default=list)
    summary: Mapped[dict | None] = mapped_column(Json, nullable=True)   # counts for the cards, kept with items


def init_app(app):
    """Connect to DATABASE_URL and create the missing tables."""
    url = app.config["DATABASE_URL"]
    kwargs = {"pool_pre_ping": True}
    if url.startswith("sqlite"):
        kwargs["connect_args"] = {"check_same_thread": False, "timeout": 30}   # background jobs use other threads
    engine = create_engine(url, **kwargs)
    if url.startswith("sqlite"):
        @event.listens_for(engine, "connect")
        def _fk(conn, _):
            conn.execute("PRAGMA foreign_keys=ON")
    Base.metadata.create_all(engine)
    _add_missing_columns(engine)
    app.extensions["db"] = engine


def _add_missing_columns(engine):
    """ALTER TABLE ... ADD COLUMN for the columns of the models that an existing table does not have yet."""
    insp = inspect(engine)
    with engine.begin() as conn:
        for table in Base.metadata.sorted_tables:
            have = {c["name"] for c in insp.get_columns(table.name)}
            for col in table.columns:
                if col.name not in have:
                    conn.execute(text(f"ALTER TABLE {table.name} ADD COLUMN {col.name} {col.type.compile(engine.dialect)}"))


def engine():
    return current_app.extensions["db"]


@contextmanager
def transaction():
    """A session that commits at the end of the block (rolls back on an error). Objects stay readable after."""
    with Session(engine(), expire_on_commit=False) as s:
        with s.begin():
            yield s


def locked(s, model, key):
    """The row, locked until the transaction ends (SELECT ... FOR UPDATE on PostgreSQL), or None."""
    return s.get(model, key, with_for_update=True)
