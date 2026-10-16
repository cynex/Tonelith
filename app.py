"""Tonelith - a small local photo developer. Run:  python app.py"""
import argparse
import collections
import math
import os
import string
import sys
import threading
import time
import uuid
import webbrowser
from urllib.parse import urlparse

from flask import Flask, Response, abort, jsonify, request, send_file, send_from_directory
from werkzeug.exceptions import HTTPException

from tonelith import db, imaging, movies, portutil
from tonelith import settings as S

ROOT = os.path.dirname(os.path.abspath(__file__))
DEFAULT_EXPORT_DIR = os.path.join(ROOT, "exports")
DEFAULT_MOVIE_DIR = os.path.join(ROOT, "movie_frames")
INFO_FILE = os.path.join(os.environ.get("TONELITH_INFO") or os.path.join(ROOT, "info"), "application_info.html")
LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1", "[::1]"}

app = Flask(__name__, static_folder=None)


def fail(msg, code=400):
    return jsonify(error=msg), code


@app.errorhandler(HTTPException)
def http_error(e):
    return fail(e.description or e.name, e.code)


@app.before_request
def guard():
    """Only the local machine's own pages may talk to the API (blocks DNS rebinding / CSRF)."""
    if request.host.rsplit(":", 1)[0].strip("[]") not in {h.strip("[]") for h in LOCAL_HOSTS}:
        abort(403, "Forbidden host")
    if request.method not in ("GET", "HEAD"):
        origin = request.headers.get("Origin")
        if origin and urlparse(origin).hostname not in {h.strip("[]") for h in LOCAL_HOSTS}:
            abort(403, "Forbidden origin")
        if request.mimetype != "application/json":
            abort(415, "JSON required")


# ---- static -----------------------------------------------------------------

@app.get("/")
def index():
    return send_from_directory(os.path.join(ROOT, "static"), "index.html", max_age=0)


@app.get("/api/app-info")
def app_info():
    """The text shown in the About window. Read from disk on every request so edits show up without a restart."""
    if not os.path.isfile(INFO_FILE):
        return fail("info/application_info.html not found", 404)
    with open(INFO_FILE, encoding="utf-8", errors="replace") as f:
        return Response(f.read(), mimetype="text/html", headers={"Cache-Control": "no-store"})


@app.get("/favicon.ico")
def favicon():  # browsers ask for this path by default
    return send_from_directory(os.path.join(ROOT, "images"), "Tonelith.ico", mimetype="image/x-icon", max_age=3600)


@app.get("/manifest.webmanifest")
def manifest():  # lets Chrome/Edge install Tonelith as an app window with its own icon
    return send_from_directory(os.path.join(ROOT, "static"), "manifest.webmanifest",
                               mimetype="application/manifest+json", max_age=0)


@app.get("/static/<path:name>")
def static_files(name):
    return send_from_directory(os.path.join(ROOT, "static"), name, max_age=0)


@app.get("/api/meta")
def meta():
    return jsonify(schema=S.SCHEMA, defaults=S.DEFAULTS, proxy=imaging.PROXY_LONG,
                   formats=list(imaging.FORMATS), export_dir=DEFAULT_EXPORT_DIR, movie_dir=DEFAULT_MOVIE_DIR,
                   raw_ext=sorted(imaging.RAW_EXT), std_ext=sorted(imaging.STD_EXT),
                   raw_available=imaging.rawpy is not None, cache=imaging.cache_stats(),
                   strength=imaging.STRENGTH, strength_range=imaging.STRENGTH_RANGE,
                   strength_defaults={k: imaging.default_strength(k) for k in imaging.STRENGTH})


@app.put("/api/prefs/strength")
def put_strength():
    imaging.set_strength(request.json or {})
    return jsonify(strength=imaging.STRENGTH)


# ---- libraries ----------------------------------------------------------------

@app.get("/api/libraries")
def libraries():
    return jsonify(db.libraries())


@app.post("/api/libraries")
def create_library():
    name = (request.json.get("name") or "").strip()
    if not name:
        return fail("Name required")
    return jsonify(id=db.create_library(name))


@app.put("/api/libraries/<int:lib_id>")
def update_library(lib_id):
    """Rename a library and/or set its location (city, region = province/state, country). Send only what changes."""
    body = request.json
    fields = {}
    if "name" in body:
        name = (body["name"] or "").strip()
        if not name:
            return fail("Name required")
        fields["name"] = name
    for key in ("city", "region", "country"):
        if key in body:
            fields[key] = str(body[key] or "").strip()[:120]
    if not fields:
        return fail("Nothing to update")
    db.update_library(lib_id, fields)
    return jsonify(ok=True)


@app.delete("/api/libraries/<int:lib_id>")
def delete_library(lib_id):
    db.delete_library(lib_id)  # only catalog rows; image files are untouched
    return jsonify(ok=True)


@app.get("/api/libraries/<int:lib_id>/images")
def library_images(lib_id):
    return jsonify(db.images(lib_id))


def _collect(paths, recursive):
    """Expand files/folders into (files, skipped_messages)."""
    files, skipped = [], []
    for p in paths:
        p = os.path.abspath(os.path.expanduser(p))
        if os.path.isdir(p):
            if recursive:
                walker = os.walk(p)
            else:
                walker = [(p, [], [f for f in os.listdir(p) if os.path.isfile(os.path.join(p, f))])]
            for folder, _, names in walker:
                files += [os.path.join(folder, n) for n in sorted(names) if imaging.is_supported(n)]
        elif os.path.isfile(p):
            if imaging.is_supported(p) or imaging.probe(p):
                files.append(p)
            else:
                skipped.append(os.path.basename(p))
        else:
            skipped.append(p)
    return files, skipped


@app.get("/api/libraries/<int:lib_id>/preview")
def library_preview(lib_id):
    return jsonify(db.library_preview(lib_id))


@app.post("/api/libraries/<int:lib_id>/images")
def add_images(lib_id):
    body = request.json
    files, skipped = _collect(body.get("paths") or [], bool(body.get("recursive")))
    added, dupes, last_id = db.add_images(lib_id, files)
    return jsonify(added=added, duplicates=dupes, skipped=skipped, last_id=last_id)


def _copy_args(dst):
    if not any(l["id"] == dst for l in db.libraries()):
        abort(404, "Library not found")
    return [int(i) for i in request.json.get("ids", [])]


@app.post("/api/libraries/<int:dst>/copy-check")
def copy_check(dst):
    return jsonify(db.copy_check(dst, _copy_args(dst)))


@app.post("/api/libraries/<int:dst>/copy")
def copy_images(dst):
    ids = _copy_args(dst)
    mode = request.json.get("on_duplicate")
    if db.copy_check(dst, ids)["duplicates"] and mode not in ("overwrite", "copy"):
        return fail("Some images already exist in the destination: choose overwrite or copy", 409)
    return jsonify(db.copy_images(dst, ids, mode))


@app.post("/api/images/featured")
def set_featured():
    body = request.json
    db.set_featured([int(i) for i in body.get("ids", [])], bool(body.get("featured")))
    return jsonify(ok=True)


@app.post("/api/images/remove")
def remove_images():
    ids = [int(i) for i in request.json.get("ids", [])]
    paths = {im["path"] for im in map(db.image, ids) if im}
    db.remove_images(ids)
    # Cached data is keyed by file, so keep it for any file still used by another library or entry.
    for p in paths:
        if not db.path_in_use(p):
            imaging.purge_path(p)
    return jsonify(ok=True)


# ---- presets --------------------------------------------------------------------

@app.get("/api/presets")
def list_presets():
    return jsonify(db.presets())


@app.post("/api/presets")
def create_preset():
    body = request.json or {}
    name = str(body.get("name", "")).strip()[:80]
    if not name:
        return fail("Give the preset a name")
    if db.preset_exists(name) and not body.get("overwrite"):
        return fail("A preset with that name already exists", 409)
    db.save_preset(name, body.get("settings"))
    return jsonify(db.presets())


@app.delete("/api/presets/<int:preset_id>")
def remove_preset(preset_id):
    db.delete_preset(preset_id)
    return jsonify(db.presets())


@app.post("/api/images/delete-files")
def delete_image_files():
    """Permanently delete the image files from disk, and every catalog entry that points at them."""
    ids = [int(i) for i in (request.json or {}).get("ids", [])]
    paths = {im["path"] for im in map(db.image, ids) if im}
    gone, failed = [], []
    for p in sorted(paths):
        try:
            os.remove(p)
        except FileNotFoundError:
            pass  # already gone: just tidy the catalog
        except OSError as e:
            failed.append(f"{os.path.basename(p)}: {e.strerror or e}")
            continue
        gone.append(p)
    db.remove_paths(gone)
    for p in gone:
        imaging.purge_path(p)
    return jsonify(deleted=len(gone), failed=failed)


# ---- settings -------------------------------------------------------------------

@app.put("/api/images/<int:iid>/settings")
def put_settings(iid):
    if not db.image(iid):
        return fail("Not found", 404)
    return jsonify(rev=db.save_settings({iid: request.json.get("settings")})[iid])


@app.post("/api/images/settings")
def batch_settings():
    """Paste: merge `settings` (only the given keys) into every image in `ids`."""
    body = request.json
    patch = {k: v for k, v in (body.get("settings") or {}).items() if k in S.DEFAULTS}
    updates = {}
    for iid in body.get("ids", []):
        im = db.image(int(iid))
        if im:
            updates[im["id"]] = S.normalize({**im["settings"], **patch})
    revs = db.save_settings(updates)
    return jsonify({iid: {"rev": rev, "settings": updates[iid]} for iid, rev in revs.items()})


# ---- imaging --------------------------------------------------------------------

def _image_or_404(iid):
    im = db.image(iid)
    if not im:
        abort(404, "Image not found")
    return im


def _render_error(e):
    if isinstance(e, FileNotFoundError):
        return fail("File is missing from disk", 404)
    return fail(f"Cannot decode image: {e}", 422)


@app.post("/api/images/<int:iid>/render")
def render_image(iid):
    im = _image_or_404(iid)
    body = request.json
    s = S.normalize(body.get("settings") or im["settings"])
    try:
        region = [float(v) for v in (body.get("region") or [0, 0, 1, 1])]
        zoom = float(body.get("zoom") or 1)
        if len(region) != 4 or not all(map(math.isfinite, region + [zoom])):
            raise ValueError
    except (TypeError, ValueError):
        return fail("Bad region or zoom")
    try:
        data, actual = imaging.render_region(im["path"], s, region, zoom)
    except Exception as e:  # noqa: BLE001
        return _render_error(e)
    return Response(data, mimetype="image/jpeg",
                    headers={"Cache-Control": "no-store", "X-Region": ",".join(f"{v:.6f}" for v in actual)})


@app.get("/api/images/<int:iid>/thumb")
def thumb(iid):
    im = _image_or_404(iid)
    try:
        path = imaging.render_thumb(im["path"], im["settings"], im["rev"])
    except Exception as e:  # noqa: BLE001
        return _render_error(e)
    resp = send_file(path, mimetype="image/jpeg", max_age=31536000)
    return resp


@app.get("/api/images/<int:iid>/info")
def info(iid):
    im = _image_or_404(iid)
    out = dict(path=im["path"], name=im["name"], raw=imaging.ext_of(im["path"]) in imaging.RAW_EXT)
    try:
        _, w, h, _ = imaging.get_proxy(im["path"])
        out.update(width=w, height=h, bytes=os.path.getsize(im["path"]))
    except Exception as e:  # noqa: BLE001
        out["error"] = str(e)
    return jsonify(out)


@app.post("/api/cache/clear")
def clear_cache():
    imaging.clear_cache()
    return jsonify(imaging.cache_stats())


# ---- filesystem browser (for opening files anywhere on this computer) -----------------

def _places():
    home = os.path.expanduser("~")
    places = [{"name": n, "path": os.path.join(home, n)}
              for n in ("Desktop", "Pictures", "Documents", "Downloads") if os.path.isdir(os.path.join(home, n))]
    if os.path.isdir("/Volumes"):  # external drives on macOS
        places.append({"name": "Volumes", "path": "/Volumes"})
    return [{"name": "Home", "path": home}] + places


def _drives():
    if os.name == "nt":
        import ctypes
        mask = ctypes.windll.kernel32.GetLogicalDrives()
        return [f"{c}:\\" for i, c in enumerate(string.ascii_uppercase) if mask >> i & 1]
    return ["/"]


def fs_list_roots():
    return jsonify(path="", parent=None, places=_places(),
                   entries=[dict(name=d, path=d, dir=True, supported=False, size=0) for d in _drives()])


@app.get("/api/fs")
def fs_list():
    path = request.args.get("path", "")
    show_all = request.args.get("all") == "1"
    want_video = request.args.get("types") == "video"  # list movie files instead of images
    if not path:
        return fs_list_roots()
    path = os.path.abspath(os.path.expanduser(path))
    if os.path.isfile(path):
        path = os.path.dirname(path)
    while not os.path.isdir(path):  # e.g. an export folder that doesn't exist yet
        parent = os.path.dirname(path)
        if parent == path:
            return fs_list_roots()
        path = parent
    entries = []
    try:
        with os.scandir(path) as it:
            for e in it:
                try:
                    is_dir = e.is_dir()
                    if e.name.startswith(".") and not show_all:
                        continue
                    sup = (not is_dir) and (movies.is_video(e.name) if want_video else imaging.is_supported(e.name))
                    if not is_dir and not sup and not show_all:
                        continue
                    entries.append(dict(name=e.name, path=e.path, dir=is_dir, supported=sup,
                                        size=0 if is_dir else e.stat().st_size))
                except OSError:
                    continue
    except PermissionError:
        return fail("Permission denied", 403)
    entries.sort(key=lambda e: (not e["dir"], e["name"].lower()))
    parent = os.path.dirname(path.rstrip("\\/")) or None
    if parent == path:
        parent = ""
    return jsonify(path=path, parent=parent, places=_places(), entries=entries)


@app.get("/api/fs/thumb")
def fs_thumb():
    path = os.path.abspath(os.path.expanduser(request.args.get("path", "")))
    if not os.path.isfile(path) or not imaging.is_supported(path):
        abort(404)
    try:
        out = imaging.browse_thumb(path)
    except Exception as e:  # noqa: BLE001
        return _render_error(e)
    return send_file(out, mimetype="image/jpeg", max_age=31536000)


# ---- movie frames ---------------------------------------------------------------

def _movie_path(body):
    path = os.path.abspath(os.path.expanduser(str(body.get("path", ""))))
    if not os.path.isfile(path):
        abort(404, "Movie file not found")
    return path


@app.post("/api/movies/probe")
def movie_probe():
    try:
        return jsonify(movies.probe(_movie_path(request.json or {})))
    except ValueError as e:
        return fail(str(e), 422)


@app.post("/api/movies/extract")
def movie_extract():
    body = request.json or {}
    path = _movie_path(body)
    every = None
    if body.get("mode") == "interval":
        try:
            every = float(body.get("seconds"))
        except (TypeError, ValueError):
            return fail("Enter how many seconds between frames")
        if not math.isfinite(every) or every <= 0:
            return fail("Seconds between frames must be more than 0")
    base = os.path.abspath(os.path.expanduser(body.get("dest") or DEFAULT_MOVIE_DIR))
    try:
        lib_id = int(body.get("lib"))
    except (TypeError, ValueError):
        return fail("No library to add the frames to")
    if not any(l["id"] == lib_id for l in db.libraries()):
        return fail("Library not found", 404)
    try:
        dest = movies.start(path, every, "png" if body.get("format") == "png" else "jpeg", base,
                            on_batch=lambda files: db.add_images(lib_id, files), lib=lib_id)
    except (ValueError, RuntimeError, OSError) as e:
        return fail(str(e), 409 if isinstance(e, RuntimeError) else 422)
    return jsonify(dest=dest)


@app.get("/api/movies/status")
def movie_status():
    return jsonify(movies.status())


@app.post("/api/movies/cancel")
def movie_cancel():
    movies.cancel()
    return jsonify(ok=True)


# ---- export ---------------------------------------------------------------------

# One FIFO queue shared by every export request; a single worker thread drains it.
Q = dict(lock=threading.Lock(), items=collections.deque(), running=False, total=0, done=0,
         cancelled=0, errors=[], files=[], current="", dests=[])


def _export_loop():
    while True:
        with Q["lock"]:
            if not Q["items"]:
                Q["running"], Q["current"] = False, ""
                return
            im, opts = Q["items"].popleft()
            Q["current"] = im["name"]
        try:
            out = imaging.export_image(im["path"], im["settings"], opts["format"], opts["dest"],
                                       opts["suffix"], opts["quality"], opts["bits"], opts["long_edge"])
            err = None
        except Exception as e:  # noqa: BLE001
            out, err = None, f"{im['name']}: {e}"
        with Q["lock"]:
            Q["done"] += 1
            if out:
                Q["files"].append(out)
            if err:
                Q["errors"].append(err)


def _queue_status():
    with Q["lock"]:
        return dict(running=Q["running"], total=Q["total"], done=Q["done"], cancelled=Q["cancelled"],
                    exported=len(Q["files"]), errors=list(Q["errors"]), current=Q["current"],
                    dests=list(Q["dests"]))


@app.post("/api/export")
def export():
    body = request.json
    if body.get("ids"):
        items = [im for im in (db.image(int(i)) for i in body["ids"]) if im]
    else:
        items = db.images(int(body.get("library_id", 0)))
    if not items:
        return fail("Nothing to export")
    fmt = body.get("format", "jpeg")
    if fmt not in imaging.FORMATS:
        return fail("Unknown format")
    dest = os.path.abspath(os.path.expanduser(body.get("dest") or DEFAULT_EXPORT_DIR))
    try:
        os.makedirs(dest, exist_ok=True)
    except OSError as e:
        return fail(f"Cannot use destination: {e}")
    le = body.get("long_edge")
    opts = dict(format=fmt, dest=dest, suffix=str(body.get("suffix") or "")[:40],
                quality=min(100, max(1, int(body.get("quality") or 92))),
                bits=16 if int(body.get("bits") or 8) == 16 else 8,
                long_edge=min(100000, max(16, int(le))) if le else None)
    with Q["lock"]:
        if not Q["running"]:  # a finished queue starts fresh
            Q.update(total=0, done=0, cancelled=0, errors=[], files=[], dests=[])
        Q["total"] += len(items)
        if dest not in Q["dests"]:
            Q["dests"].append(dest)
        Q["items"].extend((im, opts) for im in items)
        start = not Q["running"]
        Q["running"] = True
    if start:
        threading.Thread(target=_export_loop, daemon=True).start()
    return jsonify(queued=len(items))


@app.get("/api/export/status")
def export_status():
    return jsonify(_queue_status())


@app.post("/api/export/cancel")
def export_cancel():
    """Drop everything still waiting. The image being processed right now is allowed to finish."""
    with Q["lock"]:
        n = len(Q["items"])
        Q["items"].clear()
        Q["total"] -= n
        Q["cancelled"] += n
    return jsonify(cancelled=n)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=5174)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()
    # Take over from a Tonelith server that is still running on this port. This must happen before the catalog is
    # opened, because the old server holds it (and a new version may need to upgrade it).
    status, message = portutil.free_port(args.port)
    if message:
        print(message)
    if status == "blocked":
        return 1
    db.init()
    url = f"http://127.0.0.1:{args.port}/"
    if not args.no_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    print(f"Tonelith running at {url}  (Ctrl+C to quit)")
    app.run(host="127.0.0.1", port=args.port, threaded=True, debug=False)


if __name__ == "__main__":
    sys.exit(main())
