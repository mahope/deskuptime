/// SSL certificate checker using native-tls + x509-parser
/// Connects via native-tls, then parses the peer certificate for validity info.

use crate::engine::SslResult;
use std::net::ToSocketAddrs;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use x509_parser::prelude::*;

/// Check SSL certificate validity for an HTTPS URL
pub async fn check_ssl(url: &str) -> Result<SslResult, String> {
    let parsed = url::Url::parse(url).map_err(|e| format!("Invalid URL: {}", e))?;
    let host = parsed
        .host_str()
        .ok_or_else(|| "No host in URL".to_string())?;
    let port = parsed.port().unwrap_or(443);

    // Use native-tls to connect and get peer certificate
    let connector = native_tls::TlsConnector::builder()
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|e| format!("TLS connector build failed: {}", e))?;

    let addr = (host, port);
    let stream = std::net::TcpStream::connect_timeout(
        &addr.to_socket_addrs()
            .map_err(|e| format!("DNS resolution failed: {}", e))?
            .next()
            .ok_or_else(|| "No address resolved".to_string())?,
        Duration::from_secs(10),
    )
        .map_err(|e| format!("TCP connect failed: {}", e))?;

    let tls_stream = connector
        .connect(host, stream)
        .map_err(|e| format!("TLS handshake failed: {}", e))?;

    let peer_cert = tls_stream
        .peer_certificate()
        .map_err(|_| "No peer certificate".to_string())?
        .ok_or_else(|| "Peer certificate is None".to_string())?;

    // Parse the DER-encoded certificate to extract validity and issuer info
    let der = peer_cert
        .to_der()
        .map_err(|e| format!("Failed to get DER: {}", e))?;

    let (_remainder, x509) =
        X509Certificate::from_der(&der).map_err(|e| format!("Failed to parse X509: {}", e))?;

    let now = SystemTime::now();
    let _not_before = x509.validity().not_before.timestamp();
    let not_after = x509.validity().not_after.timestamp();
    let now_secs = now
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    let valid_days = (not_after - now_secs) / 86400;
    let is_expired = not_after <= now_secs;
    let expires_soon = !is_expired && valid_days <= 30;

    // Extract issuer common name (CN)
    let issuer = x509
        .issuer()
        .iter_common_name()
        .next()
        .and_then(|cn| cn.as_str().ok())
        .map(|s| s.to_string())
        .or_else(|| {
            x509
                .issuer()
                .iter_organization()
                .next()
                .and_then(|o| o.as_str().ok())
                .map(|s| s.to_string())
        });

    Ok(SslResult {
        valid_days: Some(valid_days.max(0)),
        is_expired,
        expires_soon,
        issuer,
        cipher: None,
        protocol: None,
        error: None,
    })
}