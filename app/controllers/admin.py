from fastapi import APIRouter, Request, Depends, Form, UploadFile, File, HTTPException
from fastapi.responses import RedirectResponse, JSONResponse, StreamingResponse
from sqlalchemy.orm import Session, joinedload
from sqlalchemy import func
from io import BytesIO
import secrets
from app.database import get_db
from app.models import User, Event, EventAssignment, Invitation, EntryRecord, AuditLog
from app.security import require_roles, hash_password
from app.services.importer import parse_guest_file
from app.services.exports import create_designer_zip
from app.schemas import EventCreate, UserCreate, AssignmentCreate
router=APIRouter(prefix='/admin')

def audit(db,user,event_id,action,details=''):
    db.add(AuditLog(user_id=user['id'],event_id=event_id,action=action,details=details))

@router.get('/api/overview')
def overview(request: Request, db: Session=Depends(get_db)):
    u=require_roles(request,'admin'); events=db.query(Event).order_by(Event.id.desc()).all()
    return {'events':[{'id':e.id,'name':e.name,'event_date':e.event_date,'venue':e.venue,'status':e.status,'invitations':len(e.invitations)} for e in events], 'users':db.query(User).count()}

@router.post('/api/events')
def create_event(request: Request, payload: EventCreate, db: Session=Depends(get_db)):
    u=require_roles(request,'admin'); name=payload.name.strip()
    if not name: raise HTTPException(422,'Le nom de l’événement est obligatoire.')
    e=Event(name=name,event_date=payload.event_date.strip(),venue=payload.venue.strip(),status='draft')
    db.add(e); db.flush(); audit(db,u,e.id,'event.created',name); db.commit(); return {'id':e.id,'name':e.name}

@router.get('/api/events/{event_id}')
def event_detail(event_id:int,request:Request,db:Session=Depends(get_db)):
    u=require_roles(request,'admin','supervisor','agent')  # FIX: compatible session et JWT Bearer.
    e=db.query(Event).options(joinedload(Event.invitations),joinedload(Event.assignments).joinedload(EventAssignment.user)).filter_by(id=event_id).first()
    if not e: raise HTTPException(404,'Événement introuvable.')
    if u.get('role')!='admin' and not any(a.user_id==u.get('id') for a in e.assignments): raise HTTPException(403,'Événement non attribué à ce compte.')
    invs=sorted(e.invitations,key=lambda x:x.sequence_no)
    return {'id':e.id,'name':e.name,'event_date':e.event_date,'venue':e.venue,'status':e.status,'invitations':[{'id':i.id,'sequence_no':i.sequence_no,'reference':i.reference,'guest_name':i.guest_name,'invitation_type':i.invitation_type,'quota':i.quota,'table_name':i.table_name,'status':i.status,'entered':sum(r.quantity for r in i.entries),'remaining':max(0,i.quota-sum(r.quantity for r in i.entries))} for i in invs], 'assignments':[{'id':a.user.id,'username':a.user.username,'full_name':a.user.full_name,'role':a.user.role} for a in e.assignments]}

@router.post('/api/events/{event_id}/import')
async def import_invitations(event_id:int,request:Request,file:UploadFile=File(...),db:Session=Depends(get_db)):
    u=require_roles(request,'admin'); e=db.query(Event).filter_by(id=event_id).first()
    if not e: raise HTTPException(404,'Événement introuvable.')
    content=await file.read()
    if len(content)>10*1024*1024: raise HTTPException(413,'Fichier trop volumineux (maximum 10 Mo).')
    try: guests,duplicates=parse_guest_file(file.filename or '',content)
    except ValueError as ex: raise HTTPException(422,str(ex))
    if duplicates:
        raise HTTPException(422, 'Doublons de noms détectés dans le fichier : ' + ', '.join(duplicates[:10]) + '. Corrigez ou clarifiez la liste puis réimportez.')
    existing=db.query(Invitation).filter_by(event_id=event_id).count()
    # Import is append-only: existing references are never renumbered.
    created=[]
    for g in guests:
        seq=existing+len(created)+1; ref=f'INV-{seq:04d}'
        inv=Invitation(event_id=event_id,sequence_no=seq,reference=ref,guest_name=g['guest_name'],invitation_type=g['invitation_type'],quota=g['quota'],table_name=g['table_name'],token=secrets.token_urlsafe(32),status='active')
        db.add(inv); created.append(inv)
    # FIX: les doublons bloquent l'import plus haut; ne pas enregistrer un compteur trompeur.
    audit(db,u,event_id,'invitations.imported',f'{len(created)} invitations importées')
    db.commit()
    return {'created':len(created),'duplicates':duplicates,'references':[i.reference for i in created], 'message':f'{len(created)} invitations importées dans l’ordre du fichier.'}

@router.get('/api/events/{event_id}/designer-pack')
def designer_pack(event_id:int,request:Request,db:Session=Depends(get_db)):
    u=require_roles(request,'admin'); e=db.query(Event).filter_by(id=event_id).first()
    if not e: raise HTTPException(404,'Événement introuvable.')
    invs=db.query(Invitation).filter_by(event_id=event_id).order_by(Invitation.sequence_no).all()
    if not invs: raise HTTPException(422,'Importez d’abord la liste des invités.')
    data=create_designer_zip(e,invs); audit(db,u,event_id,'designer_pack.generated',f'{len(invs)} invitations'); db.commit()
    return StreamingResponse(BytesIO(data),media_type='application/zip',headers={'Content-Disposition':f'attachment; filename="event_{event_id}_designer_pack.zip"'})

@router.get('/api/users')
def list_users(request:Request,db:Session=Depends(get_db)):
    require_roles(request,'admin')
    return [{'id':x.id,'username':x.username,'full_name':x.full_name,'role':x.role,'active':x.active} for x in db.query(User).order_by(User.id.desc()).all()]

@router.post('/api/users')
def create_user(request:Request,payload:UserCreate,db:Session=Depends(get_db)):
    u=require_roles(request,'admin'); username=payload.username.strip(); full_name=payload.full_name.strip(); password=payload.password; role=payload.role
    if not username or not full_name or len(password)<10: raise HTTPException(422,'Nom, identifiant et mot de passe de 10 caractères minimum requis.')
    if role not in {'agent','supervisor'}: raise HTTPException(422,'Rôle autorisé : agent ou supervisor.')
    if db.query(User).filter_by(username=username).first(): raise HTTPException(409,'Cet identifiant existe déjà.')
    user=User(username=username,full_name=full_name,password_hash=hash_password(password),role=role,active=True); db.add(user); db.flush(); audit(db,u,None,'user.created',f'{username} ({role})'); db.commit()
    return {'id':user.id,'username':user.username,'role':user.role}

@router.post('/api/events/{event_id}/assignments')
def assign_user(event_id:int,request:Request,payload:AssignmentCreate,db:Session=Depends(get_db)):
    u=require_roles(request,'admin'); e=db.query(Event).filter_by(id=event_id).first(); user=db.query(User).filter_by(id=payload.user_id,active=True).first()
    if not e or not user: raise HTTPException(404,'Événement ou utilisateur introuvable/inactif.')
    if user.role=='admin': raise HTTPException(422,'Un compte administrateur n’est pas affecté comme agent.')
    if db.query(EventAssignment).filter_by(event_id=event_id,user_id=user.id).first(): return {'message':'Cet utilisateur est déjà affecté.'}
    db.add(EventAssignment(event_id=event_id,user_id=user.id)); audit(db,u,event_id,'user.assigned',user.username); db.commit(); return {'message':'Agent affecté à l’événement.'}
