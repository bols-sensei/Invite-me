from io import BytesIO
import os, zipfile, secrets
from openpyxl import Workbook
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, PageBreak, Image
import qrcode
from app.models import Invitation, Event
from app.services.qr import build_payload, qr_filename

def qr_png(payload: str) -> bytes:
    img=qrcode.make(payload)
    out=BytesIO(); img.save(out, format='PNG'); return out.getvalue()

def create_designer_zip(event: Event, invitations: list[Invitation]) -> bytes:
    out=BytesIO()
    # FIX: produire chaque QR une seule fois puis réutiliser ses octets pour le PDF et le ZIP.
    qr_images = {inv.reference: qr_png(build_payload(event.id, inv.token)) for inv in invitations}
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        # Excel manifest
        wb=Workbook(); ws=wb.active; ws.title='Invitations'
        ws.append(['Événement (ID)','Ordre','Référence','Nom invité / groupe','Type','Nombre autorisé','Table','Fichier QR'])
        for inv in invitations:
            ws.append([event.id,inv.sequence_no,inv.reference,inv.guest_name,inv.invitation_type,inv.quota,inv.table_name,qr_filename(event.id,inv.reference)])
        x=BytesIO(); wb.save(x); z.writestr('manifest_invitations.xlsx', x.getvalue())
        # PDF reference
        pdf=BytesIO(); doc=SimpleDocTemplate(pdf,pagesize=landscape(A4),rightMargin=10*mm,leftMargin=10*mm,topMargin=10*mm,bottomMargin=10*mm)
        styles=getSampleStyleSheet(); title=ParagraphStyle('TitleSmall', parent=styles['Title'], fontSize=16, leading=19)
        story=[Paragraph(f'Reference invitations — {event.name}',title), Paragraph(f'Evenement n° {event.id} : {event.name} | Date : {event.event_date or "Non precisee"} | Lieu : {event.venue or "Non precise"}',styles['Normal']), Spacer(1,5*mm)]
        data=[['Ordre','Référence','Invité / groupe','Type','Quota','Table','QR code']]
        for inv in invitations:
            qr=qr_images[inv.reference]
            img=Image(BytesIO(qr), width=17*mm, height=17*mm)
            data.append([str(inv.sequence_no),inv.reference,Paragraph(inv.guest_name,styles['BodyText']),inv.invitation_type,str(inv.quota),inv.table_name or '—',img])
        table=Table(data, colWidths=[13*mm,25*mm,65*mm,25*mm,17*mm,22*mm,22*mm], repeatRows=1)
        table.setStyle(TableStyle([
            ('BACKGROUND',(0,0),(-1,0),colors.HexColor('#17324D')),('TEXTCOLOR',(0,0),(-1,0),colors.white),('FONTNAME',(0,0),(-1,0),'Helvetica-Bold'),
            ('FONTSIZE',(0,0),(-1,-1),8),('GRID',(0,0),(-1,-1),0.35,colors.HexColor('#D4DCE5')),('VALIGN',(0,0),(-1,-1),'MIDDLE'),
            ('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white,colors.HexColor('#F5F8FB')]),('LEFTPADDING',(0,0),(-1,-1),4),('RIGHTPADDING',(0,0),(-1,-1),4),('TOPPADDING',(0,1),(-1,-1),3),('BOTTOMPADDING',(0,1),(-1,-1),3)
        ]))
        story.append(table); doc.build(story); z.writestr('reference_invitations.pdf',pdf.getvalue())
        for inv in invitations: z.writestr(qr_filename(event.id,inv.reference), qr_images[inv.reference])
        instructions=(f"EVENEMENT: {event.name} (n° {event.id})\n\n" "RÈGLES POUR LE DESIGNER\n" "1. Utiliser les QR codes PNG fournis sans les recréer, retoucher ou recolorer.\n" "2. La référence INV-xxxx est la correspondance entre le PDF, l'Excel et le fichier PNG. Les fichiers sont nommés E<n° événement>_INV-xxxx.png : ne mélangez jamais les dossiers de deux événements.\n" "3. Respecter strictement l'ordre de la liste. Une invitation de groupe possède un seul QR code, quel que soit son quota.\n" "4. Tester un échantillon après intégration au design et avant impression.\n" "5. Chaque QR code n'est valable que pour son événement : un QR d'un autre événement sera refusé au contrôle.\n" "6. Ne pas publier ni transmettre les QR codes à des tiers.\n")
        z.writestr('instructions_designer.txt',instructions)
    return out.getvalue()
