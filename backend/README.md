# SRG Dashboard — Rust Backend

Telemetry API server for the CubeSat mission control dashboard. Reads telemetry from `telem.txt` (CubeSat simulator output) and serves it as JSON. Also provides user management and auth endpoints compatible with the frontend.

**Serves the dashboard** — when you run the backend, open **http://localhost:5050** in your browser. The dashboard and API are served from the same origin, avoiding CORS issues.

## Build & Run

```bash
cd backend
cargo build --release
cargo run --release
```

Then open **http://localhost:5050** in your browser.

Default port: **5050**. Override with `PORT`:

```bash
PORT=8080 cargo run --release
```

## Configuration

| Env Var     | Description                          | Default              |
|-------------|--------------------------------------|----------------------|
| `PORT`      | HTTP server port                     | `5050`               |
| `TELEM_FILE`| Path to telem.txt                    | `./telem.txt`        |

On Raspberry Pi (CubeSatSim), set:

```bash
export TELEM_FILE=/home/pi/CubeSatSim/telem.txt
```

## API Endpoints

| Method | Path           | Description                    |
|--------|----------------|--------------------------------|
| GET    | `/api/telemetry` | Current telemetry (MS5611, MPU6050, system) |
| GET    | `/api/health`    | Health check                   |
| GET    | `/api/users`     | List users (no passwords)      |
| POST   | `/api/auth`      | Login (id, pw)                 |
| POST   | `/api/users`     | Create user (admin auth)       |
| POST   | `/api/users/delete` | Delete user (admin auth)   |

## Data Files

- **telem.txt** — Telemetry file written by the CubeSat simulator. Parsed for MS5611, MPU6050, TMP, GPS.
- **users.json** — User store (created in CWD if missing). Same format as the frontend’s localStorage users.

## Frontend Integration

Add the backend URL to the dashboard’s data sources. In `app.js`, the `bases` array in `fetchUsersFromServer` and the telemetry fetch logic can include `http://localhost:5050` (or your Pi’s IP) so the dashboard pulls from this backend instead of Adafruit IO when available.
