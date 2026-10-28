from datetime import datetime, timezone
from sqlalchemy import String, Integer, Boolean, DateTime, ForeignKey, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.database import Base

def utcnow(): return datetime.now(timezone.utc)

class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(80), unique=True, index=True)
    full_name: Mapped[str] = mapped_column(String(160))
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(20), default="agent") # admin, supervisor, agent
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    assignments: Mapped[list["EventAssignment"]] = relationship(back_populates="user", cascade="all, delete-orphan")

class Event(Base):
    __tablename__ = "events"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(180))
    event_date: Mapped[str] = mapped_column(String(40), default="")
    venue: Mapped[str] = mapped_column(String(240), default="")
    status: Mapped[str] = mapped_column(String(20), default="draft")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    invitations: Mapped[list["Invitation"]] = relationship(back_populates="event", cascade="all, delete-orphan")
    assignments: Mapped[list["EventAssignment"]] = relationship(back_populates="event", cascade="all, delete-orphan")

class EventAssignment(Base):
    __tablename__ = "event_assignments"
    __table_args__ = (UniqueConstraint("event_id", "user_id", name="uq_event_user"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    event_id: Mapped[int] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"))
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    event: Mapped[Event] = relationship(back_populates="assignments")
    user: Mapped[User] = relationship(back_populates="assignments")

class Invitation(Base):
    __tablename__ = "invitations"
    __table_args__ = (UniqueConstraint("event_id", "reference", name="uq_event_reference"), UniqueConstraint("token", name="uq_invitation_token"))
    id: Mapped[int] = mapped_column(primary_key=True)
    event_id: Mapped[int] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"), index=True)
    sequence_no: Mapped[int] = mapped_column(Integer)
    reference: Mapped[str] = mapped_column(String(40))
    guest_name: Mapped[str] = mapped_column(String(200))
    invitation_type: Mapped[str] = mapped_column(String(30), default="individuelle")
    quota: Mapped[int] = mapped_column(Integer, default=1)
    table_name: Mapped[str] = mapped_column(String(80), default="")
    token: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    status: Mapped[str] = mapped_column(String(20), default="active")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    # FIX: rétablir la relation inverse attendue par Event.invitations.
    event: Mapped["Event"] = relationship(back_populates="invitations")
    entries: Mapped[list["EntryRecord"]] = relationship(back_populates="invitation", cascade="all, delete-orphan")

class EntryRecord(Base):
    __tablename__ = "entry_records"
    __table_args__ = (UniqueConstraint("idempotency_key", name="uq_entry_idempotency_key"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    event_id: Mapped[int] = mapped_column(ForeignKey("events.id"), index=True)
    invitation_id: Mapped[int] = mapped_column(ForeignKey("invitations.id"), index=True)
    quantity: Mapped[int] = mapped_column(Integer)
    method: Mapped[str] = mapped_column(String(20), default="qr")
    note: Mapped[str] = mapped_column(Text, default="")
    idempotency_key: Mapped[str | None] = mapped_column(String(100), nullable=True, index=True)
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    invitation: Mapped[Invitation] = relationship(back_populates="entries")

class AuditLog(Base):
    __tablename__ = "audit_logs"
    id: Mapped[int] = mapped_column(primary_key=True)
    event_id: Mapped[int | None] = mapped_column(ForeignKey("events.id"), nullable=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    action: Mapped[str] = mapped_column(String(100))
    details: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ExceptionReview(Base):
    __tablename__ = "exception_reviews"
    id: Mapped[int] = mapped_column(primary_key=True)
    event_id: Mapped[int] = mapped_column(ForeignKey("events.id"), index=True)
    invitation_id: Mapped[int] = mapped_column(ForeignKey("invitations.id"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    decision: Mapped[str] = mapped_column(String(20), default="review")
    reason: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(20), default="pending")
    invitation: Mapped["Invitation"] = relationship()
    user: Mapped["User"] = relationship()
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
