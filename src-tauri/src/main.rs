#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use sysinfo::Disks;
use tauri::{AppHandle, Emitter, State};

const MAX_CHILDREN_PER_DIR: usize = 700;
const MAX_ERROR_SAMPLES: usize = 80;
const PROGRESS_EVERY_ENTRIES: u64 = 250;
const PARTIAL_EVERY_MS: u64 = 350;

static NEXT_SCAN_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
struct ScannerState {
    scans: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DriveInfo {
    name: String,
    path: String,
    kind: String,
    total_space: Option<u64>,
    available_space: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FsIssue {
    path: String,
    message: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FsNode {
    name: String,
    path: String,
    kind: String,
    size: u64,
    file_count: u64,
    dir_count: u64,
    children: Vec<FsNode>,
    extension: Option<String>,
    modified_unix_secs: Option<u64>,
    issue: Option<String>,
    virtual_node: bool,
    children_loaded: bool,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanStats {
    entries_scanned: u64,
    files_scanned: u64,
    dirs_scanned: u64,
    bytes_scanned: u64,
    errors: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanProgress {
    scan_id: String,
    current_path: String,
    elapsed_ms: u128,
    stats: ScanStats,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanPartial {
    scan_id: String,
    root: FsNode,
    elapsed_ms: u128,
    stats: ScanStats,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanFinished {
    scan_id: String,
    root: Option<FsNode>,
    elapsed_ms: u128,
    stats: ScanStats,
    issues: Vec<FsIssue>,
    cancelled: bool,
    error: Option<String>,
}

struct ScanContext {
    scan_id: String,
    app: AppHandle,
    cancel: Arc<AtomicBool>,
    started_at: Instant,
    last_partial_at: Instant,
    stats: ScanStats,
    issues: Vec<FsIssue>,
}

impl ScanContext {
    fn note_entry(&mut self, path: &Path) {
        self.stats.entries_scanned = self.stats.entries_scanned.saturating_add(1);
        if self.stats.entries_scanned % PROGRESS_EVERY_ENTRIES == 0 {
            self.emit_progress(path);
        }
    }

    fn note_issue(&mut self, path: &Path, message: impl Into<String>) {
        self.stats.errors = self.stats.errors.saturating_add(1);
        if self.issues.len() < MAX_ERROR_SAMPLES {
            self.issues.push(FsIssue {
                path: path_to_string(path),
                message: message.into(),
            });
        }
    }

    fn emit_progress(&self, path: &Path) {
        let _ = self.app.emit(
            "scan-progress",
            ScanProgress {
                scan_id: self.scan_id.clone(),
                current_path: path_to_string(path),
                elapsed_ms: self.started_at.elapsed().as_millis(),
                stats: self.stats.clone(),
            },
        );
    }

    fn emit_partial(&mut self, root: &FsNode, force: bool) {
        if !force && self.last_partial_at.elapsed() < Duration::from_millis(PARTIAL_EVERY_MS) {
            return;
        }

        self.last_partial_at = Instant::now();
        let mut root = root.clone();
        root.children.sort_by(|a, b| b.size.cmp(&a.size));
        if !root.children.iter().any(|child| child.virtual_node) {
            compact_children(&mut root);
        }

        let _ = self.app.emit(
            "scan-partial",
            ScanPartial {
                scan_id: self.scan_id.clone(),
                root,
                elapsed_ms: self.started_at.elapsed().as_millis(),
                stats: self.stats.clone(),
            },
        );
    }
}

#[tauri::command]
fn list_roots() -> Vec<DriveInfo> {
    let mut drives = Vec::new();
    let mut seen = HashSet::new();

    let disks = Disks::new_with_refreshed_list();
    for disk in disks.list() {
        let path = path_to_string(disk.mount_point());
        seen.insert(normalize_drive_key(&path));
        drives.push(DriveInfo {
            name: disk.name().to_string_lossy().to_string(),
            path,
            kind: format!("{:?}", disk.kind()),
            total_space: Some(disk.total_space()),
            available_space: Some(disk.available_space()),
        });
    }

    #[cfg(windows)]
    {
        for letter in b'A'..=b'Z' {
            let path = format!("{}:\\", letter as char);
            let key = normalize_drive_key(&path);
            if !seen.contains(&key) && Path::new(&path).exists() {
                seen.insert(key);
                drives.push(DriveInfo {
                    name: path.clone(),
                    path,
                    kind: "Drive".to_string(),
                    total_space: None,
                    available_space: None,
                });
            }
        }
    }

    #[cfg(not(windows))]
    {
        if !seen.contains("/") {
            drives.push(DriveInfo {
                name: "/".to_string(),
                path: "/".to_string(),
                kind: "Root".to_string(),
                total_space: None,
                available_space: None,
            });
        }
    }

    drives.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    drives
}

#[tauri::command]
fn start_scan(
    app: AppHandle,
    state: State<'_, ScannerState>,
    path: String,
    scan_id: Option<String>,
) -> Result<String, String> {
    let root_path = normalize_user_path(&path)?;
    if !root_path.exists() {
        return Err(format!("路径不存在: {}", path_to_string(&root_path)));
    }
    if !root_path.is_dir() {
        return Err(format!(
            "请选择目录或磁盘根目录: {}",
            path_to_string(&root_path)
        ));
    }

    let scan_id = scan_id
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| format!("scan-{}", NEXT_SCAN_ID.fetch_add(1, Ordering::Relaxed)));
    let cancel = Arc::new(AtomicBool::new(false));
    let registry = state.scans.clone();
    registry
        .lock()
        .map_err(|_| "扫描状态锁已损坏".to_string())?
        .insert(scan_id.clone(), cancel.clone());

    let thread_scan_id = scan_id.clone();
    thread::spawn(move || {
        let started_at = Instant::now();
        let mut ctx = ScanContext {
            scan_id: thread_scan_id.clone(),
            app: app.clone(),
            cancel: cancel.clone(),
            started_at,
            last_partial_at: started_at,
            stats: ScanStats::default(),
            issues: Vec::new(),
        };

        ctx.emit_progress(&root_path);
        let root = scan_layer_node(&root_path, &mut ctx);
        if let Some(root) = &root {
            ctx.emit_partial(root, true);
        }
        let cancelled = cancel.load(Ordering::Relaxed);
        let error = match &root {
            Some(_) => None,
            None if cancelled => Some("扫描已取消".to_string()),
            None => Some("无法读取该目录".to_string()),
        };

        let _ = app.emit(
            "scan-finished",
            ScanFinished {
                scan_id: thread_scan_id.clone(),
                root,
                elapsed_ms: started_at.elapsed().as_millis(),
                stats: ctx.stats,
                issues: ctx.issues,
                cancelled,
                error,
            },
        );

        if let Ok(mut scans) = registry.lock() {
            scans.remove(&thread_scan_id);
        }
    });

    Ok(scan_id)
}

#[tauri::command]
fn cancel_scan(state: State<'_, ScannerState>, scan_id: String) -> Result<(), String> {
    let scans = state
        .scans
        .lock()
        .map_err(|_| "扫描状态锁已损坏".to_string())?;
    if let Some(flag) = scans.get(&scan_id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    let target = normalize_user_path(&path)?;
    if !target.exists() {
        return Err(format!("路径不存在: {}", path_to_string(&target)));
    }

    #[cfg(windows)]
    {
        let mut command = Command::new("explorer.exe");
        if target.is_file() {
            command.arg(format!("/select,{}", path_to_string(&target)));
        } else {
            command.arg(path_to_string(&target));
        }
        command.spawn().map_err(|error| error.to_string())?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(if target.is_file() {
                target.parent().unwrap_or(&target)
            } else {
                &target
            })
            .spawn()
            .map_err(|error| error.to_string())?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(if target.is_file() {
                target.parent().unwrap_or(&target)
            } else {
                &target
            })
            .spawn()
            .map_err(|error| error.to_string())?;
        return Ok(());
    }
}

fn scan_layer_node(path: &Path, ctx: &mut ScanContext) -> Option<FsNode> {
    scan_node_with_mode(path, ctx, true)
}

fn scan_summary_node(path: &Path, ctx: &mut ScanContext) -> Option<FsNode> {
    scan_node_with_mode(path, ctx, false)
}

fn scan_node_with_mode(path: &Path, ctx: &mut ScanContext, load_children: bool) -> Option<FsNode> {
    if ctx.cancel.load(Ordering::Relaxed) {
        return None;
    }

    ctx.note_entry(path);

    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) => {
            ctx.note_issue(path, error.to_string());
            return Some(error_node(path, error.to_string()));
        }
    };

    let file_type = metadata.file_type();
    if file_type.is_symlink() {
        return Some(FsNode {
            name: display_name(path),
            path: path_to_string(path),
            kind: "link".to_string(),
            size: 0,
            file_count: 0,
            dir_count: 0,
            children: Vec::new(),
            extension: None,
            modified_unix_secs: modified_secs(&metadata),
            issue: Some("已跳过符号链接或目录联接点".to_string()),
            virtual_node: false,
            children_loaded: true,
        });
    }

    if metadata.is_file() {
        let size = metadata.len();
        ctx.stats.files_scanned = ctx.stats.files_scanned.saturating_add(1);
        ctx.stats.bytes_scanned = ctx.stats.bytes_scanned.saturating_add(size);
        return Some(FsNode {
            name: display_name(path),
            path: path_to_string(path),
            kind: "file".to_string(),
            size,
            file_count: 1,
            dir_count: 0,
            children: Vec::new(),
            extension: file_extension(path),
            modified_unix_secs: modified_secs(&metadata),
            issue: None,
            virtual_node: false,
            children_loaded: true,
        });
    }

    if metadata.is_dir() {
        ctx.stats.dirs_scanned = ctx.stats.dirs_scanned.saturating_add(1);
        let mut node = FsNode {
            name: display_name(path),
            path: path_to_string(path),
            kind: "dir".to_string(),
            size: 0,
            file_count: 0,
            dir_count: 1,
            children: Vec::new(),
            extension: None,
            modified_unix_secs: modified_secs(&metadata),
            issue: None,
            virtual_node: false,
            children_loaded: load_children,
        };

        let entries = match fs::read_dir(path) {
            Ok(entries) => entries,
            Err(error) => {
                let message = error.to_string();
                ctx.note_issue(path, message.clone());
                node.issue = Some(message);
                return Some(node);
            }
        };

        for entry in entries {
            if ctx.cancel.load(Ordering::Relaxed) {
                break;
            }

            match entry {
                Ok(entry) => {
                    if let Some(child) = scan_summary_node(&entry.path(), ctx) {
                        node.size = node.size.saturating_add(child.size);
                        node.file_count = node.file_count.saturating_add(child.file_count);
                        node.dir_count = node.dir_count.saturating_add(child.dir_count);

                        if load_children {
                            node.children.push(child);
                            ctx.emit_partial(&node, false);
                        }
                    }
                }
                Err(error) => {
                    ctx.note_issue(path, error.to_string());
                }
            }
        }

        if load_children {
            node.children.sort_by(|a, b| b.size.cmp(&a.size));
            compact_children(&mut node);
        }

        return Some(node);
    }

    Some(FsNode {
        name: display_name(path),
        path: path_to_string(path),
        kind: "other".to_string(),
        size: metadata.len(),
        file_count: 0,
        dir_count: 0,
        children: Vec::new(),
        extension: None,
        modified_unix_secs: modified_secs(&metadata),
        issue: Some("未知文件类型".to_string()),
        virtual_node: false,
        children_loaded: true,
    })
}

fn compact_children(node: &mut FsNode) {
    if node.children.len() <= MAX_CHILDREN_PER_DIR {
        return;
    }

    let rest = node.children.split_off(MAX_CHILDREN_PER_DIR);
    let mut size = 0_u64;
    let mut file_count = 0_u64;
    let mut dir_count = 0_u64;
    for child in &rest {
        size = size.saturating_add(child.size);
        file_count = file_count.saturating_add(child.file_count);
        dir_count = dir_count.saturating_add(child.dir_count);
    }

    node.children.push(FsNode {
        name: format!("其他 {} 项", rest.len()),
        path: node.path.clone(),
        kind: "aggregate".to_string(),
        size,
        file_count,
        dir_count,
        children: Vec::new(),
        extension: None,
        modified_unix_secs: None,
        issue: None,
        virtual_node: true,
        children_loaded: true,
    });
}

fn error_node(path: &Path, message: String) -> FsNode {
    FsNode {
        name: display_name(path),
        path: path_to_string(path),
        kind: "error".to_string(),
        size: 0,
        file_count: 0,
        dir_count: 0,
        children: Vec::new(),
        extension: None,
        modified_unix_secs: None,
        issue: Some(message),
        virtual_node: false,
        children_loaded: true,
    }
}

fn normalize_user_path(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim().trim_matches('"');
    if trimmed.is_empty() {
        return Err("请输入要扫描的路径".to_string());
    }
    Ok(PathBuf::from(trimmed))
}

fn normalize_drive_key(path: &str) -> String {
    path.trim_end_matches(['\\', '/']).to_lowercase()
}

fn display_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| path_to_string(path))
}

fn path_to_string(path: &Path) -> String {
    path.display().to_string()
}

fn file_extension(path: &Path) -> Option<String> {
    path.extension()
        .map(|extension| extension.to_string_lossy().to_lowercase())
        .filter(|extension| !extension.is_empty())
}

fn modified_secs(metadata: &fs::Metadata) -> Option<u64> {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
}

fn main() {
    tauri::Builder::default()
        .manage(ScannerState::default())
        .invoke_handler(tauri::generate_handler![
            list_roots,
            start_scan,
            cancel_scan,
            reveal_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
