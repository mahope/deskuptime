use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};

mod engine;
mod monitor;

/// Public wrapper so the background monitor can persist URL state
pub fn save_urls_pub(app: &tauri::AppHandle, urls: &[MonitoredUrl]) {
    save_urls(app, urls);
}

/// A monitored URL with its last check result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MonitoredUrl {
    pub url: String,
    pub last_result: Option<CheckResultSummary>,
}

/// Summary stored between checks (lightweight, no full cert data)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckResultSummary {
    pub reachable: bool,
    pub status_code: Option<u16>,
    pub response_time: Option<String>,
    pub ssl: Option<bool>,
    pub ssl_days: Option<i64>,
    pub ssl_expiring: bool,
    pub last_checked: Option<String>,
    pub error: Option<String>,
}

/// Persisted license state
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LicenseState {
    pub license_key: Option<String>,
    /// Device id the key was activated with (sent as `device_id` to the license server)
    pub instance_id: Option<String>,
    /// Plan reported by the license server
    pub product: Option<String>,
    pub email: Option<String>,
    pub activated_at: Option<String>,
    /// Last time the license server confirmed the key (RFC 3339)
    #[serde(default)]
    pub validated_at: Option<String>,
    /// Set when the server definitively rejected the key (revoked/expired/unknown)
    #[serde(default)]
    pub invalid_reason: Option<String>,
    /// Computed when handed to the frontend: is Pro currently unlocked
    #[serde(default)]
    pub active: bool,
}

/// Application state
pub struct AppState {
    pub urls: Mutex<Vec<MonitoredUrl>>,
    pub license: Mutex<LicenseState>,
}

/// Free tier: max monitored URLs without a Pro license
const FREE_URL_LIMIT: usize = 3;

/// Mahope license server (licenses are sold via Stripe)
const LICENSE_API_BASE: &str = "https://mahope.tools/api/license";
const PRODUCT_KEY: &str = "deskuptime-pro";
/// Keep a cached Pro status this long when the license server is unreachable
const OFFLINE_GRACE_SECS: i64 = 7 * 24 * 60 * 60;
/// How often the running app re-validates the license
const LICENSE_RECHECK_SECS: u64 = 12 * 60 * 60;

// ─── Persistence helpers ─────────────────────────────────────────────

fn data_dir(app: &tauri::AppHandle) -> PathBuf {
    let dir = app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from("."));
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn save_urls(app: &tauri::AppHandle, urls: &[MonitoredUrl]) {
    if let Ok(json) = serde_json::to_string_pretty(urls) {
        let _ = std::fs::write(data_dir(app).join("urls.json"), json);
    }
}

fn load_urls(app: &tauri::AppHandle) -> Vec<MonitoredUrl> {
    std::fs::read_to_string(data_dir(app).join("urls.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_license(app: &tauri::AppHandle, lic: &LicenseState) {
    if let Ok(json) = serde_json::to_string_pretty(lic) {
        let _ = std::fs::write(data_dir(app).join("license.json"), json);
    }
}

fn load_license(app: &tauri::AppHandle) -> LicenseState {
    std::fs::read_to_string(data_dir(app).join("license.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

// ─── Commands ────────────────────────────────────────────────────────

#[tauri::command]
fn get_urls(app: tauri::AppHandle, state: State<AppState>) -> Vec<MonitoredUrl> {
    // Reload from disk so external edits survive restarts too
    let loaded = load_urls(&app);
    *state.urls.lock().unwrap() = loaded.clone();
    loaded
}

#[tauri::command]
fn add_url(
    url: String,
    app: tauri::AppHandle,
    state: State<AppState>,
) -> Result<(), String> {
    let licensed = is_licensed(&app);
    let mut urls = state.urls.lock().unwrap();
    if !licensed && urls.len() >= FREE_URL_LIMIT {
        return Err(format!(
            "Free version monitors up to {} URLs. Upgrade to Pro for unlimited monitoring.",
            FREE_URL_LIMIT
        ));
    }
    if urls.iter().any(|u| u.url == url) {
        return Err("URL already monitored".to_string());
    }
    urls.push(MonitoredUrl { url, last_result: None });
    save_urls(&app, &urls);
    Ok(())
}

#[tauri::command]
fn remove_url(url: String, app: tauri::AppHandle, state: State<AppState>) {
    let mut urls = state.urls.lock().unwrap();
    urls.retain(|u| u.url != url);
    save_urls(&app, &urls);
}

#[tauri::command]
fn update_url_result(url: String, result: CheckResultSummary, app: tauri::AppHandle, state: State<AppState>) {
    let mut urls = state.urls.lock().unwrap();
    if let Some(entry) = urls.iter_mut().find(|u| u.url == url) {
        entry.last_result = Some(result);
    }
    save_urls(&app, &urls);
}

#[tauri::command]
async fn check_url(url: String) -> Result<engine::CheckResult, String> {
    Ok(engine::check_url(&url).await)
}

#[tauri::command]
async fn check_all_urls(urls: Vec<String>) -> Vec<engine::CheckResult> {
    engine::check_urls(&urls).await
}

/// Get the background monitor interval (seconds)
#[tauri::command]
fn get_monitor_interval(app: tauri::AppHandle) -> u64 {
    monitor::load_settings(&app).interval_secs.max(60)
}

/// Set the background monitor interval (seconds, min 60)
#[tauri::command]
fn set_monitor_interval(secs: u64, app: tauri::AppHandle) {
    let s = monitor::MonitorSettings { interval_secs: secs.max(60) };
    monitor::save_settings(&app, &s);
}

#[tauri::command]
fn get_license_state(app: tauri::AppHandle) -> LicenseState {
    let mut lic = load_license(&app);
    lic.active = license_active(&lic);
    lic
}

#[tauri::command]
fn get_free_limit() -> usize {
    FREE_URL_LIMIT
}

/// Activate a license key for this machine against the Mahope license server
#[tauri::command]
async fn activate_license(
    license_key: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<LicenseState, String> {
    let key = license_key.trim().to_lowercase();
    if key.len() != 32 || !key.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("Invalid license key format (expected 32 hex characters)".to_string());
    }
    let device = device_id();

    let data = match post_license(
        "activate",
        serde_json::json!({ "license_key": key, "device_id": device, "product": PRODUCT_KEY }),
    )
    .await
    {
        LicenseReply::Ok(data) => data,
        LicenseReply::Rejected(msg) | LicenseReply::Transient(msg) => return Err(msg),
    };
    if data["activated"].as_bool() != Some(true) {
        return Err("License activation failed".to_string());
    }

    let now = chrono::Utc::now().to_rfc3339();
    let mut lic = LicenseState {
        license_key: Some(key),
        instance_id: Some(device),
        product: data["plan"].as_str().map(String::from),
        email: None,
        activated_at: Some(now.clone()),
        validated_at: Some(now),
        invalid_reason: None,
        active: false,
    };
    save_license(&app, &lic);
    lic.active = license_active(&lic);
    *state.license.lock().unwrap() = lic.clone();
    Ok(lic)
}

/// Remove activation from this machine
#[tauri::command]
fn deactivate_license(app: tauri::AppHandle, state: State<AppState>) -> Result<(), String> {
    let lic = load_license(&app);
    let _ = std::fs::remove_file(data_dir(&app).join("license.json"));
    *state.license.lock().unwrap() = LicenseState::default();
    // Best-effort remote deactivation so the seat is freed (spawned async, fire-and-forget)
    if let Some(key) = lic.license_key {
        let device = lic.instance_id.unwrap_or_else(device_id);
        tauri::async_runtime::spawn(async move {
            let _ = post_license(
                "deactivate",
                serde_json::json!({ "license_key": key, "device_id": device }),
            )
            .await;
        });
    }
    Ok(())
}

// ─── License server ──────────────────────────────────────────────────

enum LicenseReply {
    /// 200 with `ok: true`
    Ok(serde_json::Value),
    /// Definitive answer: bad format, unknown, revoked/expired, device limit
    Rejected(String),
    /// Network error or 5xx: no verdict, keep the cached status
    Transient(String),
}

async fn post_license(endpoint: &str, body: serde_json::Value) -> LicenseReply {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
    {
        Ok(c) => c,
        Err(e) => return LicenseReply::Transient(format!("Network error: {}", e)),
    };
    let resp = match client
        .post(format!("{}/{}", LICENSE_API_BASE, endpoint))
        .json(&body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return LicenseReply::Transient(format!("Network error: {}", e)),
    };
    let status = resp.status();
    let data: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
    if status.is_success() && data["ok"].as_bool() == Some(true) {
        return LicenseReply::Ok(data);
    }
    let msg = data["error"]
        .as_str()
        .or_else(|| data["message"].as_str())
        .map(String::from)
        .unwrap_or_else(|| match status.as_u16() {
            400 => "Invalid license key format".to_string(),
            403 => "License key is expired, revoked or for another product".to_string(),
            404 => "Unknown license key".to_string(),
            409 => "Device limit reached - deactivate another machine first".to_string(),
            code => format!("License server error (HTTP {})", code),
        });
    if status.is_server_error() {
        LicenseReply::Transient(msg)
    } else {
        LicenseReply::Rejected(msg)
    }
}

/// Re-validate the stored key. Transient failures leave the cached state untouched,
/// so Pro stays unlocked for OFFLINE_GRACE_SECS after the last successful check.
async fn refresh_license(app: &tauri::AppHandle) {
    let mut lic = load_license(app);
    let Some(key) = lic.license_key.clone() else {
        return;
    };
    let device = lic.instance_id.clone().unwrap_or_else(device_id);
    match post_license(
        "validate",
        serde_json::json!({ "license_key": key, "device_id": device, "product": PRODUCT_KEY }),
    )
    .await
    {
        LicenseReply::Ok(data) if data["valid"].as_bool() == Some(true) => {
            lic.validated_at = Some(chrono::Utc::now().to_rfc3339());
            lic.invalid_reason = None;
            if let Some(plan) = data["plan"].as_str() {
                lic.product = Some(plan.to_string());
            }
        }
        LicenseReply::Ok(data) => {
            lic.invalid_reason = Some(
                data["reason"]
                    .as_str()
                    .unwrap_or("License is no longer valid")
                    .to_string(),
            );
        }
        LicenseReply::Rejected(msg) => lic.invalid_reason = Some(msg),
        LicenseReply::Transient(_) => return,
    }
    save_license(app, &lic);
    lic.active = license_active(&lic);
    if let Some(state) = app.try_state::<AppState>() {
        *state.license.lock().unwrap() = lic.clone();
    }
    let _ = app.emit("license-changed", &lic);
}

// ─── Helpers ─────────────────────────────────────────────────────────

fn hostname() -> String {
    #[cfg(not(windows))]
    {
        if let Ok(out) = std::process::Command::new("hostname").output() {
            let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !name.is_empty() {
                return name;
            }
        }
    }
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "desktop".to_string())
}

/// Stable per-machine id, same scheme as the CLI (`deskuptime-<hostname>`), so the
/// CLI and the desktop app on one machine share a single activation seat.
fn device_id() -> String {
    format!("deskuptime-{}", hostname().trim().to_lowercase())
        .chars()
        .take(128)
        .collect()
}

/// Pro is unlocked when the server confirmed the key within the offline grace
/// period and has not definitively rejected it since.
fn license_active(lic: &LicenseState) -> bool {
    if lic.license_key.is_none() || lic.invalid_reason.is_some() {
        return false;
    }
    lic.validated_at
        .as_deref()
        .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
        .map(|t| {
            (chrono::Utc::now() - t.with_timezone(&chrono::Utc)).num_seconds() < OFFLINE_GRACE_SECS
        })
        .unwrap_or(false)
}

fn is_licensed(app: &tauri::AppHandle) -> bool {
    license_active(&load_license(app))
}

// ─── App entry ───────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            get_urls,
            add_url,
            remove_url,
            update_url_result,
            check_url,
            check_all_urls,
            get_monitor_interval,
            set_monitor_interval,
            get_license_state,
            get_free_limit,
            activate_license,
            deactivate_license,
        ])
        .setup(|app| {
            let state = AppState {
                urls: Mutex::new(load_urls(app.handle())),
                license: Mutex::new(load_license(app.handle())),
            };
            app.manage(state);
            monitor::spawn_monitor(app.handle().clone());
            let license_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    refresh_license(&license_handle).await;
                    tokio::time::sleep(std::time::Duration::from_secs(LICENSE_RECHECK_SECS)).await;
                }
            });
            use tauri::tray::TrayIconBuilder;
            use tauri::menu::{MenuBuilder, MenuItemBuilder};

            let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
            let show = MenuItemBuilder::with_id("show", "Show Window").build(app)?;

            let menu = MenuBuilder::new(app)
                .item(&show)
                .separator()
                .item(&quit)
                .build()?;

            let _tray = TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("DeskUptime")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => {
                        app.exit(0);
                    }
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
