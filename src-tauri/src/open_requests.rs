//! 启动参数 / 系统文件关联 / 拖放的打开请求队列。
//!
//! 所有外部路径先进入队列（按规范化路径去重），窗口前端就绪后通过
//! `take_open_requests` 批量取走；与 `external_open` 的待处理事件互为补充，
//! 保证“重复路径只开一个 tab”。

use serde::Serialize;
use std::{collections::HashSet, sync::Mutex};
use tauri::{AppHandle, Manager};

#[derive(Debug, Default)]
pub(crate) struct OpenRequestRegistry {
    /// 已进入分发流程的规范化路径，用于跨批次去重。
    dispatched: Mutex<HashSet<String>>,
    /// 已因类型不支持 / 授权失败被拒绝的路径，用于提示去重。
    rejected: Mutex<HashSet<String>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenRequestBatch {
    pub(crate) paths: Vec<String>,
}

impl OpenRequestRegistry {
    fn insert_dispatched(&self, path: &str) -> bool {
        self.dispatched
            .lock()
            .expect("open request registry poisoned")
            .insert(path.to_string())
    }

    pub(crate) fn record_rejected(&self, path: &str) {
        self.rejected
            .lock()
            .expect("open request registry poisoned")
            .insert(path.to_string());
    }

    pub(crate) fn was_rejected(&self, path: &str) -> bool {
        self.rejected
            .lock()
            .expect("open request registry poisoned")
            .contains(path)
    }

    fn take_all(&self) -> Vec<String> {
        let mut dispatched = self
            .dispatched
            .lock()
            .expect("open request registry poisoned");
        let mut paths = dispatched.drain().collect::<Vec<_>>();
        paths.sort();
        paths
    }
}

/// 记录一个已授权、待分发的打开路径；重复路径返回 false。
pub(crate) fn record_dispatched_path(app: &AppHandle, path: &str) -> bool {
    app.state::<OpenRequestRegistry>().insert_dispatched(path)
}

/// 记录被拒绝的路径（类型不支持、授权失败等）。
pub(crate) fn record_rejected_path(app: &AppHandle, path: &str) -> bool {
    app.state::<OpenRequestRegistry>().record_rejected(path);
    true
}

/// 前端启动兜底：取走（并清空）当前累计的打开请求，避免重复打开。
#[tauri::command]
pub(crate) fn take_open_requests(app: AppHandle) -> OpenRequestBatch {
    OpenRequestBatch {
        paths: app.state::<OpenRequestRegistry>().take_all(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dedupes_dispatched_paths() {
        let registry = OpenRequestRegistry::default();
        assert!(registry.insert_dispatched("/tmp/a.md"));
        assert!(!registry.insert_dispatched("/tmp/a.md"));
        registry.record_rejected("/tmp/b.zip");
        assert!(registry.was_rejected("/tmp/b.zip"));
        assert!(!registry.was_rejected("/tmp/a.md"));
    }
}
