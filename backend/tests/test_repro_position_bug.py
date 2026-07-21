"""
Reproduktions-Test fuer den gemeldeten Bug: nach Bearbeiten einer einzelnen
Instanz eines wiederkehrenden Termins ueber das Formular (PUT .../events/{uid}
mit recurrence_id) zeigt die Wochen-/Tagesansicht die Instanz an der falschen
Position, obwohl das Popup die korrekte Zeit anzeigt.

Reine Backend-Reproduktion: erstellt ein wiederkehrendes Event direkt in der
Test-DB, liest die Instanz per GET /events, bearbeitet sie per PUT (scope
"single"), liest danach erneut per GET /events und prueft, ob start/end
korrekt uebernommen wurden.
"""
from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import patch

from .test_phase5_api import client, auth, setup_db, CAL_ID  # noqa: F401 (pytest fixtures)


def test_single_occurrence_edit_shows_correct_position(client, auth):
    from app.db.models import Event
    from . import test_phase5_api as t

    # Wiederkehrendes Event anlegen: jeden Montag 16:30-17:30 (naiv, wie in der DB gespeichert)
    db = t.TestingSessionLocal()
    db.add(Event(
        uid="britta-uid-1",
        calendar_id=CAL_ID,
        etag='"etag-britta"',
        summary="Elterngespräch Britta",
        start=datetime(2026, 6, 1, 16, 30),
        end=datetime(2026, 6, 1, 17, 30),
        all_day=False,
        rrule="FREQ=WEEKLY",
    ))
    db.commit()
    db.close()

    # 1) Instanz vom 29. Juni per GET auslesen, um die recurrence_id zu bekommen
    r = client.get("/api/events", headers=auth, params={
        "from": "2026-06-29T00:00:00",
        "to": "2026-06-30T00:00:00",
    })
    assert r.status_code == 200
    instances = [e for e in r.json() if e["uid"] == "britta-uid-1"]
    assert len(instances) == 1, f"Erwartet genau 1 Instanz, bekommen: {instances}"
    inst = instances[0]
    print("VOR EDIT:", inst["start"], inst["end"], "recurrence_id=", inst["recurrence_id"])
    assert inst["start"].startswith("2026-06-29T16:30:00")

    # 2) Diese eine Instanz per PUT (scope="single") auf 14:15-14:45 verschieben,
    #    genau wie das Bearbeiten-Formular es tut.
    with patch("app.api.events.update_event"), patch("app.api.events.run_sync"):
        r2 = client.put(f"/api/events/britta-uid-1", headers=auth, json={
            "etag": '"etag-britta"',
            "summary": "Elterngespräch Britta",
            "start": "2026-06-29T14:15:00",
            "end": "2026-06-29T14:45:00",
            "recurrence_id": inst["recurrence_id"],
        })
    assert r2.status_code == 200, r2.text

    # 3) Erneut GET /events fuer denselben Tag -> muss jetzt 14:15-14:45 zeigen
    r3 = client.get("/api/events", headers=auth, params={
        "from": "2026-06-29T00:00:00",
        "to": "2026-06-30T00:00:00",
    })
    instances2 = [e for e in r3.json() if e["uid"] == "britta-uid-1"]
    assert len(instances2) == 1
    inst2 = instances2[0]
    print("NACH EDIT:", inst2["start"], inst2["end"])
    assert inst2["start"].startswith("2026-06-29T14:15:00"), (
        f"BUG reproduziert: GET /events zeigt weiterhin falsche Startzeit: {inst2['start']}"
    )

    # 4) Jetzt per Formular auf die korrekte Zeit 16:30-17:00 zuruecksetzen
    with patch("app.api.events.update_event"), patch("app.api.events.run_sync"):
        r4 = client.put(f"/api/events/britta-uid-1", headers=auth, json={
            "etag": '"etag-britta"',
            "summary": "Elterngespräch Britta",
            "start": "2026-06-29T16:30:00",
            "end": "2026-06-29T17:00:00",
            "recurrence_id": inst["recurrence_id"],
        })
    assert r4.status_code == 200, r4.text

    r5 = client.get("/api/events", headers=auth, params={
        "from": "2026-06-29T00:00:00",
        "to": "2026-06-30T00:00:00",
    })
    instances3 = [e for e in r5.json() if e["uid"] == "britta-uid-1"]
    assert len(instances3) == 1
    inst3 = instances3[0]
    print("NACH KORREKTUR:", inst3["start"], inst3["end"])
    assert inst3["start"].startswith("2026-06-29T16:30:00"), (
        f"BUG reproduziert: nach Korrektur immer noch falsch: {inst3['start']}"
    )
