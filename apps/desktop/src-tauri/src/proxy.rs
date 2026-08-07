use crate::connection::{
    clear_pending_pairing, connect_profile, load_pending_pairing, load_profile, parse_pairing_uri,
    pinned_http_client, pinned_tls_config, save_pending_pairing, save_profile, ImportedConnection,
    NetworkPreference, PendingPairing, ServerProfile,
};
use crate::ssh_install::{self, InstallServerRequest};
use axum::{
    body::{to_bytes, Body},
    extract::{
        ws::{Message as BrowserMessage, WebSocket, WebSocketUpgrade},
        FromRequestParts, Json, Request, State,
    },
    http::{
        header::{CONTENT_LENGTH, COOKIE, HOST, LOCATION, ORIGIN, REFERER, SET_COOKIE, UPGRADE},
        HeaderMap, HeaderName, HeaderValue, Method, StatusCode,
    },
    response::{Html, IntoResponse, Response},
    routing::{get, post},
    Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::Arc, time::SystemTime};
use tokio::{
    net::TcpListener,
    sync::{Mutex, RwLock},
};
use tokio_tungstenite::{
    connect_async_tls_with_config,
    tungstenite::{client::IntoClientRequest, Message as ServerMessage},
    Connector, MaybeTlsStream, WebSocketStream,
};

const RETRYABLE_BODY_LIMIT: usize = 16 * 1024 * 1024;
const SERVER_SESSION_COOKIE: &str = "__Host-athanor_session";
const LOCAL_SESSION_COOKIE: &str = "athanor_native_session";

#[derive(Clone)]
struct ActiveServer {
    profile: ServerProfile,
    http: reqwest::Client,
    websocket_tls: Arc<rustls::ClientConfig>,
}

pub struct ClientState {
    profile_path: PathBuf,
    pending_pairing_path: PathBuf,
    profile: RwLock<Option<ServerProfile>>,
    active: RwLock<Option<ActiveServer>>,
    activation: Mutex<()>,
    pairing_code: RwLock<Option<PendingPairing>>,
    local_origin: RwLock<String>,
    installer_origin: RwLock<String>,
}

impl ClientState {
    pub fn load(profile_path: PathBuf, pending_pairing_path: PathBuf) -> Result<Arc<Self>, String> {
        let profile = load_profile(&profile_path)?;
        let pairing_code = load_pending_pairing(&pending_pairing_path, SystemTime::now())?;
        Ok(Arc::new(Self {
            profile_path,
            pending_pairing_path,
            profile: RwLock::new(profile),
            active: RwLock::new(None),
            activation: Mutex::new(()),
            pairing_code: RwLock::new(pairing_code),
            local_origin: RwLock::new(String::new()),
            installer_origin: RwLock::new(String::new()),
        }))
    }

    async fn activate(self: &Arc<Self>, profile: ServerProfile) -> Result<ActiveServer, String> {
        let refreshed = connect_profile(&profile).await?;
        let http = pinned_http_client(&refreshed.identity, None)?;
        let mut websocket_tls = pinned_tls_config(&refreshed.identity)?;
        websocket_tls.alpn_protocols = vec![b"http/1.1".to_vec()];
        let active = ActiveServer {
            profile: refreshed.clone(),
            http,
            websocket_tls: Arc::new(websocket_tls),
        };
        let profile_path = self.profile_path.clone();
        let to_save = refreshed.clone();
        tokio::task::spawn_blocking(move || save_profile(&profile_path, &to_save))
            .await
            .map_err(|_| "The client profile writer stopped unexpectedly")??;
        *self.profile.write().await = Some(refreshed);
        *self.active.write().await = Some(active.clone());
        Ok(active)
    }

    async fn current(self: &Arc<Self>) -> Result<ActiveServer, String> {
        if let Some(active) = self.active.read().await.clone() {
            return Ok(active);
        }
        let _activation = self.activation.lock().await;
        if let Some(active) = self.active.read().await.clone() {
            return Ok(active);
        }
        let profile = self
            .profile
            .read()
            .await
            .clone()
            .ok_or("Paste the one-time connection ticket from your athanor server")?;
        self.activate(profile).await
    }

    async fn import(self: &Arc<Self>, raw: &str) -> Result<(), String> {
        let ImportedConnection {
            profile,
            pairing_code,
            pairing_expires_at,
        } = parse_pairing_uri(raw, SystemTime::now())?;
        let _activation = self.activation.lock().await;
        self.activate(profile).await?;
        let path = self.pending_pairing_path.clone();
        let pending = tokio::task::spawn_blocking(move || {
            save_pending_pairing(&path, pairing_code, pairing_expires_at)
        })
        .await
        .map_err(|_| "The pending pairing-code writer stopped unexpectedly")??;
        *self.pairing_code.write().await = Some(pending);
        Ok(())
    }

    async fn clear_pairing_code(&self) -> Result<(), String> {
        let path = self.pending_pairing_path.clone();
        tokio::task::spawn_blocking(move || clear_pending_pairing(&path))
            .await
            .map_err(|_| "The pending pairing-code remover stopped unexpectedly")??;
        *self.pairing_code.write().await = None;
        Ok(())
    }

    pub async fn import_deep_link(self: &Arc<Self>, raw: &str) -> Result<(), String> {
        self.import(raw).await
    }

    pub async fn local_origin(&self) -> String {
        self.local_origin.read().await.clone()
    }

    async fn installer_origin(&self) -> String {
        self.installer_origin.read().await.clone()
    }

    async fn invalidate(&self) {
        *self.active.write().await = None;
    }

    async fn set_network_preference(
        self: &Arc<Self>,
        preference: NetworkPreference,
    ) -> Result<(), String> {
        let mut profile_guard = self.profile.write().await;
        let Some(profile) = profile_guard.as_mut() else {
            return Err("Connect an athanor server before saving network preferences".into());
        };
        profile.network_preference = preference;
        let profile_path = self.profile_path.clone();
        let to_save = profile.clone();
        tokio::task::spawn_blocking(move || save_profile(&profile_path, &to_save))
            .await
            .map_err(|_| "The client profile writer stopped unexpectedly")??;
        drop(profile_guard);
        if let Some(active) = self.active.write().await.as_mut() {
            active.profile.network_preference = preference;
        }
        Ok(())
    }
}

#[derive(Deserialize)]
struct PairRequest {
    ticket: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NetworkPreferenceRequest {
    preference: NetworkPreference,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClientStatus {
    configured: bool,
    connected: bool,
    identity: Option<String>,
    endpoints: Vec<String>,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Bootstrap {
    pairing_code: Option<String>,
    installer_url: String,
}

#[derive(Deserialize)]
struct SshProbeRequest {
    host: String,
    port: u16,
}

pub async fn start(state: Arc<ClientState>) -> Result<String, String> {
    let installer_listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|error| format!("Could not start the secure installer: {error}"))?;
    let installer_address = installer_listener
        .local_addr()
        .map_err(|error| format!("Could not read the secure installer address: {error}"))?;
    let installer_origin = format!("http://localhost:{}", installer_address.port());
    *state.installer_origin.write().await = installer_origin;
    let installer_router = Router::new()
        .route("/", get(installer))
        .route("/probe", post(probe_ssh))
        .route("/install", post(install_server));
    #[cfg(desktop)]
    let installer_router = installer_router.route("/choose-key", post(choose_ssh_key));
    let installer_router = installer_router.with_state(state.clone());
    tauri::async_runtime::spawn(async move {
        if let Err(error) = axum::serve(installer_listener, installer_router).await {
            eprintln!("athanor secure installer stopped: {error}");
        }
    });

    /*
     * The same port every launch, because the port is part of the origin.
     *
     * Binding 0 takes whatever is free, so the shell came up on a different origin each time it
     * started - and a browser keys local storage to an origin including its port. Every launch was
     * therefore a brand new profile: the model choice, the open panel, and every draft this device
     * had not yet synced were all addressed to an origin that no longer existed. The port is
     * remembered beside the server profile and reused; if something else has taken it in the
     * meantime the ephemeral bind is still there as a fallback, which is no worse than before.
     */
    let port_path = state.profile_path.with_file_name("client-gateway-port");
    let remembered = std::fs::read_to_string(&port_path)
        .ok()
        .and_then(|raw| raw.trim().parse::<u16>().ok())
        .filter(|port| *port >= 1024);
    let listener = match remembered {
        Some(port) => match TcpListener::bind(("127.0.0.1", port)).await {
            Ok(bound) => bound,
            Err(_) => TcpListener::bind(("127.0.0.1", 0))
                .await
                .map_err(|error| {
                    format!("Could not start the private client gateway: {error}")
                })?,
        },
        None => TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|error| format!("Could not start the private client gateway: {error}"))?,
    };
    let address = listener
        .local_addr()
        .map_err(|error| format!("Could not read the private client address: {error}"))?;
    if remembered != Some(address.port()) {
        // Best effort: a shell that cannot write this still runs, it just starts somewhere else
        // next time, which is exactly what it did before.
        let _ = std::fs::write(&port_path, address.port().to_string());
    }
    let origin = format!("http://localhost:{}", address.port());
    *state.local_origin.write().await = origin.clone();
    let router = Router::new()
        .route("/__athanor/client/status", get(client_status))
        .route("/__athanor/client/pair", post(pair))
        .route(
            "/__athanor/client/network-preference",
            post(save_network_preference),
        )
        .route("/__athanor/client/bootstrap", get(bootstrap))
        .fallback(proxy)
        .with_state(state);
    tauri::async_runtime::spawn(async move {
        if let Err(error) = axum::serve(listener, router).await {
            eprintln!("athanor private client gateway stopped: {error}");
        }
    });
    Ok(origin)
}

async fn client_status(State(state): State<Arc<ClientState>>) -> Json<ClientStatus> {
    let profile = state.profile.read().await.clone();
    let connected = state.active.read().await.is_some();
    Json(ClientStatus {
        configured: profile.is_some(),
        connected,
        identity: profile.as_ref().map(|value| value.identity.clone()),
        endpoints: profile
            .as_ref()
            .map(|value| value.endpoints.clone())
            .unwrap_or_default(),
        error: None,
    })
}

fn is_local_client_origin(headers: &HeaderMap, expected: &str) -> bool {
    headers.get(ORIGIN).and_then(|value| value.to_str().ok()) == Some(expected)
}

async fn pair(
    State(state): State<Arc<ClientState>>,
    headers: HeaderMap,
    Json(request): Json<PairRequest>,
) -> Response {
    let local_origin = state.local_origin().await;
    if !is_local_client_origin(&headers, &local_origin) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "error": {
                    "code": "invalid_client_origin",
                    "message": "Connection tickets are accepted only from the athanor client"
                }
            })),
        )
            .into_response();
    }
    match state.import(&request.ticket).await {
        Ok(()) => (
            StatusCode::OK,
            Json(serde_json::json!({ "connected": true })),
        )
            .into_response(),
        Err(message) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": { "code": "connection_failed", "message": message }
            })),
        )
            .into_response(),
    }
}

async fn save_network_preference(
    State(state): State<Arc<ClientState>>,
    headers: HeaderMap,
    Json(request): Json<NetworkPreferenceRequest>,
) -> Response {
    if !is_local_client_origin(&headers, &state.local_origin().await) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "error": {
                    "code": "invalid_client_origin",
                    "message": "Network preferences are accepted only from the athanor client"
                }
            })),
        )
            .into_response();
    }
    match state.set_network_preference(request.preference).await {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({ "saved": true }))).into_response(),
        Err(message) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": { "code": "preference_failed", "message": message }
            })),
        )
            .into_response(),
    }
}

async fn bootstrap(State(state): State<Arc<ClientState>>) -> Json<Bootstrap> {
    Json(Bootstrap {
        pairing_code: state
            .pairing_code
            .read()
            .await
            .as_ref()
            .map(|pending| pending.pairing_code.clone()),
        installer_url: state.installer_origin().await,
    })
}

fn installer_error(status: StatusCode, code: &str, message: String) -> Response {
    (
        status,
        Json(serde_json::json!({
            "error": { "code": code, "message": message }
        })),
    )
        .into_response()
}

async fn installer(State(state): State<Arc<ClientState>>) -> Response {
    let configured = state.profile.read().await.is_some();
    let mut response = Html(ssh_install::installer_page(
        configured,
        &state.local_origin().await,
    ))
    .into_response();
    let headers = response.headers_mut();
    headers.insert(
        HeaderName::from_static("content-security-policy"),
        HeaderValue::from_static(
            "default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
        ),
    );
    headers.insert(
        HeaderName::from_static("cache-control"),
        HeaderValue::from_static("no-store"),
    );
    headers.insert(
        HeaderName::from_static("referrer-policy"),
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        HeaderName::from_static("x-frame-options"),
        HeaderValue::from_static("DENY"),
    );
    response
}

async fn probe_ssh(
    State(state): State<Arc<ClientState>>,
    headers: HeaderMap,
    Json(request): Json<SshProbeRequest>,
) -> Response {
    if !is_local_client_origin(&headers, &state.installer_origin().await) {
        return installer_error(
            StatusCode::FORBIDDEN,
            "invalid_installer_origin",
            "SSH checks are accepted only from the secure athanor installer".into(),
        );
    }
    match ssh_install::probe(request.host, request.port).await {
        Ok(identity) => (StatusCode::OK, Json(identity)).into_response(),
        Err(message) => installer_error(StatusCode::BAD_REQUEST, "ssh_probe_failed", message),
    }
}

#[cfg(desktop)]
async fn choose_ssh_key(State(state): State<Arc<ClientState>>, headers: HeaderMap) -> Response {
    if !is_local_client_origin(&headers, &state.installer_origin().await) {
        return installer_error(
            StatusCode::FORBIDDEN,
            "invalid_installer_origin",
            "Private keys can be selected only from the secure athanor installer".into(),
        );
    }
    let selected = rfd::AsyncFileDialog::new()
        .set_title("Choose the SSH private key")
        .pick_file()
        .await;
    let path = selected
        .as_ref()
        .and_then(|file| file.path().to_str())
        .map(str::to_owned);
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "path": path
        })),
    )
        .into_response()
}

async fn install_server(
    State(state): State<Arc<ClientState>>,
    headers: HeaderMap,
    Json(request): Json<InstallServerRequest>,
) -> Response {
    if !is_local_client_origin(&headers, &state.installer_origin().await) {
        return installer_error(
            StatusCode::FORBIDDEN,
            "invalid_installer_origin",
            "Server installation is accepted only from the secure athanor installer".into(),
        );
    }
    match ssh_install::install(request).await {
        Ok(result) => match state.import(&result.ticket).await {
            Ok(()) => (
                StatusCode::OK,
                Json(serde_json::json!({
                    "connected": true,
                    "clientUrl": state.local_origin().await
                })),
            )
                .into_response(),
            Err(message) => installer_error(
                StatusCode::BAD_GATEWAY,
                "server_pairing_failed",
                format!("athanor installed, but its private HTTPS connection failed: {message}"),
            ),
        },
        Err(message) => installer_error(StatusCode::BAD_REQUEST, "server_install_failed", message),
    }
}

fn is_hop_by_hop(name: &HeaderName) -> bool {
    matches!(
        name.as_str().to_ascii_lowercase().as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    )
}

fn forwarded_headers(input: &HeaderMap, canonical_origin: &str) -> HeaderMap {
    let mut output = HeaderMap::new();
    for (name, value) in input {
        if !is_hop_by_hop(name) && name != HOST && name != CONTENT_LENGTH {
            output.append(name.clone(), value.clone());
        }
    }
    if input.contains_key(ORIGIN) {
        if let Ok(value) = HeaderValue::from_str(canonical_origin) {
            output.insert(ORIGIN, value);
        }
    }
    if input.contains_key(REFERER) {
        if let Ok(value) = HeaderValue::from_str(&format!("{canonical_origin}/")) {
            output.insert(REFERER, value);
        }
    }
    if let Some(value) = input.get(COOKIE).and_then(|value| value.to_str().ok()) {
        let translated = value
            .split(';')
            .map(str::trim)
            .map(|cookie| {
                cookie
                    .strip_prefix(&format!("{LOCAL_SESSION_COOKIE}="))
                    .map(|value| format!("{SERVER_SESSION_COOKIE}={value}"))
                    .unwrap_or_else(|| cookie.to_owned())
            })
            .collect::<Vec<_>>()
            .join("; ");
        if let Ok(value) = HeaderValue::from_str(&translated) {
            output.insert(COOKIE, value);
        }
    }
    output
}

fn local_set_cookie(raw: &str) -> Option<HeaderValue> {
    let prefix = format!("{SERVER_SESSION_COOKIE}=");
    let value = raw.strip_prefix(&prefix)?;
    let mut parts = value.split(';');
    let session = parts.next()?;
    let mut translated = format!("{LOCAL_SESSION_COOKIE}={session}");
    for attribute in parts {
        let attribute = attribute.trim();
        if attribute.eq_ignore_ascii_case("secure")
            || attribute.to_ascii_lowercase().starts_with("domain=")
        {
            continue;
        }
        translated.push_str("; ");
        translated.push_str(attribute);
    }
    HeaderValue::from_str(&translated).ok()
}

fn upstream_url(active: &ActiveServer, path_and_query: &str) -> String {
    format!(
        "{}{}",
        active
            .profile
            .last_endpoint
            .as_ref()
            .unwrap_or(&active.profile.endpoints[0]),
        path_and_query
    )
}

fn canonical_origin(active: &ActiveServer) -> &str {
    &active.profile.endpoints[0]
}

fn should_buffer_for_retry(
    method: &Method,
    headers: &HeaderMap,
    content_length: Option<usize>,
) -> bool {
    let inherently_safe = matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS);
    let replayable = inherently_safe || headers.contains_key("idempotency-key");
    let known_small_body = content_length
        .map(|length| length <= RETRYABLE_BODY_LIMIT)
        .unwrap_or(inherently_safe);
    replayable && known_small_body
}

async fn send_buffered(
    active: &ActiveServer,
    method: Method,
    path_and_query: &str,
    headers: HeaderMap,
    body: bytes::Bytes,
) -> Result<reqwest::Response, reqwest::Error> {
    active
        .http
        .request(method, upstream_url(active, path_and_query))
        .headers(forwarded_headers(&headers, canonical_origin(active)))
        .body(body)
        .send()
        .await
}

async fn send_streaming(
    active: &ActiveServer,
    method: Method,
    path_and_query: &str,
    headers: HeaderMap,
    body: Body,
) -> Result<reqwest::Response, reqwest::Error> {
    active
        .http
        .request(method, upstream_url(active, path_and_query))
        .headers(forwarded_headers(&headers, canonical_origin(active)))
        .body(reqwest::Body::wrap_stream(body.into_data_stream()))
        .send()
        .await
}

fn upstream_response(
    response: reqwest::Response,
    active: &ActiveServer,
    local_origin: &str,
) -> Response {
    let status = response.status();
    let mut builder = Response::builder().status(status);
    if let Some(headers) = builder.headers_mut() {
        headers.insert(
            HeaderName::from_static("x-athanor-native-client"),
            HeaderValue::from_static("1"),
        );
        for (name, value) in response.headers() {
            if !is_hop_by_hop(name) && name != CONTENT_LENGTH {
                if name == SET_COOKIE {
                    if let Some(value) = value.to_str().ok().and_then(local_set_cookie) {
                        headers.append(name.clone(), value);
                    } else {
                        headers.append(name.clone(), value.clone());
                    }
                    continue;
                }
                if name == LOCATION {
                    if let Ok(raw) = value.to_str() {
                        let rewritten = active.profile.endpoints.iter().find_map(|endpoint| {
                            raw.strip_prefix(endpoint)
                                .map(|suffix| format!("{local_origin}{suffix}"))
                        });
                        if let Some(rewritten) = rewritten {
                            if let Ok(rewritten) = HeaderValue::from_str(&rewritten) {
                                headers.append(name.clone(), rewritten);
                                continue;
                            }
                        }
                    }
                }
                headers.append(name.clone(), value.clone());
            }
        }
    }
    builder
        .body(Body::from_stream(response.bytes_stream()))
        .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response())
}

fn gateway_error(
    message: String,
    html: bool,
    preference: Option<NetworkPreference>,
    installer_url: &str,
) -> Response {
    if html {
        let mut response = Html(offline_page(&message, preference, installer_url)).into_response();
        let headers = response.headers_mut();
        headers.insert(
            HeaderName::from_static("content-security-policy"),
            HeaderValue::from_static(
                "default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
            ),
        );
        headers.insert(
            HeaderName::from_static("referrer-policy"),
            HeaderValue::from_static("no-referrer"),
        );
        headers.insert(
            HeaderName::from_static("x-content-type-options"),
            HeaderValue::from_static("nosniff"),
        );
        return response;
    }
    (
        StatusCode::BAD_GATEWAY,
        Json(serde_json::json!({
            "error": { "code": "server_unreachable", "message": message }
        })),
    )
        .into_response()
}

async fn proxy(State(state): State<Arc<ClientState>>, request: Request) -> Response {
    let wants_html = request.method() == Method::GET
        && request.uri().path() == "/"
        && request
            .headers()
            .get("accept")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.contains("text/html"));

    let active = match state.current().await {
        Ok(active) => active,
        Err(message) => {
            let message = if state.profile.read().await.is_none() {
                String::new()
            } else {
                message
            };
            let preference = state
                .profile
                .read()
                .await
                .as_ref()
                .map(|profile| profile.network_preference);
            return gateway_error(
                message,
                wants_html,
                preference,
                &state.installer_origin().await,
            );
        }
    };

    if request
        .headers()
        .get(UPGRADE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.eq_ignore_ascii_case("websocket"))
    {
        return websocket_proxy(state, active, request).await;
    }

    let (parts, body) = request.into_parts();
    let path_and_query = parts
        .uri
        .path_and_query()
        .map(|value| value.as_str())
        .unwrap_or("/")
        .to_owned();
    let content_length = parts
        .headers
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok());

    let response = if should_buffer_for_retry(&parts.method, &parts.headers, content_length) {
        let buffered = match to_bytes(body, RETRYABLE_BODY_LIMIT).await {
            Ok(value) => value,
            Err(_) => {
                return (
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "This request is too large for automatic address failover",
                )
                    .into_response()
            }
        };
        match send_buffered(
            &active,
            parts.method.clone(),
            &path_and_query,
            parts.headers.clone(),
            buffered.clone(),
        )
        .await
        {
            Ok(response) => Ok((response, active.clone())),
            Err(_) => {
                state.invalidate().await;
                match state.current().await {
                    Ok(refreshed) => send_buffered(
                        &refreshed,
                        parts.method,
                        &path_and_query,
                        parts.headers,
                        buffered,
                    )
                    .await
                    .map(|response| (response, refreshed)),
                    Err(message) => {
                        let preference = state
                            .profile
                            .read()
                            .await
                            .as_ref()
                            .map(|profile| profile.network_preference);
                        return gateway_error(
                            message,
                            wants_html,
                            preference,
                            &state.installer_origin().await,
                        );
                    }
                }
            }
        }
    } else {
        send_streaming(&active, parts.method, &path_and_query, parts.headers, body)
            .await
            .map(|response| (response, active.clone()))
    };

    match response {
        Ok((response, used)) => {
            if path_and_query == "/v1/auth/register/verify" && response.status().is_success() {
                if let Err(error) = state.clear_pairing_code().await {
                    eprintln!("athanor could not remove the consumed pairing code: {error}");
                }
            }
            upstream_response(response, &used, &state.local_origin().await)
        }
        Err(error) => {
            state.invalidate().await;
            let preference = state
                .profile
                .read()
                .await
                .as_ref()
                .map(|profile| profile.network_preference);
            gateway_error(
                format!("The server connection was interrupted: {error}"),
                wants_html,
                preference,
                &state.installer_origin().await,
            )
        }
    }
}

async fn websocket_proxy(
    state: Arc<ClientState>,
    active: ActiveServer,
    request: Request,
) -> Response {
    let (mut parts, _) = request.into_parts();
    let path_and_query = parts
        .uri
        .path_and_query()
        .map(|value| value.as_str())
        .unwrap_or("/")
        .to_owned();
    let incoming_headers = parts.headers.clone();
    let upgrade = match WebSocketUpgrade::from_request_parts(&mut parts, &state).await {
        Ok(upgrade) => upgrade,
        Err(rejection) => return rejection.into_response(),
    };
    let offered = incoming_headers
        .get("sec-websocket-protocol")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    let upgrade = if offered
        .split(',')
        .any(|value| value.trim() == "athanor-capability")
    {
        upgrade.protocols(["athanor-capability"])
    } else {
        upgrade
    };
    upgrade.on_upgrade(move |browser| async move {
        if let Err(error) = bridge_websocket(
            browser,
            state.clone(),
            active,
            path_and_query,
            incoming_headers,
        )
        .await
        {
            state.invalidate().await;
            eprintln!("athanor websocket gateway closed: {error}");
        }
    })
}

async fn connect_server_websocket(
    active: &ActiveServer,
    path_and_query: &str,
    incoming_headers: &HeaderMap,
) -> Result<WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>, String> {
    let target = upstream_url(active, path_and_query).replacen("https://", "wss://", 1);
    let mut request = target
        .into_client_request()
        .map_err(|error| format!("Could not create the server WebSocket request: {error}"))?;
    for name in [
        "authorization",
        "cookie",
        "sec-websocket-protocol",
        "user-agent",
    ] {
        if let Some(value) = incoming_headers.get(name) {
            request
                .headers_mut()
                .insert(HeaderName::from_static(name), value.clone());
        }
    }
    request.headers_mut().insert(
        ORIGIN,
        HeaderValue::from_str(canonical_origin(active))
            .map_err(|_| "The canonical server origin is invalid")?,
    );
    connect_async_tls_with_config(
        request,
        None,
        true,
        Some(Connector::Rustls(active.websocket_tls.clone())),
    )
    .await
    .map_err(|error| format!("Could not connect to the pinned server WebSocket: {error}"))
    .map(|(server, _)| server)
}

async fn bridge_websocket(
    browser: WebSocket,
    state: Arc<ClientState>,
    active: ActiveServer,
    path_and_query: String,
    incoming_headers: HeaderMap,
) -> Result<(), String> {
    let server = match connect_server_websocket(&active, &path_and_query, &incoming_headers).await {
        Ok(server) => server,
        Err(first_error) => {
            state.invalidate().await;
            let refreshed = state.current().await.map_err(|refresh_error| {
                format!("{first_error}; address refresh failed: {refresh_error}")
            })?;
            connect_server_websocket(&refreshed, &path_and_query, &incoming_headers)
                .await
                .map_err(|retry_error| format!("{first_error}; reconnect failed: {retry_error}"))?
        }
    };
    let (mut browser_out, mut browser_in) = browser.split();
    let (mut server_out, mut server_in) = server.split();
    loop {
        tokio::select! {
            incoming = browser_in.next() => match incoming {
                Some(Ok(message)) => {
                    let message = match message {
                        BrowserMessage::Text(value) => ServerMessage::Text(value),
                        BrowserMessage::Binary(value) => ServerMessage::Binary(value),
                        BrowserMessage::Ping(value) => ServerMessage::Ping(value),
                        BrowserMessage::Pong(value) => ServerMessage::Pong(value),
                        BrowserMessage::Close(_) => ServerMessage::Close(None),
                    };
                    server_out.send(message).await.map_err(|error| error.to_string())?;
                }
                _ => break,
            },
            incoming = server_in.next() => match incoming {
                Some(Ok(message)) => {
                    let message = match message {
                        ServerMessage::Text(value) => Some(BrowserMessage::Text(value)),
                        ServerMessage::Binary(value) => Some(BrowserMessage::Binary(value)),
                        ServerMessage::Ping(value) => Some(BrowserMessage::Ping(value)),
                        ServerMessage::Pong(value) => Some(BrowserMessage::Pong(value)),
                        ServerMessage::Close(_) => Some(BrowserMessage::Close(None)),
                        ServerMessage::Frame(_) => None,
                    };
                    if let Some(message) = message {
                        browser_out.send(message).await.map_err(|error| error.to_string())?;
                    }
                }
                _ => break,
            }
        }
    }
    Ok(())
}

fn offline_page(
    message: &str,
    preference: Option<NetworkPreference>,
    installer_url: &str,
) -> String {
    let safe_message = message
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;");
    let network_help = match preference {
        None | Some(NetworkPreference::Fixed) => String::new(),
        Some(NetworkPreference::Unknown) => r#"
  <section class="network-help" id="network-help">
    <strong>Did the server's public address change?</strong>
    <p>Some home connections and VPS plans use dynamic public IP addresses.</p>
    <div class="choice-row">
      <button class="secondary" data-network="dynamic">It may have changed</button>
      <button class="quiet" data-network="fixed">My address is fixed</button>
    </div>
  </section>"#
            .to_owned(),
        Some(NetworkPreference::Dynamic) => r#"
  <section class="network-help" id="network-help">
    <strong>A stable hostname prevents this next time</strong>
    <ol>
      <li>Choose a dynamic-DNS hostname from your router, VPS provider, DuckDNS, or your own DNS provider.</li>
      <li>Keep that hostname updated to the server's current public IP and ensure TCP 443 reaches athanor.</li>
      <li>On the server run <code>sudo athanor set-hostname your-name.example.com</code>, then scan the refreshed QR ticket.</li>
    </ol>
    <p class="privacy">Dynamic DNS learns the hostname and IP required to provide DNS. It never bypasses athanor's pinned identity, passkey, or TLS checks.</p>
  </section>"#
            .to_owned(),
    };
    format!(
        r#"<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect athanor</title>
<style>
  :root {{ color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }}
  * {{ box-sizing: border-box; }}
  body {{ margin: 0; min-height: 100vh; display: grid; place-items: center; color: #f1f2f2;
    background: radial-gradient(circle at 50% 0%, #25282b 0, #111315 42%, #090a0b 100%); }}
  main {{ width: min(580px, calc(100vw - 32px)); padding: 36px; border-radius: 24px;
    border: 1px solid #555a5f; background: rgba(22,24,26,.92);
    box-shadow: 0 24px 80px #000a, inset 0 1px #ffffff1a; }}
  .brand {{ font-size: 22px; letter-spacing: .02em; margin-bottom: 44px; }}
  .eyebrow {{ color: #aeb3b7; text-transform: uppercase; letter-spacing: .14em; font-size: 11px; }}
  h1 {{ font-size: clamp(29px, 5vw, 42px); line-height: 1.05; margin: 10px 0 14px; }}
  p {{ color: #b9bdc0; line-height: 1.55; }}
  textarea {{ width: 100%; min-height: 120px; resize: vertical; margin: 18px 0 12px; padding: 15px;
    color: #f4f5f5; background: #0d0f10; border: 1px solid #484d51; border-radius: 14px; outline: none; }}
  textarea:focus {{ border-color: #d8dbdd; box-shadow: 0 0 0 3px #e9ecef14, 0 0 28px #dfe3e61c; }}
  button {{ width: 100%; border: 1px solid #e6e9eb; border-radius: 13px; padding: 13px 18px;
    color: #111315; background: linear-gradient(110deg,#f6f7f7,#bfc4c7,#f3f4f4); font-weight: 720;
    cursor: pointer; box-shadow: 0 0 24px #eef2f329; }}
  button:disabled {{ opacity: .55; cursor: wait; }}
  .error {{ min-height: 24px; margin-top: 12px; color: #e6a8a8; font-size: 13px; }}
  .hint {{ font-size: 13px; }}
  .network-help {{ margin-top: 22px; padding-top: 20px; border-top: 1px solid #3c4145; }}
  .network-help strong {{ display: block; margin-bottom: 4px; }}
  .network-help ol {{ padding-left: 21px; color: #c7cbcd; line-height: 1.55; }}
  .network-help code {{ color: #f0f1f2; }}
  .choice-row {{ display: grid; grid-template-columns: 1fr 1fr; gap: 9px; margin-top: 12px; }}
  .choice-row button {{ padding: 10px; }}
  button.secondary {{ color: #eceeef; background: #24272a; border-color: #697075; box-shadow: none; }}
  button.quiet {{ color: #b9bdc0; background: transparent; border-color: #3e4347; box-shadow: none; }}
  .privacy {{ font-size: 12px; }}
  .install-link {{ display: block; margin-top: 18px; color: #aeb3b7; text-align: center; font-size: 13px; }}
</style>
<main>
  <div class="brand">athanor</div>
  <div class="eyebrow">Private server connection</div>
  <h1>Connect your AI computer</h1>
  <p>Paste the one-time connection ticket printed after installing athanor. The app will pin your server’s permanent identity and follow its address when the IP changes.</p>
  <textarea id="ticket" spellcheck="false" autocomplete="off" placeholder="athanor://pair/…"></textarea>
  <button id="connect">Connect securely</button>
  <div class="error" id="error">{safe_message}</div>
  <p class="hint">The server’s SSH login, IP address, and TLS warnings are not needed here.</p>
  <a class="install-link" href="{installer_url}">Install athanor on a cloud server</a>
  {network_help}
</main>
<script>
  const button = document.querySelector('#connect');
  const error = document.querySelector('#error');
  button.addEventListener('click', async () => {{
    button.disabled = true; error.textContent = 'Verifying server identity…';
    try {{
      const response = await fetch('/__athanor/client/pair', {{
        method: 'POST', headers: {{'content-type':'application/json'}},
        body: JSON.stringify({{ticket: document.querySelector('#ticket').value.trim()}})
      }});
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message || 'Connection failed');
      location.replace('/');
    }} catch (cause) {{
      error.textContent = cause.message || 'Connection failed'; button.disabled = false;
    }}
  }});
  document.querySelectorAll('[data-network]').forEach((choice) => {{
    choice.addEventListener('click', async () => {{
      const preference = choice.dataset.network;
      const response = await fetch('/__athanor/client/network-preference', {{
        method: 'POST',
        headers: {{'content-type': 'application/json'}},
        body: JSON.stringify({{preference}})
      }});
      if (!response.ok) return;
      if (preference === 'fixed') document.querySelector('#network-help')?.remove();
      else location.reload();
    }});
  }});
</script>
</html>"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection::{save_profile, Discovery, ServerProfile};

    #[test]
    fn strips_hop_by_hop_headers_and_rewrites_browser_origin() {
        let mut input = HeaderMap::new();
        input.insert(
            axum::http::header::CONNECTION,
            HeaderValue::from_static("keep-alive"),
        );
        input.insert(HOST, HeaderValue::from_static("localhost:41000"));
        input.insert(ORIGIN, HeaderValue::from_static("http://localhost:41000"));
        input.insert(
            COOKIE,
            HeaderValue::from_static("theme=dark; athanor_native_session=private-value"),
        );
        let result = forwarded_headers(&input, "https://ai.example.test");
        assert!(!result.contains_key(axum::http::header::CONNECTION));
        assert!(!result.contains_key(HOST));
        assert_eq!(
            result.get(ORIGIN).unwrap(),
            &HeaderValue::from_static("https://ai.example.test")
        );
        assert_eq!(
            result.get(COOKIE).unwrap(),
            &HeaderValue::from_static("theme=dark; __Host-athanor_session=private-value")
        );
    }

    #[test]
    fn translates_the_secure_server_session_for_the_loopback_origin() {
        assert_eq!(
            local_set_cookie(
                "__Host-athanor_session=private-value; Path=/; HttpOnly; Secure; SameSite=Lax"
            )
            .unwrap(),
            HeaderValue::from_static(
                "athanor_native_session=private-value; Path=/; HttpOnly; SameSite=Lax"
            )
        );
        assert!(local_set_cookie("unrelated=value; Secure").is_none());
    }

    #[test]
    fn streams_large_or_unknown_mutations_instead_of_rejecting_them() {
        let mut idempotent = HeaderMap::new();
        idempotent.insert("idempotency-key", HeaderValue::from_static("operation-1"));
        assert!(should_buffer_for_retry(
            &Method::PUT,
            &idempotent,
            Some(1024)
        ));
        assert!(!should_buffer_for_retry(
            &Method::PUT,
            &idempotent,
            Some(RETRYABLE_BODY_LIMIT + 1)
        ));
        assert!(!should_buffer_for_retry(&Method::PUT, &idempotent, None));
        assert!(should_buffer_for_retry(
            &Method::GET,
            &HeaderMap::new(),
            None
        ));
    }

    #[test]
    fn escapes_connection_errors_in_the_local_onboarding_page() {
        let page = offline_page(
            "<script>alert(\"x\")</script>",
            Some(NetworkPreference::Unknown),
            "http://localhost:49123",
        );
        assert!(!page.contains("<script>alert"));
        assert!(page.contains("&lt;script&gt;"));
        assert!(page.contains("Did the server's public address change?"));
        assert!(page.contains("http://localhost:49123"));
        assert!(!offline_page(
            "offline",
            Some(NetworkPreference::Fixed),
            "http://localhost:49123"
        )
        .contains("public address change"));
        assert!(!offline_page("", None, "http://localhost:49123").contains("public address change"));
    }

    #[tokio::test]
    async fn loads_pending_pairing_only_from_the_explicit_cache_path() {
        let directory =
            std::env::temp_dir().join(format!("athanor-pairing-cache-{}", uuid::Uuid::new_v4()));
        let data_directory = directory.join("data");
        let cache_directory = directory.join("cache");
        let profile_path = data_directory.join("server-profile.json");
        let pending_path = cache_directory.join("pending-pairing.json");
        save_pending_pairing(
            &pending_path,
            "temporary-pairing-code-1234567890".into(),
            u64::MAX,
        )
        .unwrap();

        let state = ClientState::load(profile_path.clone(), pending_path.clone()).unwrap();
        assert_eq!(
            state
                .pairing_code
                .read()
                .await
                .as_ref()
                .map(|pending| pending.pairing_code.as_str()),
            Some("temporary-pairing-code-1234567890")
        );
        assert!(!profile_path.with_file_name("pending-pairing.json").exists());
        assert!(pending_path.exists());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn proxies_the_live_pinned_server_when_explicitly_requested() {
        let Ok(path) = std::env::var("ATHANOR_LIVE_MANIFEST") else {
            return;
        };
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct LiveManifest {
            identity: String,
            endpoints: Vec<String>,
            discovery: Discovery,
        }
        let manifest: LiveManifest = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let directory =
            std::env::temp_dir().join(format!("athanor-live-proxy-{}", uuid::Uuid::new_v4()));
        let profile_path = directory.join("server-profile.json");
        save_profile(
            &profile_path,
            &ServerProfile {
                version: 1,
                identity: manifest.identity,
                endpoints: manifest.endpoints,
                discovery: manifest.discovery,
                last_endpoint: None,
                network_preference: NetworkPreference::Unknown,
            },
        )
        .unwrap();
        let state =
            ClientState::load(profile_path, directory.join("pending-pairing.json")).unwrap();
        let origin = start(state).await.unwrap();
        let response = reqwest::Client::new()
            .get(format!("{origin}/healthz"))
            .send()
            .await
            .unwrap();
        assert!(response.status().is_success());
        assert_eq!(
            response
                .headers()
                .get("x-athanor-native-client")
                .and_then(|value| value.to_str().ok()),
            Some("1")
        );
        std::fs::remove_dir_all(directory).unwrap();
    }
}
