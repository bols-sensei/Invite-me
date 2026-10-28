"""Contenu des QR codes : chaque QR est rattaché à son événement.

Format : IA1.<id_evenement>.<jeton>
Les anciens QR (jeton seul, sans préfixe) restent acceptés, mais ne portent pas d'événement.
"""
import re

PREFIX = "IA1"
_RE = re.compile(r"^IA1\.(\d{1,9})\.([A-Za-z0-9_-]{16,128})$")


def build_payload(event_id: int, token: str) -> str:
    return f"{PREFIX}.{int(event_id)}.{token}"


def parse_payload(value: str) -> tuple[int | None, str]:
    """Retourne (id_evenement ou None, jeton)."""
    v = (value or "").strip()
    m = _RE.match(v)
    return (int(m.group(1)), m.group(2)) if m else (None, v)


def qr_filename(event_id: int, reference: str) -> str:
    """Nom de fichier unique par événement : deux dossiers designer ne peuvent plus se mélanger."""
    return f"QR_CODES/E{int(event_id):03d}_{reference}.png"
