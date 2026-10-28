from dotenv import load_dotenv
load_dotenv()

from pathlib import Path
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.sessions import SessionMiddleware
import os
from app.database import Base, engine, SessionLocal
from sqlalchemy import inspect, text
from app.models import User
from app.security import hash_password
from app.controllers import auth, admin, supervisor, checkin

BASE_DIR = Path(__file__).resolve().parent.parent  # FIX: racine du projet, pas le dossier app/.
APP_DIR = BASE_DIR / "app"
Base.metadata.create_all(bind=engine)
# Minimal additive migration for existing MVP databases.
with engine.begin() as conn:
    cols = {c["name"] for c in inspect(conn).get_columns("entry_records")}
    if "idempotency_key" not in cols:
        conn.execute(text("ALTER TABLE entry_records ADD COLUMN idempotency_key VARCHAR(100)"))
app = FastAPI(title="Invitation Access Control", version="0.1.0")
app.add_middleware(SessionMiddleware, secret_key=os.getenv("SECRET_KEY", "dev-only-change-me"), same_site="lax", https_only=False)
app.mount("/static", StaticFiles(directory=str(APP_DIR / "static")), name="static")
templates = Jinja2Templates(directory=str(APP_DIR / "views"))
# FIX: expose templates before any route can use request.app.state.templates.
app.state.templates = templates

# Bootstrap first administrator. Change credentials in .env before deployment.
def bootstrap_admin():
    # FIX: validate the configured administrator password before hashing it.
    admin_password = os.getenv("ADMIN_PASSWORD", "ChangeMe-123!")
    if len(admin_password) < 10:
        raise RuntimeError("ADMIN_PASSWORD doit contenir au moins 10 caractères.")
    db = SessionLocal()
    try:
        username = os.getenv("ADMIN_USERNAME", "admin")
        if not db.query(User).filter_by(username=username).first():
            db.add(User(username=username, full_name="Administrateur", password_hash=hash_password(admin_password), role="admin", active=True))
            db.commit()
    finally:
        db.close()
bootstrap_admin()

@app.get("/", include_in_schema=False)
def home(request: Request):
    if request.session.get("user_id"):
        return templates.TemplateResponse(request=request, name="dashboard.html", context={"user": dict(request.session)})  # FIX: signature Starlette récente (request, name, context).
    return templates.TemplateResponse(request=request, name="login.html", context={})  # FIX: éviter que le dictionnaire soit interprété comme le nom du template.

# Service worker servi à la racine : sa portée couvre alors « / » et « /event/... » (mode hors ligne).
@app.get("/sw.js", include_in_schema=False)
def service_worker():
    return FileResponse(APP_DIR / "static" / "sw.js", media_type="application/javascript", headers={"Cache-Control": "no-cache"})

@app.get("/event/{event_id}", include_in_schema=False)
def event_page(event_id: int, request: Request):
    if not request.session.get("user_id"):
        from fastapi.responses import RedirectResponse
        return RedirectResponse("/", status_code=303)
    return templates.TemplateResponse(request=request, name="event.html", context={"event_id": event_id, "user": dict(request.session)})  # FIX: signature Starlette récente.

app.include_router(auth.router)
app.include_router(admin.router)
app.include_router(supervisor.router)
app.include_router(checkin.router)
