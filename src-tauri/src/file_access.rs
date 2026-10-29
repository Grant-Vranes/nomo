//! 有界、授权的文件读写入口。
//!
//! 外部打开（对话框、拖放、文件关联、最近文件）统一经由这里规范化路径并授权后
//! 才允许读取。文本类文件强制 16 MiB 上限、有效 UTF-8（容忍 BOM）、拒绝 NUL 字节；
//! 二进制查看器（图片/PDF）只传路径不读文本。

use crate::file_types::{self, FileKind};
use serde::Serialize;
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

/// 单个文本文件最大 16 MB。
pub(crate) const MAX_TEXT_FILE_BYTES: u64 = 16 * 1024 * 1024;

/// 超过该大小的 HTML 源文件直接以源码模式打开。
pub(crate) const HTML_SOURCE_MODE_THRESHOLD_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExternalTextFile {
    pub(crate) path: String,
    pub(crate) content: String,
    pub(crate) size_bytes: u64,
    /// HTML 超过 2 MiB 时为 true，前端直接以源码模式打开。
    pub(crate) source_mode: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DroppedPathsDecision {
    /// 拖入单个目录时保留既有“打开文件夹”行为。
    pub(crate) folder_path: Option<String>,
    pub(crate) document_paths: Vec<String>,
}

/// 规范化用户/系统提供的路径：拒绝空值与内嵌 NUL，展开为绝对路径，
/// 尽力解析符号链接与 `..`。解析失败时退回到词法规范化，不抛错。
pub(crate) fn normalize_input_path(path: &str) -> Result<PathBuf, String> {
    if path.trim().is_empty() {
        return Err("路径为空".to_string());
    }
    if path.contains('\0') {
        return Err(format!("路径包含非法字符：{path}"));
    }
    let candidate = PathBuf::from(path);
    let absolute = if candidate.is_absolute() {
        candidate
    } else {
        std::env::current_dir()
            .map_err(|error| format!("无法确定工作目录：{error}"))?
            .join(candidate)
    };
    Ok(dunce_canonicalize(&absolute))
}

/// canonicalize 依赖文件真实存在；对尚未创建的路径退回到词法规范化。
fn dunce_canonicalize(path: &Path) -> PathBuf {
    if let Ok(resolved) = path.canonicalize() {
        return resolved;
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            std::path::Component::CurDir => {}
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

/// 授权检查：路径必须存在且为常规文件，并可通过类型注册表准入。
pub(crate) fn authorize_readable_file(path: &Path) -> Result<FileKind, String> {
    let metadata = fs::metadata(path).map_err(|error| format!("无法读取文件元数据：{error}"))?;
    if !metadata.is_file() {
        return Err(format!("目标不是常规文件：{}", path.display()));
    }
    file_types::classify(path).ok_or_else(|| format!("不支持的文件类型：{}", path.display()))
}

/// 有界文本读取：16 MiB 上限、拒绝 NUL（二进制）、要求有效 UTF-8（容忍 BOM）。
pub(crate) fn read_text_file_bounded(path: &Path) -> Result<(String, u64), String> {
    let metadata = fs::metadata(path).map_err(|error| format!("无法读取文件元数据：{error}"))?;
    let size = metadata.len();
    if size > MAX_TEXT_FILE_BYTES {
        return Err(format!(
            "文本文件超过 16 MB 读取上限：{}（{} 字节）",
            path.display(),
            size
        ));
    }
    let bytes =
        fs::read(path).map_err(|error| format!("读取文件失败：{}：{error}", path.display()))?;
    if bytes.contains(&0) {
        return Err(format!(
            "检测到二进制内容，拒绝以文本打开：{}",
            path.display()
        ));
    }
    let content = String::from_utf8(bytes)
        .map_err(|_| format!("文件不是有效的 UTF-8 编码：{}", path.display()))?;
    // 容忍并剥离 UTF-8 BOM。
    let content = content
        .strip_prefix('\u{feff}')
        .map(str::to_string)
        .unwrap_or(content);
    Ok((content, size))
}

/// 打开对话框（Ctrl/Cmd+O）：类型化 "All Files" 选择器，只返回路径，不读取内容。
#[tauri::command]
pub(crate) async fn choose_opened_file(window: WebviewWindow) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dialog = window
            .app_handle()
            .dialog()
            .file()
            .set_title("打开文件")
            .add_filter("All Files", &["*"]);
        let picked = dialog
            .blocking_pick_files()
            .ok_or_else(|| "cancelled".to_string())?;
        Ok(picked
            .into_iter()
            .filter_map(|file| file.into_path().ok())
            .map(|path| path.to_string_lossy().into_owned())
            .collect())
    })
    .await
    .map_err(|error| format!("打开对话框失败：{error}"))?
}

/// 前端查看器按需读取外部文本（HTML 源码等），始终经过授权与有界读取。
#[tauri::command]
pub(crate) async fn read_external_text_file(path: String) -> Result<ExternalTextFile, String> {
    let normalized = normalize_input_path(&path)?;
    let kind = authorize_readable_file(&normalized)?;
    let is_html = kind == FileKind::Html;
    tauri::async_runtime::spawn_blocking(move || {
        let (content, size) = read_text_file_bounded(&normalized)?;
        let source_mode = is_html && size > HTML_SOURCE_MODE_THRESHOLD_BYTES;
        Ok(ExternalTextFile {
            path: normalized.to_string_lossy().into_owned(),
            content,
            size_bytes: size,
            source_mode,
        })
    })
    .await
    .map_err(|error| format!("读取任务失败：{error}"))?
}

/// 新建画布文件（Draw.io / Excalidraw）：写入初始模板，拒绝覆盖已有文件。
#[tauri::command]
pub(crate) async fn create_canvas_file(path: String, kind: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let normalized = normalize_input_path(&path)?;
        let kind = match kind.as_str() {
            "drawio" => FileKind::Drawio,
            "excalidraw" => FileKind::Excalidraw,
            other => return Err(format!("未知的画布类型：{other}")),
        };
        let actual = file_types::classify(&normalized)
            .ok_or_else(|| format!("不支持的文件类型：{}", normalized.display()))?;
        if actual != kind {
            let expected = if kind == FileKind::Drawio {
                "drawio"
            } else {
                "excalidraw"
            };
            return Err(format!(
                "扩展名与画布类型不一致：{} 应为 .{expected}",
                normalized.display()
            ));
        }
        if normalized.exists() {
            return Err(format!("文件已存在：{}", normalized.display()));
        }
        let template = match kind {
            FileKind::Drawio => drawio_template(),
            _ => excalidraw_template(),
        };
        if let Some(parent) = normalized.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("创建目录失败：{error}"))?;
        }
        fs::write(&normalized, template).map_err(|error| format!("创建文件失败：{error}"))?;
        Ok(normalized.to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| format!("创建画布文件失败：{error}"))?
}

fn drawio_template() -> String {
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    format!(
        r#"<mxfile host="nomo" modified="{now}" agent="nomo" version="24.7.7">
  <diagram id="nomo-1" name="第 1 页">
    <mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0">
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
"#
    )
}

fn excalidraw_template() -> String {
    r#"{
  "type": "excalidraw",
  "version": 2,
  "source": "nomo",
  "elements": [],
  "appState": {
    "gridSize": null
  },
  "files": {}
}
"#
    .to_string()
}

/// 只读二进制查看器的“另存为”：把已授权的源文件复制到用户选择的目标位置。
#[tauri::command]
pub(crate) async fn export_media_file_as(
    window: WebviewWindow,
    source_path: String,
    suggested_name: String,
) -> Result<String, String> {
    let normalized = normalize_input_path(&source_path)?;
    authorize_readable_file(&normalized)?;
    let extension = normalized
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    let destination = window
        .app_handle()
        .dialog()
        .file()
        .set_file_name(&suggested_name)
        .add_filter(
            "文件",
            &[if extension.is_empty() { "*" } else { extension }],
        )
        .blocking_save_file()
        .ok_or_else(|| "cancelled".to_string())?;
    let destination = destination
        .into_path()
        .map_err(|error| format!("目标路径无效：{error}"))?;
    let destination = tauri::async_runtime::spawn_blocking(move || {
        fs::copy(&normalized, &destination).map_err(|error| format!("导出文件失败：{error}"))?;
        Ok::<String, String>(destination.to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| format!("导出任务失败：{error}"))??;
    Ok(destination)
}

/// 拖放路径的统一入口：Rust 端规范化、授权、去重后才放行。
/// 单目录拖入保留“打开文件夹”语义；文档批次交回前端，由既有窗口路由分流。
#[tauri::command]
pub(crate) async fn open_dropped_paths(
    _app: AppHandle,
    paths: Vec<String>,
) -> Result<DroppedPathsDecision, String> {
    let handle = _app.clone();
    tauri::async_runtime::spawn_blocking(move || resolve_dropped_paths(&handle, paths))
        .await
        .map_err(|error| format!("处理拖放路径失败：{error}"))?
}

fn resolve_dropped_paths(
    app: &AppHandle,
    paths: Vec<String>,
) -> Result<DroppedPathsDecision, String> {
    let mut documents: Vec<String> = Vec::new();
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let mut folder_path: Option<String> = None;
    for raw in paths {
        let normalized = normalize_input_path(&raw)?;
        let metadata =
            fs::metadata(&normalized).map_err(|error| format!("无法读取拖放路径：{error}"))?;
        if metadata.is_dir() {
            // 与既有行为一致：首个有效目录接管整批拖放。
            folder_path = Some(normalized.to_string_lossy().into_owned());
            break;
        }
        if !metadata.is_file() {
            continue;
        }
        if let Err(error) = authorize_readable_file(&normalized) {
            crate::app_logger::warn(
                "FileAccess",
                &format!("拒绝未授权的拖放路径 {}：{error}", normalized.display()),
            );
            crate::open_requests::record_rejected_path(app, &normalized.to_string_lossy());
            continue;
        }
        if seen.insert(normalized.clone()) {
            documents.push(normalized.to_string_lossy().into_owned());
        }
    }
    if folder_path.is_some() {
        return Ok(DroppedPathsDecision {
            folder_path,
            document_paths: Vec::new(),
        });
    }
    Ok(DroppedPathsDecision {
        folder_path: None,
        document_paths: documents,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_relative_paths_lexically() {
        let cwd = std::env::current_dir().unwrap();
        let normalized = normalize_input_path("src/../src/main.rs").unwrap();
        assert!(normalized.starts_with(cwd));
        assert!(normalized.ends_with("src/main.rs"));
    }

    #[test]
    fn rejects_empty_and_nul_paths() {
        assert!(normalize_input_path("   ").is_err());
        assert!(normalize_input_path("a\0b").is_err());
    }

    #[test]
    fn bounded_read_rejects_binary_and_oversize() {
        let dir = std::env::temp_dir().join("nomo-file-access-tests");
        fs::create_dir_all(&dir).unwrap();
        let binary = dir.join("binary.bin");
        fs::write(&binary, [0x68, 0x69, 0x00, 0x21]).unwrap();
        assert!(read_text_file_bounded(&binary).is_err());

        let text = dir.join("text.txt");
        fs::write(&text, "\u{feff}hello").unwrap();
        let (content, _) = read_text_file_bounded(&text).unwrap();
        assert_eq!(content, "hello");
    }
}

/// 画布文件（drawio/excalidraw）编辑器回写：UTF-8、16 MiB 上限、按扩展名校验类型。
#[tauri::command]
pub(crate) async fn write_canvas_file(path: String, content: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        const CANVAS_LIMIT: usize = 16 * 1024 * 1024;
        let normalized = normalize_input_path(&path)?;
        let kind = file_types::classify(&normalized)
            .ok_or_else(|| format!("不支持的文件类型：{}", normalized.display()))?;
        if !matches!(kind, FileKind::Drawio | FileKind::Excalidraw) {
            return Err(format!("不是可编辑的画布文件：{}", normalized.display()));
        }
        if content.len() > CANVAS_LIMIT {
            return Err(format!(
                "画布内容超过 {} MiB 上限",
                CANVAS_LIMIT / 1024 / 1024
            ));
        }
        if content.bytes().any(|byte| byte == 0) {
            return Err("画布内容包含非法 NUL 字节".to_string());
        }
        // 冲突安全：不检查外部修改（编辑器即真实来源），直接原子替换。
        let tmp = normalized.with_extension(format!(
            "{}.tmp",
            normalized
                .extension()
                .and_then(|ext| ext.to_str())
                .unwrap_or("tmp")
        ));
        fs::write(&tmp, &content).map_err(|error| format!("写入临时文件失败：{error}"))?;
        fs::rename(&tmp, &normalized).map_err(|error| {
            let _ = fs::remove_file(&tmp);
            format!("替换画布文件失败：{error}")
        })?;
        Ok(())
    })
    .await
    .map_err(|error| format!("写入画布文件失败：{error}"))?
}
