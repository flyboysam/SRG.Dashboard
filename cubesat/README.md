# CubeSat Telemetry API (Rust)

Rust telemetry server for the CubeSat simulator. Runs on the Raspberry Pi, reads `telem.txt`, and serves the JSON API for the SRG Dashboard.

## Build on Raspberry Pi

```bash
cd cubesat
cargo build --release
```

## Run on Pi

```bash
./target/release/srg-cubesat-api
```

Or from the project root:

```bash
cd cubesat && cargo run --release
```

## Configuration

| Env Var     | Description              | Default                          |
|-------------|--------------------------|----------------------------------|
| `PORT`      | HTTP port                | `5050`                           |
| `TELEM_FILE`| Path to telem.txt        | `/home/pi/CubeSatSim/telem.txt`  |

## Deploy to Pi

1. Copy the `cubesat/` folder to the Pi (or clone the repo).
2. On the Pi: `cd cubesat && cargo build --release`
3. Run: `./target/release/srg-cubesat-api`
4. The dashboard (on another machine) connects to `http://<pi-ip>:5050`

## API Endpoints

- `GET /api/telemetry` — Current telemetry
- `GET /api/health` — Health check
- `GET /api/users` — List users
- `POST /api/auth` — Login
- `POST /api/users` — Create user (admin)
- `POST /api/users/delete` — Delete user (admin)

## Cross-compile from Windows/Linux (optional)

To build on your PC for the Pi:

```bash
# Install target (Raspberry Pi 4 = aarch64)
rustup target add aarch64-unknown-linux-gnu

# Build
cargo build --release --target aarch64-unknown-linux-gnu
```

Then copy `target/aarch64-unknown-linux-gnu/release/srg-cubesat-api` to the Pi.
