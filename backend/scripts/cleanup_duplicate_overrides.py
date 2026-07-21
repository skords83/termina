"""
Einmaliges Cleanup-Skript: findet und entfernt doppelte Override-VEVENTs
(gleiche UID + RECURRENCE-ID) auf dem echten CalDAV-Server.

Hintergrund: Vor dem Fix von _dt_equal (app/caldav/write.py) wurde beim
Bearbeiten einer einzelnen Instanz eines wiederkehrenden Termins der
bereits vorhandene Override-VEVENT fuer dieselbe RECURRENCE-ID nicht
gefunden (Zeitzonen-Vergleichsfehler: naive Berlin-Zeit vs. UTC aus der
ICS), wodurch ein zweiter, doppelter VEVENT-Block mit derselben
RECURRENCE-ID angehaengt wurde, statt den alten zu ersetzen. sync.py
dedupliziert solche Duplikate beim Einlesen zwar ("letzter VEVENT-Block
gewinnt"), aber welcher Block dabei "gewinnt", war ordnungsabhaengig und
konnte sich bei jedem Sync aendern (Server-seitige Neuordnung der
VEVENT-Bloecke) -- daher die unvorhersehbaren, immer wiederkehrenden
Positions-/Zeitfehler bei rekurrenten Terminen.

Dieses Skript raeumt auf: Es laeuft standardmaessig im Dry-Run (nur
Report, keine Aenderungen). Erst mit --apply werden die Duplikate
tatsaechlich entfernt (jeweils wird nur der LETZTE VEVENT-Block pro
RECURRENCE-ID behalten -- exakt dieselbe Gewinner-Regel wie in
sync.py._upsert_event, damit sich der lokal bereits synchronisierte
Zustand durch das Cleanup nicht aendert) und die bereinigte .ics
zurueck auf den Server geschrieben.

Nutzung:
    cd backend
    PYTHONPATH=src .venv/bin/python scripts/cleanup_duplicate_overrides.py           # Dry-Run
    PYTHONPATH=src .venv/bin/python scripts/cleanup_duplicate_overrides.py --apply    # Anwenden
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from icalendar import Calendar  # noqa: E402

from app.caldav.write import _dt_equal, _get_client  # noqa: E402


def _group_overrides_by_recurrence_id(cal: Calendar) -> dict[str, list]:
    groups: dict[str, list] = {}
    for component in cal.walk("VEVENT"):
        rid = component.get("RECURRENCE-ID")
        if rid is None:
            continue
        matched_key = None
        for key, members in groups.items():
            if _dt_equal(members[0].get("RECURRENCE-ID").dt, rid.dt):
                matched_key = key
                break
        if matched_key is None:
            groups[str(rid.dt)] = [component]
        else:
            groups[matched_key].append(component)
    return groups


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Duplikate tatsaechlich entfernen und zurueckschreiben (ohne diese Option: nur Report).",
    )
    args = parser.parse_args()

    client = _get_client()
    principal = client.principal()

    total_events_checked = 0
    total_duplicates_found = 0
    total_events_fixed = 0

    for cal in principal.calendars():
        print(f"\n=== Kalender: {cal.url} ===")
        for obj in cal.objects(load_objects=True):
            try:
                ical = Calendar.from_ical(obj.data)
            except Exception as e:
                print(f"  [WARN] Konnte Objekt nicht parsen, uebersprungen: {e}")
                continue

            master = next(
                (c for c in ical.walk("VEVENT") if "RECURRENCE-ID" not in c),
                None,
            )
            uid = str(master.get("UID")) if master is not None else "?"

            total_events_checked += 1
            groups = _group_overrides_by_recurrence_id(ical)
            dupe_groups = {k: v for k, v in groups.items() if len(v) > 1}
            if not dupe_groups:
                continue

            total_duplicates_found += sum(len(v) - 1 for v in dupe_groups.values())
            print(f"  UID {uid}:")
            for rid_key, members in dupe_groups.items():
                summaries = [str(m.get("SUMMARY", "")) for m in members]
                print(
                    f"    RECURRENCE-ID {rid_key}: {len(members)} Duplikate "
                    f"-> {summaries} (behalte letztes: {summaries[-1]!r})"
                )

            if args.apply:
                for members in dupe_groups.values():
                    for stale in members[:-1]:
                        ical.subcomponents.remove(stale)
                obj.data = ical.to_ical()
                obj.save()
                total_events_fixed += 1
                print("    -> bereinigt und gespeichert.")

    print(
        f"\n{total_events_checked} Events geprueft, "
        f"{total_duplicates_found} doppelte Override-VEVENTs gefunden"
        + (f", {total_events_fixed} Events bereinigt." if args.apply else " (Dry-Run, nichts geschrieben).")
    )
    if not args.apply and total_duplicates_found:
        print("Zum Anwenden erneut mit --apply ausfuehren.")


if __name__ == "__main__":
    main()
