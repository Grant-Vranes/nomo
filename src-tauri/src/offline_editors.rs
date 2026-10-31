//! 离线图形编辑器资源服务：`drawio-local://` 与 `excalidraw-local://` 自定义协议。
//! 只从打包资源目录（resources/drawio、resources/excalidraw）读取文件，
//! 运行时绝不请求远程编辑器资源；路径穿越一律 403/404。

use std::borrow::Cow;
use std::path::{Component, Path};

use tauri::Manager as _;

use percent_encoding::percent_decode_str;

/// 从打包资源目录解析并读取请求路径，返回 (mime, bytes)。
fn resolve_asset(
    app: &tauri::AppHandle<tauri::Wry>,
    dir: &str,
    uri: &http::Uri,
) -> Result<(String, Vec<u8>), String> {
    let raw = percent_decode_str(uri.path())
        .decode_utf8()
        .map_err(|_| "非法路径编码".to_string())?
        .into_owned();
    let trimmed = raw.trim_start_matches('/');
    let trimmed = if trimmed.is_empty() {
        "index.html"
    } else {
        trimmed
    };

    let rel = Path::new(trimmed);
    // 拒绝绝对路径与 .. 穿越
    for component in rel.components() {
        match component {
            Component::Normal(_) => {}
            _ => return Err("路径穿越被拒绝".to_string()),
        }
    }
    let mut rel = rel.to_path_buf();
    if is_dir_like(&rel) {
        rel.push("index.html");
    }

    let root = app
        .path()
        .resource_dir()
        .map_err(|error| format!("读取资源目录失败：{error}"))?
        .join("resources")
        .join(dir);
    let full = root.join(&rel);
    let canonical = full
        .canonicalize()
        .map_err(|error| format!("资源不存在：{error}"))?;
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("资源目录不存在：{error}"))?;
    if !canonical.starts_with(&canonical_root) {
        return Err("路径穿越被拒绝".to_string());
    }
    let bytes = std::fs::read(&canonical).map_err(|error| format!("读取资源失败：{error}"))?;
    Ok((mime_for(&rel), bytes))
}

/// WebView 对目录路径的请求可能不带尾斜杠；统一交给文件系统判断。
fn is_dir_like(p: &Path) -> bool {
    p.extension().is_none()
}

fn mime_for(path: &Path) -> String {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "xml" => "application/xml; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "eot" => "application/vnd.ms-fontobject",
        "wasm" => "application/wasm",
        "txt" => "text/plain; charset=utf-8",
        "mp3" => "audio/mpeg",
        "mp4" => "video/mp4",
        _ => "application/octet-stream",
    }
    .to_string()
}

fn error_response(status: u16, message: &str) -> http::Response<Cow<'static, [u8]>> {
    http::Response::builder()
        .status(status)
        .header("Content-Type", "text/plain; charset=utf-8")
        .body(Cow::Owned(message.as_bytes().to_vec()))
        .unwrap()
}

// ---------------------------------------------------------------------------
// macOS 本地 HTTP 服务：WKWebView 的 WKURLSchemeHandler 只处理主框架请求，
// iframe 子框架加载自定义协议（drawio-local://）会失败，导致嵌入编辑器无法
// 初始化。因此在 macOS 上额外启动一个仅绑定 127.0.0.1 的本地 HTTP 服务，
// 用 `http://127.0.0.1:<port>/drawio/...` 供 iframe 使用。
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
use std::cell::RefCell;

#[cfg(target_os = "macos")]
thread_local! {
    static EDITOR_SERVER_PORT: RefCell<Option<u16>> = const { RefCell::new(None) };
}

/// 启动本地编辑器资源 HTTP 服务，返回监听端口。仅监听 127.0.0.1。
#[cfg(target_os = "macos")]
pub(crate) fn start_local_editor_server(app: tauri::AppHandle<tauri::Wry>) -> Result<u16, String> {
    use std::io::{Read as _, Write as _};

    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|error| format!("绑定本地编辑器服务端口失败：{error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("读取本地编辑器服务端口失败：{error}"))?
        .port();

    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let app = app.clone();
            std::thread::spawn(move || {
                let mut buffer = [0u8; 8192];
                let read = match stream.read(&mut buffer) {
                    Ok(n) if n > 0 => n,
                    _ => return,
                };
                let request = String::from_utf8_lossy(&buffer[..read]);
                // 请求行形如 `GET /drawio/index.html?x=y HTTP/1.1`
                let target = request.split_whitespace().nth(1).unwrap_or("/");
                // TODO: 临时调试日志，验证 iframe 请求是否到达本地服务
                eprintln!("[editor-server] {} {}", stream.peer_addr().map(|a| a.to_string()).unwrap_or_default(), target);
                let response = handle_local_request(&app, target);
                if write_response(&mut stream, &response).is_err() {
                    crate::app_logger::warn("OfflineEditors", "本地编辑器服务响应写入失败");
                }
            });
        }
    });

    crate::app_logger::info(
        "OfflineEditors",
        &format!("本地编辑器资源服务已启动，端口：{port}"),
    );
    Ok(port)
}

/// 查询本地编辑器资源服务端口；服务未启动（或非 macOS）返回 None。
#[cfg(target_os = "macos")]
#[tauri::command]
pub(crate) fn editor_local_server_port() -> Option<u16> {
    EDITOR_SERVER_PORT.with(|cell| *cell.borrow())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub(crate) fn editor_local_server_port() -> Option<u16> {
    None
}

#[cfg(target_os = "macos")]
pub(crate) fn store_editor_server_port(port: u16) {
    EDITOR_SERVER_PORT.with(|cell| *cell.borrow_mut().insert(port));
}

/// 解析 `/drawio/...`、`/excalidraw/...` 请求并复用现有资源解析逻辑。
#[cfg(target_os = "macos")]
fn handle_local_request(
    app: &tauri::AppHandle<tauri::Wry>,
    target: &str,
) -> http::Response<Cow<'static, [u8]>> {
    let path = target.split('?').next().unwrap_or("/");
    let trimmed = path.trim_start_matches('/');
    let (dir, rest) = match trimmed.split_once('/') {
        Some((dir, rest)) => (dir, rest),
        // `/drawio` → 目录索引
        None if trimmed == "drawio" || trimmed == "excalidraw" => (trimmed, "index.html"),
        _ => {
            return error_response(404, "未知的编辑器资源路径");
        }
    };
    if dir != "drawio" && dir != "excalidraw" {
        return error_response(404, "未知的编辑器资源路径");
    }
    let uri = http::Uri::builder()
        .path_and_query(format!("/{rest}"))
        .build()
        .map_err(|error| format!("非法请求路径：{error}"));
    let Ok(uri) = uri else {
        return error_response(400, "非法请求路径");
    };
    serve_offline_asset(app, dir, &uri)
}

#[cfg(target_os = "macos")]
fn write_response(
    stream: &mut std::net::TcpStream,
    response: &http::Response<Cow<'static, [u8]>>,
) -> std::io::Result<()> {
    use std::io::Write as _;
    use std::fmt::Write as _;

    let mut head = String::with_capacity(256);
    let _ = write!(
        head,
        "HTTP/1.1 {} {}\r\n",
        response.status().as_u16(),
        response.status().canonical_reason().unwrap_or("OK")
    );
    for (name, value) in response.headers() {
        let Ok(value) = value.to_str() else { continue };
        let _ = write!(head, "{}: {}\r\n", name.as_str(), value);
    }
    let _ = write!(head, "Content-Length: {}\r\n", response.body().len());
    head.push_str("Connection: close\r\n\r\n");
    stream.write_all(head.as_bytes())?;
    stream.write_all(response.body())?;
    stream.flush()
}

/// Tauri 自定义协议入口：从打包资源目录安全地返回静态文件。
pub(crate) fn serve_offline_asset(
    app: &tauri::AppHandle<tauri::Wry>,
    dir: &str,
    uri: &http::Uri,
) -> http::Response<Cow<'static, [u8]>> {
    match resolve_asset(app, dir, uri) {
        Ok((mime, bytes)) => http::Response::builder()
            .status(200)
            .header("Content-Type", mime)
            .header("Access-Control-Allow-Origin", "*")
            .header("Cache-Control", "no-cache")
            .body(Cow::Owned(bytes))
            .unwrap(),
        Err(error) => {
            let forbidden = error.contains("拒绝");
            crate::app_logger::warn("OfflineEditors", &format!("{dir} 资源请求失败：{error}"));
            error_response(if forbidden { 403 } else { 404 }, &error)
        }
    }
}
