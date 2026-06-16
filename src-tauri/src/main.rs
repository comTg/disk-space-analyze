#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use sysinfo::Disks;
use tauri::{AppHandle, Emitter, State};

const MAX_CHILDREN_PER_DIR: usize = 50;
const MAX_ERROR_SAMPLES: usize = 80;
const MAX_PARALLEL_SUMMARY_WORKERS: usize = 6;
const PROGRESS_EVERY_ENTRIES: u64 = 1000;
const PARTIAL_EVERY_MS: u64 = 900;

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
    emit_events: bool,
}

#[derive(Clone)]
struct SummaryTask {
    child_index: usize,
    old_child: FsNode,
    path: PathBuf,
}

struct SummaryResult {
    child_index: usize,
    old_child: FsNode,
    summary: Option<FsNode>,
    stats: ScanStats,
    issues: Vec<FsIssue>,
}

impl ScanContext {
    fn note_entry(&mut self, path: &Path) {
        self.stats.entries_scanned = self.stats.entries_scanned.saturating_add(1);
        if self.emit_events && self.stats.entries_scanned % PROGRESS_EVERY_ENTRIES == 0 {
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
        if !self.emit_events {
            return;
        }
        if !force && self.last_partial_at.elapsed() < Duration::from_millis(PARTIAL_EVERY_MS) {
            return;
        }

        self.last_partial_at = Instant::now();
        let mut root = root.clone();
        root.children.sort_by(|a, b| b.size.cmp(&a.size));
        compact_children_for_transport(&mut root, false);

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
            emit_events: true,
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
        if target.parent().is_some() && target.file_name().is_some() {
            command.arg("/select,").arg(&target);
        } else {
            command.arg(&target);
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

#[tauri::command]
fn delete_path(path: String) -> Result<(), String> {
    let target = normalize_user_path(&path)?;
    if !target.exists() {
        return Err(format!("路径不存在: {}", path_to_string(&target)));
    }
    if target.parent().is_none() || target.file_name().is_none() {
        return Err("不能删除磁盘根目录。".to_string());
    }

    trash::delete(&target).map_err(|error| format!("移到回收站失败: {error}"))
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

        if load_children {
            for entry in entries {
                if ctx.cancel.load(Ordering::Relaxed) {
                    break;
                }

                match entry {
                    Ok(entry) => {
                        if let Some(child) = scan_shallow_node(&entry.path(), ctx) {
                            add_child_totals(&mut node, &child);
                            node.children.push(child);
                            ctx.emit_partial(&node, false);
                        }
                    }
                    Err(error) => {
                        ctx.note_issue(path, error.to_string());
                    }
                }
            }

            ctx.emit_partial(&node, true);

            let summary_tasks = node
                .children
                .iter()
                .enumerate()
                .filter(|(_, child)| child.kind == "dir" && !child.virtual_node)
                .map(|(child_index, child)| SummaryTask {
                    child_index,
                    old_child: child.clone(),
                    path: PathBuf::from(child.path.clone()),
                })
                .collect::<Vec<_>>();
            run_summary_tasks(summary_tasks, &mut node, ctx);

            node.children.sort_by(|a, b| b.size.cmp(&a.size));
            compact_children(&mut node);
            return Some(node);
        }

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

fn scan_shallow_node(path: &Path, ctx: &mut ScanContext) -> Option<FsNode> {
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
        return Some(FsNode {
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
            children_loaded: false,
        });
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

fn run_summary_tasks(tasks: Vec<SummaryTask>, parent: &mut FsNode, ctx: &mut ScanContext) {
    if tasks.is_empty() || ctx.cancel.load(Ordering::Relaxed) {
        return;
    }

    let worker_count = summary_worker_count(tasks.len());
    let tasks = Arc::new(tasks);
    let next_task = Arc::new(AtomicUsize::new(0));
    let (sender, receiver) = mpsc::channel::<SummaryResult>();

    thread::scope(|scope| {
        for _ in 0..worker_count {
            let tasks = Arc::clone(&tasks);
            let next_task = Arc::clone(&next_task);
            let sender = sender.clone();
            let cancel = Arc::clone(&ctx.cancel);
            let app = ctx.app.clone();
            let scan_id = ctx.scan_id.clone();
            let started_at = ctx.started_at;

            scope.spawn(move || loop {
                if cancel.load(Ordering::Relaxed) {
                    break;
                }

                let task_index = next_task.fetch_add(1, Ordering::Relaxed);
                let Some(task) = tasks.get(task_index).cloned() else {
                    break;
                };

                let mut local_ctx = ScanContext {
                    scan_id: scan_id.clone(),
                    app: app.clone(),
                    cancel: Arc::clone(&cancel),
                    started_at,
                    last_partial_at: started_at,
                    stats: ScanStats::default(),
                    issues: Vec::new(),
                    emit_events: false,
                };
                let summary = scan_summary_node(&task.path, &mut local_ctx);
                if sender
                    .send(SummaryResult {
                        child_index: task.child_index,
                        old_child: task.old_child,
                        summary,
                        stats: local_ctx.stats,
                        issues: local_ctx.issues,
                    })
                    .is_err()
                {
                    break;
                }
            });
        }

        drop(sender);
        for result in receiver {
            merge_stats(&mut ctx.stats, &result.stats);
            merge_issues(&mut ctx.issues, result.issues);

            if let Some(summary) = result.summary {
                if result.child_index < parent.children.len() {
                    replace_child_totals(parent, &result.old_child, &summary);
                    parent.children[result.child_index] = summary;
                    ctx.emit_partial(parent, false);
                }
            }
        }
    });
}

fn summary_worker_count(task_count: usize) -> usize {
    let available = thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(2);
    task_count
        .min(available)
        .min(MAX_PARALLEL_SUMMARY_WORKERS)
        .max(1)
}

fn merge_stats(target: &mut ScanStats, source: &ScanStats) {
    target.entries_scanned = target
        .entries_scanned
        .saturating_add(source.entries_scanned);
    target.files_scanned = target.files_scanned.saturating_add(source.files_scanned);
    target.dirs_scanned = target.dirs_scanned.saturating_add(source.dirs_scanned);
    target.bytes_scanned = target.bytes_scanned.saturating_add(source.bytes_scanned);
    target.errors = target.errors.saturating_add(source.errors);
}

fn merge_issues(target: &mut Vec<FsIssue>, source: Vec<FsIssue>) {
    let remaining = MAX_ERROR_SAMPLES.saturating_sub(target.len());
    target.extend(source.into_iter().take(remaining));
}

fn add_child_totals(node: &mut FsNode, child: &FsNode) {
    node.size = node.size.saturating_add(child.size);
    node.file_count = node.file_count.saturating_add(child.file_count);
    node.dir_count = node.dir_count.saturating_add(child.dir_count);
}

fn replace_child_totals(node: &mut FsNode, old_child: &FsNode, new_child: &FsNode) {
    node.size = node
        .size
        .saturating_sub(old_child.size)
        .saturating_add(new_child.size);
    node.file_count = node
        .file_count
        .saturating_sub(old_child.file_count)
        .saturating_add(new_child.file_count);
    node.dir_count = node
        .dir_count
        .saturating_sub(old_child.dir_count)
        .saturating_add(new_child.dir_count);
}

fn compact_children(node: &mut FsNode) {
    compact_children_with_mode(node, true);
}

fn compact_children_for_transport(node: &mut FsNode, keep_aggregate_children: bool) {
    compact_children_with_mode(node, keep_aggregate_children);
}

fn compact_children_with_mode(node: &mut FsNode, keep_aggregate_children: bool) {
    if node
        .children
        .iter()
        .any(|child| child.virtual_node && child.kind == "aggregate")
    {
        if !keep_aggregate_children {
            clear_transport_aggregate_children(node);
        }
        return;
    }

    if node.children.len() <= MAX_CHILDREN_PER_DIR {
        if !keep_aggregate_children {
            clear_transport_aggregate_children(node);
        }
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
        children: if keep_aggregate_children {
            rest
        } else {
            Vec::new()
        },
        extension: None,
        modified_unix_secs: None,
        issue: None,
        virtual_node: true,
        children_loaded: true,
    });
}

fn clear_transport_aggregate_children(node: &mut FsNode) {
    for child in &mut node.children {
        if child.virtual_node && child.kind == "aggregate" {
            child.children.clear();
        }
    }
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
            reveal_path,
            delete_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
