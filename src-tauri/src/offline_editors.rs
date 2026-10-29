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
