#!/usr/bin/env python3
"""
CubeSat-SIM Ground Station — Telemetry API Server
===================================================
Reads telem.txt from the CubeSat simulator and serves it as a JSON API
so the web dashboard can pull live data.

Usage:
    pip install flask psutil
    python3 push_to_dash.py

The dashboard connects to http://<pi-ip>:5050/api/telemetry
"""

import re
import time
import os
import json
import threading
import urllib.request
import urllib.error
from datetime import datetime, timezone
from http.server import HTTPServer, BaseHTTPRequestHandler
import psutil

# ─── CONFIGURATION ───────────────────────────────────────
PI_HOST = '0.0.0.0'
PI_PORT = 5050
TELEM_FILE = '/home/pi/CubeSatSim/telem.txt'
STALE_TIMEOUT = 120  # seconds before data is considered stale

# GitHub Gist cloud relay — Gist ID and push interval
GIST_ID = '5da070ed5aa3c9b8268eaac884b4a199'
# Token: set GITHUB_TOKEN in the environment, or put it in a file named GITHUB_TOKEN (no extension) next to this script
def _load_token():
    t = os.environ.get('GITHUB_TOKEN', '').strip()
    if t:
        return t
    script_dir = os.path.dirname(os.path.abspath(__file__))
    for name in ('GITHUB_TOKEN', 'gist_token.txt'):
        path = os.path.join(script_dir, name)
        if os.path.isfile(path):
            try:
                with open(path, 'r') as f:
                    return f.read().strip()
            except Exception:
                pass
    return ''
GITHUB_TOKEN = _load_token()
GIST_PUSH_INTERVAL = 5  # seconds between cloud pushes
# Write a local telemetry.json next to this script (so you can confirm the script is updating data)
WRITE_LOCAL_JSON = True
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
USERS_FILE = os.path.join(SCRIPT_DIR, 'users.json')
# Default users if users.json is missing (id, pw, role, created)
DEF_USERS = [
    {'id': 'flyboysam', 'pw': 'Airplane11!', 'role': 'admin', 'created': 'SYSTEM'},
    {'id': 'guest', 'pw': 'guest123', 'role': 'guest', 'created': '2026-02-22'},
]
# ─────────────────────────────────────────────────────────

latest_telemetry = {
    'status': 'offline',
    'timestamp': None,
    'ms5611': {'temp': 0.0, 'pressure': 0.0, 'altitude': 0.0},
    'mpu6050': {
        'gx': 0.0, 'gy': 0.0, 'gz': 0.0,
        'ax': 0.0, 'ay': 0.0, 'az': 0.0,
    },
    'tmp': 0.0,
    'system': {'cpu': 0.0, 'gpu_temp': 0.0},
}
lock = threading.Lock()


def load_users():
    """Load user list from users.json; fall back to DEF_USERS if missing or invalid."""
    try:
        if os.path.isfile(USERS_FILE):
            with open(USERS_FILE, 'r') as f:
                data = json.load(f)
            if isinstance(data, list) and data:
                return data
    except Exception:
        pass
    return [dict(u) for u in DEF_USERS]


def save_users(users_list):
    """Persist user list to users.json."""
    try:
        with open(USERS_FILE, 'w') as f:
            json.dump(users_list, f, indent=2)
    except Exception as e:
        print(f"[USERS] save failed: {e}")


def get_gpu_temp():
    try:
        res = os.popen('vcgencmd measure_temp').readline()
        return float(res.replace("temp=", "").replace("'C\n", ""))
    except Exception:
        return 0.0


def _idx_token(parts, token):
    """Index of part that equals token or starts with token (e.g. MS5611 or MS5611>)."""
    for i, p in enumerate(parts):
        if p == token or p.startswith(token):
            return i
    return -1


def parse_telem_line(line):
    """
    Parses a telem.txt line. Supports Pi format from Telem file:
      ... BAT 4.50 0.0  MPU6050 gx gy gz ax ay az GPS lat lon alt TMP temp MS5611>
    MS5611 can appear at end with no values — then we use TMP for temp and GPS alt for altitude.
    """
    data = {}
    parts = re.split(r'[\s,]+', line.strip())

    try:
        if 'TMP' in parts:
            idx = parts.index('TMP')
            if idx + 1 < len(parts):
                data['tmp'] = float(parts[idx + 1])
    except (IndexError, ValueError):
        pass

    try:
        if 'GPS' in parts:
            idx = parts.index('GPS')
            if idx + 3 <= len(parts):
                data['gps'] = (
                    float(parts[idx + 1]),
                    float(parts[idx + 2]),
                    float(parts[idx + 3]),
                )
    except (IndexError, ValueError):
        pass

    try:
        idx = _idx_token(parts, 'MS5611')
        if idx >= 0:
            if idx + 3 <= len(parts):
                data['ms5611'] = {
                    'temp': float(parts[idx + 1]),
                    'pressure': float(parts[idx + 2]),
                    'altitude': float(parts[idx + 3]),
                }
            else:
                # Pi format: MS5611 at end with no values — use TMP for temp, GPS for altitude
                temp = data.get('tmp', 0.0)
                gps = data.get('gps', (0.0, 0.0, 0.0))
                data['ms5611'] = {
                    'temp': temp,
                    'pressure': 1013.25,
                    'altitude': gps[2],
                }
    except (IndexError, ValueError):
        pass

    try:
        if 'MPU6050' in parts:
            idx = parts.index('MPU6050')
            if idx + 6 <= len(parts):
                data['mpu6050'] = {
                    'gx': float(parts[idx + 1]),
                    'gy': float(parts[idx + 2]),
                    'gz': float(parts[idx + 3]),
                    'ax': float(parts[idx + 4]),
                    'ay': float(parts[idx + 5]),
                    'az': float(parts[idx + 6]),
                }
    except (IndexError, ValueError):
        pass

    return data


def push_to_gist(data):
    """Push telemetry JSON to GitHub Gist for cloud relay."""
    if not GITHUB_TOKEN or not GIST_ID:
        return
    token = GITHUB_TOKEN.strip()
    if not token:
        return
    # GitHub accepts Bearer or "token <pat>"; use Bearer for current API
    auth = token if token.startswith(('Bearer ', 'token ')) else f'Bearer {token}'
    try:
        payload = json.dumps({
            'files': {
                'telemetry.json': {
                    'content': json.dumps(data, indent=2)
                }
            }
        }).encode('utf-8')
        req = urllib.request.Request(
            f'https://api.github.com/gists/{GIST_ID}',
            data=payload,
            method='PATCH',
            headers={
                'Authorization': auth,
                'Accept': 'application/vnd.github+json',
                'Content-Type': 'application/json',
                'X-GitHub-Api-Version': '2022-11-28',
            }
        )
        urllib.request.urlopen(req, timeout=10)
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', errors='replace') if e.fp else ''
        print(f"[GIST PUSH ERROR] HTTP {e.code}: {body[:400]}")
    except Exception as e:
        print(f"[GIST PUSH ERROR] {e}")


def write_local_json(data):
    """Write telemetry to a local telemetry.json so you can confirm the script is updating."""
    if not WRITE_LOCAL_JSON:
        return
    path = os.path.join(SCRIPT_DIR, 'telemetry.json')
    try:
        with open(path, 'w') as f:
            json.dump(data, f, indent=2)
    except Exception as e:
        print(f"[LOCAL JSON ERROR] {e}")


def test_gist_push():
    """Try one PATCH to the Gist; return (True, None) on success or (False, error_string)."""
    if not GITHUB_TOKEN or not GIST_ID:
        return (False, 'No GITHUB_TOKEN or GIST_ID')
    token = GITHUB_TOKEN.strip()
    if not token:
        return (False, 'GITHUB_TOKEN is empty')
    auth = token if token.startswith(('Bearer ', 'token ')) else f'Bearer {token}'
    try:
        payload = json.dumps({
            'files': {
                'telemetry.json': {
                    'content': json.dumps(latest_telemetry, indent=2)
                }
            }
        }).encode('utf-8')
        req = urllib.request.Request(
            f'https://api.github.com/gists/{GIST_ID}',
            data=payload,
            method='PATCH',
            headers={
                'Authorization': auth,
                'Accept': 'application/vnd.github+json',
                'Content-Type': 'application/json',
                'X-GitHub-Api-Version': '2022-11-28',
            }
        )
        urllib.request.urlopen(req, timeout=10)
        return (True, None)
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', errors='replace') if e.fp else ''
        return (False, f'HTTP {e.code}: {body[:300]}')
    except Exception as e:
        return (False, str(e))


def telemetry_reader():
    """Background thread that reads telem.txt every second."""
    global latest_telemetry
    last_gist_push = 0

    while True:
        try:
            cpu_load = psutil.cpu_percent(interval=None)
            gpu_temp = get_gpu_temp()

            with lock:
                latest_telemetry['system'] = {
                    'cpu': cpu_load,
                    'gpu_temp': gpu_temp,
                }

            if os.path.exists(TELEM_FILE):
                file_age = time.time() - os.path.getmtime(TELEM_FILE)

                if file_age > STALE_TIMEOUT:
                    with lock:
                        latest_telemetry['status'] = 'stale'
                        latest_telemetry['timestamp'] = datetime.now(timezone.utc).isoformat()
                else:
                    with open(TELEM_FILE, 'r') as f:
                        lines = f.readlines()

                    # Use the most recent line that contains each sensor (MS5611 can be on a different line than MPU6050/TMP)
                    last_ms5611 = last_mpu6050 = last_tmp = ''
                    for line in reversed(lines):
                        stripped = line.strip()
                        if not stripped:
                            continue
                        if 'MS5611' in stripped and not last_ms5611:
                            last_ms5611 = stripped
                        if 'MPU6050' in stripped and not last_mpu6050:
                            last_mpu6050 = stripped
                        if 'TMP' in stripped and not last_tmp:
                            last_tmp = stripped
                        if last_ms5611 and last_mpu6050 and last_tmp:
                            break

                    with lock:
                        latest_telemetry['status'] = 'live'
                        latest_telemetry['timestamp'] = datetime.now(timezone.utc).isoformat()
                    if last_ms5611:
                        parsed = parse_telem_line(last_ms5611)
                        if 'ms5611' in parsed:
                            with lock:
                                latest_telemetry['ms5611'] = parsed['ms5611']
                    if last_mpu6050:
                        parsed = parse_telem_line(last_mpu6050)
                        if 'mpu6050' in parsed:
                            with lock:
                                latest_telemetry['mpu6050'] = parsed['mpu6050']
                    if last_tmp:
                        parsed = parse_telem_line(last_tmp)
                        if 'tmp' in parsed:
                            with lock:
                                latest_telemetry['tmp'] = parsed['tmp']
            else:
                with lock:
                    latest_telemetry['status'] = 'no_file'
                    latest_telemetry['timestamp'] = datetime.now(timezone.utc).isoformat()

            # Push to GitHub Gist on interval and write local telemetry.json
            now = time.time()
            with lock:
                snapshot = dict(latest_telemetry)
            if WRITE_LOCAL_JSON:
                write_local_json(snapshot)
            if GITHUB_TOKEN and (now - last_gist_push) >= GIST_PUSH_INTERVAL:
                push_to_gist(snapshot)
                last_gist_push = now

        except Exception as e:
            print(f"[READER ERROR] {e}")

        time.sleep(1)


class TelemHandler(BaseHTTPRequestHandler):
    """Minimal HTTP handler — no framework dependencies beyond stdlib."""

    def do_GET(self):
        if self.path == '/api/telemetry':
            with lock:
                payload = json.dumps(latest_telemetry)
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(payload.encode())

        elif self.path == '/api/health':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({'ok': True}).encode())

        elif self.path == '/api/users':
            users_list = load_users()
            public = [{'id': u['id'], 'role': u['role'], 'created': u.get('created', '')} for u in users_list]
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps(public).encode())

        else:
            self.send_response(404)
            self.send_header('Content-Type', 'text/plain')
            self.end_headers()
            self.wfile.write(b'Not Found')

    def _read_body(self):
        length = int(self.headers.get('Content-Length', 0))
        if length <= 0:
            return None
        try:
            return json.loads(self.rfile.read(length).decode('utf-8'))
        except Exception:
            return None

    def _send_json(self, status, obj):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(obj).encode())

    def do_POST(self):
        path = self.path.split('?')[0]
        body = self._read_body() or {}

        if path == '/api/auth':
            uid = (body.get('id') or '').strip()
            pw = body.get('pw') or ''
            users_list = load_users()
            match = next((u for u in users_list if u['id'].lower() == uid.lower() and u.get('pw') == pw), None)
            if match:
                self._send_json(200, {'ok': True, 'user': {'id': match['id'], 'role': match['role'], 'created': match.get('created', '')}})
            else:
                self._send_json(401, {'ok': False, 'error': 'Invalid credentials'})
            return

        if path == '/api/users':
            admin_id = (body.get('adminId') or '').strip()
            admin_pw = body.get('adminPw') or ''
            users_list = load_users()
            admin = next((u for u in users_list if u['id'].lower() == admin_id.lower() and u.get('pw') == admin_pw), None)
            if not admin or admin.get('role') != 'admin':
                self._send_json(401, {'ok': False, 'error': 'Admin required'})
                return
            uid = (body.get('id') or '').strip()
            pw = body.get('pw') or ''
            role = (body.get('role') or 'guest').strip() or 'guest'
            if not uid or len(uid) < 3:
                self._send_json(400, {'ok': False, 'error': 'Username required (≥3 chars)'})
                return
            if len(pw) < 6:
                self._send_json(400, {'ok': False, 'error': 'Password must be ≥6 characters'})
                return
            if next((u for u in users_list if u['id'].lower() == uid.lower()), None):
                self._send_json(400, {'ok': False, 'error': 'Username already exists'})
                return
            created = datetime.now(timezone.utc).strftime('%Y-%m-%d')
            users_list.append({'id': uid, 'pw': pw, 'role': role, 'created': created})
            save_users(users_list)
            self._send_json(200, {'ok': True})
            return

        if path == '/api/users/delete':
            admin_id = (body.get('adminId') or '').strip()
            admin_pw = body.get('adminPw') or ''
            users_list = load_users()
            admin = next((u for u in users_list if u['id'].lower() == admin_id.lower() and u.get('pw') == admin_pw), None)
            if not admin or admin.get('role') != 'admin':
                self._send_json(401, {'ok': False, 'error': 'Admin required'})
                return
            target_id = (body.get('id') or '').strip()
            if target_id.lower() == 'flyboysam':
                self._send_json(400, {'ok': False, 'error': 'Protected user'})
                return
            if target_id.lower() == admin_id.lower():
                self._send_json(400, {'ok': False, 'error': 'Cannot remove your own account'})
                return
            users_list = [u for u in users_list if u['id'].lower() != target_id.lower()]
            save_users(users_list)
            self._send_json(200, {'ok': True})
            return

        self.send_response(404)
        self.send_header('Content-Type', 'text/plain')
        self.end_headers()
        self.wfile.write(b'Not Found')

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def log_message(self, format, *args):
        pass  # suppress per-request console spam


class ReuseAddrHTTPServer(HTTPServer):
    """Allow reusing the port so restarting the script does not give 'Address already in use'."""
    allow_reuse_address = True


def main():
    if not os.path.isfile(USERS_FILE):
        save_users(load_users())
    reader_thread = threading.Thread(target=telemetry_reader, daemon=True)
    reader_thread.start()

    server = ReuseAddrHTTPServer((PI_HOST, PI_PORT), TelemHandler)
    gist_status = f"ENABLED (every {GIST_PUSH_INTERVAL}s)" if GITHUB_TOKEN else "DISABLED (no token)"
    print(f"""
╔══════════════════════════════════════════════════════╗
║  CUBESAT-SIM  TELEMETRY API SERVER                   ║
║  Listening on  http://{PI_HOST}:{PI_PORT}                  ║
║  Endpoint:     /api/telemetry                        ║
║  Telem file:   {TELEM_FILE:<38s} ║
║  Gist relay:   {gist_status:<38s} ║
╚══════════════════════════════════════════════════════╝
""")
    if not GITHUB_TOKEN:
        print("  Set GITHUB_TOKEN in the environment, or create a file named GITHUB_TOKEN next to this script.")
    elif GIST_ID:
        print(f"  Gist ID: {GIST_ID} (telemetry.json)")
        ok, err = test_gist_push()
        if ok:
            print("  Gist test: OK — telemetry.json will be updated on GitHub every", GIST_PUSH_INTERVAL, "s")
        else:
            print("  Gist test: FAILED —", err)
    if WRITE_LOCAL_JSON:
        print("  Local file: telemetry.json (written in this script's folder)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
        server.server_close()


if __name__ == '__main__':
    main()
