"""Extract still frames from a movie file (decoded with OpenCV's bundled FFmpeg)."""
import os
import shutil
import threading
import time

import cv2
import numpy as np

VIDEO_EXT = {".mp4", ".m4v", ".mov", ".avi", ".mkv", ".webm", ".wmv", ".mpg", ".mpeg", ".mts", ".m2ts",
             ".3gp", ".flv", ".ts", ".mxf", ".ogv"}


def is_video(path):
    return os.path.splitext(path)[1].lower() in VIDEO_EXT


def probe(path):
    cap = cv2.VideoCapture(path)
    try:
        if not cap.isOpened():
            raise ValueError("Cannot open this movie file")
        fps = cap.get(cv2.CAP_PROP_FPS) or 0.0
        frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        return dict(width=int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), height=int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)),
                    fps=round(fps, 3), frames=max(0, frames), duration=round(frames / fps, 2) if fps and frames else 0)
    finally:
        cap.release()


_lock = threading.Lock()
_job = dict(running=False, done=0, total=0, saved=0, error=None, dest=None, finished=False, cancelled=False,
            lib=None, name="", added=0, expected=0)
_cancel = threading.Event()


def status():
    with _lock:
        return dict(_job)


def cancel():
    _cancel.set()


def start(path, every_seconds, fmt, base_dir, on_batch=None, lib=None):
    """Begin extracting in a background thread. every_seconds=None means every frame. Returns the output folder.

    on_batch(list_of_new_file_paths) is called as frames are written, so they can be added to a library while the
    extraction is still going."""
    with _lock:
        if _job["running"]:
            raise RuntimeError("A movie import is already running")
    info = probe(path)
    fps = info["fps"] or 25.0
    step = 1 if not every_seconds else max(1, round(fps * every_seconds))
    ext, params = (".png", [cv2.IMWRITE_PNG_COMPRESSION, 3]) if fmt == "png" else (".jpg", [cv2.IMWRITE_JPEG_QUALITY, 95])
    stem = os.path.splitext(os.path.basename(path))[0] or "movie"
    root = os.path.join(base_dir, f"{stem}_{time.strftime('%Y%m%d-%H%M%S')}")
    dest, n = root, 1
    while os.path.exists(dest):  # never mix with an earlier import
        n += 1
        dest = f"{root}-{n}"
    os.makedirs(dest)
    _cancel.clear()
    with _lock:
        _job.update(running=True, done=0, total=info["frames"], saved=0, error=None, dest=dest, finished=False, cancelled=False,
                    lib=lib, name=os.path.basename(path), added=0,
                    expected=(info["frames"] - 1) // step + 1 if info["frames"] else 0)
    threading.Thread(target=_run, args=(path, step, ext, params, dest, stem, on_batch), daemon=True).start()
    return dest


def _flush(batch, on_batch):
    if not batch or not on_batch:
        return 0
    try:
        on_batch(list(batch))
    except Exception:  # noqa: BLE001 - a catalog hiccup must not kill the extraction
        return 0
    n = len(batch)
    batch.clear()
    with _lock:
        _job["added"] += n
    return n


def _run(path, step, ext, params, dest, stem, on_batch):
    cap = cv2.VideoCapture(path)
    idx = saved = 0
    err = None
    batch, last_flush = [], time.time()
    try:
        while not _cancel.is_set():
            if not cap.grab():
                break
            if idx % step == 0:
                ok, frame = cap.retrieve()
                if ok:
                    enc_ok, buf = cv2.imencode(ext, frame, params)  # imencode + write handles non-ASCII paths on Windows
                    if enc_ok:
                        out = os.path.join(dest, f"{stem}_f{idx:07d}{ext}")
                        with open(out, "wb") as f:
                            f.write(np.asarray(buf).tobytes())
                        saved += 1
                        batch.append(out)
                        if len(batch) >= 20 or time.time() - last_flush > 1.5:
                            _flush(batch, on_batch); last_flush = time.time()
            idx += 1
            if idx % 5 == 0:
                with _lock:
                    _job.update(done=idx, saved=saved)
    except Exception as e:  # noqa: BLE001
        err = str(e)
    finally:
        cap.release()
    _flush(batch, on_batch)
    cancelled = _cancel.is_set()
    if not saved:  # nothing worth keeping
        shutil.rmtree(dest, ignore_errors=True)
    if not saved and not cancelled and not err:
        err = "No frames could be read from this movie"
    with _lock:
        _job.update(running=False, finished=True, done=idx, saved=saved, error=err, cancelled=cancelled)
