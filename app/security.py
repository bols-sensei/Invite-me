import os
from datetime import datetime, timedelta, timezone
import jwt
from pwdlib import PasswordHash
from fastapi import Request, HTTPException

_password_hash = PasswordHash.recommended()  # Argon2id when argon2-cffi is installed
JWT_ALGORITHM = os.getenv("JWT_ALGORITHM", "HS256")
JWT_SECRET = os.getenv("JWT_SECRET_KEY") or os.getenv("SECRET_KEY", "dev-only-change-me")

def hash_password(password: str) -> str:
    if len(password) < 10:
        raise ValueError("Le mot de passe doit contenir au moins 10 caractères.")
    return _password_hash.hash(password)

def verify_password(password: str, hashed: str) -> bool:
    try: return _password_hash.verify(password, hashed)
    except Exception: return False

def create_access_token(user: dict) -> tuple[str, int]:
    minutes = max(5, int(os.getenv("JWT_EXPIRE_MINUTES", "60")))
    now = datetime.now(timezone.utc)
    payload = {"sub": str(user["id"]), "username": user["username"], "full_name": user["full_name"], "role": user["role"], "iat": now, "exp": now + timedelta(minutes=minutes), "type": "access"}
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM), minutes * 60

def _token_user(token: str):
    try:
        data = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM], options={"require": ["sub", "exp", "iat"]})
        if data.get("type") != "access": raise ValueError("Invalid token type")
        return {"id": int(data["sub"]), "username": data.get("username"), "full_name": data.get("full_name"), "role": data.get("role")}
    except Exception:
        raise HTTPException(status_code=401, detail="Jeton JWT invalide ou expiré", headers={"WWW-Authenticate":"Bearer"})

def current_user(request: Request):
    auth = request.headers.get("Authorization", "")
    if auth.lower().startswith("bearer "):
        return _token_user(auth[7:].strip())
    user_id = request.session.get("user_id")
    if not user_id: raise HTTPException(status_code=401, detail="Connexion requise")
    return {"id": int(user_id), "username": request.session.get("username"), "full_name": request.session.get("full_name"), "role": request.session.get("role")}

def require_roles(request: Request, *roles):
    user = current_user(request)
    if user["role"] not in roles: raise HTTPException(status_code=403, detail="Permission insuffisante")
    return user
