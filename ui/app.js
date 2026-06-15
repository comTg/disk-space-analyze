const state = {
  roots: [],
  rootNode: null,
  currentNode: null,
  selectedNode: null,
  nodeByPath: new Map(),
  parentByPath: new Map(),
  currentScanId: null,
  activeScans: new Map(),
  scanStatsById: new Map(),
  scanning: false,
  scanMode: null,
  scanPath: null,
  issues: [],
  contextNode: null,
  largestSortKey: "size",
  largestSortDir: "desc",
};

const els = {
  pathInput: document.querySelector("#pathInput"),
  scanButton: document.querySelector("#scanButton"),
  cancelButton: document.querySelector("#cancelButton"),
  rescanButton: document.querySelector("#rescanButton"),
  refreshDrivesButton: document.querySelector("#refreshDrivesButton"),
  driveList: document.querySelector("#driveList"),
  statusText: document.querySelector("#statusText"),
  scanProgress: document.querySelector("#scanProgress"),
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
  contextMenu: document.querySelector("#contextMenu"),
};

const TREEMAP_GAP = 3;
const TREEMAP_HEADER_HEIGHT = 22;
const TREEMAP_MIN_NEST_WIDTH = 150;
const TREEMAP_MIN_NEST_HEIGHT = 92;
const TREEMAP_MIN_LABEL_WIDTH = 56;
const TREEMAP_MIN_LABEL_HEIGHT = 28;
const TREEMAP_MAX_NEST_DEPTH = 4;

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
  updateScanControls();
}

function bindEvents() {
  els.scanButton.addEventListener("click", () => startRootScan(els.pathInput.value));
  els.pathInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      startRootScan(els.pathInput.value);
    }
  });
  els.cancelButton.addEventListener("click", cancelScan);
  els.rescanButton.addEventListener("click", () => {
    if (state.currentNode?.path) {
      refreshCurrentDirectory();
    }
  });
  els.refreshDrivesButton.addEventListener("click", loadRoots);
  els.upButton.addEventListener("click", goUp);
  els.revealButton.addEventListener("click", revealSelectedPath);
  window.addEventListener("resize", () => renderTreemap());
  window.addEventListener("blur", hideContextMenu);
  document.addEventListener("click", hideContextMenu);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hideContextMenu();
    }
  });
}

async function bindTauriEvents() {
  const api = tauriApi();
  if (!api?.event?.listen) {
    setStatus("未检测到 Tauri API。请使用 cargo run 启动桌面应用。");
    return;
  }

  await api.event.listen("scan-progress", (event) => {
    const payload = event.payload;
    if (!isCurrentScan(payload)) {
      return;
    }
    const scan = state.activeScans.get(payload.scanId);
    updateStats(payload.stats, payload.scanId);
    setStatus(`扫描中：${payload.currentPath}`);
    if (scan) {
      state.currentScanId = payload.scanId;
    }
  });

  await api.event.listen("scan-partial", (event) => {
    const payload = event.payload;
    if (!isCurrentScan(payload) || !payload.root) {
      return;
    }
    const scan = state.activeScans.get(payload.scanId);
    updateStats(payload.stats, payload.scanId);
    applyPartialScan(payload.root, scan);
    setStatus(`扫描中：${scan?.path || payload.root.path}`);
  });

  await api.event.listen("scan-finished", (event) => {
    const payload = event.payload;
    if (!isCurrentScan(payload)) {
      return;
    }
    finishScan(payload, state.activeScans.get(payload.scanId));
  });
}

function isCurrentScan(payload) {
  return payload && state.activeScans.has(payload.scanId);
}

async function loadRoots() {
  if (state.scanning) {
    setStatus("扫描进行中，请先取消当前扫描。");
    return;
  }

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
      button.disabled = state.scanning;
      button.addEventListener("click", () => {
        if (state.scanning) {
          setStatus("扫描进行中，请先取消当前扫描。");
          return;
        }
        els.pathInput.value = drive.path;
        startRootScan(drive.path);
      });
      button.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        if (state.scanning) {
          setStatus("扫描进行中，请先取消当前扫描。");
          return;
        }
        els.pathInput.value = drive.path;
        showPathContextMenu(event.clientX, event.clientY, drive.path);
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

async function startRootScan(path) {
  const scanPath = String(path || "").trim();
  if (!scanPath) {
    setStatus("请输入要扫描的路径。");
    return;
  }
  if (state.scanning) {
    setStatus("扫描进行中，请先取消当前扫描。");
    return;
  }

  state.rootNode = null;
  state.currentNode = null;
  state.selectedNode = null;
  state.issues = [];
  state.nodeByPath.clear();
  state.parentByPath.clear();
  const scanId = beginScan("root", scanPath);
  updateStats({});
  renderLoading(`正在准备扫描 ${scanPath}`);
  setStatus(`准备扫描：${scanPath}`);

  await requestBackendScan(scanPath, scanId);
}

async function startExpandScan(node) {
  if (!isExpandableDir(node)) {
    return;
  }
  if (isPathScanning(node.path)) {
    state.currentNode = node;
    state.selectedNode = node;
    renderAll();
    setStatus(`正在扫描目录：${node.path}`);
    return;
  }

  state.currentNode = node;
  state.selectedNode = node;
  state.issues = [];
  node.childrenLoading = true;
  const scanId = beginScan("expand", node.path);
  renderAll();
  setStatus(`准备扫描目录：${node.path}`);

  await requestBackendScan(node.path, scanId);
}

function refreshCurrentDirectory() {
  if (!state.currentNode?.path) {
    return;
  }
  if (state.scanning) {
    setStatus("扫描进行中，请先取消当前扫描。");
    return;
  }
  if (!state.rootNode || state.currentNode.path === state.rootNode.path) {
    startRootScan(state.currentNode.path);
    return;
  }
  startExpandScan(state.currentNode);
}

function beginScan(mode, path) {
  const scanId = createScanId();
  state.scanning = true;
  state.scanMode = mode;
  state.scanPath = path;
  state.currentScanId = scanId;
  state.activeScans.set(scanId, { mode, path });
  hideContextMenu();
  updateScanControls();
  return scanId;
}

async function requestBackendScan(path, requestedScanId) {
  try {
    const scanId = await invoke("start_scan", { path, scanId: requestedScanId });
    if (scanId && scanId !== requestedScanId) {
      const scan = state.activeScans.get(requestedScanId);
      state.activeScans.delete(requestedScanId);
      state.activeScans.set(scanId, scan || { mode: "expand", path });
    }
    state.currentScanId = scanId || requestedScanId;
    els.pathInput.value = path;
    refreshScanningState();
    updateScanControls();
    setStatus(`扫描已开始：${path}`);
  } catch (error) {
    failActiveScan(requestedScanId, error.message || String(error));
  }
}

function failActiveScan(scanId, message) {
  const failedScan = state.activeScans.get(scanId);
  state.activeScans.delete(scanId);
  state.scanStatsById.delete(scanId);
  refreshScanningState();
  clearLoadingFlagForPath(failedScan?.path);
  updateScanControls();

  if (failedScan?.mode === "root") {
    renderEmpty("扫描启动失败");
  } else if (failedScan?.path) {
    renderAll();
  }
  setStatus(message);
}

async function cancelScan() {
  if (!state.activeScans.size) {
    setStatus("当前没有正在进行的扫描。");
    return;
  }
  try {
    await Promise.all(
      [...state.activeScans.keys()].map((scanId) => invoke("cancel_scan", { scanId }))
    );
    setStatus("正在取消扫描...");
  } catch (error) {
    setStatus(error.message || String(error));
  }
}

function applyPartialScan(root, scan) {
  if (scan?.mode === "expand") {
    mergeScannedNode(root, false);
    renderAll();
    return;
  }

  applyRootNode(root);
  renderAll();
}

function finishScan(payload, scan) {
  const mode = scan?.mode;
  const scanPath = scan?.path;
  state.activeScans.delete(payload.scanId);
  state.scanStatsById.delete(payload.scanId);
  refreshScanningState();
  clearLoadingFlagForPath(scanPath);
  updateStats(payload.stats);
  state.issues = payload.issues || [];

  if (!payload.root) {
    if (mode === "root") {
      renderEmpty(payload.error || "扫描未生成结果");
    } else {
      renderAll();
    }
    renderIssues();
    setStatus(payload.error || "扫描结束");
    return;
  }

  if (mode === "expand" && payload.root.path === scanPath) {
    mergeScannedNode(payload.root, !payload.cancelled);
    const expandedNode = state.nodeByPath.get(payload.root.path);
    if (expandedNode) {
      state.currentNode = expandedNode;
      state.selectedNode = expandedNode;
    }
  } else {
    applyRootNode(payload.root);
  }

  renderAll();
  const elapsed = formatDuration(payload.elapsedMs || 0);
  const activeSuffix = state.activeScans.size ? `，仍有 ${state.activeScans.size} 个扫描任务` : "";
  setStatus(payload.cancelled ? `扫描已取消，用时 ${elapsed}${activeSuffix}` : `扫描完成，用时 ${elapsed}${activeSuffix}`);
}

function applyRootNode(root) {
  const previousCurrentPath = state.currentNode?.path || root.path;
  const previousSelectedPath = state.selectedNode?.path || root.path;
  if (state.rootNode) {
    preserveLoadedSubtrees(root, new Map(state.nodeByPath));
  }
  state.rootNode = root;
  rebuildIndex();
  state.currentNode = state.nodeByPath.get(previousCurrentPath) || state.rootNode;
  state.selectedNode = state.nodeByPath.get(previousSelectedPath) || state.currentNode;
}

function preserveLoadedSubtrees(node, existingNodes) {
  const existing = existingNodes.get(node.path);
  if (
    existing &&
    existing !== node &&
    existing.children?.length &&
    (!node.children?.length || node.childrenLoaded === false)
  ) {
    node.children = existing.children;
    node.childrenLoaded = existing.childrenLoaded;
    node.childrenLoading = existing.childrenLoading || isPathScanning(node.path);
  }

  for (const child of node.children || []) {
    preserveLoadedSubtrees(child, existingNodes);
  }
}

function mergeScannedNode(scannedNode, complete) {
  if (!state.rootNode) {
    applyRootNode(scannedNode);
    return;
  }

  const previousCurrentPath = state.currentNode?.path;
  const previousSelectedPath = state.selectedNode?.path;
  const target = state.nodeByPath.get(scannedNode.path);
  if (!target) {
    return;
  }

  const preserved = {
    size: target.size,
    fileCount: target.fileCount,
    dirCount: target.dirCount,
  };
  Object.assign(target, scannedNode);

  if (!complete) {
    target.size = preserved.size;
    target.fileCount = preserved.fileCount;
    target.dirCount = preserved.dirCount;
    target.childrenLoaded = false;
    target.childrenLoading = isPathScanning(target.path);
  } else {
    target.childrenLoaded = true;
    target.childrenLoading = false;
  }

  rebuildIndex();
  state.currentNode = state.nodeByPath.get(previousCurrentPath) || state.nodeByPath.get(target.path) || state.rootNode;
  state.selectedNode = state.nodeByPath.get(previousSelectedPath) || state.currentNode;
}

function rebuildIndex() {
  state.nodeByPath.clear();
  state.parentByPath.clear();
  if (state.rootNode) {
    indexTree(state.rootNode, null);
  }
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
    attachNodeContextMenu(button, item);
    els.breadcrumbs.appendChild(button);
  });
}

function renderTreemap() {
  if (!state.currentNode) {
    return;
  }

  const root = state.currentNode;
  els.treemap.classList.remove("empty", "loading", "loading-screen");
  delete els.treemap.dataset.loadingLabel;
  els.treemap.replaceChildren();

  const children = (root.children || []).filter(isVisibleChild);
  if ((root.childrenLoading || isPathScanning(root.path)) && !children.length) {
    renderLoading(`正在扫描 ${root.name || root.path}`);
    return;
  }

  if (!children.length) {
    renderEmpty(root.childrenLoaded === false ? "该目录尚未展开" : "该目录没有可显示的子项");
    return;
  }

  const rect = els.treemap.getBoundingClientRect();
  const layouts = layoutSquarified(children, 0, 0, rect.width, rect.height, 0);
  const fragment = document.createDocumentFragment();
  for (const item of layouts) {
    fragment.appendChild(createTile(item));
  }
  els.treemap.appendChild(fragment);

  if (root.childrenLoading || isPathScanning(root.path)) {
    els.treemap.classList.add("loading");
    els.treemap.dataset.loadingLabel = "扫描中";
  }
}

function layoutSquarified(nodes, x, y, width, height, depth) {
  const total = nodes.reduce((sum, node) => sum + weightForNode(node), 0);
  if (!total || width <= 0 || height <= 0) {
    return [];
  }

  const items = nodes
    .map((node) => ({
      node,
      area: Math.max(1, (weightForNode(node) / total) * width * height),
    }))
    .filter((item) => item.area > 0);
  const layouts = [];
  let row = [];
  let rowArea = 0;
  let cursorX = x;
  let cursorY = y;
  let remainingWidth = width;
  let remainingHeight = height;

  while (items.length) {
    const next = items[0];
    const side = Math.max(1, Math.min(remainingWidth, remainingHeight));
    const currentWorst = row.length ? worstAspect(row, rowArea, side) : Infinity;
    const nextWorst = worstAspect([...row, next], rowArea + next.area, side);

    if (!row.length || nextWorst <= currentWorst) {
      row.push(next);
      rowArea += next.area;
      items.shift();
      continue;
    }

    const placed = placeTreemapRow(row, rowArea, cursorX, cursorY, remainingWidth, remainingHeight, depth);
    layouts.push(...placed.layouts);
    cursorX = placed.x;
    cursorY = placed.y;
    remainingWidth = placed.width;
    remainingHeight = placed.height;
    row = [];
    rowArea = 0;
  }

  if (row.length) {
    const placed = placeTreemapRow(row, rowArea, cursorX, cursorY, remainingWidth, remainingHeight, depth);
    layouts.push(...placed.layouts);
  }

  return layouts.filter((item) => item.width >= 1 && item.height >= 1);
}

function worstAspect(row, rowArea, side) {
  if (!row.length || rowArea <= 0 || side <= 0) {
    return Infinity;
  }
  const areas = row.map((item) => item.area);
  const maxArea = Math.max(...areas);
  const minArea = Math.max(1, Math.min(...areas));
  const sideSquared = side * side;
  const rowAreaSquared = rowArea * rowArea;
  return Math.max(
    (sideSquared * maxArea) / rowAreaSquared,
    rowAreaSquared / (sideSquared * minArea)
  );
}

function placeTreemapRow(row, rowArea, x, y, width, height, depth) {
  const layouts = [];
  const horizontal = width >= height;

  if (horizontal) {
    const rowHeight = Math.max(1, Math.min(height, rowArea / Math.max(1, width)));
    let offsetX = x;
    row.forEach((item, index) => {
      const isLast = index === row.length - 1;
      const itemWidth = isLast ? x + width - offsetX : item.area / rowHeight;
      layouts.push(treemapRect(item.node, offsetX, y, itemWidth, rowHeight, depth));
      offsetX += itemWidth;
    });
    return { layouts, x, y: y + rowHeight, width, height: Math.max(0, height - rowHeight) };
  }

  const rowWidth = Math.max(1, Math.min(width, rowArea / Math.max(1, height)));
  let offsetY = y;
  row.forEach((item, index) => {
    const isLast = index === row.length - 1;
    const itemHeight = isLast ? y + height - offsetY : item.area / rowWidth;
    layouts.push(treemapRect(item.node, x, offsetY, rowWidth, itemHeight, depth));
    offsetY += itemHeight;
  });
  return { layouts, x: x + rowWidth, y, width: Math.max(0, width - rowWidth), height };
}

function treemapRect(node, x, y, width, height, depth) {
  const gap = depth === 0 ? TREEMAP_GAP : Math.max(1, TREEMAP_GAP - 1);
  return {
    node,
    x: x + gap / 2,
    y: y + gap / 2,
    width: Math.max(0, width - gap),
    height: Math.max(0, height - gap),
    depth,
  };
}

function createTile(layout) {
  const { node, x, y, width, height } = layout;
  const nestedChildren = nestedTreemapChildren(node, width, height, layout.depth);
  const tile = document.createElement("div");
  tile.className = [
    "tile",
    node.kind,
    nestedChildren.length ? "container" : "leaf",
    state.selectedNode?.path === node.path ? "selected" : "",
    node.childrenLoaded === false ? "unloaded" : "",
    node.childrenLoading ? "loading-node" : "",
  ].filter(Boolean).join(" ");
  tile.style.left = `${x}px`;
  tile.style.top = `${y}px`;
  tile.style.width = `${Math.max(1, width)}px`;
  tile.style.height = `${Math.max(1, height)}px`;
  tile.style.background = colorForNode(node);
  tile.title = `${node.path}\n${formatBytes(node.size)}`;

  if (nestedChildren.length) {
    const header = document.createElement("div");
    header.className = "tile-header";
    header.innerHTML = `
      <span>${escapeHtml(node.name)}</span>
      <small>${escapeHtml(tileSizeLabel(node))}</small>
    `;
    tile.appendChild(header);

    const childY = TREEMAP_HEADER_HEIGHT;
    const childHeight = Math.max(0, height - TREEMAP_HEADER_HEIGHT);
    const childLayouts = layoutSquarified(nestedChildren, 0, childY, width, childHeight, layout.depth + 1);
    for (const childLayout of childLayouts) {
      tile.appendChild(createTile(childLayout));
    }
  } else if (width > TREEMAP_MIN_LABEL_WIDTH && height > TREEMAP_MIN_LABEL_HEIGHT) {
    const label = document.createElement("div");
    label.className = "tile-label";
    label.innerHTML = `
      <span class="tile-name">${escapeHtml(node.name)}</span>
      <span class="tile-size">${escapeHtml(tileSizeLabel(node))}</span>
    `;
    tile.appendChild(label);
  }

  tile.addEventListener("click", (event) => {
    event.stopPropagation();
    if (node.kind === "dir" && !node.virtualNode) {
      enterNode(node);
    } else {
      selectNode(node);
    }
  });
  attachNodeContextMenu(tile, node);

  return tile;
}

function nestedTreemapChildren(node, width, height, depth) {
  if (
    !isExpandableDir(node) ||
    node.childrenLoaded === false ||
    depth >= TREEMAP_MAX_NEST_DEPTH ||
    width < TREEMAP_MIN_NEST_WIDTH ||
    height < TREEMAP_MIN_NEST_HEIGHT
  ) {
    return [];
  }

  return (node.children || []).filter(isVisibleChild);
}

function enterNode(node) {
  if (!node || node.virtualNode) {
    return;
  }

  state.selectedNode = node;
  if (isExpandableDir(node) && node.childrenLoaded === false) {
    state.currentNode = node;
    renderAll();
    startExpandScan(node);
    return;
  }

  state.currentNode = node;
  renderAll();
}

function selectNode(node) {
  if (!node) {
    return;
  }
  state.selectedNode = node;
  renderSelectedInfo();
  renderTreemap();
  updateScanControls();
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
    els.currentInfo.className = "info-block muted";
    els.currentInfo.textContent = "尚未扫描";
    return;
  }
  els.currentInfo.classList.remove("muted");
  els.currentInfo.innerHTML = infoRows(state.currentNode);
}

function renderLargestList() {
  if (!state.currentNode?.children?.length) {
    els.largestList.innerHTML = `<div class="muted">${state.currentNode?.childrenLoading ? "正在扫描..." : "暂无子项"}</div>`;
    return;
  }

  const rows = sortedLargestChildren();
  if (!rows.length) {
    els.largestList.innerHTML = `<div class="muted">暂无可显示项目</div>`;
    return;
  }

  const table = document.createElement("table");
  table.className = "largest-table";
  const thead = document.createElement("thead");
  const tbody = document.createElement("tbody");
  const columns = [
    ["name", "名称"],
    ["size", "大小"],
    ["percent", "占比"],
    ["fileCount", "文件"],
    ["dirCount", "目录"],
  ];

  const headerRow = document.createElement("tr");
  for (const [key, label] of columns) {
    const th = document.createElement("th");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `${label}${sortMark(key)}`;
    button.addEventListener("click", () => {
      setLargestSort(key);
    });
    th.appendChild(button);
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);

  const totalSize = sizeTotalForPercent(rows);
  for (const child of rows) {
    const row = document.createElement("tr");
    row.className = state.selectedNode?.path === child.path ? "selected" : "";

    const nameCell = document.createElement("td");
    const nameButton = document.createElement("button");
    nameButton.className = "largest-name";
    nameButton.textContent = child.name;
    nameButton.title = child.path;
    nameButton.addEventListener("click", () => {
      if (child.kind === "dir" && !child.virtualNode) {
        enterNode(child);
      } else {
        selectNode(child);
      }
    });
    nameCell.appendChild(nameButton);

    row.append(
      nameCell,
      tableCell(largestSizeLabel(child), "number"),
      tableCell(formatPercent(child.size, totalSize), "number"),
      tableCell(formatNumber(child.fileCount), "number"),
      tableCell(formatNumber(displayDirCount(child)), "number")
    );

    attachNodeContextMenu(row, child);
    tbody.appendChild(row);
  }

  table.append(thead, tbody);
  els.largestList.replaceChildren(table);
}

function sortedLargestChildren() {
  return [...(state.currentNode?.children || [])]
    .filter(isVisibleChild)
    .sort(compareLargestRows);
}

function compareLargestRows(a, b) {
  const key = state.largestSortKey;
  const dir = state.largestSortDir === "asc" ? 1 : -1;
  const valueA = largestSortValue(a, key);
  const valueB = largestSortValue(b, key);

  if (typeof valueA === "string" || typeof valueB === "string") {
    const compared = String(valueA).localeCompare(String(valueB), "zh-CN", {
      numeric: true,
      sensitivity: "base",
    });
    return compared * dir || fallbackLargestCompare(a, b);
  }

  return ((valueA > valueB ? 1 : valueA < valueB ? -1 : 0) * dir) || fallbackLargestCompare(a, b);
}

function fallbackLargestCompare(a, b) {
  return (b.size - a.size) || String(a.name).localeCompare(String(b.name), "zh-CN", { numeric: true });
}

function largestSortValue(node, key) {
  if (key === "name") return node.name || "";
  if (key === "percent" || key === "size") return Number(node.size || 0);
  if (key === "fileCount") return Number(node.fileCount || 0);
  if (key === "dirCount") return displayDirCount(node);
  return Number(node.size || 0);
}

function setLargestSort(key) {
  if (state.largestSortKey === key) {
    state.largestSortDir = state.largestSortDir === "asc" ? "desc" : "asc";
  } else {
    state.largestSortKey = key;
    state.largestSortDir = key === "name" ? "asc" : "desc";
  }
  renderLargestList();
}

function sortMark(key) {
  if (state.largestSortKey !== key) {
    return "";
  }
  return state.largestSortDir === "asc" ? " ↑" : " ↓";
}

function tableCell(text, className = "") {
  const cell = document.createElement("td");
  if (className) {
    cell.className = className;
  }
  cell.textContent = text;
  cell.title = text;
  return cell;
}

function sizeTotalForPercent(rows) {
  return Number(state.currentNode?.size || 0) || rows.reduce((sum, item) => sum + Number(item.size || 0), 0);
}

function formatPercent(size, total) {
  if (!total || !size) {
    return "0%";
  }
  const value = (Number(size) / Number(total)) * 100;
  return `${value >= 10 ? value.toFixed(1) : value >= 1 ? value.toFixed(2) : "<1"}%`;
}

function displayDirCount(node) {
  return Math.max(0, Number(node.dirCount || 0) - (node.kind === "dir" ? 1 : 0));
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
  if (node.kind === "dir" && !node.virtualNode) {
    rows.push(["子项", childrenStateLabel(node)]);
  }
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
  els.treemap.classList.remove("loading", "loading-screen");
  delete els.treemap.dataset.loadingLabel;
  els.treemap.innerHTML = `
    <div class="empty-state">
      <strong>${escapeHtml(message)}</strong>
      <span>支持本机磁盘和映射网络驱动器，例如 Z:\\</span>
    </div>
  `;
}

function renderLoading(message) {
  els.treemap.classList.add("empty", "loading-screen");
  els.treemap.classList.remove("loading");
  delete els.treemap.dataset.loadingLabel;
  els.treemap.innerHTML = `
    <div class="empty-state loading-state">
      <span class="spinner" aria-hidden="true"></span>
      <strong>${escapeHtml(message)}</strong>
      <span>正在统计当前层级的目录大小</span>
    </div>
  `;
}

function updateScanControls() {
  els.pathInput.disabled = state.scanning;
  els.scanButton.disabled = state.scanning;
  els.cancelButton.disabled = !state.scanning;
  els.rescanButton.disabled = state.scanning || !state.currentNode?.path;
  els.refreshDrivesButton.disabled = state.scanning;
  els.upButton.disabled = !state.currentNode || !state.parentByPath.has(state.currentNode.path);
  els.revealButton.disabled = !(state.selectedNode || state.currentNode);
  els.scanProgress?.classList.toggle("active", state.scanning);
  document.body.classList.toggle("is-scanning", state.scanning);

  for (const button of els.driveList.querySelectorAll(".drive-item")) {
    button.disabled = state.scanning;
  }
}

function updateStats(stats = {}, scanId = null) {
  if (scanId && stats) {
    state.scanStatsById.set(scanId, stats);
  }

  const activeStats = aggregateActiveStats();
  const source = state.activeScans.size ? activeStats : stats;
  els.metricSize.textContent = formatBytes(source.bytesScanned || state.rootNode?.size || 0);
  els.metricFiles.textContent = formatNumber(source.filesScanned || state.rootNode?.fileCount || 0);
  els.metricDirs.textContent = formatNumber(source.dirsScanned || state.rootNode?.dirCount || 0);
  els.metricErrors.textContent = formatNumber(source.errors || 0);
}

function setStatus(message) {
  els.statusText.textContent = message;
  els.statusText.title = message;
}

function createScanId() {
  return `ui-scan-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function attachNodeContextMenu(element, node) {
  element.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    selectNode(node);
    showNodeContextMenu(event.clientX, event.clientY, node);
  });
}

function showNodeContextMenu(x, y, node) {
  state.contextNode = node;
  const items = [
    {
      label: node.kind === "dir" ? "选中目录" : "选中项目",
      action: () => selectNode(node),
    },
  ];

  if (isExpandableDir(node)) {
    items.push({
      label: node.childrenLoaded === false ? "扫描并进入" : "进入目录",
      disabled: isPathScanning(node.path),
      action: () => enterNode(node),
    });
    items.push({
      label: "重新扫描此层",
      disabled: isPathScanning(node.path),
      action: () => startExpandScan(node),
    });
  }

  if (!node.virtualNode) {
    items.push({
      label: "打开位置",
      action: revealSelectedPath,
    });
  }

  renderContextMenu(x, y, items);
}

function showPathContextMenu(x, y, path) {
  renderContextMenu(x, y, [
    {
      label: "选中路径",
      action: () => {
        els.pathInput.value = path;
      },
    },
    {
      label: "扫描路径",
      disabled: state.scanning,
      action: () => startRootScan(path),
    },
  ]);
}

function renderContextMenu(x, y, items) {
  els.contextMenu.replaceChildren(
    ...items.map((item) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = item.label;
      button.disabled = Boolean(item.disabled);
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        hideContextMenu();
        item.action();
      });
      return button;
    })
  );

  els.contextMenu.hidden = false;
  const { innerWidth, innerHeight } = window;
  const rect = els.contextMenu.getBoundingClientRect();
  els.contextMenu.style.left = `${Math.min(x, innerWidth - rect.width - 8)}px`;
  els.contextMenu.style.top = `${Math.min(y, innerHeight - rect.height - 8)}px`;
}

function hideContextMenu() {
  if (!els.contextMenu.hidden) {
    els.contextMenu.hidden = true;
    els.contextMenu.replaceChildren();
  }
}

function refreshScanningState() {
  state.scanning = state.activeScans.size > 0;
  if (!state.scanning) {
    state.currentScanId = null;
    state.scanMode = null;
    state.scanPath = null;
    return;
  }

  const latest = [...state.activeScans.entries()].at(-1);
  if (latest) {
    const [scanId, scan] = latest;
    state.currentScanId = scanId;
    state.scanMode = scan.mode;
    state.scanPath = scan.path;
  }
}

function aggregateActiveStats() {
  const total = {};
  for (const stats of state.scanStatsById.values()) {
    total.bytesScanned = (total.bytesScanned || 0) + Number(stats.bytesScanned || 0);
    total.filesScanned = (total.filesScanned || 0) + Number(stats.filesScanned || 0);
    total.dirsScanned = (total.dirsScanned || 0) + Number(stats.dirsScanned || 0);
    total.errors = (total.errors || 0) + Number(stats.errors || 0);
  }
  return total;
}

function isPathScanning(path) {
  if (!path) {
    return false;
  }
  return [...state.activeScans.values()].some((scan) => scan.path === path);
}

function clearLoadingFlagForPath(path) {
  if (!path) {
    return;
  }
  const node = state.nodeByPath.get(path) || findNodeByPath(state.rootNode, path);
  if (node) {
    node.childrenLoading = false;
  }
}

function findNodeByPath(node, path) {
  if (!node) {
    return null;
  }
  if (node.path === path) {
    return node;
  }
  for (const child of node.children || []) {
    const found = findNodeByPath(child, path);
    if (found) {
      return found;
    }
  }
  return null;
}

function isVisibleChild(node) {
  return node.size > 0 || isExpandableDir(node) || node.kind === "error";
}

function weightForNode(node) {
  if (node.size > 0) {
    return node.size;
  }
  if (isExpandableDir(node)) {
    return 1;
  }
  return 0;
}

function clearLoadingFlags(node = state.rootNode) {
  if (!node) {
    return;
  }
  node.childrenLoading = false;
  for (const child of node.children || []) {
    clearLoadingFlags(child);
  }
}

function isExpandableDir(node) {
  return node?.kind === "dir" && !node.virtualNode;
}

function childrenStateLabel(node) {
  if (node.childrenLoading) {
    return "扫描中";
  }
  return node.childrenLoaded === false ? "待展开" : "已展开";
}

function tileSizeLabel(node) {
  if (isExpandableDir(node) && node.size <= 0) {
    return isPathScanning(node.path) || node.childrenLoading ? "计算中" : "待计算";
  }
  const suffix = node.kind === "dir" && !node.virtualNode && node.childrenLoaded === false
    ? " · 待展开"
    : "";
  return `${formatBytes(node.size)}${suffix}`;
}

function largestSizeLabel(node) {
  if (isExpandableDir(node) && node.size <= 0) {
    return isPathScanning(node.path) || node.childrenLoading ? "计算中" : "待计算";
  }
  return formatBytes(node.size);
}

function colorForNode(node) {
  if (node.issue || node.kind === "error") {
    return "linear-gradient(135deg, #7a2e2a, #b54f42)";
  }
  if (node.virtualNode || node.kind === "aggregate") {
    return "linear-gradient(135deg, #4b515b, #343a43)";
  }
  if (node.kind === "file") {
    const lightA = 43 + (hashString(node.path) % 8);
    const lightB = Math.min(62, lightA + 10);
    return `linear-gradient(135deg, hsl(207 35% ${lightA}%), hsl(209 40% ${lightB}%))`;
  }

  const hue = 31 + (hashString(node.path) % 12);
  const sat = 28 + (hashString(node.name) % 10);
  const lightA = 41 + (hashString(`${node.path}:a`) % 8);
  const lightB = Math.min(60, lightA + 9);
  return `linear-gradient(135deg, hsl(${hue} ${sat}% ${lightA}%), hsl(${hue + 5} ${sat}% ${lightB}%))`;
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
