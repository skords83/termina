# Design: Terminfreigabe „Mit Oma + Opa teilen"

**Datum:** 2026-08-17
**Status:** Entwurf, vom Nutzer freigegeben, bereit für Implementierungsplan

## Kontext / Problem

Termina ist aktuell ein Single-/Familien-Owner-CalDAV-Kalender. Es kommt regelmäßig vor, dass die Großeltern (Oma + Opa) entweder für die Kinderbetreuung gebraucht werden oder gemeinsame Termine mit der Familie haben (z. B. wöchentliches Einkaufen freitags, Sperrmüll). Aktuell haben die Großeltern keinen Zugriff auf irgendeinen Termina-Kalender.

Zwei Grundmuster wurden im Gespräch identifiziert:
1. **Eigenständige Termine** (häufigster Fall): z. B. „Kinder hüten 15–17 Uhr" — wird direkt für die Großeltern angelegt, hat meist eine andere (breitere) Zeitspanne und einen anderen Titel als ein evtl. zugrunde liegender privater Termin (z. B. Arzttermin).
2. **Serientermine, die 1:1 geteilt werden sollen**: z. B. „Einkaufen freitags" — ein Termin, der für beide Seiten identisch ist, inkl. gelegentlicher Ausnahmen (ein Freitag fällt aus, wird verschoben — kommt alle paar Wochen vor).

## Ziel

Eine Aktion „Mit Oma + Opa teilen" an einem Termin, die eine unabhängige, aber lose rückverknüpfte Kopie in einem dedizierten Kalender für die Großeltern erzeugt — inklusive Unterstützung für Serientermine und Erkennung, wenn Original und Kopie auseinanderlaufen.

## Bestehende Infrastruktur (keine Änderung nötig)

Termina hat bereits ein vollständiges Mehrbenutzer- und Zugriffssystem, das für diese Funktion wiederverwendet wird:

- `User`-Modell mit Rollen `admin` / `member` / `child`, eigene Logins/Sessions (`backend/src/app/db/models.py`, `backend/src/app/auth/`).
- `UserCalendarAccess`: Admin vergibt pro User Zugriff auf einzelne Kalender (`PUT /admin/users/{id}/calendar-access`).
- Zugriff ist aktuell binär: Wer Zugriff auf einen Kalender hat, darf dort lesen **und** schreiben (`ensure_calendar_access` gated beides identisch, siehe `backend/src/app/api/events.py`). Es gibt keine „nur lesen"-Stufe — für diese Funktion ist das ausreichend, da Schreibrecht für die Großeltern ausdrücklich gewünscht ist.
- `EventFormModal.tsx` hat bereits ein Kalender-Dropdown beim Anlegen/Bearbeiten eines Termins.

**Setup (kein neuer Code, Konfiguration/Betrieb):**
1. Neuer Kalender „Oma & Opa" wird auf dem externen CalDAV-Server angelegt und von Termina eingesynct.
2. Neuer Termina-Account für die Großeltern (Rolle `member`), Zugriff ausschließlich auf diesen Kalender.

## Neue Funktion im Detail

### Teilen-Aktion

Neue Aktion am Termin (Button/Menüpunkt in Termin-Detail bzw. `EventFormModal`): „Mit Oma + Opa teilen".

Öffnet einen Dialog:
- Titel und Start/Ende vorausgefüllt aus dem Quelltermin, frei editierbar (Privatsphäre — z. B. „Zahnarzttermin" → „Kinder hüten").
- Zwei Zeit-Puffer-Felder: „+X Min. davor", „+X Min. danach", Default 0 (0/0 ergibt eine exakte 1:1-Kopie).
- Bei Serienterminen (RRULE gesetzt): Dialog macht klar, dass die **ganze Serie** übernommen wird (gleiche RRULE, Puffer wird auf jede Instanz gleich angewendet).

Beim Bestätigen wird ein neuer, unabhängiger Termin (bzw. eine neue Serie) im Kalender „Oma & Opa" angelegt. Ab dann läuft die Kopie eigenständig — keine automatische, stille Synchronisierung in beide Richtungen.

### Einzeltermine

Einfacher Fall: eine Kopie, ein `event_shares`-Eintrag (siehe Datenmodell), fertig.

### Serientermine

Die komplette Serie wird kopiert (gleiche RRULE), inkl. Verankerung der Instanz-Zuordnung zwischen Original und Kopie (Original-Instanz ↔ Kopie-Instanz, versetzt um den gespeicherten Puffer), damit spätere Einzel-Ausnahmen (Punkt „Instanz-Ebene" unten) einander zugeordnet werden können.

## Datenmodell

Neue Tabelle `event_shares`:

| Feld | Typ | Beschreibung |
|---|---|---|
| `id` | Integer, PK | |
| `source_uid` | FK → `events.uid` | Quelltermin (Master bei Serien) |
| `shared_uid` | FK → `events.uid` | Kopie im Oma&Opa-Kalender (Master bei Serien) |
| `snapshot_start` | DateTime | Start des Quelltermins zum Zeitpunkt des Teilens |
| `snapshot_end` | DateTime | Ende des Quelltermins zum Zeitpunkt des Teilens |
| `snapshot_summary` | String | Titel des Quelltermins zum Zeitpunkt des Teilens |
| `snapshot_rrule` | String, nullable | RRULE zum Zeitpunkt des Teilens (nur Serien) |
| `buffer_before_minutes` | Integer, default 0 | |
| `buffer_after_minutes` | Integer, default 0 | |
| `dismissed` | Boolean, default false | „Ignorieren"-Zustand für aktuelle Abweichung |
| `created_at` | DateTime | |

Für die Instanz-Ebene bei Serien: eine zweite, schlanke Zuordnungsstruktur (z. B. `event_share_instances` oder Erweiterung derselben Tabelle) hält die Zuordnung Original-`recurrence_id` ↔ Kopie-`recurrence_id` fest, damit einzelne `EventOverride`-Ausnahmen einander zugeordnet werden können. Details (Tabellenform vs. berechneter Offset) werden in der Implementierungsplanung entschieden.

## Drift-Erkennung & Reminder

Ausgangspunkt: Vergleich der aktuellen Werte des Quelltermins (bzw. einer seiner Instanzen) gegen den gespeicherten Snapshot in `event_shares`.

**Serien-Ebene:** Ändert sich RRULE, Start/Ende oder Titel der Serie selbst gegenüber dem Snapshot → Hinweis bezieht sich auf die ganze Serie.

**Instanz-Ebene:** Wird für eine Instanz der geteilten Serie ein `EventOverride` angelegt/geändert (z. B. ein Freitag fällt aus/verschiebt sich) oder gelöscht (EXDATE), wird geprüft, ob die zugeordnete Instanz in der Kopie-Serie eine passende Ausnahme hat. Fehlt sie oder weicht sie ab → Hinweis bezieht sich auf genau diese eine Instanz.

**Anzeige (in beiden Fällen gleich):**
- Toast direkt beim Speichern der Änderung am Original: „Auch bei Oma+Opa aktualisieren?" mit Bestätigen/Ignorieren.
- Zusätzlich persistentes Icon am betroffenen Termin-Chip (Serie oder einzelne Instanz), solange die Abweichung nicht aufgelöst ist — analog zum bestehenden Wiederholungssymbol.
- Klick auf Icon oder „Aktualisieren" öffnet den Ziel-Termin (Kopie bzw. neue Instanz-Ausnahme in der Kopie) vorausgefüllt mit den neuen Werten (Original ± gespeicherter Puffer) zur Kontrolle vor dem Speichern — **kein** stilles Auto-Überschreiben.
- „Ignorieren" aktualisiert nur den Snapshot (bzw. markiert die Instanz als bestätigt abweichend), ändert die Kopie nicht. Icon verschwindet, bis erneut eine Abweichung auftritt.

**Löschen:** Löschen eines geteilten Quelltermins (oder einer geteilten Instanz) löst denselben Hinweis-Mechanismus aus („Auch bei Oma+Opa löschen?") statt automatischem Mitlöschen.

## Out of Scope

- Rückschreibung von Änderungen, die die Großeltern selbst vornehmen, zurück zum Original (keine bidirektionale Synchronisierung).
- Jede Form von stiller/automatischer Synchronisierung — jede Übernahme einer Änderung erfordert eine explizite Bestätigung.
- „Nur lesen"-Zugriffsrechte pro Kalender (aktuell binär im System) — eigenes, separates Thema, falls später gewünscht (z. B. für Kinder-Accounts mit Lesezugriff auf einen Familien-Kalender).

## Offene Implementierungsfragen (für die Plan-Phase)

- Genaues Tabellendesign für die Instanz-Zuordnung bei Serien (separate Tabelle vs. berechneter Offset).
- Exakte UI-Platzierung des „Teilen"-Buttons in `EventFormModal` / Termin-Detail.
- Welcher CalDAV-Server im Einsatz ist, um die Anlage des Kalenders „Oma & Opa" zu dokumentieren (Setup-Schritt, kein Code).

## Testing-Überlegungen

- Backend: Teilen eines Einzeltermins erzeugt korrekte Kopie + `event_shares`-Eintrag.
- Backend: Teilen einer Serie erzeugt Kopie-Serie mit identischer RRULE (± Puffer).
- Backend: Änderung am Original-Einzeltermin/-Serie löst Drift-Erkennung aus, „Ignorieren" aktualisiert Snapshot korrekt.
- Backend: Instanz-Override im Original wird korrekt der Kopie-Instanz zugeordnet, Drift wird erkannt.
- Frontend: Icon-Anzeige an Chip (Serie/Instanz), Toast-Verhalten, Dialog-Vorausfüllung mit Puffer-Berechnung.
