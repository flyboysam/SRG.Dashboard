//! CubeSat-SIM Ground Station — Telemetry API Server
//!
//! Reads telem.txt from the CubeSat simulator and serves it as a JSON API.
//! Compatible with the SRG Dashboard frontend.

use axum::{
    extract::State,
    http::header,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use sysinfo::System;
use tokio::fs;
use tokio::sync::RwLock;
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::ServeDir;

const DEFAULT_PORT: u16 = 5050;
const STALE_TIMEOUT_SECS: u64 = 120;
#[derive(Clone, Default, Serialize, Deserialize)]
struct Ms5611 {
    temp: f64,
    pressure: f64,
    altitude: f64,
}

#[derive(Clone, Default, Serialize, Deserialize)]
struct Mpu6050 {
    gx: f64,
    gy: f64,
    gz: f64,
    ax: f64,
    ay: f64,
    az: f64,
}

#[derive(Clone, Default, Serialize, Deserialize)]
struct SystemInfo {
    cpu: f64,
    gpu_temp: f64,
}

#[derive(Clone, Default, Serialize, Deserialize)]
struct Telemetry {
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    timestamp: Option<String>,
    ms5611: Ms5611,
    mpu6050: Mpu6050,
    tmp: f64,
    system: SystemInfo,
}

#[derive(Clone, Serialize, Deserialize)]
struct User {
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pw: Option<String>,
    role: String,
    created: String,
}

#[derive(Clone)]
struct AppState {
    telemetry: Arc<RwLock<Telemetry>>,
    users: Arc<RwLock<Vec<User>>>,
    users_file: PathBuf,
    telem_file: PathBuf,
}

fn default_users() -> Vec<User> {
    vec![
        User {
            id: "flyboysam".into(),
            pw: Some("Airplane11!".into()),
            role: "admin".into(),
            created: "SYSTEM".into(),
        },
        User {
            id: "guest".into(),
            pw: Some("guest123".into()),
            role: "guest".into(),
            created: "2026-02-22".into(),
        },
        User {
            id: "SRG".into(),
            pw: Some("SRG_2026".into()),
            role: "guest".into(),
            created: "2026-02-22".into(),
        },
    ]
}

fn idx_token(parts: &[&str], token: &str) -> Option<usize> {
    parts.iter().position(|p| *p == token || p.starts_with(token))
}

fn parse_telem_line(line: &str) -> (Option<Ms5611>, Option<Mpu6050>, Option<f64>) {
    let parts: Vec<&str> = line
        .split(|c: char| c.is_whitespace() || c == ',')
        .filter(|s| !s.is_empty())
        .collect();

    let mut tmp: Option<f64> = None;
    if let Some(idx) = parts.iter().position(|p| *p == "TMP") {
        if idx + 1 < parts.len() {
            if let Ok(v) = parts[idx + 1].parse::<f64>() {
                tmp = Some(v);
            }
        }
    }

    let mut gps: (f64, f64, f64) = (0.0, 0.0, 0.0);
    if let Some(idx) = parts.iter().position(|p| *p == "GPS") {
        if idx + 3 <= parts.len() {
            if let (Ok(lat), Ok(lon), Ok(alt)) = (
                parts[idx + 1].parse::<f64>(),
                parts[idx + 2].parse::<f64>(),
                parts[idx + 3].parse::<f64>(),
            ) {
                gps = (lat, lon, alt);
            }
        }
    }

    let mut ms5611: Option<Ms5611> = None;
    if let Some(idx) = idx_token(&parts, "MS5611") {
        if idx + 3 <= parts.len() {
            if let (Ok(t), Ok(p), Ok(a)) = (
                parts[idx + 1].parse::<f64>(),
                parts[idx + 2].parse::<f64>(),
                parts[idx + 3].parse::<f64>(),
            ) {
                ms5611 = Some(Ms5611 {
                    temp: t,
                    pressure: p,
                    altitude: a,
                });
            }
        } else {
            let t = tmp.unwrap_or(0.0);
            ms5611 = Some(Ms5611 {
                temp: t,
                pressure: 1013.25,
                altitude: gps.2,
            });
        }
    }

    let mut mpu6050: Option<Mpu6050> = None;
    if let Some(idx) = parts.iter().position(|p| *p == "MPU6050") {
        if idx + 6 <= parts.len() {
            if let (Ok(gx), Ok(gy), Ok(gz), Ok(ax), Ok(ay), Ok(az)) = (
                parts[idx + 1].parse::<f64>(),
                parts[idx + 2].parse::<f64>(),
                parts[idx + 3].parse::<f64>(),
                parts[idx + 4].parse::<f64>(),
                parts[idx + 5].parse::<f64>(),
                parts[idx + 6].parse::<f64>(),
            ) {
                mpu6050 = Some(Mpu6050 { gx, gy, gz, ax, ay, az });
            }
        }
    }

    (ms5611, mpu6050, tmp)
}

fn get_gpu_temp() -> f64 {
    #[cfg(target_os = "linux")]
    {
        let output = std::process::Command::new("vcgencmd")
            .arg("measure_temp")
            .output();
        if let Ok(out) = output {
            let s = String::from_utf8_lossy(&out.stdout);
            if let Some(rest) = s.strip_prefix("temp=") {
                if let Some(rest) = rest.strip_suffix("'C\n") {
                    if let Ok(t) = rest.parse::<f64>() {
                        return t;
                    }
                }
            }
        }
    }
    0.0
}

fn get_cpu_usage() -> f64 {
    let mut sys = System::new_all();
    sys.refresh_cpu();
    std::thread::sleep(Duration::from_millis(200));
    sys.refresh_cpu();
    sys.global_cpu_info().cpu_usage() as f64
}

fn iso_timestamp() -> String {
    chrono::Utc::now().to_rfc3339()
}

async fn telemetry_reader_loop(state: AppState) {
    let mut last_ms5611 = String::new();
    let mut last_mpu6050 = String::new();
    let mut last_tmp = String::new();

    loop {
        let cpu = get_cpu_usage();
        let gpu_temp = get_gpu_temp();

        {
            let mut telemetry = state.telemetry.write().await;
            telemetry.system = SystemInfo { cpu, gpu_temp };
        }

        let telem_path = state.telem_file.clone();
        if telem_path.exists() {
            let metadata = fs::metadata(&telem_path).await;
            let file_age = metadata
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| {
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs()
                        .saturating_sub(d.as_secs())
                })
                .unwrap_or(1);

            if file_age > STALE_TIMEOUT_SECS {
                let mut telemetry = state.telemetry.write().await;
                telemetry.status = "stale".into();
                telemetry.timestamp = Some(iso_timestamp());
            } else if let Ok(content) = fs::read_to_string(&telem_path).await {
                let lines: Vec<&str> = content.lines().rev().collect();
                last_ms5611.clear();
                last_mpu6050.clear();
                last_tmp.clear();

                for line in lines {
                    let stripped = line.trim();
                    if stripped.is_empty() {
                        continue;
                    }
                    if stripped.contains("MS5611") && last_ms5611.is_empty() {
                        last_ms5611 = stripped.to_string();
                    }
                    if stripped.contains("MPU6050") && last_mpu6050.is_empty() {
                        last_mpu6050 = stripped.to_string();
                    }
                    if stripped.contains("TMP") && last_tmp.is_empty() {
                        last_tmp = stripped.to_string();
                    }
                    if !last_ms5611.is_empty() && !last_mpu6050.is_empty() && !last_tmp.is_empty() {
                        break;
                    }
                }

                let mut telemetry = state.telemetry.write().await;
                telemetry.status = "live".into();
                telemetry.timestamp = Some(iso_timestamp());

                if !last_ms5611.is_empty() {
                    let (ms5611, _, _) = parse_telem_line(&last_ms5611);
                    if let Some(m) = ms5611 {
                        telemetry.ms5611 = m;
                    }
                }
                if !last_mpu6050.is_empty() {
                    let (_, mpu6050, _) = parse_telem_line(&last_mpu6050);
                    if let Some(m) = mpu6050 {
                        telemetry.mpu6050 = m;
                    }
                }
                if !last_tmp.is_empty() {
                    let (_, _, tmp) = parse_telem_line(&last_tmp);
                    if let Some(t) = tmp {
                        telemetry.tmp = t;
                    }
                }
            }
        } else {
            let mut telemetry = state.telemetry.write().await;
            telemetry.status = "no_file".into();
            telemetry.timestamp = Some(iso_timestamp());
        }

        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

async fn load_users(path: &PathBuf) -> Vec<User> {
    if let Ok(content) = fs::read_to_string(path).await {
        if let Ok(users) = serde_json::from_str::<Vec<User>>(&content) {
            if !users.is_empty() {
                return users;
            }
        }
    }
    default_users()
}

async fn save_users(path: &PathBuf, users: &[User]) {
    let _ = fs::write(&path, serde_json::to_string_pretty(users).unwrap_or_default()).await;
}

async fn get_telemetry(State(state): State<AppState>) -> Json<Telemetry> {
    let telemetry = state.telemetry.read().await.clone();
    Json(telemetry)
}

async fn get_health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "ok": true }))
}

async fn get_users(State(state): State<AppState>) -> Json<Vec<serde_json::Value>> {
    let users = state.users.read().await;
    let public: Vec<serde_json::Value> = users
        .iter()
        .map(|u| {
            serde_json::json!({
                "id": u.id,
                "role": u.role,
                "created": u.created
            })
        })
        .collect();
    Json(public)
}

async fn post_auth(
    State(state): State<AppState>,
    Json(body): Json<serde_json::Value>,
) -> (axum::http::StatusCode, Json<serde_json::Value>) {
    let id = body.get("id").and_then(|v| v.as_str()).unwrap_or("").trim();
    let pw = body.get("pw").and_then(|v| v.as_str()).unwrap_or("");

    let users = state.users.read().await;
    let match_user = users.iter().find(|u| {
        u.id.eq_ignore_ascii_case(id) && u.pw.as_deref().unwrap_or("") == pw
    });

    if let Some(u) = match_user {
        return (
            axum::http::StatusCode::OK,
            Json(serde_json::json!({
                "ok": true,
                "user": {
                    "id": u.id,
                    "role": u.role,
                    "created": u.created
                }
            })),
        );
    }

    (
        axum::http::StatusCode::UNAUTHORIZED,
        Json(serde_json::json!({ "ok": false, "error": "Invalid credentials" })),
    )
}

async fn post_users(
    State(state): State<AppState>,
    Json(body): Json<serde_json::Value>,
) -> (axum::http::StatusCode, Json<serde_json::Value>) {
    let admin_id = body.get("adminId").and_then(|v| v.as_str()).unwrap_or("").trim();
    let admin_pw = body.get("adminPw").and_then(|v| v.as_str()).unwrap_or("");
    let uid = body.get("id").and_then(|v| v.as_str()).unwrap_or("").trim();
    let pw = body.get("pw").and_then(|v| v.as_str()).unwrap_or("");
    let role = body.get("role").and_then(|v| v.as_str()).unwrap_or("guest").trim();
    let role = if role.is_empty() { "guest" } else { role };

    let mut users = state.users.read().await.clone();
    let admin = users.iter().find(|u| {
        u.id.eq_ignore_ascii_case(admin_id) && u.pw.as_deref().unwrap_or("") == admin_pw
    });

    if admin.is_none() || admin.unwrap().role != "admin" {
        return (
            axum::http::StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "ok": false, "error": "Admin required" })),
        );
    }

    if uid.len() < 3 {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": "Username required (≥3 chars)" })),
        );
    }

    if pw.len() < 6 {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": "Password must be ≥6 characters" })),
        );
    }

    if users.iter().any(|u| u.id.eq_ignore_ascii_case(uid)) {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": "Username already exists" })),
        );
    }

    let created = chrono::Utc::now().format("%Y-%m-%d").to_string();
    users.push(User {
        id: uid.to_string(),
        pw: Some(pw.to_string()),
        role: role.to_string(),
        created,
    });

    let mut users_guard = state.users.write().await;
    *users_guard = users;
    save_users(&state.users_file, &*users_guard).await;

    (
        axum::http::StatusCode::OK,
        Json(serde_json::json!({ "ok": true })),
    )
}

async fn post_users_delete(
    State(state): State<AppState>,
    Json(body): Json<serde_json::Value>,
) -> (axum::http::StatusCode, Json<serde_json::Value>) {
    let admin_id = body.get("adminId").and_then(|v| v.as_str()).unwrap_or("").trim();
    let admin_pw = body.get("adminPw").and_then(|v| v.as_str()).unwrap_or("");
    let target_id = body.get("id").and_then(|v| v.as_str()).unwrap_or("").trim();

    let mut users = state.users.read().await.clone();
    let admin = users.iter().find(|u| {
        u.id.eq_ignore_ascii_case(admin_id) && u.pw.as_deref().unwrap_or("") == admin_pw
    });

    if admin.is_none() || admin.unwrap().role != "admin" {
        return (
            axum::http::StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "ok": false, "error": "Admin required" })),
        );
    }

    if target_id.eq_ignore_ascii_case("flyboysam") {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": "Protected user" })),
        );
    }

    if target_id.eq_ignore_ascii_case(admin_id) {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": "Cannot remove your own account" })),
        );
    }

    users.retain(|u| !u.id.eq_ignore_ascii_case(target_id));

    let mut users_guard = state.users.write().await;
    *users_guard = users;
    save_users(&state.users_file, &*users_guard).await;

    (
        axum::http::StatusCode::OK,
        Json(serde_json::json!({ "ok": true })),
    )
}

#[tokio::main]
async fn main() {
    let script_dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let users_file = script_dir.join("users.json");
    let telem_file = std::env::var("TELEM_FILE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| script_dir.join("telem.txt"));

    let users = load_users(&users_file).await;
    if !users_file.exists() {
        save_users(&users_file, &users).await;
    }

    let state = AppState {
        telemetry: Arc::new(RwLock::new(Telemetry::default())),
        users: Arc::new(RwLock::new(users)),
        users_file: users_file.clone(),
        telem_file: telem_file.clone(),
    };

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers([header::CONTENT_TYPE]);

    let dashboard_root = script_dir
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| script_dir.clone());

    let api_routes = Router::new()
        .route("/telemetry", get(get_telemetry))
        .route("/health", get(get_health))
        .route("/users", get(get_users).post(post_users))
        .route("/users/delete", post(post_users_delete))
        .route("/auth", post(post_auth))
        .with_state(state.clone());

    let app = Router::new()
        .nest("/api", api_routes)
        .nest_service("/", ServeDir::new(&dashboard_root))
        .layer(cors);

    tokio::spawn(telemetry_reader_loop(state));

    let port = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(DEFAULT_PORT);

    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], port));
    println!(
        r#"
╔══════════════════════════════════════════════════════╗
║  CUBESAT-SIM  TELEMETRY API SERVER (Rust)            ║
║  Dashboard:    http://localhost:{}                   ║
║  API:          /api/telemetry, /api/auth, /api/users  ║
║  Telem file:   {:<38} ║
╚══════════════════════════════════════════════════════╝
"#,
        port,
        telem_file.display().to_string()
    );

    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("Failed to bind to port {}: {}", port, e);
            eprintln!("Port may be in use. Try: 1) Close other instances of this app");
            eprintln!("2) Set PORT=5051 (or another port) and run again");
            std::process::exit(1);
        }
    };
    axum::serve(listener, app).await.expect("serve");
}
