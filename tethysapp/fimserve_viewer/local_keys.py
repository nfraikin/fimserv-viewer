"""API keys kept in a file on the machine, never in the repo.

``~/.fimserve_viewer/keys.env`` (or the file the ``FIMSERVE_VIEWER_KEYS``
environment variable names) holds one ``NAME=value`` per line:

    MAPBOX_TOKEN=pk....
    CIROH_API_KEY=...

The file sits outside the repository, so keys stay out of the code, commits
and GitHub, whose push protection rejects a commit carrying one. Lookups go:
an app setting (when the caller has one), then an environment variable of the
same name, then this file. The file is read on every lookup, so an edited key
takes effect without restarting the portal.
"""

import os
from pathlib import Path

KEYS_FILE_ENV = "FIMSERVE_VIEWER_KEYS"
DEFAULT_KEYS_FILE = Path("~/.fimserve_viewer/keys.env")


def keys_file() -> Path:
    """Where the keys file is looked for."""
    return Path(os.environ.get(KEYS_FILE_ENV) or DEFAULT_KEYS_FILE).expanduser()


def read_keys(path=None) -> dict:
    """``{NAME: value}`` from a keys file; {} when there is none.

    Blank lines and ``#`` comments are skipped, and a value may be quoted.
    """
    path = Path(path) if path is not None else keys_file()
    try:
        text = path.read_text(encoding="utf-8")
    except (FileNotFoundError, NotADirectoryError):
        return {}
    keys = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        keys[name.strip()] = value
    return keys


def get(name, setting_value=None):
    """The key called ``name``: the app setting, environment or keys file; None if unset."""
    for value in (setting_value, os.environ.get(name), read_keys().get(name)):
        if value and str(value).strip():
            return str(value).strip()
    return None
