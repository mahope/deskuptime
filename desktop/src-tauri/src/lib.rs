use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};
use url::Url;

mod engine;
mod monitor;

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

impl CheckResultSummary {
    pub(crate) fn from_check_result(result: &engine::CheckResult) -> Self {
        Self {
            reachable: result.reachable,
            status_code: result.status_code,
            response_time: result.response_time_ms.map(|ms| format!("{ms}ms")),
            ssl: result.ssl.as_ref().map(|_| true),
            ssl_days: result.ssl.as_ref().and_then(|ssl| ssl.valid_days),
            ssl_expiring: result
                .ssl
                .as_ref()
                .map(|ssl| ssl.expires_soon)
                .unwrap_or(false),
            last_checked: Some(result.timestamp.clone()),
            error: result.error.clone(),
        }
    }
}

pub(crate) fn result_is_newer(
    existing: Option<&CheckResultSummary>,
    incoming: &CheckResultSummary,
) -> bool {
    let Some(incoming_checked) = incoming
        .last_checked
        .as_deref()
        .and_then(|timestamp| chrono::DateTime::parse_from_rfc3339(timestamp).ok())
    else {
        return false;
    };
    match existing
        .and_then(|result| result.last_checked.as_deref())
        .and_then(|timestamp| chrono::DateTime::parse_from_rfc3339(timestamp).ok())
    {
        Some(existing_checked) => incoming_checked > existing_checked,
        None => true,
    }
}

pub(crate) fn apply_url_result(
    urls: &mut [MonitoredUrl],
    url: &str,
    result: CheckResultSummary,
) -> Result<CheckResultSummary, String> {
    let entry = urls
        .iter_mut()
        .find(|entry| entry.url == url)
        .ok_or_else(|| "URL is not monitored.".to_string())?;
    if let Some(existing) = entry.last_result.as_ref() {
        if !result_is_newer(Some(existing), &result) {
            return Ok(existing.clone());
        }
    }
    entry.last_result = Some(result.clone());
    Ok(result)
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

#[derive(Debug, Clone, Serialize)]
pub struct FrontendLicenseState {
    pub active: bool,
    pub product: Option<String>,
    pub email: Option<String>,
    pub activated_at: Option<String>,
    pub validated_at: Option<String>,
    pub invalid_reason: Option<String>,
}

impl FrontendLicenseState {
    fn from_state(state: &LicenseState) -> Self {
        Self {
            active: state.active,
            product: state.product.clone(),
            email: state.email.clone(),
            activated_at: state.activated_at.clone(),
            validated_at: state.validated_at.clone(),
            invalid_reason: state.invalid_reason.clone(),
        }
    }
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
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn save_urls(app: &tauri::AppHandle, urls: &[MonitoredUrl]) -> Result<(), String> {
    save_urls_to_path(&data_dir(app).join("urls.json"), urls)
}

fn save_urls_to_path(path: &Path, urls: &[MonitoredUrl]) -> Result<(), String> {
    let json = serde_json::to_string_pretty(urls)
        .map_err(|error| format!("Could not serialize monitored URLs: {error}"))?;
    std::fs::write(path, json).map_err(|error| format!("Could not save monitored URLs: {error}"))
}

pub(crate) fn commit_urls<F>(
    current: &mut Vec<MonitoredUrl>,
    candidate: Vec<MonitoredUrl>,
    persist: F,
) -> Result<(), String>
where
    F: FnOnce(&[MonitoredUrl]) -> Result<(), String>,
{
    persist(&candidate)?;
    *current = candidate;
    Ok(())
}

fn load_urls(app: &tauri::AppHandle) -> Vec<MonitoredUrl> {
    let loaded = load_urls_from_path(&data_dir(app).join("urls.json")).unwrap_or_default();
    normalize_monitored_urls(loaded)
}

fn load_urls_from_path(path: &Path) -> Result<Vec<MonitoredUrl>, String> {
    let json = std::fs::read_to_string(path)
        .map_err(|error| format!("Could not read monitored URLs: {error}"))?;
    serde_json::from_str(&json).map_err(|error| format!("Could not parse monitored URLs: {error}"))
}

fn normalize_monitored_urls(urls: Vec<MonitoredUrl>) -> Vec<MonitoredUrl> {
    let mut normalized = Vec::new();
    for mut entry in urls {
        let Ok(url) = canonicalize_http_url(&entry.url) else {
            continue;
        };
        entry.url = url;
        if !normalized
            .iter()
            .any(|item: &MonitoredUrl| item.url == entry.url)
        {
            normalized.push(entry);
        }
    }
    normalized
}

fn canonicalize_http_url(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() || trimmed.chars().any(|character| character.is_control()) {
        return Err("Invalid URL. Use an http:// or https:// address.".to_string());
    }
    let has_explicit_scheme = trimmed.split_once("://").is_some_and(|(scheme, _)| {
        !scheme.is_empty()
            && scheme
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || matches!(character, '+' | '-' | '.'))
    });
    let candidate = if has_explicit_scheme {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    let mut parsed = Url::parse(&candidate)
        .map_err(|_| "Invalid URL. Use an http:// or https:// address.".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Only http:// and https:// URLs are supported.".to_string());
    }
    if parsed.host_str().is_none_or(str::is_empty) {
        return Err("The URL must include a host name.".to_string());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("URLs containing credentials are not supported.".to_string());
    }
    parsed.set_fragment(None);
    Ok(parsed.to_string())
}

fn save_license(app: &tauri::AppHandle, lic: &LicenseState) -> Result<(), String> {
    let json = serde_json::to_string_pretty(lic)
        .map_err(|error| format!("Could not serialize license state: {error}"))?;
    std::fs::write(data_dir(app).join("license.json"), json)
        .map_err(|error| format!("Could not save license state: {error}"))
}

fn load_license(app: &tauri::AppHandle) -> LicenseState {
    std::fs::read_to_string(data_dir(app).join("license.json"))
        .ok()
        .and_then(|serialized| serde_json::from_str(&serialized).ok())
        .unwrap_or_default()
}

// ─── Commands ────────────────────────────────────────────────────────

#[tauri::command]
fn get_urls(app: tauri::AppHandle, state: State<AppState>) -> Vec<MonitoredUrl> {
    // Reload from disk so external edits survive restarts too
    let mut urls = state.urls.lock().unwrap();
    let loaded = load_urls(&app);
    *urls = loaded.clone();
    loaded
}

#[tauri::command]
fn add_url(url: String, app: tauri::AppHandle, state: State<AppState>) -> Result<String, String> {
    let canonical_url = canonicalize_http_url(&url)?;
    let licensed = is_licensed(&app);
    let mut urls = state.urls.lock().unwrap();
    if !licensed && urls.len() >= FREE_URL_LIMIT {
        return Err(format!(
            "Free version monitors up to {} URLs. Upgrade to Pro for unlimited monitoring.",
            FREE_URL_LIMIT
        ));
    }
    if urls.iter().any(|item| item.url == canonical_url) {
        return Err("URL already monitored".to_string());
    }
    let mut candidate = urls.clone();
    candidate.push(MonitoredUrl {
        url: canonical_url.clone(),
        last_result: None,
    });
    commit_urls(&mut urls, candidate, |urls| save_urls(&app, urls))?;
    Ok(canonical_url)
}

#[tauri::command]
fn remove_url(url: String, app: tauri::AppHandle, state: State<AppState>) -> Result<(), String> {
    let canonical_url = canonicalize_http_url(&url)?;
    let mut urls = state.urls.lock().unwrap();
    let mut candidate = urls.clone();
    candidate.retain(|item| item.url != canonical_url);
    commit_urls(&mut urls, candidate, |urls| save_urls(&app, urls))
}

#[tauri::command]
fn update_url_result(
    url: String,
    result: CheckResultSummary,
    app: tauri::AppHandle,
    state: State<AppState>,
) -> Result<CheckResultSummary, String> {
    let canonical_url = canonicalize_http_url(&url)?;
    let mut urls = state.urls.lock().unwrap();
    let mut candidate = urls.clone();
    let persisted = apply_url_result(&mut candidate, &canonical_url, result)?;
    commit_urls(&mut urls, candidate, |urls| save_urls(&app, urls))?;
    Ok(persisted)
}

#[tauri::command]
async fn check_url(url: String) -> Result<engine::CheckResult, String> {
    let canonical_url = canonicalize_http_url(&url)?;
    Ok(engine::check_url(&canonical_url).await)
}

#[tauri::command]
async fn check_all_urls(urls: Vec<String>) -> Result<Vec<engine::CheckResult>, String> {
    let canonical_urls = urls
        .iter()
        .map(|url| canonicalize_http_url(url))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(engine::check_urls(&canonical_urls).await)
}

/// Get the background monitor interval (seconds)
#[tauri::command]
fn get_monitor_interval(app: tauri::AppHandle) -> u64 {
    monitor::load_settings(&app).interval_secs.max(60)
}

/// Set the background monitor interval (seconds, min 60)
#[tauri::command]
fn set_monitor_interval(secs: u64, app: tauri::AppHandle) {
    let s = monitor::MonitorSettings {
        interval_secs: secs.max(60),
    };
    monitor::save_settings(&app, &s);
}

#[tauri::command]
fn get_license_state(app: tauri::AppHandle) -> FrontendLicenseState {
    let mut license = load_license(&app);
    license.active = license_active(&license);
    FrontendLicenseState::from_state(&license)
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
) -> Result<FrontendLicenseState, String> {
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
    save_license(&app, &lic)?;
    lic.active = license_active(&lic);
    *state.license.lock().unwrap() = lic.clone();
    Ok(FrontendLicenseState::from_state(&lic))
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
    if save_license(app, &lic).is_err() {
        return;
    }
    lic.active = license_active(&lic);
    if let Some(state) = app.try_state::<AppState>() {
        *state.license.lock().unwrap() = lic.clone();
    }
    let frontend_state = FrontendLicenseState::from_state(&lic);
    let _ = app.emit("license-changed", frontend_state);
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
            use tauri::menu::{MenuBuilder, MenuItemBuilder};
            use tauri::tray::TrayIconBuilder;

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

#[cfg(test)]
mod tests {
    use super::*;
    use engine::{CheckResult, SslResult};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn check_result(
        reachable: bool,
        status_code: Option<u16>,
        response_time_ms: Option<u64>,
        ssl: Option<SslResult>,
        error: Option<&str>,
    ) -> CheckResult {
        CheckResult {
            url: "https://example.com/".to_string(),
            timestamp: "2026-09-25T12:00:00Z".to_string(),
            reachable,
            status_code,
            response_time_ms,
            ssl,
            content: None,
            error: error.map(String::from),
        }
    }

    #[test]
    fn canonicalizes_only_http_urls() {
        assert_eq!(
            canonicalize_http_url("  HTTPS://Example.COM:443/a#fragment  ").unwrap(),
            "https://example.com/a"
        );
        assert_eq!(
            canonicalize_http_url("example.com:8443/status").unwrap(),
            "https://example.com:8443/status"
        );
        assert_eq!(
            canonicalize_http_url("example.com/?next=https://example.org").unwrap(),
            "https://example.com/?next=https://example.org"
        );
        assert!(canonicalize_http_url("ftp://example.com").is_err());
        assert!(canonicalize_http_url("javascript:alert(1)").is_err());
        assert!(canonicalize_http_url("https://").is_err());
        assert!(canonicalize_http_url("https://user:secret@example.com").is_err());
    }

    #[test]
    fn canonical_url_encodes_frontend_hostile_characters() {
        let canonical =
            canonicalize_http_url("https://example.com/\"<img src=x onerror=alert(1)>").unwrap();
        assert!(canonical.starts_with("https://example.com/"));
        assert!(!canonical.contains('"'));
        assert!(!canonical.contains('<'));
        assert!(!canonical.contains('>'));
    }

    #[test]
    fn frontend_license_state_never_serializes_secrets() {
        let license = LicenseState {
            license_key: Some("0123456789abcdef0123456789abcdef".to_string()),
            instance_id: Some("private-device-id".to_string()),
            product: Some("deskuptime-pro".to_string()),
            email: None,
            activated_at: Some("2026-09-25T12:00:00Z".to_string()),
            validated_at: Some("2026-09-25T12:00:00Z".to_string()),
            invalid_reason: None,
            active: true,
        };
        let dto = FrontendLicenseState::from_state(&license);
        let json = serde_json::to_string(&dto).unwrap();

        assert_eq!(dto.active, true);
        assert!(!json.contains("license_key"));
        assert!(!json.contains("instance_id"));
        assert!(!json.contains("0123456789abcdef0123456789abcdef"));
        assert!(!json.contains("private-device-id"));
    }

    #[test]
    fn check_result_summary_preserves_the_ipc_matrix() {
        let down = CheckResultSummary::from_check_result(&check_result(
            false,
            None,
            Some(17),
            None,
            Some("connection refused"),
        ));
        let down_json = serde_json::to_value(&down).unwrap();
        assert_eq!(down_json["reachable"], false);
        assert!(down_json["status_code"].is_null());
        assert_eq!(down_json["response_time"], "17ms");
        assert!(down_json["ssl"].is_null());
        assert!(down_json["ssl_days"].is_null());
        assert_eq!(down_json["ssl_expiring"], false);
        assert_eq!(down_json["last_checked"], "2026-09-25T12:00:00Z");
        assert_eq!(down_json["error"], "connection refused");

        let up = CheckResultSummary::from_check_result(&check_result(
            true,
            Some(204),
            None,
            Some(SslResult {
                valid_days: Some(42),
                is_expired: false,
                expires_soon: true,
                issuer: None,
                cipher: None,
                protocol: None,
                error: None,
            }),
            None,
        ));
        let up_json = serde_json::to_value(&up).unwrap();
        assert_eq!(up_json["reachable"], true);
        assert_eq!(up_json["status_code"], 204);
        assert!(up_json["response_time"].is_null());
        assert_eq!(up_json["ssl"], true);
        assert_eq!(up_json["ssl_days"], 42);
        assert_eq!(up_json["ssl_expiring"], true);
    }

    #[test]
    fn delayed_manual_result_cannot_replace_a_newer_result() {
        let mut urls = vec![MonitoredUrl {
            url: "https://example.com/".to_string(),
            last_result: Some(CheckResultSummary {
                reachable: false,
                status_code: Some(200),
                response_time: Some("10ms".to_string()),
                ssl: None,
                ssl_days: None,
                ssl_expiring: false,
                last_checked: Some("2026-09-25T12:00:02Z".to_string()),
                error: None,
            }),
        }];
        let delayed = CheckResultSummary::from_check_result(&check_result(
            true,
            Some(200),
            Some(9),
            None,
            None,
        ));

        let persisted = apply_url_result(&mut urls, "https://example.com/", delayed).unwrap();

        assert_eq!(persisted.reachable, false);
        assert_eq!(urls[0].last_result.as_ref().unwrap().reachable, false);
        assert_eq!(
            urls[0]
                .last_result
                .as_ref()
                .and_then(|result| result.last_checked.as_deref()),
            Some("2026-09-25T12:00:02Z")
        );
    }

    #[test]
    fn failed_persistence_does_not_publish_candidate_state() {
        let mut current = vec![MonitoredUrl {
            url: "https://example.com/".to_string(),
            last_result: None,
        }];
        let candidate = vec![MonitoredUrl {
            url: "https://example.com/new".to_string(),
            last_result: None,
        }];

        let error = commit_urls(&mut current, candidate, |_| Err("disk full".to_string()))
            .expect_err("persistence should fail");

        assert_eq!(error, "disk full");
        assert_eq!(current.len(), 1);
        assert_eq!(current[0].url, "https://example.com/");
    }

    #[test]
    fn url_state_survives_a_persistence_round_trip() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "deskuptime-url-state-{}-{unique}.json",
            std::process::id()
        ));
        let urls = vec![MonitoredUrl {
            url: "https://example.com/health".to_string(),
            last_result: Some(CheckResultSummary {
                reachable: true,
                status_code: Some(200),
                response_time: Some("8ms".to_string()),
                ssl: Some(true),
                ssl_days: Some(90),
                ssl_expiring: false,
                last_checked: Some("12:00:00".to_string()),
                error: None,
            }),
        }];

        save_urls_to_path(&path, &urls).unwrap();
        let loaded = load_urls_from_path(&path).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].url, urls[0].url);
        assert_eq!(
            loaded[0]
                .last_result
                .as_ref()
                .unwrap()
                .response_time
                .as_deref(),
            Some("8ms")
        );
        let unavailable_path = path.with_file_name("missing-parent").join("urls.json");
        assert!(save_urls_to_path(&unavailable_path, &urls).is_err());
        let _ = std::fs::remove_file(path);
    }
}
