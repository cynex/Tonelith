"""Stop the server when the browser is closed.

Every open Tonelith page holds one long-lived "server-sent events" request. The server counts them; when the count
drops to zero and stays there for a short grace period (long enough for a page refresh), it exits.
It never exits while there is work in progress (export queue, movie import), and it gives up waiting for the very
first page after a while so a server nobody opened doesn't linger.
"""
import os
import threading
import time

GRACE_SECONDS = 12      # no pages for this long -> quit (a refresh reconnects well within this)
FIRST_PAGE_SECONDS = 90  # no page ever connected -> quit
COUNTDOWN_SECONDS = 3   # "shutting down in 3, 2, 1" is printed before exiting; a returning page cancels it
BEAT_SECONDS = 1       # heartbeat written to each page; a closed page is noticed on the next write

_lock = threading.Lock()
_open = 0
_seen = False                 # has any page connected yet?
_idle_since = time.monotonic()  # when the count last reached zero (or the server started)
_busy = lambda: False         # replaced by start(): True while an export or movie import is running


def connected():
    """Called when a page connects; returns a function to call when it goes away."""
    global _open, _seen
    with _lock:
        _open += 1
        _seen = True

    def gone():
        global _open, _idle_since
        with _lock:
            _open = max(0, _open - 1)
            if _open == 0:
                _idle_since = time.monotonic()
    return gone


def events():
    """The body of one page's event stream: a heartbeat comment every few seconds until the page goes away."""
    gone = connected()
    try:
        yield "retry: 1500\n\n"
        while True:
            yield ": beat\n\n"
            time.sleep(BEAT_SECONDS)
    finally:
        gone()


def start(busy, on_exit=None):
    """Begin watching. `busy()` says whether work is in progress (the server then stays up)."""
    global _busy, _idle_since
    _busy = busy
    _idle_since = time.monotonic()

    def watch():
        global _idle_since
        while True:
            time.sleep(1)
            with _lock:
                idle = _open == 0
                waited = time.monotonic() - _idle_since
                seen = _seen
            if not idle:
                continue
            if _busy():
                with _lock:
                    _idle_since = time.monotonic()  # restart the countdown once the work finishes
                continue
            if waited > (GRACE_SECONDS if seen else FIRST_PAGE_SECONDS):
                print("Tonelith: the browser was closed, shutting down in...", flush=True)
                for n in range(COUNTDOWN_SECONDS, 0, -1):
                    print(f"  {n}", flush=True)
                    time.sleep(1)
                    with _lock:
                        back = _open > 0
                    if back or _busy():  # a page reconnected (or work started): stay up
                        print("Tonelith: cancelled, staying up.", flush=True)
                        break
                else:
                    print("Tonelith: goodbye.", flush=True)
                    if on_exit:
                        on_exit()
                    os._exit(0)
                with _lock:
                    _idle_since = time.monotonic()

    threading.Thread(target=watch, name="tonelith-lifecycle", daemon=True).start()
