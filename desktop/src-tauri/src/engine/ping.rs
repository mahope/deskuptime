/// HTTP/HTTPS reachability checker using reqwest
use reqwest::Client;
use std::time::Instant;

/// Check if a URL is reachable, returns (status_code, response_time_ms) on success
pub async fn check_reachability(url: &str) -> Result<(u16, u64), String> {
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("Deskuptime/0.1 (monitor; +https://github.com/mahope/deskuptime)")
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| format!("Failed to build client: {}", e))?;

    let start = Instant::now();

    // Try HEAD first
    match client.head(url).send().await {
        Ok(resp) => {
            let elapsed = start.elapsed().as_millis() as u64;
            Ok((resp.status().as_u16(), elapsed))
        }
        Err(_) => {
            // Fallback to GET
            let get_start = Instant::now();
            match client.get(url).send().await {
                Ok(resp) => {
                    let elapsed = get_start.elapsed().as_millis() as u64;
                    Ok((resp.status().as_u16(), elapsed))
                }
                Err(e) => Err(format!("GET fallback failed: {}", e)),
            }
        }
    }
}