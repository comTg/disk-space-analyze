const state = {
  roots: [],
  rootNode: null,
  currentNode: null,
  selectedNode: null,
  nodeByPath: new Map(),
  parentByPath: new Map(),
  currentScanId: null,
  scanning: false,
  issues: [],
};

const els = {
  pathInput: document.querySelector("#pathInput"),
  scanButton: document.querySelector("#scanButton"),
  cancelButton: document.querySelector("#cancelButton"),
  rescanButton: document.querySelector("#rescanButton"),
  refreshDrivesButton: document.querySelector("#refreshDrivesButton"),
  driveList: document.querySelector("#driveList"),
  statusText: document.querySelector("#statusText"),
  metricSize: document.querySelector("#metricSize"),
  metricFiles: document.querySelector("#metricFiles"),
  metricDirs: document.querySelector("#metricDirs"),
  metricErrors: document.querySelector("#metricErrors"),
  breadcrumbs: document.querySelector("#breadcrumbs"),
  treemap: document.querySelector("#treemap"),
  upButton: document.querySelector("#upButton"),
  revealButton: document.querySelector("#revealButton"),
  currentInfo: document.querySelector("#currentInfo"),
  largestList: document.querySelector("#largestList"),
  selectedInfo: document.querySelector("#selectedInfo"),
  issueList: document.querySelector("#issueList"),
};

function tauriApi() {
  return window.__TAURI__ || null;
}

function invoke(command, args = {}) {
  const api = tauriApi();
  if (!api?.core?.invoke) {
    return Promise.reject(new Error("请通过 Tauri 运行此应用"));
  }
  return api.core.invoke(command, args);
}

async function init() {
  bindEvents();
  await bindTauriEvents();
  await loadRoots();
}

function bindEvents() {
  els.scanButton.addEventListener("click", () => startScan(els.pathInput.value));
  els.pathInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      startScan(els.pathInput.value);
    }
  });
  els.cancelButton.addEventListener("click", cancelScan);
  els.rescanButton.addEventListener("click", () => {
    if (state.currentNode?.path) {
      startScan(state.currentNode.path);
    }
  });
  els.refreshDrivesButton.addEventListener("click", loadRoots);
  els.upButton.addEventListener("click", goUp);
  els.revealButton.addEventListener("click", revealSelectedPath);
  window.addEventListener("resize", () => renderTreemap());
}

async function bindTauriEvents() {
  const api = tauriApi();
  if (!api?.event?.listen) {
    setStatus("未检测到 Tauri API。请使用 cargo run 启动桌面应用。");
    return;
  }

  await api.event.listen("scan-progress", (event) => {
    const payload = event.payload;
    if (!payload || payload.scanId !== state.currentScanId) {
      return;
    }
    updateStats(payload.stats);
    setStatus(`扫描中：${payload.currentPath}`);
  });

  await api.event.listen("scan-finished", (event) => {
    const payload = event.payload;
    if (!payload || payload.scanId !== state.currentScanId) {
      return;
    }
    finishScan(payload);
  });
}

async function loadRoots() {
  els.driveList.innerHTML = `<div class="muted">正在读取驱动器...</div>`;
  try {
    state.roots = await invoke("list_roots");
    renderDriveList();
    if (!els.pathInput.value && state.roots[0]) {
      els.pathInput.value = state.roots[0].path;
    }
  } catch (error) {
    els.driveList.innerHTML = `<div class="muted">${escapeHtml(error.message || String(error))}</div>`;
  }
}

function renderDriveList() {
  if (!state.roots.length) {
    els.driveList.innerHTML = `<div class="muted">未发现可访问驱动器，可手动输入路径。</div>`;
    return;
  }

  els.driveList.replaceChildren(
    ...state.roots.map((drive) => {
      const button = document.createElement("button");
      button.className = "drive-item";
      button.title = drive.path;
      button.addEventListener("click", () => {
        els.pathInput.value = drive.path;
        startScan(drive.path);
      });

      const used = drive.totalSpace && drive.availableSpace != null
        ? Math.max(0, drive.totalSpace - drive.availableSpace)
        : null;
      const pct = used != null && drive.totalSpace
        ? Math.min(100, Math.round((used / drive.totalSpace) * 100))
        : 0;

      button.innerHTML = `
        <div class="drive-title">
          <span>${escapeHtml(drive.name || drive.path)}</span>
          <span class="drive-kind">${escapeHtml(drive.kind || "Drive")}</span>
        </div>
        <div class="drive-path">${escapeHtml(drive.path)}</div>
        <div class="usage-bar"><div class="usage-fill" style="width:${pct}%"></div></div>
        <div class="drive-path">${used == null ? "容量未知" : `${formatBytes(used)} / ${formatBytes(drive.totalSpace)}`}</div>
      `;
      return button;
    })
  );
}

async function startScan(path) {
  const scanPath = String(path || "").trim();
  if (!scanPath) {
    setStatus("请输入要扫描的路径。");
    return;
  }

  state.rootNode = null;
  state.currentNode = null;
  state.selectedNode = null;
  state.issues = [];
  state.nodeByPath.clear();
  state.parentByPath.clear();
  state.scanning = true;
  updateScanControls();
  updateStats({});
  renderEmpty(`正在准备扫描 ${scanPath}`);
  setStatus(`准备扫描：${scanPath}`);

  try {
    const scanId = await invoke("start_scan", { path: scanPath });
    state.currentScanId = scanId;
    els.pathInput.value = scanPath;
    setStatus(`扫描已开始：${scanPath}`);
  } catch (error) {
    state.scanning = false;
    state.currentScanId = null;
    updateScanControls();
    renderEmpty("扫描启动失败");
    setStatus(error.message || String(error));
  }
}

async function cancelScan() {
  if (!state.currentScanId) {
    return;
  }
  try {
    await invoke("cancel_scan", { scanId: state.currentScanId });
    setStatus("正在取消扫描...");
  } catch (error) {
    setStatus(error.message || String(error));
  }
}

function finishScan(payload) {
  state.scanning = false;
  updateScanControls();
  updateStats(payload.stats);
  state.issues = payload.issues || [];

  if (!payload.root) {
    renderEmpty(payload.error || "扫描未生成结果");
    renderIssues();
    setStatus(payload.error || "扫描结束");
    return;
  }

  state.rootNode = payload.root;
  state.currentNode = payload.root;
  state.selectedNode = payload.root;
  indexTree(payload.root, null);
  renderAll();
  const elapsed = formatDuration(payload.elapsedMs || 0);
  setStatus(payload.cancelled ? `扫描已取消，用时 ${elapsed}` : `扫描完成，用时 ${elapsed}`);
}

function indexTree(node, parent) {
  state.nodeByPath.set(node.path, node);
  if (parent) {
    state.parentByPath.set(node.path, parent.path);
  }
  for (const child of node.children || []) {
    if (!child.virtualNode) {
      indexTree(child, node);
    }
  }
}

function renderAll() {
  renderBreadcrumbs();
  renderTreemap();
  renderCurrentInfo();
  renderLargestList();
  renderSelectedInfo();
  renderIssues();
  updateScanControls();
}

function renderBreadcrumbs() {
  els.breadcrumbs.replaceChildren();
  if (!state.currentNode) {
    return;
  }

  const chain = [];
  let node = state.currentNode;
  while (node) {
    chain.unshift(node);
    const parentPath = state.parentByPath.get(node.path);
    node = parentPath ? state.nodeByPath.get(parentPath) : null;
  }

  chain.forEach((item, index) => {
    const button = document.createElement("button");
    button.className = `breadcrumb${index === chain.length - 1 ? " active" : ""}`;
    button.textContent = item.name || item.path;
    button.title = item.path;
    button.addEventListener("click", () => enterNode(item));
    els.breadcrumbs.appendChild(button);
  });
}

function renderTreemap() {
  if (!state.currentNode) {
    return;
  }

  const root = state.currentNode;
  els.treemap.classList.remove("empty");
  els.treemap.replaceChildren();

  const rect = els.treemap.getBoundingClientRect();
  const children = (root.children || []).filter((child) => child.size > 0);

  if (!children.length) {
    renderEmpty("该目录没有可显示的子项");
    return;
  }

  const layouts = layoutSlice(children, 0, 0, rect.width, rect.height, 0);
  const fragment = document.createDocumentFragment();
  for (const item of layouts) {
    fragment.appendChild(createTile(item));
  }
  els.treemap.appendChild(fragment);
}

function layoutSlice(nodes, x, y, width, height, depth) {
  const total = nodes.reduce((sum, node) => sum + Math.max(0, node.size), 0);
  if (!total || width <= 0 || height <= 0) {
    return [];
  }

  const horizontal = width >= height;
  let offset = 0;
  const layouts = [];

  nodes.forEach((node, index) => {
    const ratio = Math.max(0, node.size) / total;
    const last = index === nodes.length - 1;
    const tileWidth = horizontal ? (last ? width - offset : width * ratio) : width;
    const tileHeight = horizontal ? height : (last ? height - offset : height * ratio);
    const tileX = horizontal ? x + offset : x;
    const tileY = horizontal ? y : y + offset;
    offset += horizontal ? tileWidth : tileHeight;

    layouts.push({
      node,
      x: tileX,
      y: tileY,
      width: Math.max(0, tileWidth),
      height: Math.max(0, tileHeight),
      depth,
    });
  });

  return layouts.filter((item) => item.width >= 1 && item.height >= 1);
}

function createTile(layout) {
  const { node, x, y, width, height } = layout;
  const tile = document.createElement("div");
  tile.className = `tile ${node.kind}${state.selectedNode?.path === node.path ? " selected" : ""}`;
  tile.style.left = `${x}px`;
  tile.style.top = `${y}px`;
  tile.style.width = `${Math.max(1, width)}px`;
  tile.style.height = `${Math.max(1, height)}px`;
  tile.style.background = colorForNode(node);
  tile.title = `${node.path}\n${formatBytes(node.size)}`;

  if (width > 52 && height > 30) {
    const label = document.createElement("div");
    label.className = "tile-label";
    label.innerHTML = `
      <span class="tile-name">${escapeHtml(node.name)}</span>
      <span class="tile-size">${formatBytes(node.size)}</span>
    `;
    tile.appendChild(label);
  }

  tile.addEventListener("click", (event) => {
    event.stopPropagation();
    state.selectedNode = node;
    if (node.kind === "dir" && !node.virtualNode) {
      enterNode(node);
    } else {
      renderSelectedInfo();
      renderTreemap();
      updateScanControls();
    }
  });

  return tile;
}

function enterNode(node) {
  if (!node || node.virtualNode) {
    return;
  }
  state.currentNode = node;
  state.selectedNode = node;
  renderAll();
}

function goUp() {
  if (!state.currentNode) {
    return;
  }
  const parentPath = state.parentByPath.get(state.currentNode.path);
  if (parentPath) {
    enterNode(state.nodeByPath.get(parentPath));
  }
}

async function revealSelectedPath() {
  const target = state.selectedNode || state.currentNode;
  if (!target?.path || target.virtualNode) {
    return;
  }
  try {
    await invoke("reveal_path", { path: target.path });
  } catch (error) {
    setStatus(error.message || String(error));
  }
}

function renderCurrentInfo() {
  if (!state.currentNode) {
    els.currentInfo.textContent = "尚未扫描";
    return;
  }
  els.currentInfo.classList.remove("muted");
  els.currentInfo.innerHTML = infoRows(state.currentNode);
}

function renderLargestList() {
  if (!state.currentNode?.children?.length) {
    els.largestList.innerHTML = `<div class="muted">暂无子项</div>`;
    return;
  }

  const items = state.currentNode.children
    .filter((child) => child.size > 0)
    .slice(0, 18)
    .map((child) => {
      const row = document.createElement("div");
      row.className = "largest-item";

      const button = document.createElement("button");
      button.textContent = child.name;
      button.title = child.path;
      button.addEventListener("click", () => {
        if (child.kind === "dir" && !child.virtualNode) {
          enterNode(child);
        } else {
          state.selectedNode = child;
          renderSelectedInfo();
          renderTreemap();
          updateScanControls();
        }
      });

      const size = document.createElement("small");
      size.textContent = formatBytes(child.size);

      row.append(button, size);
      return row;
    });

  els.largestList.replaceChildren(...items);
}

function renderSelectedInfo() {
  const node = state.selectedNode;
  if (!node) {
    els.selectedInfo.className = "info-block muted";
    els.selectedInfo.textContent = "点击矩形查看详情，点击目录进入下一级。";
    return;
  }
  els.selectedInfo.classList.remove("muted");
  els.selectedInfo.innerHTML = infoRows(node);
}

function renderIssues() {
  if (!state.issues.length) {
    els.issueList.className = "issue-list muted";
    els.issueList.textContent = "暂无";
    return;
  }
  els.issueList.classList.remove("muted");
  els.issueList.replaceChildren(
    ...state.issues.map((issue) => {
      const item = document.createElement("div");
      item.className = "issue-item";
      item.innerHTML = `
        <div class="issue-path">${escapeHtml(issue.path)}</div>
        <div class="issue-message">${escapeHtml(issue.message)}</div>
      `;
      return item;
    })
  );
}

function infoRows(node) {
  const rows = [
    ["名称", node.name],
    ["路径", node.path],
    ["类型", kindLabel(node)],
    ["大小", formatBytes(node.size)],
    ["文件", formatNumber(node.fileCount)],
    ["目录", formatNumber(Math.max(0, (node.dirCount || 0) - (node.kind === "dir" ? 1 : 0)))],
  ];
  if (node.extension) {
    rows.push(["扩展名", `.${node.extension}`]);
  }
  if (node.modifiedUnixSecs) {
    rows.push(["修改时间", new Date(node.modifiedUnixSecs * 1000).toLocaleString()]);
  }
  if (node.issue) {
    rows.push(["问题", node.issue]);
  }
  return rows
    .map(([label, value]) => `
      <div class="info-row">
        <span>${escapeHtml(label)}</span>
        <span>${escapeHtml(value == null ? "" : String(value))}</span>
      </div>
    `)
    .join("");
}

function renderEmpty(message) {
  els.treemap.classList.add("empty");
  els.treemap.innerHTML = `
    <div class="empty-state">
      <strong>${escapeHtml(message)}</strong>
      <span>支持本机磁盘和映射网络驱动器，例如 Z:\\</span>
    </div>
  `;
}

function updateScanControls() {
  els.scanButton.disabled = state.scanning;
  els.cancelButton.disabled = !state.scanning;
  els.rescanButton.disabled = state.scanning || !state.currentNode?.path;
  els.upButton.disabled = !state.currentNode || !state.parentByPath.has(state.currentNode.path);
  els.revealButton.disabled = state.scanning || !(state.selectedNode || state.currentNode);
}

function updateStats(stats = {}) {
  els.metricSize.textContent = formatBytes(stats.bytesScanned || state.rootNode?.size || 0);
  els.metricFiles.textContent = formatNumber(stats.filesScanned || state.rootNode?.fileCount || 0);
  els.metricDirs.textContent = formatNumber(stats.dirsScanned || state.rootNode?.dirCount || 0);
  els.metricErrors.textContent = formatNumber(stats.errors || 0);
}

function setStatus(message) {
  els.statusText.textContent = message;
}

function colorForNode(node) {
  if (node.issue || node.kind === "error") {
    return "linear-gradient(135deg, #7a2e2a, #b54f42)";
  }
  if (node.virtualNode || node.kind === "aggregate") {
    return "linear-gradient(135deg, #555d69, #3f4651)";
  }
  if (node.kind === "file") {
    return "linear-gradient(135deg, #8a6330, #c18634)";
  }

  const hue = hashString(node.path) % 360;
  const sat = 38 + (hashString(node.name) % 18);
  const lightA = 34 + (hashString(`${node.path}:a`) % 10);
  const lightB = Math.min(58, lightA + 10);
  return `linear-gradient(135deg, hsl(${hue} ${sat}% ${lightA}%), hsl(${(hue + 18) % 360} ${sat}% ${lightB}%))`;
}

function kindLabel(node) {
  if (node.virtualNode) return "合并项目";
  if (node.kind === "dir") return "目录";
  if (node.kind === "file") return "文件";
  if (node.kind === "link") return "链接";
  if (node.kind === "error") return "无法访问";
  return node.kind || "未知";
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 100 ? size.toFixed(0) : size >= 10 ? size.toFixed(1) : size.toFixed(2)} ${units[unit]}`;
}

function formatNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(Number(value || 0));
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(Number(ms || 0) / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds} 秒`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes} 分 ${seconds} 秒`;
}

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < String(value).length; index += 1) {
    hash ^= String(value).charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

init();
