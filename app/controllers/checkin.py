from fastapi import APIRouter, Request, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import func
from app.database import get_db
from app.models import EventAssignment, Invitation, EntryRecord, AuditLog, ExceptionReview
from app.security import require_roles
from app.schemas import EntryRequest, SyncBatch, ExceptionDecision
from app.services.qr import parse_payload
router=APIRouter(prefix='/checkin')
def ensure_assignment(db,event_id,user_id):
    if not db.query(EventAssignment).filter_by(event_id=event_id,user_id=user_id).first(): raise HTTPException(403,'Vous n’êtes pas affecté à cet événement.')
@router.get('/api/events/{event_id}/lookup')
def lookup(event_id:int,request:Request,q:str,db:Session=Depends(get_db)):
    u=require_roles(request,'admin','supervisor','agent')
    if u['role']!='admin': ensure_assignment(db,event_id,u['id'])
    query=db.query(Invitation).filter(Invitation.event_id==event_id,Invitation.status=='active')
    if q.strip().startswith('token:'):
        qr_event,token=parse_payload(q.strip()[6:])
        if qr_event is not None and qr_event!=event_id: raise HTTPException(409,f'Ce QR code appartient à un autre événement (n° {qr_event}).')
        query=query.filter(Invitation.token==token)
    else: query=query.filter((Invitation.reference.ilike(f'%{q.strip()}%')) | (Invitation.guest_name.ilike(f'%{q.strip()}%')))
    invs=query.order_by(Invitation.sequence_no).limit(25).all()
    return [{'id':i.id,'reference':i.reference,'guest_name':i.guest_name,'invitation_type':i.invitation_type,'quota':i.quota,'entered':sum(x.quantity for x in i.entries),'remaining':max(0,i.quota-sum(x.quantity for x in i.entries)),'table_name':i.table_name,'status':i.status} for i in invs]
@router.post('/api/events/{event_id}/entry')
def register_entry(event_id:int,request:Request,payload:EntryRequest,db:Session=Depends(get_db)):
    u=require_roles(request,'admin','supervisor','agent')
    if u['role']!='admin': ensure_assignment(db,event_id,u['id'])
    inv=db.query(Invitation).filter_by(id=payload.invitation_id,event_id=event_id).with_for_update().first()
    if not inv: raise HTTPException(404,'Invitation introuvable pour cet événement.')
    if inv.status!='active': raise HTTPException(409,'Invitation révoquée ou inactive.')
    try: quantity=int(payload.quantity)
    except Exception: raise HTTPException(422,'Quantité invalide.')
    if quantity<1: raise HTTPException(422,'La quantité doit être supérieure à zéro.')
    entered=db.query(func.coalesce(func.sum(EntryRecord.quantity),0)).filter_by(invitation_id=inv.id).scalar() or 0
    if entered+quantity>inv.quota: raise HTTPException(409,f'Quota dépassé : {inv.quota-entered} personne(s) restante(s).')
    note=(payload.note or '').strip(); method=payload.method
    if method not in {'qr','manual','nfc','offline'}: method='manual'
    rec=EntryRecord(event_id=event_id,invitation_id=inv.id,quantity=quantity,method=method,note=note,created_by=u['id'],idempotency_key=payload.idempotency_key); db.add(rec)
    db.add(AuditLog(event_id=event_id,user_id=u['id'],action='entry.registered',details=f'{inv.reference}; quantity={quantity}; method={method}; note={note}'))
    db.commit(); return {'message':'Entrée enregistrée.','reference':inv.reference,'entered':entered+quantity,'remaining':inv.quota-entered-quantity}
@router.post('/api/events/{event_id}/exceptions')
def exception(event_id:int,request:Request,payload:ExceptionDecision,db:Session=Depends(get_db)):
    u=require_roles(request,'supervisor')
    ensure_assignment(db,event_id,u['id'])
    inv=db.query(Invitation).filter_by(id=payload.invitation_id,event_id=event_id).first()
    reason=(payload.reason or '').strip()
    if not inv or len(reason)<8: raise HTTPException(422,'Invitation requise et motif d’au moins 8 caractères.')
    db.add(ExceptionReview(event_id=event_id,invitation_id=inv.id,user_id=u['id'],decision=payload.decision,reason=reason,status='pending' if payload.decision=='review' else payload.decision))
    db.add(AuditLog(event_id=event_id,user_id=u['id'],action='exception.reviewed',details=f'{inv.reference}; decision={payload.decision}; reason={reason}'))
    db.commit(); return {'message':'Décision enregistrée dans l’historique.','reference':inv.reference}


@router.post('/api/sync')
def sync_offline_batch(request: Request, batch: SyncBatch, db: Session=Depends(get_db)):
    """Idempotent synchronization. Conflicts are reported instead of silently overbooking."""
    u=require_roles(request,'admin','supervisor','agent')
    results=[]
    for item in batch.entries:
        existing=db.query(EntryRecord).filter_by(idempotency_key=item.client_id).first()
        if existing:
            results.append({'client_id':item.client_id,'status':'already_synced','reference':existing.invitation.reference})
            continue
        if u['role']!='admin': ensure_assignment(db,item.event_id,u['id'])
        qr_event,token=parse_payload(item.token)
        if qr_event is not None and qr_event!=item.event_id:
            results.append({'client_id':item.client_id,'status':'rejected','reason':f'QR code d’un autre événement (n° {qr_event})'})
            continue
        inv=db.query(Invitation).filter_by(event_id=item.event_id,token=token).first()
        if not inv or inv.status!='active':
            results.append({'client_id':item.client_id,'status':'rejected','reason':'Invitation introuvable, inactive ou révoquée'})
            continue
        entered=db.query(func.coalesce(func.sum(EntryRecord.quantity),0)).filter_by(invitation_id=inv.id).scalar() or 0
        if entered + item.quantity > inv.quota:
            results.append({'client_id':item.client_id,'status':'conflict','reference':inv.reference,'reason':f'Quota dépassé; {max(0,inv.quota-entered)} place(s) restante(s)'})
            continue
        rec=EntryRecord(event_id=item.event_id,invitation_id=inv.id,quantity=item.quantity,method=item.method,note='Synchronisé depuis un appareil hors ligne',created_by=u['id'],idempotency_key=item.client_id)
        db.add(rec)
        # FIX: commit par item pour que chaque passage soit idempotent dès sa synchronisation.
        # En cas de synchronisations concurrentes avec le même client_id, la contrainte UNIQUE peut
        # déclencher IntegrityError; une stratégie de retry/rollback est nécessaire pour ce cas.
        db.flush()
        db.add(AuditLog(event_id=item.event_id,user_id=u['id'],action='entry.synced',details=f'{inv.reference}; client_id={item.client_id}; quantity={item.quantity}; method={item.method}'))
        db.commit()
        results.append({'client_id':item.client_id,'status':'synced','reference':inv.reference,'remaining':max(0,inv.quota-entered-item.quantity)})
    return {'results':results,'synced':sum(x['status'] in {'synced','already_synced'} for x in results),'conflicts':sum(x['status']=='conflict' for x in results)}
