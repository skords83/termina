"""Restore deleted content under a new UID without rewriting a surviving series."""
from copy import deepcopy
from datetime import datetime, date, timedelta, timezone
from dateutil.rrule import rrulestr
from icalendar import Calendar
from app.caldav.write import _find_master, _dt_equal, _to_utc, _to_midnight_utc, BERLIN


def restore_calendar(item, uid):
    cal=Calendar.from_ical(item.raw_ical)
    master=_find_master(cal)
    if master is None or master.get('DTSTART') is None:
        raise ValueError('Der gesicherte Termin enthält keinen gültigen Beginn.')
    if item.scope != 'all':
        rid=datetime.fromisoformat(item.recurrence_id)
        original=master['DTSTART'].dt
        target=(_to_midnight_utc(rid) if item.all_day else _to_utc(rid))
        if isinstance(original, datetime):
            target=target.astimezone(original.tzinfo) if original.tzinfo else target.astimezone(BERLIN).replace(tzinfo=None)
        else:
            target=rid.date()
        def before(value):
            if item.all_day:
                return (value.date() if isinstance(value,datetime) else value) < rid.date()
            return _to_utc(value) < _to_utc(rid)
        if item.scope == 'single':
            def same_occurrence(value):
                if item.all_day:
                    return (value.date() if isinstance(value, datetime) else value) == rid.date()
                return _dt_equal(value, rid)
            matches = [ev for ev in cal.walk('VEVENT') if ev.get('RECURRENCE-ID') is not None
                       and same_occurrence(ev['RECURRENCE-ID'].dt)]
            chosen=deepcopy(matches[0] if matches else master)
            if not matches:
                duration=(chosen['DTEND'].dt-original) if chosen.get('DTEND') else None
                chosen['DTSTART'].dt=target
                if duration is not None: chosen['DTEND'].dt=target+duration
            for key in ('RRULE','RDATE','EXDATE','RECURRENCE-ID'):
                chosen.pop(key,None)
            cal.subcomponents=[c for c in cal.subcomponents if c.name!='VEVENT']+[chosen]
        else:
            # Keep DTSTART and the original rule: shifting DTSTART changes implicit
            # BYDAY/BYMONTHDAY and interval phase. Exclude the original prefix instead.
            excluded=[]
            if master.get('RRULE'):
                start=original if isinstance(original,datetime) else datetime.combine(original,datetime.min.time())
                rule=rrulestr(master['RRULE'].to_ical().decode(),dtstart=start)
                for occurrence in rule:
                    value=occurrence if isinstance(original,datetime) else occurrence.date()
                    if not before(value): break
                    excluded.append(value)
                    if len(excluded)>20000:
                        raise ValueError('Dieser Serienabschnitt ist zu groß für eine sichere Wiederherstellung.')
            rdates=master.get('RDATE',[])
            for prop in rdates if isinstance(rdates,list) else [rdates]:
                excluded.extend(v.dt for v in prop.dts if before(v.dt))
            if excluded: master.add('EXDATE',excluded)
            cal.subcomponents=[ev for ev in cal.subcomponents if ev.name!='VEVENT' or ev.get('RECURRENCE-ID') is None or not before(ev['RECURRENCE-ID'].dt)]
    for ev in cal.walk('VEVENT'):
        ev.pop('UID',None);ev.add('UID',uid)
    return cal.to_ical()
