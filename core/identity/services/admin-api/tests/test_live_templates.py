"""Meeting-agenda templates — the value object, unit tested without a database.

A template is what the user types once and reuses for a KIND of meeting, so the rules worth
pinning are the ones that keep the list usable over months: bounded size, no accidental
duplicates, stable ids so editing updates in place, and a reader that survives a malformed row
written by an older client rather than refusing to show anything.
"""
import pytest
from fastapi import HTTPException

from admin_api.app.live_templates import (DATA_KEY, MAX_ITEMS, MAX_TEMPLATES, normalize_template,
                                          remove_template, store_templates, templates_from_data,
                                          upsert_template)


def test_a_template_keeps_the_users_words_and_order():
    t = normalize_template({"name": "Weekly standup", "items": ["Blockers", "What shipped"]})
    assert t["name"] == "Weekly standup"
    assert t["items"] == ["Blockers", "What shipped"]
    assert t["id"] == "t-weekly-standup"
    assert t["created_at"] and t["updated_at"]


def test_items_may_arrive_as_one_textarea_blob():
    t = normalize_template({"name": "Kickoff", "items": "Scope\n\n  Budget  \nTimeline\n"})
    assert t["items"] == ["Scope", "Budget", "Timeline"]


def test_pasted_bullets_and_numbering_are_stripped_but_a_year_is_not():
    t = normalize_template({"name": "Planning", "items": ["- Hiring", "2. Roadmap", "2026 budget review"]})
    assert t["items"] == ["Hiring", "Roadmap", "2026 budget review"]


def test_the_same_line_twice_is_a_typo_not_two_points():
    t = normalize_template({"name": "Retro", "items": ["Wins", "wins", "Losses"]})
    assert t["items"] == ["Wins", "Losses"]


def test_a_template_needs_a_name_and_at_least_one_line():
    for bad in ({"name": "", "items": ["x"]}, {"name": "Empty", "items": []},
                {"name": "Blank", "items": ["   ", ""]}, "not an object"):
        with pytest.raises(HTTPException) as exc:
            normalize_template(bad)
        assert exc.value.status_code == 422


def test_items_are_bounded():
    t = normalize_template({"name": "Huge", "items": [f"point {i}" for i in range(MAX_ITEMS + 20)]})
    assert len(t["items"]) == MAX_ITEMS


def test_saving_the_same_name_updates_in_place_and_keeps_created_at():
    first = upsert_template([], {"name": "Weekly standup", "items": ["Blockers"]})
    again = upsert_template(first, {"name": "Weekly standup", "items": ["Blockers", "Demos"]})
    assert len(again) == 1
    assert again[0]["items"] == ["Blockers", "Demos"]
    assert again[0]["created_at"] == first[0]["created_at"]


def test_the_most_recently_saved_template_comes_first():
    ts = upsert_template(upsert_template([], {"name": "A", "items": ["a"]}), {"name": "B", "items": ["b"]})
    assert [t["name"] for t in ts] == ["B", "A"]


def test_the_number_of_templates_is_capped():
    ts = []
    for i in range(MAX_TEMPLATES):
        ts = upsert_template(ts, {"name": f"T{i}", "items": ["x"]})
    with pytest.raises(HTTPException) as exc:
        upsert_template(ts, {"name": "one too many", "items": ["x"]})
    assert exc.value.status_code == 422
    # Replacing one of the existing ones is still fine at the cap.
    assert len(upsert_template(ts, {"name": "T0", "items": ["y"]})) == MAX_TEMPLATES


def test_a_malformed_row_is_skipped_rather_than_blocking_the_whole_list():
    data = {DATA_KEY: [
        {"id": "t-good", "name": "Good", "items": ["a"]},
        {"id": "t-nameless", "items": ["a"]},
        {"id": "t-empty", "name": "Empty", "items": []},
        "not a dict",
        {"name": "no id", "items": ["a"]},
    ]}
    assert [t["name"] for t in templates_from_data(data)] == ["Good"]


def test_reading_a_user_document_without_templates_is_empty_not_an_error():
    assert templates_from_data({}) == []
    assert templates_from_data({DATA_KEY: "nonsense"}) == []
    assert templates_from_data(None) == []


def test_removing_is_by_id_and_tolerates_an_unknown_one():
    ts = upsert_template([], {"name": "Weekly standup", "items": ["a"]})
    assert remove_template(ts, "t-weekly-standup") == []
    assert remove_template(ts, "t-nope") == ts


def test_storing_touches_no_other_namespace_in_the_user_document():
    data = {"webhook_url": "https://hook", "calendar_connections": [{"id": "c1"}], "google": {"sub": "x"}}
    merged = store_templates(data, [{"id": "t-a", "name": "A", "items": ["a"]}])
    assert merged["webhook_url"] == "https://hook"
    assert merged["calendar_connections"] == [{"id": "c1"}]
    assert merged["google"] == {"sub": "x"}
    assert merged[DATA_KEY][0]["name"] == "A"
    assert data.get(DATA_KEY) is None  # the caller's dict is not mutated
