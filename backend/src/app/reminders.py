"""Relative DISPLAY alarms supported by calendar apps (minutes before DTSTART)."""
from copy import deepcopy
from datetime import timedelta
from icalendar import Alarm


def is_managed_alarm(component) -> bool:
    trigger = component.get("TRIGGER")
    return (component.name == "VALARM" and str(component.get("ACTION", "")) == "DISPLAY"
            and trigger is not None and isinstance(trigger.dt, timedelta)
            and trigger.params.get("RELATED", "START") == "START"
            and trigger.dt.total_seconds() <= 0 and trigger.dt.total_seconds() % 60 == 0)


def read_reminders(component) -> list[int]:
    return sorted({int(-alarm["TRIGGER"].dt.total_seconds() // 60)
                   for alarm in component.subcomponents if is_managed_alarm(alarm)})


def set_reminders(component, minutes: list[int]) -> None:
    component.subcomponents = [alarm for alarm in component.subcomponents if not is_managed_alarm(alarm)]
    for value in sorted(set(minutes)):
        alarm = Alarm()
        alarm.add("ACTION", "DISPLAY")
        alarm.add("DESCRIPTION", str(component.get("SUMMARY", "Termin")))
        alarm.add("TRIGGER", -timedelta(minutes=value))
        component.add_component(alarm)


def copy_alarms(source, target) -> None:
    if source is not None:
        for component in source.subcomponents:
            if component.name == "VALARM":
                target.add_component(deepcopy(component))
