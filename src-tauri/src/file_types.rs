//! 桌面端文件类型注册表：扩展名 → 打开方式的唯一事实源。
//!
//! 与 `docs/desktop-file-support.md` 中的表格保持一致；前端 `src/file-types.ts`
//! 是它的镜像实现，两侧的新增类型必须同步修改。

use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FileKind {
    /// Markdown 富文本/源码双模式编辑器。
    Markdown,
    /// 代码/文本文件，CodeMirror 编辑器（未知后缀回退纯文本）。
    Code,
    /// HTML，默认沙箱 iframe 预览，可切换源码视图。
    Html,
    /// Draw.io 画布，本地离线 webapp。
    Drawio,
    /// Excalidraw 画布，独立离线微应用。
    Excalidraw,
    /// PDF，只读查看器。
    Pdf,
    /// 图片，只读查看器。
    Image,
}

pub(crate) const MARKDOWN_EXTENSIONS: &[&str] = &["md", "markdown", "mdx"];

pub(crate) const CODE_EXTENSIONS: &[&str] = &[
    "py",
    "pyw",
    "js",
    "mjs",
    "cjs",
    "jsx",
    "ts",
    "tsx",
    "mts",
    "cts",
    "json",
    "jsonc",
    "json5",
    "yaml",
    "yml",
    "toml",
    "ini",
    "cfg",
    "conf",
    "rs",
    "go",
    "rb",
    "php",
    "java",
    "kt",
    "kts",
    "swift",
    "c",
    "h",
    "cpp",
    "cc",
    "cxx",
    "hpp",
    "hh",
    "cs",
    "m",
    "mm",
    "dart",
    "lua",
    "pl",
    "pm",
    "r",
    "jl",
    "sh",
    "bash",
    "zsh",
    "fish",
    "ps1",
    "psm1",
    "bat",
    "cmd",
    "sql",
    "xml",
    "css",
    "scss",
    "sass",
    "less",
    "styl",
    "vue",
    "svelte",
    "astro",
    "graphql",
    "gql",
    "proto",
    "zig",
    "nim",
    "v",
    "ex",
    "exs",
    "erl",
    "hrl",
    "hs",
    "elm",
    "clj",
    "cljs",
    "scala",
    "groovy",
    "gradle",
    "cmake",
    "dockerfile",
    "makefile",
    "lock",
    "gitignore",
    "editorconfig",
    "txt",
];

pub(crate) const HTML_EXTENSIONS: &[&str] = &["html", "htm"];
pub(crate) const DRAWIO_EXTENSIONS: &[&str] = &["drawio"];
pub(crate) const EXCALIDRAW_EXTENSIONS: &[&str] = &["excalidraw"];
pub(crate) const PDF_EXTENSIONS: &[&str] = &["pdf"];
pub(crate) const IMAGE_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif",
];

/// 常见无后缀/点文件按文件名识别（大小写不敏感，不含开头的点）。
const CODE_FILE_NAMES: &[&str] = &[
    "dockerfile",
    "makefile",
    "cmakelists.txt",
    "license",
    "licence",
    "notice",
    "authors",
    "contributors",
    "changelog",
    "rust-toolchain",
    "gitattributes",
    "gitmodules",
    "npmrc",
    "nvmrc",
    "babelrc",
    "eslintrc",
    "prettierrc",
];

pub(crate) fn extension_of(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
}

pub(crate) fn file_name_lower(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.to_ascii_lowercase())
        .unwrap_or_default()
}

fn matches(list: &[&str], value: &str) -> bool {
    list.contains(&value)
}

/// 按文件名判定代码/文本：常见无后缀名、`.gitignore`/`.env*` 等点文件。
/// 剩余无后缀文件也回退为文本（编辑器内再回退纯文本）。
pub(crate) fn classify_as_code_by_name(path: &Path) -> bool {
    let name = file_name_lower(path);
    if name.is_empty() {
        return false;
    }
    if let Some(stem) = name.strip_prefix('.') {
        if !stem.is_empty() {
            // `.env*`、`.gitignore`、`.prettierrc` 等全部点文件都视为文本。
            return true;
        }
    }
    if matches(CODE_FILE_NAMES, name.as_str()) {
        return true;
    }
    // 无后缀文件（LICENSE、Makefile 的别名等）回退为文本。
    extension_of(path).is_none()
}

/// 完整分类。返回 `None` 表示不支持打开。
pub(crate) fn classify(path: &Path) -> Option<FileKind> {
    let name = file_name_lower(path);
    if name.is_empty() {
        return None;
    }
    let extension = extension_of(path);
    if let Some(extension) = extension.as_deref() {
        if matches(MARKDOWN_EXTENSIONS, extension) {
            return Some(FileKind::Markdown);
        }
        if matches(HTML_EXTENSIONS, extension) {
            return Some(FileKind::Html);
        }
        if matches(DRAWIO_EXTENSIONS, extension) {
            return Some(FileKind::Drawio);
        }
        if matches(EXCALIDRAW_EXTENSIONS, extension) {
            return Some(FileKind::Excalidraw);
        }
        if matches(PDF_EXTENSIONS, extension) {
            return Some(FileKind::Pdf);
        }
        if matches(IMAGE_EXTENSIONS, extension) {
            return Some(FileKind::Image);
        }
        if matches(CODE_EXTENSIONS, extension) {
            return Some(FileKind::Code);
        }
    }
    if classify_as_code_by_name(path) {
        return Some(FileKind::Code);
    }
    None
}

/// 外部打开链路（文件关联、启动参数、拖放、文件树）共用的准入检查。
pub(crate) fn is_supported(path: &Path) -> bool {
    classify(path).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kind_of(name: &str) -> Option<FileKind> {
        classify(Path::new(name))
    }

    #[test]
    fn classifies_markdown() {
        assert_eq!(kind_of("a.md"), Some(FileKind::Markdown));
        assert_eq!(kind_of("a.MARKDOWN"), Some(FileKind::Markdown));
        assert_eq!(kind_of("a.mdx"), Some(FileKind::Markdown));
    }

    #[test]
    fn classifies_code_and_text() {
        assert_eq!(kind_of("main.py"), Some(FileKind::Code));
        assert_eq!(kind_of("app.ts"), Some(FileKind::Code));
        assert_eq!(kind_of("config.yaml"), Some(FileKind::Code));
        assert_eq!(kind_of("Dockerfile"), Some(FileKind::Code));
        assert_eq!(kind_of(".gitignore"), Some(FileKind::Code));
        assert_eq!(kind_of(".env.local"), Some(FileKind::Code));
        assert_eq!(kind_of("LICENSE"), Some(FileKind::Code));
    }

    #[test]
    fn classifies_viewers() {
        assert_eq!(kind_of("page.html"), Some(FileKind::Html));
        assert_eq!(kind_of("diagram.drawio"), Some(FileKind::Drawio));
        assert_eq!(kind_of("sketch.excalidraw"), Some(FileKind::Excalidraw));
        assert_eq!(kind_of("doc.pdf"), Some(FileKind::Pdf));
        assert_eq!(kind_of("photo.PNG"), Some(FileKind::Image));
    }

    #[test]
    fn rejects_unknown_binary_extensions() {
        assert_eq!(kind_of("archive.zip"), None);
        assert_eq!(kind_of("video.mp4"), None);
        assert_eq!(kind_of("app.exe"), None);
    }
}
