// uni-api status backend, merged from melosbot/uni-api-status (Next.js API
// routes) into the Rust front process.  Every handler keeps the original
// request/response contract so the exported static UI works unchanged.
//
// Upstream-merge note: this file and the `webui/` directory are additive
// only.  main.rs hooks in via `status::maybe_merge`, which no-ops when the
// bundled UI is absent so the binary behaves exactly like upstream.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use axum::extract::{Path as UrlPath, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde_json::{json, Map, Value};

#[derive(Clone)]
pub struct StatusState {
    pub config_path: PathBuf,
    pub ui_root: PathBuf,
    /// Loopback absolute base used when the browser sends a same-origin
    /// relative path back to the gateway (e.g. "/v1").
    pub internal_base: String,
    pub http: reqwest::Client,
    pub stats_db: PathBuf,
    pub stats_enabled: bool,
    pub model_context_path: PathBuf,
}

/// Merge the status surface into the public router when enabled.  Enabled by
/// default; disabled with `UNI_API_STATUS=0` or when the exported UI folder
/// (`UNI_API_STATUS_UI`, default `./status`) is missing.
pub fn maybe_merge(app: Router) -> Router {
    if std::env::var("UNI_API_STATUS")
        .map(|value| value == "0")
        .unwrap_or(false)
    {
        return app;
    }
    let config_path = PathBuf::from(
        std::env::var("UNI_API_CONFIG_PATH").unwrap_or_else(|_| "api.yaml".to_owned()),
    );
    let ui_root =
        PathBuf::from(std::env::var("UNI_API_STATUS_UI").unwrap_or_else(|_| "./status".to_owned()));
    if !ui_root.is_dir() {
        return app;
    }
    let internal_base = format!(
        "http://127.0.0.1:{}",
        std::env::var("PORT").unwrap_or_else(|_| "8000".to_owned())
    );
    let database_disabled = matches!(
        std::env::var("DISABLE_DATABASE").as_deref(),
        Ok("1") | Ok("true") | Ok("TRUE") | Ok("yes")
    );
    let stats_backend = std::env::var("DB_TYPE")
        .unwrap_or_else(|_| "sqlite".into())
        .trim()
        .to_ascii_lowercase();
    if stats_backend != "sqlite" {
        eprintln!(
            "{}",
            json!({"kind": "log", "event": "status_stats_backend_unsupported", "backend": stats_backend})
        );
    }
    let stats_db =
        PathBuf::from(std::env::var("DB_PATH").unwrap_or_else(|_| "./data/stats.db".into()));
    let model_context_path = PathBuf::from(
        std::env::var("UNI_API_MODEL_CONTEXT_PATH")
            .unwrap_or_else(|_| "uni_api/api/model_context_windows.json".to_owned()),
    );
    let state = StatusState {
        config_path: config_path.canonicalize().unwrap_or(config_path),
        ui_root: ui_root.canonicalize().unwrap_or(ui_root),
        internal_base,
        http: reqwest::Client::builder()
            .user_agent("uni-api-status/merged")
            .build()
            .unwrap_or_default(),
        stats_db,
        stats_enabled: stats_backend == "sqlite" && !database_disabled,
        model_context_path,
    };
    let status = router(state);
    app.merge(status)
}

fn router(state: StatusState) -> Router {
    Router::new()
        .route("/api/auth/validate-key", post(validate_key))
        .route("/api/auth/available-keys", post(available_keys))
        .route("/api/config/load", get(load_config))
        .route("/api/config/save", post(save_config))
        .route("/api/model-context/load", get(load_model_context))
        .route("/api/model-context/save", post(save_model_context))
        .route("/api/filters", get(filters))
        .route("/api/logs", get(logs))
        .route("/api/stats/overview", get(stats_overview))
        .route("/api/stats/models", get(stats_models))
        .route("/api/stats/channels", get(stats_channels))
        .route("/api/providers/list", get(providers_list))
        .route("/api/providers/models", post(provider_models))
        .route("/api/providers/test-real", post(provider_test_real))
        .route("/api/empty", get(|| async { (StatusCode::OK, "") }))
        .route("/", get(serve_ui))
        .route("/index.html", get(serve_ui))
        .route("/_next/{*asset}", get(serve_next_asset))
        .with_state(state)
}

// ---------------------------------------------------------------------------
// api.yaml helpers
// ---------------------------------------------------------------------------

fn json_error(status: StatusCode, body: Value) -> Response {
    (status, Json(body)).into_response()
}

fn internal_error(context: &str, error: &dyn std::fmt::Display) -> Response {
    eprintln!(
        "{}",
        json!({"kind": "log", "event": "status_internal_error", "context": context, "error": error.to_string()})
    );
    json_error(
        StatusCode::INTERNAL_SERVER_ERROR,
        json!({ "error": "Internal server error" }),
    )
}

fn read_config(state: &StatusState) -> Result<(String, Value), Response> {
    let content = match std::fs::read_to_string(&state.config_path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({ "error": "Configuration file not found" }),
            ))
        }
        Err(error) => return Err(internal_error("read api.yaml", &error)),
    };
    match serde_yaml::from_str::<Value>(&content) {
        Ok(config) => Ok((content, config)),
        Err(error) => Err(internal_error("parse api.yaml", &error)),
    }
}

fn find_key<'a>(config: &'a Value, api_key: &str) -> Option<&'a Map<String, Value>> {
    config
        .get("api_keys")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .find(|entry| entry.get("api").and_then(Value::as_str) == Some(api_key))
}

/// Shared prologue for most routes: require a non-empty apiKey, load config
/// once, return (entry, config).  Faithful to the TypeScript behaviour where
/// key validation reloads the file each time.
fn require_key(
    state: &StatusState,
    params: &Map<String, Value>,
) -> Result<(Map<String, Value>, Value), Response> {
    let api_key = match query_key(params) {
        Some(value) if !value.is_empty() => value,
        _ => {
            return Err(json_error(
                StatusCode::BAD_REQUEST,
                json!({ "error": "API Key is required" }),
            ))
        }
    };
    let (_, config) = read_config(state)?;
    match find_key(&config, api_key) {
        Some(entry) => Ok((entry.clone(), config)),
        None => Err(json_error(
            StatusCode::FORBIDDEN,
            json!({ "error": "Unauthorized" }),
        )),
    }
}

fn require_admin(
    state: &StatusState,
    params: &Map<String, Value>,
) -> Result<(String, Value), Response> {
    let (entry, config) = require_key(state, params)?;
    if entry.get("role").and_then(Value::as_str) == Some("admin") {
        let (content, _) = read_config(state)?;
        Ok((content, config))
    } else {
        Err(json_error(
            StatusCode::FORBIDDEN,
            json!({ "error": "Unauthorized" }),
        ))
    }
}

fn query_key(query: &Map<String, Value>) -> Option<&str> {
    query.get("apiKey").and_then(Value::as_str)
}

fn body_key<'a>(body: &'a Value, name: &str) -> Option<&'a str> {
    body.get(name)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
}

fn decode_upstream_debug(value: &str) -> Option<Value> {
    let bytes = BASE64.decode(value).ok()?;
    serde_json::from_slice::<Value>(&bytes).ok()
}

// ---------------------------------------------------------------------------
// stats database (read-only SQLite; matches lib/db.ts empty-data fallback
// when the stats file does not exist yet)
// ---------------------------------------------------------------------------

type SqlValue = rusqlite::types::Value;

fn query_rows_blocking(
    db_path: PathBuf,
    sql: String,
    args: Vec<SqlValue>,
) -> Result<Vec<Map<String, Value>>, String> {
    if !db_path.exists() {
        return Ok(Vec::new());
    }
    let connection = rusqlite::Connection::open_with_flags(
        &db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_PRIVATE_CACHE,
    )
    .map_err(|error| error.to_string())?;
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| error.to_string())?;
    let column_names: Vec<String> = (0..statement.column_count())
        .map(|index| statement.column_name(index).unwrap_or_default().to_owned())
        .collect();
    let refs: Vec<&dyn rusqlite::ToSql> = args
        .iter()
        .map(|value| value as &dyn rusqlite::ToSql)
        .collect();
    let mut rows = statement
        .query(rusqlite::params_from_iter(refs))
        .map_err(|error| error.to_string())?;
    let mut output = Vec::new();
    while let Some(row) = rows.next().map_err(|error| error.to_string())? {
        let mut object = Map::new();
        for (index, name) in column_names.iter().enumerate() {
            let value = match row.get_ref(index).map_err(|error| error.to_string())? {
                rusqlite::types::ValueRef::Null => Value::Null,
                rusqlite::types::ValueRef::Integer(number) => json!(number),
                rusqlite::types::ValueRef::Real(number) => json!(number),
                rusqlite::types::ValueRef::Text(text) => {
                    json!(String::from_utf8_lossy(text).into_owned())
                }
                rusqlite::types::ValueRef::Blob(_) => Value::Null,
            };
            object.insert(name.clone(), value);
        }
        output.push(object);
    }
    Ok(output)
}

async fn run_sqlite(
    state: &StatusState,
    sql: String,
    args: Vec<SqlValue>,
) -> Result<Vec<Map<String, Value>>, Response> {
    if !state.stats_enabled {
        return Ok(Vec::new());
    }
    let path = state.stats_db.clone();
    let joined = tokio::task::spawn_blocking(move || query_rows_blocking(path, sql, args))
        .await
        .map_err(|error| internal_error("stats task", &error))?;
    joined.map_err(|error| {
        json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": "Database query failed", "details": error }),
        )
    })
}

fn text_arg(value: &str) -> SqlValue {
    SqlValue::Text(value.to_owned())
}

// ---------------------------------------------------------------------------
// auth routes
// ---------------------------------------------------------------------------

async fn validate_key(State(state): State<StatusState>, Json(body): Json<Value>) -> Response {
    let Some(api_key) = body_key(&body, "apiKey") else {
        return json_error(
            StatusCode::BAD_REQUEST,
            json!({ "valid": false, "error": "API Key is required" }),
        );
    };
    let api_key = api_key.to_owned();
    let (_, config) = match read_config(&state) {
        Ok(value) => value,
        Err(response) => return response,
    };
    if !config.get("api_keys").is_some_and(Value::is_array) {
        return json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "valid": false, "error": "Invalid configuration" }),
        );
    }
    match find_key(&config, &api_key) {
        Some(entry) => Json(json!({
            "valid": true,
            "role": entry.get("role").and_then(Value::as_str).unwrap_or("user"),
        }))
        .into_response(),
        None => Json(json!({ "valid": false })).into_response(),
    }
}

async fn available_keys(State(state): State<StatusState>, Json(body): Json<Value>) -> Response {
    let Some(admin_key) = body_key(&body, "adminKey") else {
        return json_error(
            StatusCode::BAD_REQUEST,
            json!({ "error": "Admin key is required" }),
        );
    };
    let admin_key = admin_key.to_owned();
    let (_, config) = match read_config(&state) {
        Ok(value) => value,
        Err(response) => return response,
    };
    if !config.get("api_keys").is_some_and(Value::is_array) {
        return json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": "Invalid configuration" }),
        );
    }
    match find_key(&config, &admin_key) {
        Some(entry) if entry.get("role").and_then(Value::as_str) == Some("admin") => {}
        _ => return json_error(StatusCode::FORBIDDEN, json!({ "error": "Unauthorized" })),
    }
    let keys: Vec<Value> = config["api_keys"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .map(|item| {
            let mut key = json!({
                "api": item.get("api").cloned().unwrap_or(Value::Null),
                "role": item.get("role").and_then(Value::as_str).unwrap_or("user"),
            });
            if let Some(name) = item.get("name").filter(|value| !value.is_null()) {
                key.as_object_mut()
                    .unwrap()
                    .insert("name".into(), name.clone());
            }
            key
        })
        .collect();
    Json(json!({ "keys": keys })).into_response()
}

// ---------------------------------------------------------------------------
// config routes
// ---------------------------------------------------------------------------

async fn load_config(
    State(state): State<StatusState>,
    Query(params): Query<Map<String, Value>>,
) -> Response {
    let (content, _) = match require_admin(&state, &params) {
        Ok(value) => value,
        Err(response) => return response,
    };
    Json(json!({ "config": content })).into_response()
}

async fn save_config(State(state): State<StatusState>, Json(body): Json<Value>) -> Response {
    let api_key = body_key(&body, "apiKey").map(str::to_owned);
    let config = body
        .get("config")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if api_key.is_none() || config.is_empty() {
        return json_error(
            StatusCode::BAD_REQUEST,
            json!({ "error": "API Key and config are required" }),
        );
    }
    let params = Map::from_iter([("apiKey".into(), json!(api_key.unwrap()))]);
    if let Err(response) = require_admin(&state, &params) {
        return response;
    }
    if serde_yaml::from_str::<Value>(config).is_err() {
        return json_error(
            StatusCode::BAD_REQUEST,
            json!({ "error": "Invalid YAML syntax" }),
        );
    }
    if let Err(error) = std::fs::write(&state.config_path, config) {
        return internal_error("write api.yaml", &error);
    }
    Json(json!({ "success": true })).into_response()
}

// ---------------------------------------------------------------------------
// model context windows (model_context_windows.json)
// ---------------------------------------------------------------------------

async fn load_model_context(
    State(state): State<StatusState>,
    Query(params): Query<Map<String, Value>>,
) -> Response {
    if let Err(response) = require_admin(&state, &params) {
        return response;
    }
    let content = match std::fs::read_to_string(&state.model_context_path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Json(json!({ "data": {} })).into_response()
        }
        Err(error) => return internal_error("read model_context_windows.json", &error),
    };
    let data = serde_json::from_str::<Value>(&content).unwrap_or_else(|_| json!({}));
    Json(json!({ "data": data })).into_response()
}

async fn save_model_context(State(state): State<StatusState>, Json(body): Json<Value>) -> Response {
    let api_key = body_key(&body, "apiKey").map(str::to_owned);
    let data = body.get("data").cloned().unwrap_or(Value::Null);
    if api_key.is_none() || !data.is_object() {
        return json_error(
            StatusCode::BAD_REQUEST,
            json!({ "error": "API Key and a JSON object data are required" }),
        );
    }
    let params = Map::from_iter([("apiKey".into(), json!(api_key.unwrap()))]);
    if let Err(response) = require_admin(&state, &params) {
        return response;
    }
    let pretty = match serde_json::to_string_pretty(&data) {
        Ok(pretty) => format!("{pretty}\n"),
        Err(error) => return internal_error("serialize model_context_windows.json", &error),
    };
    if let Err(error) = std::fs::write(&state.model_context_path, pretty) {
        return internal_error("write model_context_windows.json", &error);
    }
    Json(json!({ "success": true })).into_response()
}

// ---------------------------------------------------------------------------
// stats routes
// ---------------------------------------------------------------------------

async fn stats_overview(
    State(state): State<StatusState>,
    Query(params): Query<Map<String, Value>>,
) -> Response {
    let api_key = match require_key(&state, &params) {
        Ok((entry, _)) => entry
            .get("api")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        Err(response) => return response,
    };
    let rows = match run_sqlite(
        &state,
        "SELECT COUNT(*) as requests, \
         COALESCE(SUM(total_tokens), 0) as totalTokens, \
         COALESCE(SUM(prompt_tokens), 0) as promptTokens, \
         COALESCE(SUM(completion_tokens), 0) as completionTokens, \
         COALESCE(AVG(process_time), 0) as avgProcessTime, \
         COALESCE(AVG(first_response_time), 0) as avgFirstResponseTime \
         FROM request_stats WHERE api_key = $1 AND endpoint = '/v1/chat/completions'"
            .to_owned(),
        vec![text_arg(&api_key)],
    )
    .await
    {
        Ok(rows) => rows,
        Err(response) => return response,
    };
    let stats = rows.into_iter().next().unwrap_or_else(|| {
        Map::from_iter([
            ("requests".into(), json!(0)),
            ("totalTokens".into(), json!(0)),
            ("promptTokens".into(), json!(0)),
            ("completionTokens".into(), json!(0)),
            ("avgProcessTime".into(), json!(0)),
            ("avgFirstResponseTime".into(), json!(0)),
        ])
    });
    Json(Value::Object(stats)).into_response()
}

const RANKING_SQL: &str = "SELECT r.{group} as {group}, \
     COUNT(*) as requests, \
     COALESCE(SUM(CASE WHEN c.success = 1 THEN 1 ELSE 0 END), 0) as successes, \
     COALESCE(SUM(CASE WHEN c.success = 0 THEN 1 ELSE 0 END), 0) as failures, \
     COALESCE(AVG(CAST(COALESCE(c.success, 0) AS REAL)), 0) as successRate, \
     COALESCE(SUM(r.total_tokens), 0) as totalTokens, \
     COALESCE(SUM(r.prompt_tokens), 0) as promptTokens, \
     COALESCE(SUM(r.completion_tokens), 0) as completionTokens, \
     COALESCE(AVG(r.process_time), 0) as avgProcessTime, \
     COALESCE(AVG(r.first_response_time), 0) as avgFirstResponseTime \
     FROM request_stats r LEFT JOIN channel_stats c ON r.request_id = c.request_id \
     WHERE r.api_key = $1 AND r.endpoint = '/v1/chat/completions' \
     GROUP BY r.{group} ORDER BY requests DESC";

async fn run_ranking(state: &StatusState, group: &str, api_key: String) -> Response {
    match run_sqlite(
        state,
        RANKING_SQL.replace("{group}", group),
        vec![text_arg(&api_key)],
    )
    .await
    {
        Ok(rows) => {
            Json(Value::Array(rows.into_iter().map(Value::Object).collect())).into_response()
        }
        Err(response) => response,
    }
}

async fn stats_models(
    State(state): State<StatusState>,
    Query(params): Query<Map<String, Value>>,
) -> Response {
    let api_key = match require_key(&state, &params) {
        Ok((entry, _)) => entry
            .get("api")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        Err(response) => return response,
    };
    run_ranking(&state, "model", api_key).await
}

async fn stats_channels(
    State(state): State<StatusState>,
    Query(params): Query<Map<String, Value>>,
) -> Response {
    let api_key = match require_key(&state, &params) {
        Ok((entry, _)) => entry
            .get("api")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        Err(response) => return response,
    };
    run_ranking(&state, "provider", api_key).await
}

const DISTINCT_SQL: &str = "SELECT DISTINCT {column} FROM request_stats \
     WHERE api_key = $1 AND endpoint = '/v1/chat/completions' ORDER BY {column}";

async fn filters(
    State(state): State<StatusState>,
    Query(params): Query<Map<String, Value>>,
) -> Response {
    let api_key = match require_key(&state, &params) {
        Ok((entry, _)) => entry
            .get("api")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        Err(response) => return response,
    };
    let column_list = |rows: Vec<Map<String, Value>>, column: &str| -> Vec<Value> {
        rows.into_iter()
            .filter_map(|row| row.get(column).cloned())
            .filter(|value| !value.is_null() && value.as_str().map_or(true, |s| !s.is_empty()))
            .collect()
    };
    let models = match run_sqlite(
        &state,
        DISTINCT_SQL.replace("{column}", "model"),
        vec![text_arg(&api_key)],
    )
    .await
    {
        Ok(rows) => column_list(rows, "model"),
        Err(response) => return response,
    };
    let providers = match run_sqlite(
        &state,
        DISTINCT_SQL.replace("{column}", "provider"),
        vec![text_arg(&api_key)],
    )
    .await
    {
        Ok(rows) => column_list(rows, "provider"),
        Err(response) => return response,
    };
    Json(json!({ "models": models, "providers": providers })).into_response()
}

async fn logs(
    State(state): State<StatusState>,
    Query(params): Query<Map<String, Value>>,
) -> Response {
    let entry = match require_key(&state, &params) {
        Ok((entry, _)) => entry,
        Err(response) => return response,
    };
    let api_key = entry
        .get("api")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let get = |name: &str| {
        params
            .get(name)
            .and_then(Value::as_str)
            .map(str::to_owned)
            .filter(|value| !value.is_empty())
    };
    let page: i64 = get("page")
        .and_then(|value| value.parse().ok())
        .unwrap_or(1)
        .max(1);
    let limit: i64 = get("limit")
        .and_then(|value| value.parse().ok())
        .unwrap_or(30)
        .clamp(1, 100);

    let mut where_clauses = vec!["r.api_key = $1".to_owned(), "r.endpoint = $2".to_owned()];
    let mut args: Vec<SqlValue> = vec![text_arg(&api_key), text_arg("/v1/chat/completions")];
    if let Some(value) = get("model") {
        where_clauses.push(format!("r.model = ${}", args.len() + 1));
        args.push(text_arg(&value));
    }
    if let Some(value) = get("provider") {
        where_clauses.push(format!("r.provider = ${}", args.len() + 1));
        args.push(text_arg(&value));
    }
    if let Some(value) = get("status") {
        let boolean = match value.to_ascii_lowercase().as_str() {
            "true" => Some(1),
            "false" => Some(0),
            _ => None,
        };
        if let Some(number) = boolean {
            where_clauses.push(format!("c.success = ${}", args.len() + 1));
            args.push(SqlValue::Integer(number));
        }
    }
    let sql = format!(
        "SELECT r.timestamp, \
         MAX(COALESCE(c.success, 0)) as success, \
         r.model, r.provider, \
         r.process_time as processTime, r.first_response_time as firstResponseTime, \
         r.prompt_tokens as promptTokens, r.completion_tokens as completionTokens, \
         r.total_tokens as totalTokens, r.text \
         FROM request_stats r LEFT JOIN channel_stats c ON r.request_id = c.request_id \
         WHERE {} \
         GROUP BY r.request_id ORDER BY r.timestamp DESC \
         LIMIT ${} OFFSET ${}",
        where_clauses.join(" AND "),
        args.len() + 1,
        args.len() + 2
    );
    args.push(SqlValue::Integer(limit + 1));
    args.push(SqlValue::Integer((page - 1) * limit));

    match run_sqlite(&state, sql, args).await {
        Ok(rows) => {
            let has_next = rows.len() as i64 > limit;
            let logs: Vec<Value> = rows
                .into_iter()
                .take(limit as usize)
                .map(|mut row| {
                    let success = row.get("success").and_then(Value::as_i64).unwrap_or(0);
                    row.insert("success".into(), json!(success == 1));
                    Value::Object(row)
                })
                .collect();
            Json(json!({ "logs": logs, "hasNextPage": has_next })).into_response()
        }
        Err(response) => response,
    }
}

// ---------------------------------------------------------------------------
// provider routes
// ---------------------------------------------------------------------------

async fn providers_list(
    State(state): State<StatusState>,
    Query(params): Query<Map<String, Value>>,
) -> Response {
    if let Err(response) = require_key(&state, &params) {
        return response;
    }
    let (_, config) = match read_config(&state) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let mut providers = Vec::new();
    for provider in config
        .get("providers")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let mut models = Vec::new();
        for entry in provider
            .get("model")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            match entry {
                Value::String(name) => models.push(json!({ "original": name, "display": name })),
                Value::Object(mapping) => {
                    for (original, display) in mapping {
                        models.push(json!({ "original": original, "display": display }));
                    }
                }
                _ => {}
            }
        }
        let base_url = provider
            .get("base_url")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let supported = base_url.contains("/chat/completions")
            || base_url.contains("/v1/messages")
            || base_url.contains("/responses");
        providers.push(json!({
            "provider": provider.get("provider").cloned().unwrap_or(Value::Null),
            "base_url": base_url,
            "api": provider.get("api").cloned().unwrap_or(Value::Null),
            "models": models,
            "supported": supported,
        }));
    }
    // Same-origin relative path: the browser (and test-real below) reach the
    // gateway through this very process, no host/port assumption needed.
    Json(json!({ "providers": providers, "uniApiBaseUrl": "/v1" })).into_response()
}

/// Strip a known endpoint suffix from a channel base_url, then append the
/// model-list endpoint (mirrors baseUrlToModelsUrl in the TS route).  Note
/// that a base_url ending in "/v1" keeps that segment on purpose.
fn base_url_to_models_url(base_url: &str) -> String {
    let mut root = base_url.trim_end_matches('/').to_owned();
    for suffix in [
        "/chat/completions",
        "/completions",
        "/responses",
        "/messages",
    ] {
        if root.ends_with(suffix) {
            root.truncate(root.len() - suffix.len());
            break;
        }
    }
    format!("{root}/models")
}

fn channel_key(api: &Value) -> String {
    match api {
        Value::String(key) => key.clone(),
        Value::Array(items) => items
            .first()
            .map(|item| match item {
                Value::String(key) => key.clone(),
                other => other
                    .get("api")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
            })
            .unwrap_or_default(),
        _ => String::new(),
    }
}

async fn provider_models(State(state): State<StatusState>, Json(body): Json<Value>) -> Response {
    let api_key = body_key(&body, "apiKey").map(str::to_owned);
    let base_url = body_key(&body, "base_url").unwrap_or_default().to_owned();
    let api = body.get("api").cloned().unwrap_or(Value::Null);
    if api_key.is_none() || base_url.is_empty() || api.is_null() {
        return Json(json!({ "success": false, "message": "缺少必要参数" })).into_response();
    }
    let params = Map::from_iter([("apiKey".into(), json!(api_key.unwrap()))]);
    if require_key(&state, &params).is_err() {
        return Json(json!({ "success": false, "message": "未授权" })).into_response();
    }
    let channel_api = channel_key(&api);
    if channel_api.is_empty() {
        return Json(json!({ "success": false, "message": "渠道未配置 API Key" })).into_response();
    }
    let url = base_url_to_models_url(&base_url);
    let mut request = state.http.get(&url).timeout(Duration::from_secs(30));
    if base_url.contains("/v1/messages") {
        request = request
            .header("x-api-key", &channel_api)
            .header("anthropic-version", "2023-06-01");
    } else {
        request = request.bearer_auth(&channel_api);
    }
    match request.send().await {
        Ok(response) => {
            let status = response.status();
            if !status.is_success() {
                let text = response.text().await.unwrap_or_default();
                return Json(json!({
                    "success": false,
                    "message": format!(
                        "HTTP {}: {}",
                        status.as_u16(),
                        text.chars().take(200).collect::<String>()
                    ),
                }))
                .into_response();
            }
            match response.json::<Value>().await {
                Ok(data) => Json(json!({ "success": true, "models": extract_model_ids(&data) }))
                    .into_response(),
                Err(error) => {
                    Json(json!({ "success": false, "message": error.to_string() })).into_response()
                }
            }
        }
        Err(error) => Json(json!({ "success": false, "message": format!("网络错误: {error}") }))
            .into_response(),
    }
}

fn extract_model_ids(data: &Value) -> Vec<Value> {
    let candidates = [
        data.get("data").cloned(),
        data.get("models").cloned(),
        if data.is_array() {
            Some(data.clone())
        } else {
            None
        },
    ];
    for candidate in candidates.into_iter().flatten() {
        if let Some(items) = candidate.as_array() {
            return items
                .iter()
                .filter_map(|item| match item {
                    Value::String(name) => Some(json!(name)),
                    other => other.get("id").cloned(),
                })
                .collect();
        }
    }
    Vec::new()
}

/// Strip a known endpoint suffix (mirrors resolveBaseRoot in the TS route).
fn normalize_base_root(base_url: &str) -> String {
    let mut root = base_url.trim_end_matches('/').to_owned();
    for suffix in [
        "/chat/completions",
        "/v1/messages",
        "/completions",
        "/responses",
        "/messages",
    ] {
        if root.ends_with(suffix) {
            root.truncate(root.len() - suffix.len());
            break;
        }
    }
    root
}

async fn provider_test_real(State(state): State<StatusState>, Json(body): Json<Value>) -> Response {
    let api_key = body_key(&body, "apiKey").unwrap_or_default().to_owned();
    let api = body.get("api").cloned().unwrap_or(Value::Null);
    let model = body_key(&body, "model").unwrap_or_default().to_owned();
    if api_key.is_empty() || model.is_empty() || api.is_null() {
        return Json(json!({ "success": false, "message": "缺少必要参数 (apiKey / api / model)" }))
            .into_response();
    }
    let (_, config) = match read_config(&state) {
        Ok(value) => value,
        Err(_) => {
            return Json(json!({ "success": false, "message": "配置文件未找到" })).into_response()
        }
    };
    if find_key(&config, &api_key).is_none() {
        return Json(json!({ "success": false, "message": "未授权" })).into_response();
    }
    let endpoint = match body_key(&body, "endpoint") {
        Some(value @ ("responses" | "messages")) => value.to_owned(),
        _ => "chat/completions".to_owned(),
    };
    let base_url = body_key(&body, "baseUrl").unwrap_or_default().to_owned();
    let root = if base_url.is_empty() {
        format!("{}/v1", state.internal_base)
    } else if base_url.starts_with('/') {
        // Same-origin relative option coming from the exported UI ("/v1").
        format!("{}{}", state.internal_base, normalize_base_root(&base_url))
    } else {
        normalize_base_root(&base_url)
    };
    let url = format!("{root}/{endpoint}");
    let test_text = "真实测试，请回复 ok";
    let request_body = if endpoint == "responses" {
        json!({ "model": model, "input": [{ "role": "user", "content": [{ "type": "input_text", "text": test_text }] }] })
    } else {
        json!({ "model": model, "messages": [{ "role": "user", "content": test_text }] })
    };
    let channel_api = channel_key(&api);
    let mut headers = Map::new();
    headers.insert("Content-Type".into(), json!("application/json"));
    let mut request = state
        .http
        .post(&url)
        .timeout(Duration::from_secs(60))
        .header(header::CONTENT_TYPE, "application/json")
        .header("x-uni-api-debug", "1");
    if endpoint == "messages" {
        request = request
            .header("x-api-key", &channel_api)
            .header("anthropic-version", "2023-06-01");
        headers.insert("x-api-key".into(), json!(channel_api.clone()));
        headers.insert("anthropic-version".into(), json!("2023-06-01"));
    } else {
        request = request.bearer_auth(&channel_api);
        headers.insert(
            "Authorization".into(),
            json!(format!("Bearer {channel_api}")),
        );
    }
    let request_info =
        json!({ "method": "POST", "url": url, "headers": headers, "body": request_body });
    let started = Instant::now();
    match request.json(&request_body).send().await {
        Ok(response) => {
            let status = response.status().as_u16();
            let upstream_request = response
                .headers()
                .get("x-uni-api-upstream-request")
                .and_then(|value| value.to_str().ok())
                .and_then(decode_upstream_debug);
            let upstream_response = response
                .headers()
                .get("x-uni-api-upstream-response")
                .and_then(|value| value.to_str().ok())
                .and_then(decode_upstream_debug);
            let text = response.text().await.unwrap_or_default();
            let elapsed = started.elapsed().as_secs_f64();
            let mut result = json!({
                "success": (200..300).contains(&status),
                "message": if (200..300).contains(&status) { "测试成功".to_owned() } else { format!("HTTP {status}") },
                "responseTime": elapsed,
                "request": request_info,
                "response": { "status": status, "body": text },
            });
            if let (Some(request), Some(response)) = (upstream_request, upstream_response) {
                if let Some(object) = result.as_object_mut() {
                    object.insert(
                        "upstream".into(),
                        json!({ "request": request, "response": response }),
                    );
                }
            }
            Json(result).into_response()
        }
        Err(error) => {
            let elapsed = started.elapsed().as_secs_f64();
            let message = if error.is_timeout() {
                "请求超时(60s)".to_owned()
            } else {
                format!("网络错误: {error}")
            };
            Json(json!({
                "success": false,
                "message": message,
                "responseTime": elapsed,
                "request": request_info,
                "response": { "status": 0, "body": "" },
            }))
            .into_response()
        }
    }
}

// ---------------------------------------------------------------------------
// static UI (exported Next.js site from webui/out, installed to
// UNI_API_STATUS_UI, default ./status)
// ---------------------------------------------------------------------------

const MIME: &[(&str, &str)] = &[
    ("html", "text/html; charset=utf-8"),
    ("js", "text/javascript"),
    ("mjs", "text/javascript"),
    ("css", "text/css"),
    ("json", "application/json"),
    ("svg", "image/svg+xml"),
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("webp", "image/webp"),
    ("ico", "image/x-icon"),
    ("txt", "text/plain; charset=utf-8"),
    ("woff", "font/woff"),
    ("woff2", "font/woff2"),
    ("map", "application/json"),
];

fn mime_for(path: &Path) -> &'static str {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    MIME.iter()
        .find(|(name, _)| *name == extension)
        .map(|(_, value)| *value)
        .unwrap_or("application/octet-stream")
}

fn serve_file(root: &Path, relative: &str, immutable: bool) -> Response {
    let candidate = match root.join(relative).canonicalize() {
        Ok(path) if path.starts_with(root) && path.is_file() => path,
        _ => return json_error(StatusCode::NOT_FOUND, json!({ "error": "Not found" })),
    };
    match std::fs::read(&candidate) {
        Ok(bytes) => {
            let mut headers = HeaderMap::new();
            headers.insert(
                header::CONTENT_TYPE,
                HeaderValue::from_str(mime_for(&candidate))
                    .unwrap_or(HeaderValue::from_static("application/octet-stream")),
            );
            headers.insert(
                header::CACHE_CONTROL,
                HeaderValue::from_static(if immutable {
                    "public, max-age=31536000, immutable"
                } else {
                    "no-cache"
                }),
            );
            (headers, bytes).into_response()
        }
        Err(error) => internal_error("read status asset", &error),
    }
}

async fn serve_ui(State(state): State<StatusState>) -> Response {
    serve_file(&state.ui_root, "index.html", false)
}

async fn serve_next_asset(
    State(state): State<StatusState>,
    UrlPath(asset): UrlPath<String>,
) -> Response {
    serve_file(&state.ui_root.join("_next"), &asset, true)
}
