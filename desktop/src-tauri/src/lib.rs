use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Manager, State};

mod engine;

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
    pub instance_id: Option<String>,
    pub product: Option<String>,
    pub email: Option<String>,
    pub activated_at: Option<String>,
}

/// Application state
pub struct AppState {
    pub urls: Mutex<Vec<MonitoredUrl>>,
    pub license: Mutex<LicenseState>,
}

/// Free tier: max monitored URLs without a Pro license
const FREE_URL_LIMIT: usize = 3;

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

#[tauri::command]
fn get_license_state(app: tauri::AppHandle) -> LicenseState {
    load_license(&app)
}

#[tauri::command]
fn get_free_limit() -> usize {
    FREE_URL_LIMIT
}

/// Activate a Lemon Squeezy license key for this machine
#[tauri::command]
async fn activate_license(
    license_key: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<LicenseState, String> {
    let machine = hostname();

    let client = reqwest::Client::new();
    let resp = client
        .post("https://api.lemonsqueezy.com/v1/licenses/activate")
        .form(&[
            ("license_key", license_key.as_str()),
            ("instance_name", machine.as_str()),
        ])
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    let status = resp.status();
    let data: serde_json::Value =
        resp.json().await.map_err(|e| format!("Bad response: {}", e))?;

    if !status.is_success() || data["activated"].as_bool() != Some(true) {
        let msg = data["error"]
            .as_str()
            .unwrap_or("License activation failed");
        return Err(msg.to_string());
    }

    let lic = LicenseState {
        license_key: Some(license_key),
        instance_id: data["instance"]["id"].as_str().map(String::from),
        product: data["meta"]["product_name"].as_str().map(String::from),
        email: data["meta"]["customer_email"].as_str().map(String::from),
        activated_at: Some(chrono::Utc::now().to_rfc3339()),
    };
    save_license(&app, &lic);
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
    if let (Some(key), Some(instance)) = (&lic.license_key, &lic.instance_id) {
        let key = key.clone();
        let instance = instance.clone();
        tauri::async_runtime::spawn(async move {
            let client = reqwest::Client::new();
            let _ = client
                .post("https://api.lemonsqueezy.com/v1/licenses/deactivate")
                .form(&[("license_key", key.as_str()), ("instance_id", instance.as_str())])
                .send()
                .await;
        });
    }
    Ok(())
}

// ─── Helpers ─────────────────────────────────────────────────────────

fn hostname() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "desktop".to_string())
}

fn is_licensed(app: &tauri::AppHandle) -> bool {
    load_license(app).license_key.is_some()
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
            get_license_state,
            get_free_limit,
            activate_license,
            deactivate_license,
        ])
        .setup(|app| {
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
