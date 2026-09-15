"""The gate reads minio back with the credentials it boots minio with (offline).

`deploy/compose` derives minio's root user and password from `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY`.
The gate pins both, for the same reason it pins every published host port: an unpinned variable falls
through to `deploy/compose/.env` — the developer's live stack — and the proof stack then boots on
somebody's real keys.

The port version of this failure is loud ("port is already allocated"). This one was silent. `mc` was
refused, the listing came back empty, and `test_05_recording_to_minio` reported "chunk object not in
minio: []" — a storage bug that did not exist. The upload had worked: meeting-api read the same real
keys from the same `.env`, so its `put_object` succeeded and the route answered 200. Only the reader
was locked out.

So this pins the invariant the conftest comment states: what `Stack.minio_ls` presents must be what
the stack was started with.
"""
from __future__ import annotations

import re
from pathlib import Path

import conftest

COMPOSE = Path(__file__).resolve().parents[3] / "deploy" / "compose" / "docker-compose.yml"

#: `${VAR:-default}` as the minio service interpolates its root credentials.
_MINIO_CREDENTIAL_VARS = re.compile(r'MINIO_ROOT_(?:USER|PASSWORD)=\$\{([A-Z0-9_]+):-[^}]+\}')


def test_the_gate_pins_every_variable_minios_credentials_come_from():
    referenced = set(_MINIO_CREDENTIAL_VARS.findall(COMPOSE.read_text()))
    assert referenced, "minio's root credentials are no longer interpolated — update this test"
    pinned = set(conftest._stack_env())
    assert referenced <= pinned, (
        f"minio boots from {sorted(referenced - pinned)}, which the gate does not pin — the proof "
        f"stack falls through to deploy/compose/.env and comes up on the developer's real keys")


def test_the_reader_presents_the_credentials_the_stack_booted_with():
    """The two halves have to be the same values, not merely both present: `minio_ls` authenticates
    with what it was given, and the stack accepts only what it was started with."""
    env = conftest._stack_env()
    assert env["MINIO_ACCESS_KEY"] == conftest.MINIO_ACCESS_KEY
    assert env["MINIO_SECRET_KEY"] == conftest.MINIO_SECRET_KEY


def test_a_failed_listing_is_not_reported_as_an_empty_bucket():
    """`minio_ls` must RAISE when it cannot look. Returning [] is indistinguishable from "the object
    is not there" at every call site, which is what turned a locked-out reader into a hunt for a
    storage bug."""
    calls: list = []

    class _Refused(conftest.Stack):
        def exec(self, service, *cmd, check=True):
            calls.append((cmd[:3], check))
            if cmd[:2] == ("mc", "ls"):
                assert check, "the listing must not tolerate a non-zero exit"
                raise RuntimeError("mc: Unable to initialize new alias from active credentials")
            return ""

    try:
        _Refused().minio_ls("recordings/1/2/")
    except RuntimeError as exc:
        assert "credentials" in str(exc)
    else:
        raise AssertionError("a refused listing returned instead of raising")
