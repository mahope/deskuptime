/// Content change detector using reqwest + SHA-256

use crate::engine::ContentResult;
use sha2::{Digest, Sha256};

/// Fetch a URL's HTML, compute content hash and extract title
pub async fn check_content(url: &str) -> Result<ContentResult, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .user_agent("Deskuptime/0.1 (monitor; +https://github.com/mahope/deskuptime)")
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| format!("Client build failed: {}", e))?;

    let resp = client
        .get(url)
        .header("Accept", "text/html,application/xhtml+xml")
        .send()
        .await
        .map_err(|e| format!("Fetch failed: {}", e))?;

    if !resp.status().is_success() {
        return Ok(ContentResult {
            fetched: false,
            content_length: None,
            hash: None,
            changed: None,
            title: None,
            error: Some(format!("HTTP {}", resp.status().as_u16())),
        });
    }

    let html = resp.text().await.map_err(|e| format!("Read body failed: {}", e))?;
    let content_length = html.len();

    // Compute SHA-256 hash
    let mut hasher = Sha256::new();
    hasher.update(html.as_bytes());
    let hash = hex::encode(hasher.finalize());

    // Extract <title>
    let title = html
        .to_lowercase()
        .split("<title>")
        .nth(1)
        .and_then(|s| s.split("</title>").next())
        .map(|s| s.trim().to_string());

    Ok(ContentResult {
        fetched: true,
        content_length: Some(content_length),
        hash: Some(hash),
        changed: None, // Caller provides previous hash for comparison
        title,
        error: None,
    })
}