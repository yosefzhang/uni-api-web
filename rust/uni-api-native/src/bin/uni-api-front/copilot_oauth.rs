use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tokio::sync::Mutex;

const DEFAULT_TOKEN_URL: &str = "https://api.github.com/copilot_internal/v2/token";
const DEFAULT_TOKEN_TTL_SECONDS: u64 = 30 * 60;
const EXPIRY_SKEW_SECONDS: u64 = 60;

// Identity headers mirror the official Copilot Chat client (same values the
// token endpoint checks for VS Code sessions). Overridable via env for tests.
const COPILOT_USER_AGENT: &str = "GitHubCopilotChat/0.38.0";
const COPILOT_EDITOR_VERSION: &str = "vscode/1.110.0";
const COPILOT_EDITOR_PLUGIN_VERSION: &str = "copilot-chat/0.38.0";
const COPILOT_API_VERSION: &str = "2025-04-01";

#[derive(Clone)]
pub struct CopilotTokenManager {
    cache: Arc<Mutex<HashMap<String, CachedCopilotToken>>>,
    locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
    token_url: Arc<str>,
}

#[derive(Clone)]
struct CachedCopilotToken {
    token: String,
    expires_at: Option<u64>,
}

pub struct CopilotAuth {
    pub token: String,
}

impl CopilotTokenManager {
    pub fn new() -> Self {
        Self {
            cache: Arc::new(Mutex::new(HashMap::new())),
            locks: Arc::new(Mutex::new(HashMap::new())),
            token_url: std::env::var("COPILOT_TOKEN_URL")
                .unwrap_or_else(|_| DEFAULT_TOKEN_URL.into())
                .into(),
        }
    }

    /// Exchange a GitHub PAT for a short-lived Copilot token, reusing a cached
    /// token while it is valid. The PAT itself is the durable credential, so
    /// unlike Codex OAuth there is no refresh-token rotation to persist.
    pub async fn resolve(&self, pat: &str, proxy: Option<&str>) -> Result<CopilotAuth, String> {
        let pat = pat.trim();
        let lock = {
            let mut locks = self.locks.lock().await;
            locks
                .entry(pat.to_owned())
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };
        let _guard = lock.lock().await;
        if let Some(token) = self.cache.lock().await.get(pat) {
            if token_is_valid(token) {
                return Ok(CopilotAuth {
                    token: token.token.clone(),
                });
            }
        }
        let mut builder = reqwest::Client::builder().http1_only();
        if let Some(proxy) = proxy.filter(|value| !value.trim().is_empty()) {
            builder = builder.proxy(
                reqwest::Proxy::all(proxy)
                    .map_err(|error| format!("invalid Copilot proxy: {error}"))?,
            );
        }
        let client = builder
            .build()
            .map_err(|error| format!("build Copilot token client: {error}"))?;
        let response = client
            .get(self.token_url.as_ref())
            .header("authorization", format!("token {pat}"))
            .header("user-agent", COPILOT_USER_AGENT)
            .header("editor-version", COPILOT_EDITOR_VERSION)
            .header("editor-plugin-version", COPILOT_EDITOR_PLUGIN_VERSION)
            .header("accept", "application/json")
            .header("x-github-api-version", COPILOT_API_VERSION)
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|error| format!("Copilot token exchange request failed: {error}"))?;
        let status = response.status();
        let body = response
            .bytes()
            .await
            .map_err(|error| format!("read Copilot token exchange response failed: {error}"))?;
        if !status.is_success() {
            return Err(format!(
                "Copilot token exchange failed: status {}: {}",
                status.as_u16(),
                String::from_utf8_lossy(&body)
            ));
        }
        let payload: Value = serde_json::from_slice(&body)
            .map_err(|error| format!("decode Copilot token exchange response failed: {error}"))?;
        let token = payload
            .get("token")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|token| !token.is_empty())
            .ok_or_else(|| "Copilot token exchange returned empty token".to_owned())?
            .to_owned();
        let expires_at = payload
            .get("expires_at")
            .and_then(|value| {
                value
                    .as_u64()
                    .or_else(|| value.as_str().and_then(|value| value.parse().ok()))
            })
            .or_else(|| Some(unix_seconds().saturating_add(DEFAULT_TOKEN_TTL_SECONDS)));
        self.cache.lock().await.insert(
            pat.to_owned(),
            CachedCopilotToken {
                token: token.clone(),
                expires_at,
            },
        );
        Ok(CopilotAuth { token })
    }

    /// Drop the cached token for a PAT so the next attempt re-exchanges it.
    /// Called when the upstream answers 401-403 with a token that went stale.
    pub async fn clear(&self, pat: &str) {
        self.cache.lock().await.remove(pat.trim());
    }
}

fn token_is_valid(token: &CachedCopilotToken) -> bool {
    token
        .expires_at
        .is_none_or(|expires_at| unix_seconds() < expires_at.saturating_sub(EXPIRY_SKEW_SECONDS))
}

fn unix_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cached(expires_at: Option<u64>) -> CachedCopilotToken {
        CachedCopilotToken {
            token: "fixture".into(),
            expires_at,
        }
    }

    #[test]
    fn token_without_expiry_is_always_valid() {
        assert!(token_is_valid(&cached(None)));
    }

    #[test]
    fn token_is_valid_until_skew_before_expiry() {
        let now = unix_seconds();
        assert!(token_is_valid(&cached(Some(now + 120))));
        assert!(!token_is_valid(&cached(Some(now + 30))));
        assert!(!token_is_valid(&cached(Some(now.saturating_sub(1)))));
    }
}
