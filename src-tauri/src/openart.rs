use std::{sync::Arc, time::Duration};

use anyhow::{Context, Result};
use axum::{
    extract::{Query, State as AxumState},
    response::Html,
    routing::get,
    Router,
};
use rmcp::{
    model::{CallToolRequestParams, ClientInfo},
    service::{RoleClient, RunningService},
    transport::{
        auth::{
            AuthClient, AuthError, AuthorizationManager, AuthorizationRequest, CredentialStore,
            OAuthState, StoredCredentials,
        },
        streamable_http_client::StreamableHttpClientTransportConfig,
        StreamableHttpClientTransport,
    },
    ServiceExt,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;
use tokio::sync::{oneshot, Mutex, RwLock};

const OPENART_MCP_URL: &str = "https://mcp.openart.ai/mcp";
const KEYRING_SERVICE: &str = "FrameFlow Studio";
const KEYRING_USER: &str = "openart-oauth";

type McpClient = RunningService<RoleClient, ClientInfo>;

pub struct OpenArtClientState {
    client: Mutex<Option<McpClient>>,
    credentials: KeyringCredentialStore,
}

impl Default for OpenArtClientState {
    fn default() -> Self {
        Self {
            client: Mutex::new(None),
            credentials: KeyringCredentialStore::default(),
        }
    }
}

#[derive(Debug, Deserialize)]
struct CallbackParams {
    code: String,
    state: String,
    iss: Option<String>,
}

#[derive(Clone)]
struct CallbackState {
    sender: Arc<Mutex<Option<oneshot::Sender<CallbackParams>>>>,
}

#[derive(Clone, Default)]
struct KeyringCredentialStore {
    memory: Arc<RwLock<Option<StoredCredentials>>>,
}

impl KeyringCredentialStore {
    fn entry() -> Result<keyring::Entry, AuthError> {
        keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
            .map_err(|e| AuthError::InternalError(e.to_string()))
    }
}

#[async_trait::async_trait]
impl CredentialStore for KeyringCredentialStore {
    async fn load(&self) -> Result<Option<StoredCredentials>, AuthError> {
        if let Some(credentials) = self.memory.read().await.clone() {
            return Ok(Some(credentials));
        }
        match Self::entry()?.get_password() {
            Ok(value) => {
                let credentials: StoredCredentials = serde_json::from_str(&value)
                    .map_err(|e| AuthError::InternalError(e.to_string()))?;
                *self.memory.write().await = Some(credentials.clone());
                Ok(Some(credentials))
            }
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(AuthError::InternalError(error.to_string())),
        }
    }

    async fn save(&self, credentials: StoredCredentials) -> Result<(), AuthError> {
        let value = serde_json::to_string(&credentials)
            .map_err(|e| AuthError::InternalError(e.to_string()))?;
        *self.memory.write().await = Some(credentials);
        Self::entry()?
            .set_password(&value)
            .map_err(|e| AuthError::InternalError(e.to_string()))
    }

    async fn clear(&self) -> Result<(), AuthError> {
        *self.memory.write().await = None;
        match Self::entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(AuthError::InternalError(error.to_string())),
        }
    }
}

async fn oauth_state(
    client: reqwest::Client,
    credentials: KeyringCredentialStore,
) -> Result<OAuthState> {
    let mut manager = AuthorizationManager::new(OPENART_MCP_URL).await?;
    manager.with_client(client)?;
    manager.set_credential_store(credentials);
    if manager.initialize_from_store().await? {
        Ok(OAuthState::Authorized(manager))
    } else {
        Ok(OAuthState::Unauthorized(manager))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenArtStatus {
    connected: bool,
    endpoint: &'static str,
    tool_count: usize,
    tools: Vec<Value>,
    message: String,
}

async fn callback_handler(
    Query(params): Query<CallbackParams>,
    AxumState(state): AxumState<CallbackState>,
) -> Html<&'static str> {
    if let Some(sender) = state.sender.lock().await.take() {
        let _ = sender.send(params);
    }
    Html("<!doctype html><html><head><meta charset='utf-8'><title>FrameFlow</title></head><body style='font-family:system-ui;padding:48px;background:#f2f7f3;color:#173f39'><h1>OpenArt 연결 완료</h1><p>FrameFlow Studio로 돌아가세요. 이 창은 닫아도 됩니다.</p></body></html>")
}

enum ConnectOutcome {
    Connected(McpClient),
    AuthRequired(String),
}

async fn try_connect() -> Result<ConnectOutcome> {
    let transport = StreamableHttpClientTransport::with_client(
        reqwest::Client::default(),
        StreamableHttpClientTransportConfig::with_uri(OPENART_MCP_URL),
    );
    match ClientInfo::default().serve(transport).await {
        Ok(client) => Ok(ConnectOutcome::Connected(client)),
        Err(error) => match error.auth_challenge() {
            Some(challenge) => Ok(ConnectOutcome::AuthRequired(challenge.to_string())),
            None => Err(error.into()),
        },
    }
}

async fn tools_as_values(client: &McpClient) -> Result<Vec<Value>> {
    client
        .peer()
        .list_all_tools()
        .await?
        .into_iter()
        .map(|tool| serde_json::to_value(tool).map_err(Into::into))
        .collect()
}

async fn connect_authorized(manager: AuthorizationManager) -> Result<McpClient> {
    // Pass the freshly issued token explicitly on the initialize request. Some
    // hosted MCP gateways reject initialize before the reactive AuthClient layer
    // gets a chance to resolve credentials from its store.
    let access_token = manager
        .get_access_token()
        .await
        .context("OAuth access token unavailable")?;
    let auth_client = AuthClient::new(reqwest::Client::default(), manager);
    let config =
        StreamableHttpClientTransportConfig::with_uri(OPENART_MCP_URL).auth_header(access_token);
    let transport = StreamableHttpClientTransport::with_client(auth_client, config);
    ClientInfo::default()
        .serve(transport)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn openart_connect(
    state: State<'_, OpenArtClientState>,
) -> Result<OpenArtStatus, String> {
    if let Some(client) = state.client.lock().await.as_ref() {
        let tools = tools_as_values(client).await.map_err(|e| e.to_string())?;
        return Ok(OpenArtStatus {
            connected: true,
            endpoint: OPENART_MCP_URL,
            tool_count: tools.len(),
            tools,
            message: "이미 연결되어 있습니다.".into(),
        });
    }

    let client = match try_connect().await.map_err(|e| e.to_string())? {
        ConnectOutcome::Connected(client) => client,
        ConnectOutcome::AuthRequired(challenge) => {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
                .await
                .map_err(|e| e.to_string())?;
            let port = listener.local_addr().map_err(|e| e.to_string())?.port();
            let redirect_uri = format!("http://127.0.0.1:{port}/callback");
            let (sender, receiver) = oneshot::channel();
            let callback_state = CallbackState {
                sender: Arc::new(Mutex::new(Some(sender))),
            };
            let router = Router::new()
                .route("/callback", get(callback_handler))
                .with_state(callback_state);
            let server = tokio::spawn(async move {
                let _ = axum::serve(listener, router).await;
            });

            let oauth_client = reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .map_err(|e| e.to_string())?;
            let mut oauth = oauth_state(oauth_client, state.credentials.clone())
                .await
                .map_err(|e| e.to_string())?;
            if !matches!(&oauth, OAuthState::Authorized(_)) {
                oauth
                    .start_authorization(
                        AuthorizationRequest::new(&redirect_uri)
                            .with_client_name("FrameFlow Studio")
                            .with_challenge(challenge),
                    )
                    .await
                    .map_err(|e| e.to_string())?;
                let auth_url = oauth
                    .get_authorization_url()
                    .await
                    .map_err(|e| e.to_string())?;
                open::that(auth_url).map_err(|e| e.to_string())?;
                let params = tokio::time::timeout(Duration::from_secs(300), receiver)
                    .await
                    .map_err(|_| "OpenArt 로그인 시간이 초과되었습니다.".to_string())?
                    .map_err(|e| e.to_string())?;
                oauth
                    .handle_callback_with_issuer(&params.code, &params.state, params.iss.as_deref())
                    .await
                    .map_err(|e| e.to_string())?;
            }
            server.abort();
            let manager = oauth
                .into_authorization_manager()
                .context("OAuth authorization manager unavailable")
                .map_err(|e| e.to_string())?;
            match connect_authorized(manager).await {
                Ok(client) => client,
                Err(error) => {
                    let _ = state.credentials.clear().await;
                    return Err(format!("OpenArt OAuth 연결 초기화에 실패했습니다. 저장된 인증을 초기화했으니 연결 버튼을 눌러 다시 승인해 주세요. ({error:#})"));
                }
            }
        }
    };

    let tools = tools_as_values(&client).await.map_err(|e| e.to_string())?;
    let status = OpenArtStatus {
        connected: true,
        endpoint: OPENART_MCP_URL,
        tool_count: tools.len(),
        tools,
        message: "OpenArt MCP가 연결되었습니다.".into(),
    };
    *state.client.lock().await = Some(client);
    Ok(status)
}

#[tauri::command]
pub async fn openart_disconnect(state: State<'_, OpenArtClientState>) -> Result<(), String> {
    if let Some(client) = state.client.lock().await.take() {
        client.cancel().await.map_err(|e| e.to_string())?;
    }
    state.credentials.clear().await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn openart_status(state: State<'_, OpenArtClientState>) -> Result<OpenArtStatus, String> {
    let guard = state.client.lock().await;
    if let Some(client) = guard.as_ref() {
        let tools = tools_as_values(client).await.map_err(|e| e.to_string())?;
        Ok(OpenArtStatus {
            connected: true,
            endpoint: OPENART_MCP_URL,
            tool_count: tools.len(),
            tools,
            message: "연결됨".into(),
        })
    } else {
        Ok(OpenArtStatus {
            connected: false,
            endpoint: OPENART_MCP_URL,
            tool_count: 0,
            tools: vec![],
            message: "연결되지 않음".into(),
        })
    }
}

#[tauri::command]
pub async fn openart_list_tools(
    state: State<'_, OpenArtClientState>,
) -> Result<Vec<Value>, String> {
    let guard = state.client.lock().await;
    let client = guard
        .as_ref()
        .ok_or_else(|| "OpenArt MCP가 연결되지 않았습니다.".to_string())?;
    tools_as_values(client).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn openart_call_tool(
    state: State<'_, OpenArtClientState>,
    tool_name: String,
    arguments: Value,
) -> Result<Value, String> {
    let guard = state.client.lock().await;
    let client = guard
        .as_ref()
        .ok_or_else(|| "OpenArt MCP가 연결되지 않았습니다.".to_string())?;
    let object = arguments
        .as_object()
        .cloned()
        .ok_or_else(|| "도구 인자는 JSON 객체여야 합니다.".to_string())?;
    let result = client
        .peer()
        .call_tool(CallToolRequestParams::new(tool_name).with_arguments(object))
        .await
        .map_err(|e| e.to_string())?;
    serde_json::to_value(result).map_err(|e| e.to_string())
}
