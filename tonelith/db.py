"""SQLite catalog. Stores library names, references (paths) to images, and settings only."""
import json
import os
import sqlite3
import time

from . import paths
from . import settings as S

DATA_DIR = paths.data_dir()
DB_PATH = os.path.join(DATA_DIR, "tonelith.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS libraries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created REAL NOT NULL,
    city TEXT NOT NULL DEFAULT '',
    region TEXT NOT NULL DEFAULT '',
    country TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    added REAL NOT NULL,
    settings TEXT NOT NULL DEFAULT '{}',
    featured INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_images_lib ON images(library_id);
CREATE INDEX IF NOT EXISTS idx_images_lib_path ON images(library_id, path);
CREATE TABLE IF NOT EXISTS presets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    settings TEXT NOT NULL,
    created REAL NOT NULL
);
"""

# Older catalogs had UNIQUE (library_id, path), which stops a library holding two entries for one file
# (needed for "copy as new entry"). SQLite can't drop a constraint, so the table is rebuilt.
REBUILD = """
BEGIN;
CREATE TABLE images_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    added REAL NOT NULL,
    settings TEXT NOT NULL DEFAULT '{}'
);
INSERT INTO images_new (id, library_id, path, name, added, settings)
    SELECT id, library_id, path, name, added, settings FROM images;
DROP TABLE images;
ALTER TABLE images_new RENAME TO images;
COMMIT;
"""


def _migrate():
    con = connect()
    try:
        row = con.execute("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'images'").fetchone()
        if not row or "UNIQUE" not in row[0].upper():
            return
        # Safety net for existing catalogs. The backup API is WAL-aware, unlike copying the file.
        bak = sqlite3.connect(DB_PATH + ".bak-before-migration")
        try:
            con.backup(bak)
        finally:
            bak.close()
        con.executescript(REBUILD)
    finally:
        con.close()


def connect():
    con = sqlite3.connect(DB_PATH, timeout=15)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    return con


def init():
    os.makedirs(DATA_DIR, exist_ok=True)
    if os.path.isfile(DB_PATH):
        _migrate()
    with connect() as con:
        con.execute("PRAGMA journal_mode = WAL")
        con.executescript(SCHEMA)
        if "featured" not in {r["name"] for r in con.execute("PRAGMA table_info(images)")}:
            con.execute("ALTER TABLE images ADD COLUMN featured INTEGER NOT NULL DEFAULT 0")  # keeps all existing rows
        have = {r["name"] for r in con.execute("PRAGMA table_info(libraries)")}
        for col in ("city", "region", "country"):  # a library's location; added to catalogs made before it existed
            if col not in have:
                con.execute(f"ALTER TABLE libraries ADD COLUMN {col} TEXT NOT NULL DEFAULT ''")
        if not con.execute("SELECT 1 FROM libraries").fetchone():
            con.execute("INSERT INTO libraries (name, created) VALUES (?, ?)", ("My Library", time.time()))


def _image(row):
    s = S.normalize(json.loads(row["settings"] or "{}"))
    return dict(id=row["id"], library_id=row["library_id"], path=row["path"], name=row["name"],
                settings=s, rev=S.revision(s), edited=not S.is_default(s), featured=bool(row["featured"]),
                missing=not os.path.isfile(row["path"]), added=row["added"])


# libraries ----------------------------------------------------------------

def libraries():
    with connect() as con:
        rows = con.execute("""SELECT l.id, l.name, l.city, l.region, l.country, COUNT(i.id) AS count FROM libraries l
                              LEFT JOIN images i ON i.library_id = l.id
                              GROUP BY l.id ORDER BY l.id""").fetchall()
    return [dict(r) for r in rows]


def create_library(name):
    with connect() as con:
        cur = con.execute("INSERT INTO libraries (name, created) VALUES (?, ?)", (name, time.time()))
        return cur.lastrowid


def update_library(lib_id, fields):
    """fields: any of name, city, region, country."""
    cols = [k for k in ("name", "city", "region", "country") if k in fields]
    if not cols:
        return
    with connect() as con:
        con.execute(f"UPDATE libraries SET {', '.join(c + ' = ?' for c in cols)} WHERE id = ?",
                    [fields[c] for c in cols] + [lib_id])


def delete_library(lib_id):
    with connect() as con:
        con.execute("DELETE FROM libraries WHERE id = ?", (lib_id,))


# images -------------------------------------------------------------------

def images(lib_id):
    with connect() as con:
        rows = con.execute("SELECT * FROM images WHERE library_id = ? ORDER BY name COLLATE NOCASE, id",
                           (lib_id,)).fetchall()
    return [_image(r) for r in rows]


def library_preview(lib_id, limit=25):
    """What the Manage libraries window shows for a library: its featured images if it has any, otherwise its first
    `limit` images (same order as the library view). Only the fields needed to draw thumbnails."""
    with connect() as con:
        total = con.execute("SELECT COUNT(*) FROM images WHERE library_id = ?", (lib_id,)).fetchone()[0]
        featured = con.execute("SELECT COUNT(*) FROM images WHERE library_id = ? AND featured = 1", (lib_id,)).fetchone()[0]
        rows = con.execute(
            "SELECT * FROM images WHERE library_id = ?" + (" AND featured = 1" if featured else "")
            + " ORDER BY name COLLATE NOCASE, id LIMIT ?", (lib_id, limit)).fetchall()
    ims = [_image(r) for r in rows]
    return dict(mode="featured" if featured else "first", total=total, featured=featured,
                images=[dict(id=i["id"], name=i["name"], rev=i["rev"], missing=i["missing"]) for i in ims])


def image(image_id):
    with connect() as con:
        row = con.execute("SELECT * FROM images WHERE id = ?", (image_id,)).fetchone()
    return _image(row) if row else None


def add_images(lib_id, paths):
    """Returns (added, duplicates, id of the last image added or None)."""
    added = dupes = 0
    last_id = None
    with connect() as con:
        have = {r[0] for r in con.execute("SELECT path FROM images WHERE library_id = ?", (lib_id,))}
        for p in paths:
            if p in have:
                dupes += 1
                continue
            cur = con.execute("INSERT INTO images (library_id, path, name, added, settings) VALUES (?,?,?,?,?)",
                              (lib_id, p, os.path.basename(p), time.time(), "{}"))
            last_id = cur.lastrowid
            have.add(p)
            added += 1
    return added, dupes, last_id


def set_featured(ids, featured):
    with connect() as con:
        con.executemany("UPDATE images SET featured = ? WHERE id = ?", [(1 if featured else 0, int(i)) for i in ids])


def remove_images(ids):
    with connect() as con:
        con.executemany("DELETE FROM images WHERE id = ?", [(i,) for i in ids])


# presets ------------------------------------------------------------------

def presets():
    with connect() as con:
        rows = con.execute("SELECT id, name, settings FROM presets ORDER BY name COLLATE NOCASE").fetchall()
    return [dict(id=r["id"], name=r["name"], settings=S.normalize(json.loads(r["settings"]))) for r in rows]


def preset_exists(name):
    with connect() as con:
        return con.execute("SELECT 1 FROM presets WHERE name = ?", (name,)).fetchone() is not None


def save_preset(name, settings):
    """Create the preset, or replace the settings of the one with this name (case-insensitive)."""
    blob = json.dumps(S.normalize(settings))
    with connect() as con:
        con.execute("""INSERT INTO presets (name, settings, created) VALUES (?, ?, ?)
                       ON CONFLICT(name) DO UPDATE SET settings = excluded.settings""", (name, blob, time.time()))


def delete_preset(preset_id):
    with connect() as con:
        con.execute("DELETE FROM presets WHERE id = ?", (preset_id,))


def remove_paths(paths):
    """Delete every catalog entry (in any library) that points at one of these files."""
    n = 0
    with connect() as con:
        for p in paths:
            n += con.execute("DELETE FROM images WHERE path = ?", (p,)).rowcount
    return n


def path_in_use(path):
    with connect() as con:
        return con.execute("SELECT 1 FROM images WHERE path = ? LIMIT 1", (path,)).fetchone() is not None


def save_settings(updates):
    """updates: {image_id: settings}. Returns {image_id: rev}."""
    revs = {}
    with connect() as con:
        for iid, s in updates.items():
            s = S.normalize(s)
            con.execute("UPDATE images SET settings = ? WHERE id = ?", (json.dumps(s), iid))
            revs[iid] = S.revision(s)
    return revs


# copying between libraries ------------------------------------------------------

def _copy_context(con, dst, ids):
    rows = [r for r in (con.execute("SELECT * FROM images WHERE id = ?", (int(i),)).fetchone() for i in ids) if r]
    existing, names = {}, set()
    for r in con.execute("SELECT id, path, name FROM images WHERE library_id = ? ORDER BY id", (dst,)):
        existing.setdefault(r["path"], []).append(r["id"])
        names.add(r["name"])
    return rows, existing, names


def copy_check(dst, ids):
    """Dry run: how many of `ids` would be new in `dst` and how many already have an entry there."""
    with connect() as con:
        rows, existing, _ = _copy_context(con, dst, ids)
    seen, dups = set(existing), 0
    for r in rows:
        if r["path"] in seen:
            dups += 1
        else:
            seen.add(r["path"])
    return dict(total=len(rows), duplicates=dups, new=len(rows) - dups)


def _copy_name(name, taken):
    stem, ext = os.path.splitext(name)
    cand, n = f"{stem} (copy){ext}", 2
    while cand in taken:
        cand, n = f"{stem} (copy {n}){ext}", n + 1
    return cand


def copy_images(dst, ids, on_duplicate):
    """Copy entries (path + settings) into `dst`. on_duplicate: 'overwrite' replaces the settings of the
    existing entry for that file, 'copy' adds another entry. Returns counts."""
    added = overwritten = copied = 0
    with connect() as con:
        rows, existing, names = _copy_context(con, dst, ids)
        for r in rows:
            have = existing.get(r["path"])
            if have and on_duplicate == "overwrite":
                con.execute("UPDATE images SET settings = ? WHERE id = ?", (r["settings"], have[0]))
                overwritten += 1
                continue
            name = _copy_name(r["name"], names) if have else r["name"]
            cur = con.execute("INSERT INTO images (library_id, path, name, added, settings, featured) VALUES (?,?,?,?,?,?)",
                              (dst, r["path"], name, time.time(), r["settings"], r["featured"]))
            existing.setdefault(r["path"], []).append(cur.lastrowid)
            names.add(name)
            if have:
                copied += 1
            else:
                added += 1
    return dict(added=added, overwritten=overwritten, copied=copied)
