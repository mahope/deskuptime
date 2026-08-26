//! Background monitor loop: checks all monitored URLs on a fixed interval,
//! saves results, fires OS notifications on status changes, and emits a
//! `monitor-results` event so the frontend can re-render without user action.

use crate::engine;
use crate::{AppState, MonitoredUrl};
use serde_json::json;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Emitter, Manager};

/// Persisted settings (currently just the check interval)
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MonitorSettings {
    /// Seconds between automatic check rounds (min 60)
    pub interval_secs: u64,
}

impl Default for MonitorSettings {
    fn default() -> Self {
        Self { interval_secs: 300 }
    }
}

pub fn load_settings(app: &tauri::AppHandle) -> MonitorSettings {
    let dir = app.path().app_data_dir().unwrap_or_default();
    std::fs::read_to_string(dir.join("monitor.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_settings(app: &tauri::AppHandle, s: &MonitorSettings) {
    if let Some(dir) = app.path().app_data_dir().ok() {
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(json) = serde_json::to_string_pretty(s) {
            let _ = std::fs::write(dir.join("monitor.json"), json);
        }
    }
}

/// Run one full round of checks over the currently stored URLs and persist
/// the summaries. Returns true if any status flipped vs. the previous result.
async fn run_round(
    app: &tauri::AppHandle,
    state: &AppState,
) -> bool {
    let urls: Vec<MonitoredUrl> = {
        let guard = state.urls.lock().unwrap();
        guard.clone()
    };
    if urls.is_empty() {
        return false;
    }

    let targets: Vec<String> = urls.iter().map(|u| u.url.clone()).collect();
    let results = engine::check_urls(&targets).await;

    let mut any_flip = false;
    for res in results {
        let summary = crate::CheckResultSummary {
            reachable: res.reachable,
            status_code: res.status_code,
            response_time: res.response_time_ms.map(|ms| format!("{}ms", ms)),
            ssl: res.ssl.as_ref().map(|_| true),
            ssl_days: res.ssl.as_ref().and_then(|s| s.valid_days),
            ssl_expiring: res.ssl.as_ref().map(|s| s.expires_soon).unwrap_or(false),
            last_checked: Some(chrono::Local::now().format("%H:%M:%S").to_string()),
            error: res.error.clone(),
        };

        // Detect flip against previous state
        let prev_reachable = {
            let mut guard = state.urls.lock().unwrap();
            if let Some(entry) = guard.iter_mut().find(|u| u.url == res.url) {
                let prev = entry.last_result.as_ref().map(|r| r.reachable);
                entry.last_result = Some(summary.clone());
                prev
            } else {
                None
            }
        };
        if let Some(prev) = prev_reachable {
            if prev != res.reachable {
                any_flip = true;
                notify_status_change(app, &res.url, res.reachable);
                let _ = app.emit(
                    "status-changed",
                    json!({ "url": res.url, "reachable": res.reachable }),
                );
            }
        }
    }

    // Persist everything once
    let final_urls: Vec<MonitoredUrl> = state.urls.lock().unwrap().clone();
    crate::save_urls_pub(app, &final_urls);
    let _ = app.emit(
        "monitor-results",
        json!({
            "urls": final_urls,
            "anyChange": any_flip,
        }),
    );
    any_flip
}

fn notify_status_change(app: &tauri::AppHandle, url: &str, up: bool) {
    use tauri_plugin_notification::NotificationExt;
    let host = url
        .split("://")
        .nth(1)
        .unwrap_or(url)
        .trim_end_matches('/');
    let title = if up { "Site is back UP ✓" } else { "Site is DOWN ✗" };
    let body = if up {
        format!("{} responded again.", host)
    } else {
        format!("{} did not respond.", host)
    };
    let _ = app.notification().builder().title(title).body(body).show();
}

/// Spawn the forever-running background loop at app startup.
pub fn spawn_monitor(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Wait briefly for initial UI load before first round
        tokio::time::sleep(Duration::from_secs(5)).await;
        loop {
            let interval = {
                let s = load_settings(&app);
                Duration::from_secs(s.interval_secs.max(60))
            };
            let _ = run_round(&app, &app.state::<AppState>()).await;
            tokio::time::sleep(interval).await;
        }
    });
}

// Silence unused-import warning for Mutex if unused elsewhere
#[allow(dead_code)]
fn _t(_: Mutex<u8>) {}
