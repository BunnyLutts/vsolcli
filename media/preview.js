/*
 * olcli PDF 预览 webview 前端（普通脚本，非 module，无 import/require）。
 *
 * ── 宿主 → 页面 ──────────────────────────────────────────────────────────
 * { type: 'load', version: number, name: string, data: string, preserveView: boolean }
 *   version       宿主自增序号；页面把所有异步回调与它绑定，旧序号的结果一律丢弃，
 *                 避免上一条 load 的 getPage/render 回来时画到新文档的槽位上。
 *   name          文件名，仅用于工具栏显示（用 textContent 写入，不拼 HTML）。
 *   data          PDF 字节的 base64，不含 data: 前缀；允许含换行。
 *   preserveView  true 表示沿用上一份文档的可见位置与缩放（编译刷新时用），
 *                 false 表示回到第 1 页并重新适应宽度。
 *
 * ── 页面 → 宿主 ──────────────────────────────────────────────────────────
 * { type: 'ready' }                  脚本初始化完成、可以接收 load，仅发送一次。
 * { type: 'error', message: string } 解码/解析/渲染失败的可读中文原因（同文案去重，
 *                                    避免一屏坏页把宿主日志刷爆）。
 * { type: 'reload-request' }         用户点了「重新加载」，宿主重新读盘后回一条
 *                                    preserveView:true 的 load。
 *
 * ── 为什么不能自己 new Worker ────────────────────────────────────────────
 * 宿主按顺序把 pdf.min.js、pdf.worker.min.js 当普通脚本注入；worker 脚本把自己的
 * WorkerMessageHandler 挂到 globalThis.pdfjsWorker 上，pdf.js 在 PDFWorker 构造函数里
 * 先查这个全局量，查到就直接在主线程走 fake worker，既不读 workerSrc 也不 new Worker。
 * webview 的 CSP 没有 worker-src，自己 new Worker(...) 会被 CSP 拦下，而且 webview 里
 * 也没有可用的 worker 脚本 URL。所以这里不设置 GlobalWorkerOptions.workerSrc，
 * 也不创建 Worker。代价是解析与光栅化都在主线程，超大 PDF 首次打开会卡顿。
 */
(function () {
  'use strict';

  var MIN_SCALE = 0.1;
  var MAX_SCALE = 5;
  var ZOOM_FACTOR = 1.15;
  // 适宽时给滚动条和亚像素取整留余量，否则页面比容器宽 1~2px 会撑出横向滚动条并反复触发重排。
  var FIT_SAFETY_PX = 8;
  // 与 IntersectionObserver 的 rootMargin 保持一致，resize/缩放后用它补渲染「本已在视口内」的页面。
  var RENDER_MARGIN_PX = 300;
  var MAX_ERROR_LENGTH = 400;
  var MAX_PIXEL_RATIO = 3; // 再高只是成倍吃显存，肉眼收益很小

  var vscode = null;
  try {
    // acquireVsCodeApi 只允许调用一次，第二次会抛错；失败了就降级成「只显示不上报」。
    vscode = acquireVsCodeApi();
  } catch (e) {
    vscode = null;
  }

  var pagesEl = null;
  var toolbarEl = null;
  var stackEl = null;
  var nameEl = null;
  var pageLabelEl = null;
  var zoomLabelEl = null;
  var prevButton = null;
  var nextButton = null;

  var state = {
    version: 0,
    doc: null,
    loadingTask: null,
    pages: [],
    renderQueue: [],
    renderBusy: false,
    scale: 1,
    fitWidth: true,
    currentPage: 1,
    stackOffset: 0,
    geometryValid: false,
    layoutWidth: 0,
    relayouting: false,
    observer: null,
    hasObserver: false,
    scrollScheduled: false,
    resizeTimer: null,
    reportedErrors: Object.create(null),
    fatalReported: false
  };

  // ── 与宿主的通道 ────────────────────────────────────────────────────────

  function post(message) {
    if (!vscode) return;
    try {
      vscode.postMessage(message);
    } catch (e) {
      // 面板已销毁时 postMessage 会抛，静默即可：宿主那边已经没有接收方了。
    }
  }

  function reportError(message) {
    var text = truncate(message, MAX_ERROR_LENGTH);
    if (!text) return;
    if (state.reportedErrors[text]) return;
    state.reportedErrors[text] = true;
    if (window.console && console.error) console.error('[olcli preview]', text);
    post({ type: 'error', message: text });
  }

  // ── 启动 ───────────────────────────────────────────────────────────────

  function init() {
    toolbarEl = document.getElementById('toolbar');
    pagesEl = document.getElementById('pages');
    // 宿主契约里有这两个容器；万一没有就自己补，避免整块面板变成静默空白。
    if (!toolbarEl) {
      toolbarEl = document.createElement('div');
      toolbarEl.id = 'toolbar';
      document.body.appendChild(toolbarEl);
    }
    if (!pagesEl) {
      pagesEl = document.createElement('div');
      pagesEl.id = 'pages';
      document.body.appendChild(pagesEl);
    }

    stackEl = document.createElement('div');
    stackEl.className = 'preview-stack';
    pagesEl.appendChild(stackEl);

    buildToolbar();

    pagesEl.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onWindowResize);
    window.addEventListener('message', onMessage);
    window.addEventListener('error', onWindowError);
    window.addEventListener('unhandledrejection', onUnhandledRejection);

    if (typeof IntersectionObserver === 'function') {
      try {
        state.observer = new IntersectionObserver(onIntersections, {
          root: pagesEl,
          rootMargin: RENDER_MARGIN_PX + 'px 0px',
          threshold: 0
        });
        state.hasObserver = true;
      } catch (e) {
        state.observer = null;
        state.hasObserver = false;
      }
    }

    setFileName('');
    updatePageIndicator();
    updateZoomLabel();

    post({ type: 'ready' });
  }

  function buildToolbar() {
    toolbarEl.textContent = '';

    nameEl = document.createElement('span');
    nameEl.className = 'preview-name';
    nameEl.textContent = '未打开文档';

    pageLabelEl = document.createElement('span');
    pageLabelEl.className = 'preview-pages';

    var spacer = document.createElement('span');
    spacer.className = 'preview-spacer';

    prevButton = makeButton('上一页', 'page-previous', '跳到上一页', function () {
      goToPage(state.currentPage - 1);
    });
    nextButton = makeButton('下一页', 'page-next', '跳到下一页', function () {
      goToPage(state.currentPage + 1);
    });
    var zoomOutButton = makeButton('缩小', 'zoom-out', '缩小', function () {
      zoomBy(1 / ZOOM_FACTOR);
    });
    var zoomInButton = makeButton('放大', 'zoom-in', '放大', function () {
      zoomBy(ZOOM_FACTOR);
    });
    var fitButton = makeButton('适宽', 'fit-width', '按窗口宽度适应', function () {
      applyFitWidth();
    });
    var reloadButton = makeButton('重新加载', 'refresh', '重新读取并渲染当前 PDF', function () {
      post({ type: 'reload-request' });
    });

    zoomLabelEl = document.createElement('span');
    zoomLabelEl.className = 'preview-zoom';

    toolbarEl.appendChild(nameEl);
    toolbarEl.appendChild(pageLabelEl);
    toolbarEl.appendChild(spacer);
    toolbarEl.appendChild(prevButton);
    toolbarEl.appendChild(nextButton);
    toolbarEl.appendChild(zoomOutButton);
    toolbarEl.appendChild(zoomLabelEl);
    toolbarEl.appendChild(zoomInButton);
    toolbarEl.appendChild(fitButton);
    toolbarEl.appendChild(reloadButton);
  }

  function makeButton(label, icon, title, handler) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'preview-button';
    button.setAttribute('aria-label', title || label);
    var glyph = document.createElement('span');
    glyph.className = 'preview-icon preview-icon-' + icon;
    glyph.setAttribute('aria-hidden', 'true');
    button.appendChild(glyph);
    var caption = document.createElement('span');
    caption.textContent = label;
    button.appendChild(caption);
    if (title) button.title = title;
    button.addEventListener('click', function (event) {
      event.preventDefault();
      try {
        handler();
      } catch (err) {
        reportError(describeError(err));
      }
    });
    return button;
  }

  // ── 消息分发 ───────────────────────────────────────────────────────────

  function onMessage(event) {
    var data = event && event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'load') onLoadMessage(data);
  }

  function onLoadMessage(message) {
    // 宿主给的 version 正常递增时才采信，否则退回自增，保证守卫始终单调。
    var version = (typeof message.version === 'number' && isFinite(message.version) && message.version >= state.version)
      ? message.version
      : state.version + 1;

    // 必须在拆旧文档之前量，拆完 DOM 就量不到了。
    var keepView = message.preserveView === true && state.pages.length > 0 && state.geometryValid;
    var savedView = keepView ? captureViewState() : null;

    state.version = version; // 从此旧 version 的所有回调都会被丢弃
    setFileName(message.name);
    resetStage();
    showLoading();

    loadIntoStage(version, message.data, savedView).catch(function (err) {
      if (state.version !== version) return; // 已被更新的 load 取代，不是错误
      var text = describeError(err);
      disposeDocument();
      showFatal(text);
      reportError(text);
    });
  }

  // ── 载入与拆除 ─────────────────────────────────────────────────────────

  async function loadIntoStage(version, base64, savedView) {
    if (typeof pdfjsLib === 'undefined' || !pdfjsLib.getDocument) {
      throw new Error('pdf.js 未能加载（缺少 pdf.min.js）');
    }
    if (!window.pdfjsWorker || !window.pdfjsWorker.WorkerMessageHandler) {
      throw new Error('pdf.js 解析脚本未能加载（缺少 pdf.worker.min.js）');
    }

    var bytes = base64ToBytes(base64);
    // CSP 没有 'unsafe-eval'，不关掉 eval 会在首次解析时直接抛错。
    var task = pdfjsLib.getDocument({ data: bytes, isEvalSupported: false, useWorkerFetch: false });
    state.loadingTask = task;

    var doc = null;
    try {
      doc = await task.promise;
    } finally {
      if (state.loadingTask === task) state.loadingTask = null;
    }
    if (version !== state.version) {
      destroyQuietly(doc);
      return;
    }

    state.doc = doc;
    await buildPages(version, doc);
    if (version !== state.version) return;

    if (savedView) {
      state.fitWidth = savedView.fitWidth === true;
      if (!state.fitWidth) state.scale = clampScale(savedView.scale);
    } else {
      state.fitWidth = true;
    }

    layoutAllPages();
    measureGeometry();
    if (savedView) restoreViewState(savedView);
    else setScrollTop(0);
    updatePageIndicator();
    updateZoomLabel();
    requestVisibleRenders();
  }

  function cancelAllRenders() {
    for (var i = 0; i < state.pages.length; i++) cancelMetaRender(state.pages[i]);
  }

  function disposeDocument() {
    cancelAllRenders();
    var doc = state.doc;
    var task = state.loadingTask;
    state.doc = null;
    state.loadingTask = null;
    // doc.destroy() 内部就是 loadingTask.destroy()，两条路径都兜住。
    var pending = null;
    try {
      if (doc && typeof doc.destroy === 'function') pending = doc.destroy();
      else if (task && typeof task.destroy === 'function') pending = task.destroy();
    } catch (e) {
      pending = null;
    }
    if (pending && typeof pending.catch === 'function') pending.catch(function () {});
  }

  function destroyQuietly(doc) {
    if (!doc || typeof doc.destroy !== 'function') return;
    try {
      var pending = doc.destroy();
      if (pending && typeof pending.catch === 'function') pending.catch(function () {});
    } catch (e) {
      // 已经销毁过了
    }
  }

  function resetStage() {
    if (state.observer) {
      try {
        state.observer.disconnect();
      } catch (e) {
        // 忽略：旧观察器已经无效
      }
    }
    disposeDocument();
    // 注意不要重置 renderBusy：在跑的那次 render 的 finally 会接着泵新队列。
    state.pages = [];
    state.renderQueue = [];
    state.geometryValid = false;
    state.layoutWidth = 0;
    state.currentPage = 1;
    state.reportedErrors = Object.create(null);
    state.fatalReported = false;
    if (stackEl) stackEl.textContent = '';
  }

  async function buildPages(version, doc) {
    var total = typeof doc.numPages === 'number' ? doc.numPages : 0;
    if (total <= 0) throw new Error('该 PDF 不含任何页面');

    var metas = [];
    // 先按页序取到每页的原始尺寸，才能立刻把占位高度定下来，不然滚动条会随着渲染跳动。
    for (var i = 1; i <= total; i++) {
      var page = await doc.getPage(i);
      if (version !== state.version) return;
      var baseViewport = page.getViewport({ scale: 1 });
      var wrapper = document.createElement('div');
      wrapper.className = 'preview-page';
      wrapper.dataset.pageIndex = String(i);
      var canvas = document.createElement('canvas');
      canvas.className = 'preview-canvas';
      wrapper.appendChild(canvas);
      metas.push({
        index: i,
        page: page,
        baseViewport: baseViewport,
        wrapper: wrapper,
        canvas: canvas,
        rendered: false,
        renderedScale: 0,
        renderedDpr: 0,
        renderTask: null,
        rendering: false,
        queued: false,
        errorEl: null,
        measuredTop: 0,
        measuredHeight: 0,
        version: version
      });
    }
    if (version !== state.version) return;

    state.pages = metas;
    stackEl.textContent = '';
    var fragment = document.createDocumentFragment();
    for (i = 0; i < metas.length; i++) fragment.appendChild(metas[i].wrapper);
    stackEl.appendChild(fragment);

    if (state.observer) {
      for (i = 0; i < metas.length; i++) {
        try {
          state.observer.observe(metas[i].wrapper);
        } catch (e) {
          // 单个元素观察失败不影响其它页
        }
      }
    }
  }

  // ── 尺寸与布局 ─────────────────────────────────────────────────────────

  function clampScale(value) {
    var number = (typeof value === 'number' && isFinite(value) && value > 0) ? value : 1;
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, number));
  }

  function getDevicePixelRatio() {
    var ratio = window.devicePixelRatio;
    if (typeof ratio !== 'number' || !isFinite(ratio) || ratio <= 0) return 1;
    return Math.min(MAX_PIXEL_RATIO, Math.max(1, ratio));
  }

  function getContentWidth() {
    var width = stackEl ? stackEl.clientWidth : 0;
    if (!width && pagesEl) width = pagesEl.clientWidth;
    return width > 0 ? width : 0;
  }

  function layoutAllPages() {
    if (!state.pages.length) return;
    var contentWidth = getContentWidth();
    state.layoutWidth = contentWidth;

    if (state.fitWidth) {
      var widest = 0;
      for (var i = 0; i < state.pages.length; i++) {
        widest = Math.max(widest, state.pages[i].baseViewport.width);
      }
      if (widest > 0 && contentWidth > 0) {
        state.scale = clampScale((contentWidth - FIT_SAFETY_PX) / widest);
      }
    }
    state.scale = clampScale(state.scale);

    var dpr = getDevicePixelRatio();
    for (i = 0; i < state.pages.length; i++) {
      var meta = state.pages[i];
      var viewport = meta.page.getViewport({ scale: state.scale });
      var cssWidth = Math.max(1, Math.floor(viewport.width));
      var cssHeight = Math.max(1, Math.floor(viewport.height));
      meta.wrapper.style.width = cssWidth + 'px';
      meta.wrapper.style.height = cssHeight + 'px';
      meta.canvas.style.width = cssWidth + 'px';
      meta.canvas.style.height = cssHeight + 'px';
      if (meta.renderedScale !== state.scale || meta.renderedDpr !== dpr) {
        cancelMetaRender(meta);
        meta.rendered = false;
        // 尺寸变了就释放旧位图；等这页回到视口附近再按新尺寸重画。
        if (meta.canvas.width !== 0 || meta.canvas.height !== 0) {
          meta.canvas.width = 0;
          meta.canvas.height = 0;
        }
      }
    }
    state.geometryValid = false;
  }

  function measureGeometry() {
    if (!state.pages.length) {
      state.geometryValid = false;
      return;
    }
    var pagesRect = pagesEl.getBoundingClientRect();
    var stackRect = stackEl.getBoundingClientRect();
    // stackOffset 是滚动坐标系里 stack 内容的起点（含容器 padding），加回 scrollTop 后就与滚动无关了。
    state.stackOffset = (stackRect.top - pagesRect.top) + pagesEl.scrollTop;
    for (var i = 0; i < state.pages.length; i++) {
      var meta = state.pages[i];
      var rect = meta.wrapper.getBoundingClientRect();
      meta.measuredTop = rect.top - stackRect.top;
      meta.measuredHeight = rect.height;
    }
    state.geometryValid = true;
  }

  // ── 视图捕获与恢复 ─────────────────────────────────────────────────────

  function findTopVisibleSlot(scrollY) {
    var low = 0;
    var high = state.pages.length - 1;
    var best = 0;
    while (low <= high) {
      var mid = (low + high) >> 1;
      var meta = state.pages[mid];
      if (meta.measuredTop + meta.measuredHeight > scrollY + 0.5) {
        best = mid;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }
    return best;
  }

  function captureViewState() {
    if (!state.pages.length || !state.geometryValid) return null;
    var scrollY = pagesEl.scrollTop - state.stackOffset;
    var slot = findTopVisibleSlot(scrollY);
    var meta = state.pages[slot];
    var within = Math.min(Math.max(scrollY - meta.measuredTop, 0), meta.measuredHeight);
    return {
      index: meta.index,
      // 用页内比例而不是像素，换文档/换缩放后依然落在同一处内容上。
      ratio: meta.measuredHeight > 0 ? within / meta.measuredHeight : 0,
      scale: state.scale,
      fitWidth: state.fitWidth
    };
  }

  function restoreViewState(view) {
    if (!view || !state.pages.length || !state.geometryValid) return;
    var slot = Math.min(Math.max((view.index || 1) - 1, 0), state.pages.length - 1);
    var meta = state.pages[slot];
    var ratio = (typeof view.ratio === 'number' && isFinite(view.ratio)) ? Math.min(Math.max(view.ratio, 0), 1) : 0;
    setScrollTop(state.stackOffset + meta.measuredTop + ratio * meta.measuredHeight);
  }

  function setScrollTop(value) {
    var target = Math.max(0, typeof value === 'number' && isFinite(value) ? value : 0);
    pagesEl.scrollTop = target; // 越界由浏览器夹紧
    updatePageIndicator();
  }

  function relayoutKeepingPlace() {
    if (!state.pages.length || state.relayouting) return;
    state.relayouting = true;
    try {
      var view = captureViewState();
      layoutAllPages();
      measureGeometry();
      if (view) restoreViewState(view);
      updatePageIndicator();
      updateZoomLabel();
      requestVisibleRenders();
    } finally {
      state.relayouting = false;
    }
  }

  function applyFitWidth() {
    if (!state.pages.length) return;
    state.fitWidth = true;
    relayoutKeepingPlace();
  }

  function zoomBy(factor) {
    if (!state.pages.length) return;
    state.fitWidth = false;
    state.scale = clampScale(state.scale * factor);
    relayoutKeepingPlace();
  }

  function goToPage(pageNumber) {
    if (!state.pages.length || !state.geometryValid) return;
    var slot = Math.min(Math.max((pageNumber || 1) - 1, 0), state.pages.length - 1);
    setScrollTop(state.stackOffset + state.pages[slot].measuredTop);
  }

  // ── 惰性渲染 ───────────────────────────────────────────────────────────

  function onIntersections(entries) {
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var target = entry.target;
      var slot = parseInt(target.dataset.pageIndex, 10) - 1;
      var meta = state.pages[slot];
      if (!meta || meta.wrapper !== target || meta.version !== state.version) continue;
      if (entry.isIntersecting) {
        enqueueRender(meta);
      } else if (meta.renderTask) {
        // 快速滚动时把已经滚走的页让出来，否则主线程 fake worker 会被远处的页面占满。
        cancelMetaRender(meta);
      }
    }
  }

  function enqueueRender(meta) {
    if (!meta || meta.version !== state.version) return;
    if (meta.queued || meta.rendering) return;
    var dpr = getDevicePixelRatio();
    if (meta.rendered && meta.renderedScale === state.scale && meta.renderedDpr === dpr) return;
    meta.queued = true;
    state.renderQueue.push(meta);
    pumpRenderQueue();
  }

  function pumpRenderQueue() {
    if (state.renderBusy) return;
    var meta = shiftNextRenderable();
    if (!meta) return;
    state.renderBusy = true;
    renderPage(meta)
      .catch(function () {
        // 渲染内部已经处理失败；这里只保证队列不中断
      })
      .then(function () {
        state.renderBusy = false;
        pumpRenderQueue();
      });
  }

  function shiftNextRenderable() {
    var dpr = getDevicePixelRatio();
    while (state.renderQueue.length) {
      var meta = state.renderQueue.shift();
      if (!meta) continue;
      meta.queued = false;
      if (meta.version !== state.version || !meta.page) continue;
      if (meta.rendered && meta.renderedScale === state.scale && meta.renderedDpr === dpr) continue;
      return meta;
    }
    return null;
  }

  function cancelMetaRender(meta) {
    var task = meta.renderTask;
    meta.renderTask = null;
    if (!task) return;
    try {
      task.cancel();
    } catch (e) {
      // 任务已经结束
    }
  }

  async function renderPage(meta) {
    var version = state.version;
    var dpr = getDevicePixelRatio();
    var canvas = meta.canvas;
    var context = canvas.getContext('2d');
    if (!context) throw new Error('无法创建画布上下文，预览不可用');

    var viewport = meta.page.getViewport({ scale: state.scale });
    var pixelWidth = Math.max(1, Math.floor(viewport.width * dpr));
    var pixelHeight = Math.max(1, Math.floor(viewport.height * dpr));
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    canvas.style.width = Math.max(1, Math.floor(viewport.width)) + 'px';
    canvas.style.height = Math.max(1, Math.floor(viewport.height)) + 'px';

    meta.rendering = true;
    var task = null;
    var cancelled = false;
    try {
      task = meta.page.render({
        canvasContext: context,
        viewport: viewport,
        // 位图按 dpr 放大，再用 transform 让 PDF 坐标落到设备像素上，避免 dpr=2 时文字发虚。
        transform: dpr === 1 ? null : [dpr, 0, 0, dpr, 0, 0]
      });
      meta.renderTask = task;
      await task.promise;
      if (version !== state.version) return;
      meta.rendered = true;
      meta.renderedScale = state.scale;
      meta.renderedDpr = dpr;
      clearPageError(meta);
      updatePageIndicator();
    } catch (err) {
      if (version !== state.version) return;
      if (isRenderCancelled(err)) {
        cancelled = true;
        return;
      }
      showPageError(meta, '第 ' + meta.index + ' 页渲染失败：' + describeError(err));
      reportError('第 ' + meta.index + ' 页渲染失败：' + describeError(err));
    } finally {
      meta.rendering = false;
      if (meta.renderTask === task) meta.renderTask = null;
      // 被取消的渲染（缩放/重载/滚出视口）没有在队列里留下任何东西：如果这页仍在
      // 视口附近而尺寸已经变了，就自己重新排队。失败不重排，否则坏页会无限重试。
      if (cancelled && meta.version === state.version && isPageNearViewport(meta)) {
        enqueueRender(meta);
      }
    }
  }

  function isRenderCancelled(err) {
    if (!err) return false;
    if (err.name === 'RenderingCancelledException') return true;
    var message = err.message ? String(err.message) : '';
    return message.indexOf('Rendering cancelled') !== -1 || message.indexOf('RenderingCancelled') !== -1;
  }

  function showPageError(meta, message) {
    if (!meta.errorEl) {
      meta.errorEl = document.createElement('div');
      meta.errorEl.className = 'preview-page-error';
      meta.wrapper.appendChild(meta.errorEl);
    }
    meta.errorEl.textContent = message;
  }

  function clearPageError(meta) {
    if (!meta.errorEl) return;
    if (meta.errorEl.parentNode === meta.wrapper) meta.wrapper.removeChild(meta.errorEl);
    meta.errorEl = null;
  }

  function isPageNearViewport(meta) {
    if (!meta || !state.geometryValid || !pagesEl.clientHeight) return false;
    var viewTop = pagesEl.scrollTop - state.stackOffset;
    var viewBottom = viewTop + pagesEl.clientHeight;
    return meta.measuredTop <= viewBottom + RENDER_MARGIN_PX &&
      meta.measuredTop + meta.measuredHeight >= viewTop - RENDER_MARGIN_PX;
  }

  function requestVisibleRenders() {
    if (!state.pages.length || !state.geometryValid) return;
    // 面板被折叠时容器高度为 0，此时按几何判断会把所有页都算成「附近」。
    if (!pagesEl.clientHeight) return;
    var viewTop = pagesEl.scrollTop - state.stackOffset;
    var viewBottom = viewTop + pagesEl.clientHeight;
    for (var i = 0; i < state.pages.length; i++) {
      var meta = state.pages[i];
      if (meta.measuredTop > viewBottom + RENDER_MARGIN_PX) break; // 页序递增，后面更远
      if (meta.measuredTop + meta.measuredHeight < viewTop - RENDER_MARGIN_PX) continue;
      enqueueRender(meta);
    }
  }

  // ── 滚动与尺寸变化 ─────────────────────────────────────────────────────

  function onScroll() {
    if (state.scrollScheduled) return;
    state.scrollScheduled = true;
    var raf = window.requestAnimationFrame
      ? window.requestAnimationFrame
      : function (fn) { return window.setTimeout(fn, 16); };
    raf(function () {
      state.scrollScheduled = false;
      if (!state.pages.length) return;
      ensureLayoutWidth();
      updatePageIndicator();
      // 没有 IntersectionObserver 时用几何判定兜住惰性渲染。
      if (!state.hasObserver) requestVisibleRenders();
    });
  }

  function ensureLayoutWidth() {
    if (state.relayouting || !state.pages.length) return;
    var width = getContentWidth();
    // 面板从隐藏变为可见时宽度会从 0 变成真实值，但不会触发 window.resize，
    // 所以借滚动/交叉回调补一次重排。
    if (width > 0 && Math.abs(width - state.layoutWidth) > 1) relayoutKeepingPlace();
  }

  function onWindowResize() {
    if (state.resizeTimer) window.clearTimeout(state.resizeTimer);
    state.resizeTimer = window.setTimeout(function () {
      state.resizeTimer = null;
      ensureLayoutWidth();
    }, 150);
  }

  // ── 工具栏状态 ─────────────────────────────────────────────────────────

  function setFileName(name) {
    var text = (typeof name === 'string' && name) ? name : '';
    nameEl.textContent = text || '未打开文档';
    nameEl.title = text;
  }

  function updateZoomLabel() {
    zoomLabelEl.textContent = Math.round(state.scale * 100) + '%';
  }

  function updatePageIndicator() {
    var total = state.pages.length;
    if (!total) {
      pageLabelEl.textContent = '第 – / – 页';
      prevButton.disabled = true;
      nextButton.disabled = true;
      return;
    }
    if (state.geometryValid) {
      state.currentPage = findTopVisibleSlot(pagesEl.scrollTop - state.stackOffset) + 1;
    }
    state.currentPage = Math.min(Math.max(state.currentPage, 1), total);
    pageLabelEl.textContent = '第 ' + state.currentPage + ' / ' + total + ' 页';
    prevButton.disabled = state.currentPage <= 1;
    nextButton.disabled = state.currentPage >= total;
  }

  // ── 提示与错误展示 ─────────────────────────────────────────────────────

  function showLoading() {
    if (!stackEl) return;
    stackEl.textContent = '';
    var box = document.createElement('div');
    box.className = 'preview-loading';
    box.textContent = '正在加载 PDF…';
    stackEl.appendChild(box);
  }

  function showFatal(message) {
    if (state.observer) {
      try {
        state.observer.disconnect();
      } catch (e) {
        // 忽略
      }
    }
    state.pages = [];
    state.geometryValid = false;
    if (stackEl) {
      stackEl.textContent = '';
      var box = document.createElement('div');
      box.className = 'preview-error';
      var title = document.createElement('div');
      title.className = 'preview-error-title';
      title.textContent = '无法显示 PDF 预览';
      var detail = document.createElement('div');
      detail.className = 'preview-error-detail';
      detail.textContent = truncate(message, 1000);
      box.appendChild(title);
      box.appendChild(detail);
      stackEl.appendChild(box);
    }
    updatePageIndicator();
  }

  function onWindowError(event) {
    if (state.fatalReported) return; // 只报第一次，避免连环错误把宿主刷屏
    state.fatalReported = true;
    var source = event ? (event.error || event.message) : null;
    reportError('预览脚本异常：' + describeError(source));
  }

  function onUnhandledRejection(event) {
    if (state.fatalReported) return;
    state.fatalReported = true;
    reportError('预览脚本异常：' + describeError(event ? event.reason : null));
  }

  function describeError(err) {
    if (err === null || err === undefined) return '未知错误';
    if (typeof err === 'string') return truncate(err, MAX_ERROR_LENGTH);
    var name = err.name ? String(err.name) : '';
    var message = err.message ? String(err.message) : '';
    if (!message) {
      try {
        message = String(err);
      } catch (e) {
        message = '';
      }
    }
    if (/PasswordException/.test(name)) return '该 PDF 已加密，需要密码，暂不支持预览';
    if (/InvalidCharacterError/.test(name)) return 'PDF 数据不是合法的 base64（解码失败）';
    if (/InvalidPDFException/.test(name) || /Invalid PDF structure/i.test(message)) {
      return 'PDF 文件已损坏或不是有效的 PDF';
    }
    if (/MissingPDFException/.test(name)) return 'PDF 文件不存在或为空';
    if (/UnexpectedResponseException/.test(name)) return 'PDF 数据无法读取';
    if (/NetworkError/.test(name)) return 'PDF 数据读取失败';
    if (/size is zero/i.test(message)) return 'PDF 文件为空（0 字节）';
    if (/Worker was destroyed/i.test(message)) return '预览已重新加载，旧任务被取消';
    if (name && message) return truncate(name + '：' + message, MAX_ERROR_LENGTH);
    return truncate(message || '未知错误', MAX_ERROR_LENGTH);
  }

  function truncate(text, max) {
    var value = text === null || text === undefined ? '' : String(text);
    value = value.replace(/\s+/g, ' ').trim();
    if (value.length <= max) return value;
    return value.slice(0, max) + '…';
  }

  // ── base64 → 字节 ──────────────────────────────────────────────────────

  function base64ToBytes(base64) {
    if (typeof base64 !== 'string') throw new Error('PDF 数据缺失');
    var clean = base64.replace(/[\s]+/g, '');
    if (!clean) throw new Error('PDF 数据为空');
    if (clean.length % 4 !== 0) throw new Error('PDF 数据不是合法的 base64（长度不是 4 的倍数）');

    var padding = 0;
    if (clean.charAt(clean.length - 1) === '=') padding++;
    if (clean.charAt(clean.length - 2) === '=') padding++;
    var bytes = new Uint8Array((clean.length / 4) * 3 - padding);
    var offset = 0;
    // 分块 atob 并逐字节填充：String.fromCharCode(...arr) 在几十万字符时必然爆栈，
    // 一次解出整份超大 PDF 也会长时间占住主线程。
    var chunkSize = 65536; // 4 的倍数，切点始终落在 base64 的四字符组边界上
    for (var start = 0; start < clean.length; start += chunkSize) {
      var chunk = clean.substring(start, start + chunkSize);
      var binary = window.atob(chunk);
      for (var i = 0; i < binary.length; i++) bytes[offset++] = binary.charCodeAt(i);
    }
    return offset === bytes.length ? bytes : bytes.subarray(0, offset);
  }

  // ── 入口 ───────────────────────────────────────────────────────────────

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
