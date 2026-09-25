//! Background monitor loop: checks all monitored URLs on a fixed interval,
//! saves results, fires OS notifications on status changes, and emits a
//! `monitor-results` event so the frontend can re-render without user action.

use crate::engine;
use crate::{AppState, MonitoredUrl};
use serde_json::json;
use url::Url;
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

#[derive(Clone, serde::Serialize)]
struct MonitorResultsEvent<'a> {
    urls: &'a [MonitoredUrl],
    any_change: bool,
}

fn apply_round_results(
    urls: &mut [MonitoredUrl],
    results: &[engine::CheckResult],
) -> Vec<(String, bool)> {
    let mut changes = Vec::new();
    for result in results {
        let summary = crate::CheckResultSummary::from_check_result(result);
        let Some(entry) = urls.iter_mut().find(|entry| entry.url == result.url) else {
            continue;
        };
        if !crate::result_is_newer(entry.last_result.as_ref(), &summary) {
            continue;
        }
        let previous = entry
            .last_result
            .as_ref()
            .map(|previous| previous.reachable);
        entry.last_result = Some(summary);
        if let Some(previous) = previous {
            if previous != result.reachable {
                changes.push((result.url.clone(), result.reachable));
            }
        }
    }
    changes
}

async fn run_round(app: &tauri::AppHandle, state: &AppState) -> Result<bool, String> {
    let targets: Vec<String> = {
        let urls = state.urls.lock().unwrap();
        urls.iter().map(|url| url.url.clone()).collect()
    };
    if targets.is_empty() {
        return Ok(false);
    }

    let results = engine::check_urls(&targets).await;
    let mut current = state.urls.lock().unwrap();
    let mut candidate = current.clone();
    let changes = apply_round_results(&mut candidate, &results);
    crate::commit_urls(&mut current, candidate, |urls| crate::save_urls(app, urls))?;
    let persisted_urls = current.clone();
    drop(current);

    let any_change = !changes.is_empty();
    let _ = app.emit(
        "monitor-results",
        MonitorResultsEvent {
            urls: &persisted_urls,
            any_change,
        },
    );
    for (url, reachable) in changes {
        notify_status_change(app, &url, reachable);
        let _ = app.emit(
            "status-changed",
            json!({ "url": url, "reachable": reachable }),
        );
    }
    Ok(any_change)
}

fn notification_host(url: &str) -> String {
    Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(str::to_string))
        .unwrap_or_else(|| "site".to_string())
}

fn notify_status_change(app: &tauri::AppHandle, url: &str, up: bool) {
    use tauri_plugin_notification::NotificationExt;
    let host = notification_host(url);
    let title = if up {
        "Site is back UP ✓"
    } else {
        "Site is DOWN ✗"
    };
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

#[cfg(test)]
mod tests {
    use super::*;

    fn result(timestamp: &str, reachable: bool) -> engine::CheckResult {
        engine::CheckResult {
            url: "https://example.com/".to_string(),
            timestamp: timestamp.to_string(),
            reachable,
            status_code: Some(200),
            response_time_ms: Some(10),
            ssl: None,
            content: None,
            error: None,
        }
    }

    #[test]
    fn notification_omits_paths_and_query_strings() {
        assert_eq!(
            notification_host("https://example.com/private?token=secret"),
            "example.com"
        );
        assert_eq!(notification_host("not a URL"), "site");
    }

    #[test]
    fn stale_results_cannot_overwrite_a_newer_manual_result() {
        let mut urls = vec![MonitoredUrl {
            url: "https://example.com/".to_string(),
            last_result: Some(crate::CheckResultSummary {
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

        let changes = apply_round_results(&mut urls, &[result("2026-09-25T12:00:01Z", true)]);

        assert!(changes.is_empty());
        assert_eq!(
            urls[0]
                .last_result
                .as_ref()
                .and_then(|summary| summary.last_checked.as_deref()),
            Some("2026-09-25T12:00:02Z")
        );
        assert_eq!(urls[0].last_result.as_ref().unwrap().reachable, false);
    }

    #[test]
    fn monitor_event_uses_snake_case() {
        let urls = vec![MonitoredUrl {
            url: "https://example.com/".to_string(),
            last_result: None,
        }];
        let value = serde_json::to_value(MonitorResultsEvent {
            urls: &urls,
            any_change: true,
        })
        .unwrap();

        assert_eq!(value["any_change"], true);
        assert!(value.get("anyChange").is_none());
    }
}

// Silence unused-import warning for Mutex if unused elsewhere
#[allow(dead_code)]
fn _t(_: Mutex<u8>) {}
