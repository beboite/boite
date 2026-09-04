use std::net::TcpListener;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use reqwest::{Method, Response};
use serde_json::{json, Value};
use tokio::sync::mpsc;

use super::protocol;
use crate::driver::{ExecMode, OpenSpec, PilotError};
use crate::proc::Line;

const START_TIMEOUT: Duration = Duration::from_secs(30);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone)]
pub(super) struct Api {
    client: reqwest::Client,
    base_url: Arc<str>,
    directory: Arc<str>,
    password: Option<Arc<str>>,
}

impl Api {
    pub fn new(
        base_url: String,
        directory: &Path,
        password: Option<String>,
    ) -> Result<Self, PilotError> {
        let client = reqwest::Client::builder()
            .build()
            .map_err(|error| PilotError::Protocol(error.to_string()))?;
        Ok(Self {
            client,
            base_url: base_url.trim_end_matches('/').to_string().into(),
            directory: directory.to_string_lossy().to_string().into(),
            password: password.map(Into::into),
        })
    }

    fn request(&self, method: Method, path: &str) -> reqwest::RequestBuilder {
        let request = self
            .client
            .request(method, format!("{}{}", self.base_url, path))
            .query(&[("directory", self.directory.as_ref())]);
        match &self.password {
            Some(password) => request.basic_auth("opencode", Some(password.as_ref())),
            None => request,
        }
    }

    pub async fn json(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, PilotError> {
        self.json_with_timeout(method, path, body, REQUEST_TIMEOUT)
            .await
    }

    pub async fn json_with_timeout(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        timeout: Duration,
    ) -> Result<Value, PilotError> {
        let request = match body {
            Some(body) => self.request(method, path).json(&body),
            None => self.request(method, path),
        };
        tokio::time::timeout(timeout, async {
            let response = request.send().await.map_err(http_error)?;
            read_json(response).await
        })
        .await
        .map_err(|_| PilotError::Timeout)?
    }

    pub async fn optional_json(
        &self,
        method: Method,
        path: &str,
    ) -> Result<Option<Value>, PilotError> {
        tokio::time::timeout(REQUEST_TIMEOUT, async {
            let response = self
                .request(method, path)
                .send()
                .await
                .map_err(http_error)?;
            if response.status() == reqwest::StatusCode::NOT_FOUND {
                return Ok(None);
            }
            read_json(response).await.map(Some)
        })
        .await
        .map_err(|_| PilotError::Timeout)?
    }

    pub async fn event_response(&self) -> Result<Response, PilotError> {
        self.request(Method::GET, "/event")
            .header("Accept", "text/event-stream")
            .send()
            .await
            .map_err(http_error)?
            .error_for_status()
            .map_err(http_error)
    }
}

fn http_error(error: reqwest::Error) -> PilotError {
    PilotError::Protocol(error.without_url().to_string())
}

async fn read_json(mut response: Response) -> Result<Value, PilotError> {
    let status = response.status();
    if !status.is_success() {
        // Provider bodies can contain prompts, configuration or credentials.
        return Err(PilotError::Protocol(format!(
            "OpenCode HTTP {}",
            status.as_u16(),
        )));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(http_error)? {
        if bytes.len() + chunk.len() > 8 * 1024 * 1024 {
            return Err(PilotError::Protocol(
                "OpenCode response exceeds 8 MiB".into(),
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    if bytes.is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_slice(&bytes)
        .map_err(|error| PilotError::Protocol(format!("invalid OpenCode response: {error}")))
}

pub(super) fn reserve_port() -> Result<u16, PilotError> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    Ok(listener.local_addr()?.port())
}

pub(super) async fn wait_for_ready(
    rx: &mut mpsc::UnboundedReceiver<Line>,
) -> Result<String, PilotError> {
    let wait = async {
        let mut startup = String::new();
        while let Some(line) = rx.recv().await {
            match line {
                Line::Out(line) => {
                    if let Some(url) = protocol::parse_ready_url(&line) {
                        return Ok(url);
                    }
                    push_startup(&mut startup, &line);
                }
                Line::Err(line) => push_startup(&mut startup, &line),
                Line::Eof => {
                    return Err(PilotError::Spawn(format!(
                        "OpenCode exited before it was ready: {}",
                        startup.trim()
                    )))
                }
            }
        }
        Err(PilotError::Spawn(
            "OpenCode closed its output during startup".into(),
        ))
    };
    tokio::time::timeout(START_TIMEOUT, wait)
        .await
        .map_err(|_| PilotError::Timeout)?
}

fn push_startup(output: &mut String, line: &str) {
    output.push_str(line);
    output.push('\n');
    if output.len() > 4096 {
        let mut start = output.len() - 4096;
        while !output.is_char_boundary(start) {
            start += 1;
        }
        output.drain(..start);
    }
}

pub(super) async fn verify_health(api: &Api) -> Result<String, PilotError> {
    let health = api.json(Method::GET, "/global/health", None).await?;
    let version = health["version"]
        .as_str()
        .ok_or_else(|| PilotError::Protocol("OpenCode health response has no version".into()))?;
    if !health["healthy"].as_bool().unwrap_or(false) {
        return Err(PilotError::Protocol(
            "OpenCode server is not healthy".into(),
        ));
    }
    if !protocol::version_at_least(version, protocol::MINIMUM_VERSION) {
        return Err(PilotError::Protocol(format!(
            "OpenCode {version} is too old; {} or newer is required",
            protocol::MINIMUM_VERSION
        )));
    }
    Ok(version.to_string())
}

pub(super) async fn adopt_or_create(
    api: &Api,
    spec: &OpenSpec,
    mode: ExecMode,
) -> Result<Value, PilotError> {
    if let Some(resume) = &spec.resume {
        if let Some(adopted) = api
            .optional_json(Method::GET, &format!("/session/{resume}"))
            .await?
        {
            let same_directory = adopted["directory"]
                .as_str()
                .is_none_or(|directory| paths_equal(directory, &spec.cwd));
            let session = if same_directory {
                api.json(
                    Method::PATCH,
                    &format!("/session/{resume}"),
                    Some(json!({ "permission": protocol::permission_rules(mode) })),
                )
                .await?
            } else {
                let forked = api
                    .json(
                        Method::POST,
                        &format!("/session/{resume}/fork"),
                        Some(json!({})),
                    )
                    .await?;
                let id = forked["id"].as_str().ok_or_else(|| {
                    PilotError::Protocol("OpenCode fork returned no session id".into())
                })?;
                api.json(
                    Method::PATCH,
                    &format!("/session/{id}"),
                    Some(json!({ "permission": protocol::permission_rules(mode) })),
                )
                .await?
            };
            return Ok(session);
        }
    }
    api.json(
        Method::POST,
        "/session",
        Some(json!({ "permission": protocol::permission_rules(mode) })),
    )
    .await
}

fn paths_equal(left: &str, right: &Path) -> bool {
    let left = std::fs::canonicalize(left).unwrap_or_else(|_| left.into());
    let right = std::fs::canonicalize(right).unwrap_or_else(|_| right.to_path_buf());
    if cfg!(windows) {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    } else {
        left == right
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn serve(response: &'static str, hold: bool) -> (Api, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 4096];
            let bytes_read = stream.read(&mut request).await.unwrap();
            assert!(bytes_read > 0);
            stream.write_all(response.as_bytes()).await.unwrap();
            if hold {
                std::future::pending::<()>().await;
            }
        });
        (Api::new(url, Path::new("."), None).unwrap(), task)
    }

    #[tokio::test]
    async fn timeout_includes_body_read_after_headers() {
        let (api, task) = serve("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n", true).await;
        let result = api
            .json_with_timeout(Method::GET, "/", None, Duration::from_millis(50))
            .await;
        task.abort();
        let _ = task.await;
        assert!(matches!(result, Err(PilotError::Timeout)));
    }

    #[tokio::test]
    async fn error_body_is_not_exposed() {
        let (api, task) = serve(
            "HTTP/1.1 403 Forbidden\r\nContent-Length: 18\r\n\r\nprivate-error-body",
            false,
        )
        .await;
        let error = api
            .json(Method::GET, "/", None)
            .await
            .unwrap_err()
            .to_string();
        task.await.unwrap();
        assert!(error.contains("403"));
        assert!(!error.contains("private-error-body"));
    }

    #[test]
    fn startup_tail_never_splits_utf8() {
        let mut output = String::new();
        push_startup(&mut output, &"é".repeat(4096));
        assert!(output.len() <= 4096);
        assert!(output.ends_with('\n'));
    }
}
