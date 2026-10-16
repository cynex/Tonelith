"""Where Tonelith finds its own files and where it keeps the user's data.

Run from source, everything lives in the repository folder. Packaged with PyInstaller the program is read-only and
unpacked somewhere temporary, so the bundled files come from the bundle and the user's data goes to their own folders.
"""
import os
import sys

FROZEN = bool(getattr(sys, "frozen", False))

# Bundled, read-only files: static/, images/, info/
RESOURCE_ROOT = getattr(sys, "_MEIPASS", None) if FROZEN else None
RESOURCE_ROOT = RESOURCE_ROOT or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _user_data_root():
    home = os.path.expanduser("~")
    if sys.platform == "win32":
        return os.environ.get("APPDATA") or os.path.join(home, "AppData", "Roaming")
    if sys.platform == "darwin":
        return os.path.join(home, "Library", "Application Support")
    return os.environ.get("XDG_DATA_HOME") or os.path.join(home, ".local", "share")


def data_dir():
    """Catalog database, caches and preferences."""
    if os.environ.get("TONELITH_DATA"):
        return os.environ["TONELITH_DATA"]
    if FROZEN:
        return os.path.join(_user_data_root(), "Tonelith")
    return os.path.join(RESOURCE_ROOT, "data")


def _user_files_dir(name):
    """Default folder for things the user creates (exports, movie frames)."""
    if FROZEN:
        return os.path.join(os.path.expanduser("~"), "Pictures", "Tonelith", name)
    return os.path.join(RESOURCE_ROOT, name.lower().replace(" ", "_"))


def export_dir():
    return _user_files_dir("Exports")


def movie_dir():
    return _user_files_dir("Movie Frames")
