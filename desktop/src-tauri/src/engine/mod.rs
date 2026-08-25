use serde::{Deserialize, Serialize};

pub mod ping;
pub mod ssl;
pub mod content;

/// Result from a full URL check
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckResult {
    pub url: String,
    pub timestamp: String,
    pub reachable: bool,
    pub status_code: Option<u16>,
    pub response_time_ms: Option<u64>,
    pub ssl: Option<SslResult>,
    pub content: Option<ContentResult>,
    pub error: Option<String>,
}

/// SSL certificate check result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SslResult {
    pub valid_days: Option<i64>,
    pub is_expired: bool,
    pub expires_soon: bool,
    pub issuer: Option<String>,
    pub cipher: Option<String>,
    pub protocol: Option<String>,
    pub error: Option<String>,
}

/// Content change detection result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContentResult {
    pub fetched: bool,
    pub content_length: Option<usize>,
    pub hash: Option<String>,
    pub changed: Option<bool>,
    pub title: Option<String>,
    pub error: Option<String>,
}

/// Minimal status summary for the UI
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Summary {
    pub url: String,
    pub status: String,
    pub status_code: Option<u16>,
    pub response_time: Option<String>,
    pub ssl: Option<SslResult>,
    pub last_checked: String,
}

/// Check a single URL with all checks
pub async fn check_url(url: &str) -> CheckResult {
    let start = std::time::Instant::now();

    // 1. Reachability check
    let ping_result = ping::check_reachability(url).await;
    let elapsed = start.elapsed().as_millis() as u64;

    if let Err(ref err) = ping_result {
        return CheckResult {
            url: url.to_string(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            reachable: false,
            status_code: None,
            response_time_ms: Some(elapsed),
            ssl: None,
            content: None,
            error: Some(err.clone()),
        };
    }

    let (status_code, response_time) = ping_result.unwrap();

    // 2. SSL check (HTTPS only)
    let ssl_result = if url.starts_with("https://") {
        match ssl::check_ssl(url).await {
            Ok(s) => Some(s),
            Err(e) => Some(SslResult {
                valid_days: None,
                is_expired: false,
                expires_soon: false,
                issuer: None,
                cipher: None,
                protocol: None,
                error: Some(e),
            }),
        }
    } else {
        None
    };

    // 3. Content hash
    let content_result = match content::check_content(url).await {
        Ok(c) => Some(c),
        Err(e) => Some(ContentResult {
            fetched: false,
            content_length: None,
            hash: None,
            changed: None,
            title: None,
            error: Some(e),
        }),
    };

    let total_elapsed = start.elapsed().as_millis() as u64;

    CheckResult {
        url: url.to_string(),
        timestamp: chrono::Utc::now().to_rfc3339(),
        reachable: true,
        status_code: Some(status_code),
        response_time_ms: Some(response_time.max(total_elapsed)),
        ssl: ssl_result,
        content: content_result,
        error: None,
    }
}

/// Check multiple URLs in parallel
pub async fn check_urls(urls: &[String]) -> Vec<CheckResult> {
    let futures: Vec<_> = urls.iter().map(|url| check_url(url)).collect();
    futures::future::join_all(futures).await
}

/// Create a summary from a CheckResult
pub fn summarize(result: &CheckResult) -> Summary {
    let status = if result.reachable { "UP" } else { "DOWN" };
    Summary {
        url: result.url.clone(),
        status: status.to_string(),
        status_code: result.status_code,
        response_time: result.response_time_ms.map(|ms| format!("{}ms", ms)),
        ssl: result.ssl.clone(),
        last_checked: result.timestamp.clone(),
    }
}