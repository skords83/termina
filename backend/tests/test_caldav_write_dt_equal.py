"""
Regression-Test für _dt_equal in app.caldav.write.

Bug: RECURRENCE-ID-Werte, die aus einer .ics gelesen werden, sind immer UTC-aware
(siehe _to_utc), während recurrence_id-Parameter aus der DB naive Europe/Berlin-
Wandzeit sind. Der alte _dt_equal verglich beide nur nach `.replace(tzinfo=None)`,
ohne vorher auf dieselbe Zeitzone zu normalisieren — das ergab für Berlin (nie UTC+0)
immer False, obwohl beide denselben Zeitpunkt meinten. Folge: update_event/
delete_occurrence/restore_occurrence/move_event fanden einen bereits vorhandenen
Override-VEVENT für dieselbe Instanz nicht wieder und hängten einen zweiten,
duplizierten VEVENT mit derselben RECURRENCE-ID an, statt ihn zu ersetzen.
"""
from __future__ import annotations

from datetime import date, datetime, timezone

from app.caldav.write import _dt_equal, BERLIN


def test_naive_berlin_equals_same_instant_in_utc_summer():
    # 29.06.2026 16:30 Berlin (CEST, UTC+2) == 14:30 UTC
    naive_berlin = datetime(2026, 6, 29, 16, 30, 0)
    utc_from_ics = datetime(2026, 6, 29, 14, 30, 0, tzinfo=timezone.utc)
    assert _dt_equal(naive_berlin, utc_from_ics)
    assert _dt_equal(utc_from_ics, naive_berlin)


def test_naive_berlin_equals_same_instant_in_utc_winter():
    # 15.01.2026 09:00 Berlin (CET, UTC+1) == 08:00 UTC
    naive_berlin = datetime(2026, 1, 15, 9, 0, 0)
    utc_from_ics = datetime(2026, 1, 15, 8, 0, 0, tzinfo=timezone.utc)
    assert _dt_equal(naive_berlin, utc_from_ics)


def test_different_instants_are_not_equal():
    naive_berlin = datetime(2026, 6, 29, 16, 30, 0)
    utc_other = datetime(2026, 6, 29, 15, 30, 0, tzinfo=timezone.utc)
    assert not _dt_equal(naive_berlin, utc_other)


def test_both_utc_still_compares_correctly():
    a = datetime(2026, 6, 29, 14, 30, 0, tzinfo=timezone.utc)
    b = datetime(2026, 6, 29, 14, 30, 0, tzinfo=timezone.utc)
    assert _dt_equal(a, b)


def test_both_naive_berlin_still_compares_correctly():
    a = datetime(2026, 6, 29, 16, 30, 0)
    b = datetime(2026, 6, 29, 16, 30, 0)
    assert _dt_equal(a, b)


def test_all_day_date_normalized_via_berlin_midnight():
    d = date(2026, 6, 29)
    utc_midnight = datetime(2026, 6, 28, 22, 0, 0, tzinfo=timezone.utc)  # Berlin midnight in summer
    assert _dt_equal(d, utc_midnight)


def test_none_handling():
    assert _dt_equal(None, None)
    assert not _dt_equal(None, datetime(2026, 6, 29, 16, 30, 0))
