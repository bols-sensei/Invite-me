from pydantic import BaseModel, Field, ConfigDict
from typing import Literal

class TokenRequest(BaseModel):
    username: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=1, max_length=256)

class EntryRequest(BaseModel):
    invitation_id: int = Field(gt=0)
    quantity: int = Field(default=1, ge=1, le=1000)
    method: Literal["qr", "manual", "nfc", "offline"] = "qr"
    note: str = Field(default="", max_length=1000)
    idempotency_key: str | None = Field(default=None, min_length=8, max_length=100)

class SyncEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")
    client_id: str = Field(min_length=8, max_length=100)
    event_id: int = Field(gt=0)
    token: str = Field(min_length=8, max_length=200)
    quantity: int = Field(default=1, ge=1, le=1000)
    method: Literal["qr", "manual", "nfc"] = "qr"
    occurred_at: str | None = Field(default=None, max_length=60)

class SyncBatch(BaseModel):
    entries: list[SyncEntry] = Field(min_length=1, max_length=500)

class ExceptionDecision(BaseModel):
    invitation_id: int = Field(gt=0)
    reason: str = Field(min_length=8, max_length=1000)
    decision: Literal["approve", "reject", "review"] = "review"

class EventCreate(BaseModel):
    name: str = Field(min_length=1, max_length=180)
    event_date: str = Field(default="", max_length=40)
    venue: str = Field(default="", max_length=240)

class UserCreate(BaseModel):
    username: str = Field(min_length=1, max_length=80)
    full_name: str = Field(min_length=1, max_length=160)
    password: str = Field(min_length=10, max_length=256)
    role: Literal["agent", "supervisor"] = "agent"

class AssignmentCreate(BaseModel):
    user_id: int = Field(gt=0)
