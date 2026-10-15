"""Stop a Tonelith server that is already running on a port, so a fresh start can take over.

Works on Windows (netstat/taskkill) and macOS/Linux (lsof/kill) using only the standard library.
A program is only stopped if it actually answers like Tonelith, never just because it holds the port.
"""
import json
import os
import re
import signal
import socket
import subprocess
import time
import urllib.request


def _run(cmd):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=15).stdout
    except (OSError, subprocess.SubprocessError):
        return ""


def listening_pids(port, windows=None):
    """Process ids that are listening on a TCP port."""
    windows = (os.name == "nt") if windows is None else windows
    pids = set()
    if windows:
        for proto in ("tcp", "tcpv6"):
            for line in _run(["netstat", "-ano", "-p", proto]).splitlines():
                p = line.split()
                # Proto  Local  Foreign  State  PID. Listening sockets have a foreign address ending in ":0".
                # (The state word is translated on non-English Windows, so it is not used.)
                if (len(p) >= 5 and p[0].upper().startswith("TCP") and p[1].rsplit(":", 1)[-1] == str(port)
                        and p[2].rsplit(":", 1)[-1] == "0" and p[-1].isdigit()):
                    pids.add(int(p[-1]))
        return pids
    for exe in ("lsof", "/usr/sbin/lsof"):  # macOS and most Linux
        out = _run([exe, "-ti", f"tcp:{port}", "-sTCP:LISTEN"])
        if out.strip():
            return {int(x) for x in out.split() if x.isdigit()}
    out = _run(["ss", "-ltnpH", f"sport = :{port}"])  # Linux without lsof
    return {int(x) for x in re.findall(r"pid=(\d+)", out)}


def port_in_use(port):
    with socket.socket() as s:
        s.settimeout(1)
        return s.connect_ex(("127.0.0.1", port)) == 0


def is_tonelith(port):
    """True if whatever is on the port answers like a Tonelith server (any version)."""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/meta", timeout=3) as r:
            data = json.load(r)
        return isinstance(data, dict) and "schema" in data and "defaults" in data
    except Exception:  # noqa: BLE001 - not HTTP, refused, not JSON...
        return False


def stop_pid(pid, windows=None):
    windows = (os.name == "nt") if windows is None else windows
    if windows:
        _run(["taskkill", "/PID", str(pid), "/T", "/F"])  # /T also ends the launcher's child processes
        return
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    for _ in range(30):  # up to 3 s to exit politely, then force it
        time.sleep(0.1)
        try:
            os.kill(pid, 0)
        except OSError:
            return
    try:
        os.kill(pid, signal.SIGKILL)
    except OSError:
        pass


def free_port(port):
    """Make `port` available. Returns (status, message): 'free', 'stopped' or 'blocked'."""
    pids = listening_pids(port)
    if not pids:
        return ("blocked", f"Port {port} is in use by another program. Free it or run with --port <number>.") \
            if port_in_use(port) else ("free", "")
    if not is_tonelith(port):
        return ("blocked", f"Port {port} is in use by another program (PID {', '.join(map(str, sorted(pids)))}). "
                           f"Close it, or start Tonelith on another port with --port <number>.")
    for pid in pids:
        stop_pid(pid)
    for _ in range(50):  # wait up to 5 s for the port to be released
        if not port_in_use(port):
            return ("stopped", f"Stopped the Tonelith server that was already running on port {port} "
                               f"(PID {', '.join(map(str, sorted(pids)))}).")
        time.sleep(0.1)
    return ("blocked", f"Could not stop the program using port {port}.")
