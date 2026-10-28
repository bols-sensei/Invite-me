from fastapi import APIRouter, Request, Depends, Form, HTTPException
from fastapi.responses import RedirectResponse, JSONResponse
from sqlalchemy.orm import Session
from app.database import get_db
from app.models import User
from app.security import verify_password, current_user, create_access_token
from app.schemas import TokenRequest
router=APIRouter()
@router.post('/login')
def login(request: Request, username: str=Form(...), password: str=Form(...), db: Session=Depends(get_db)):
    user=db.query(User).filter(User.username==username,User.active==True).first()
    if not user or not verify_password(password,user.password_hash):
        return request.app.state.templates.TemplateResponse(request=request, name='login.html', context={'error':'Identifiants incorrects ou compte désactivé.'}, status_code=401) if hasattr(request.app.state,'templates') else JSONResponse({'detail':'Identifiants incorrects'},status_code=401)  # FIX: signature TemplateResponse compatible avec Starlette récente.
    request.session.clear(); request.session.update({'user_id':user.id,'username':user.username,'full_name':user.full_name,'role':user.role})
    return RedirectResponse('/',status_code=303)
@router.post('/logout')
def logout(request: Request):
    request.session.clear(); return RedirectResponse('/',status_code=303)
@router.get('/api/me')
def me(request: Request): return current_user(request)

@router.post('/api/auth/token')
def issue_token(payload: TokenRequest, db: Session=Depends(get_db)):
    user=db.query(User).filter(User.username==payload.username,User.active==True).first()
    if not user or not verify_password(payload.password,user.password_hash):
        raise HTTPException(status_code=401, detail='Identifiants incorrects ou compte désactivé.', headers={'WWW-Authenticate':'Bearer'})
    token, expires_in=create_access_token({'id':user.id,'username':user.username,'full_name':user.full_name,'role':user.role})
    return {'access_token':token,'token_type':'bearer','expires_in':expires_in,'user':{'id':user.id,'username':user.username,'full_name':user.full_name,'role':user.role}}
