use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::State;
use tauri::Manager;

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

/// Application state
pub struct AppState {
    pub urls: Mutex<Vec<MonitoredUrl>>,
}

// ─── Commands ────────────────────────────────────────────────────────

#[tauri::command]
fn get_urls(state: State<AppState>) -> Vec<MonitoredUrl> {
    state.urls.lock().unwrap().clone()
}

#[tauri::command]
fn add_url(url: String, state: State<AppState>) -> Result<(), String> {
    let mut urls = state.urls.lock().unwrap();
    if urls.iter().any(|u| u.url == url) {
        return Err("URL already monitored".to_string());
    }
    urls.push(MonitoredUrl {
        url,
        last_result: None,
    });
    Ok(())
}

#[tauri::command]
fn remove_url(url: String, state: State<AppState>) {
    let mut urls = state.urls.lock().unwrap();
    urls.retain(|u| u.url != url);
}

#[tauri::command]
fn update_url_result(url: String, result: CheckResultSummary, state: State<AppState>) {
    let mut urls = state.urls.lock().unwrap();
    if let Some(entry) = urls.iter_mut().find(|u| u.url == url) {
        entry.last_result = Some(result);
    }
}

#[tauri::command]
async fn check_url(url: String) -> Result<engine::CheckResult, String> {
    Ok(engine::check_url(&url).await)
}

#[tauri::command]
async fn check_all_urls(urls: Vec<String>) -> Vec<engine::CheckResult> {
    engine::check_urls(&urls).await
}

// ─── App entry ───────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .manage(AppState {
            urls: Mutex::new(Vec::new()),
        })
        .invoke_handler(tauri::generate_handler![
            get_urls,
            add_url,
            remove_url,
            update_url_result,
            check_url,
            check_all_urls,
        ])
        .setup(|app| {
            // Optional: set up system tray
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