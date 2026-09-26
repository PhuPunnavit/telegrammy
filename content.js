(() => {
  // Inject MAIN world hook
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('inject.js');
  (document.head || document.documentElement).appendChild(script);
  script.onload = () => script.remove();

  const detectedMedia = new Map();
  let panelVisible = false;

  // Listen for media from inject.js
  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'TG_MEDIA_DETECTED') {
      const media = event.data.payload;
      if (!detectedMedia.has(media.url)) {
        detectedMedia.set(media.url, media);
        updateFloatingButton();
        if (panelVisible) renderMediaList();
      }
    }
  });

  // Observe DOM for Telegram media elements to add quick download buttons
  const observer = new MutationObserver(() => {
    attachQuickButtons();
  });

  observer.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true
  });

  function formatBytes(bytes) {
    if (!bytes) return 'N/A';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  }

  function getMediaExtension(type) {
    if (type.includes('video/mp4')) return '.mp4';
    if (type.includes('video/webm')) return '.webm';
    if (type.includes('video')) return '.mp4';
    if (type.includes('audio/ogg')) return '.ogg';
    if (type.includes('audio/mp3') || type.includes('audio/mpeg')) return '.mp3';
    if (type.includes('audio')) return '.mp3';
    if (type.includes('image/png')) return '.png';
    if (type.includes('image/webp')) return '.webp';
    if (type.includes('image/jpeg')) return '.jpg';
    return '.bin';
  }

  function triggerDownload(url, filename) {
    chrome.runtime.sendMessage({
      type: 'DOWNLOAD_FILE',
      payload: { url, filename }
    }, (res) => {
      if (!res || !res.success) {
        // Fallback via anchor click
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
    });
  }

  function attachQuickButtons() {
    // Media targets for Telegram Web A & K
    const mediaNodes = document.querySelectorAll(
      'video:not([data-tg-btn]), audio:not([data-tg-btn]), .media-photo:not([data-tg-btn]), img.full-media:not([data-tg-btn])'
    );

    mediaNodes.forEach(node => {
      node.setAttribute('data-tg-btn', 'true');
      const container = node.closest('.media-container, .media-wrapper, .bubble-content, .Message, .media-box') || node.parentElement;
      if (!container || container.querySelector('.tg-dl-quick-btn')) return;

      const btn = document.createElement('button');
      btn.className = 'tg-dl-quick-btn';
      btn.innerHTML = '⬇ Download';
      btn.title = 'Download Telegram Media';
      btn.onclick = (e) => {
        e.stopPropagation();
        e.preventDefault();
        const src = node.currentSrc || node.src;
        if (!src) {
          alert('Media source loading, please play or open it first.');
          return;
        }
        const ext = node.tagName.toLowerCase() === 'video' ? '.mp4' : (node.tagName.toLowerCase() === 'audio' ? '.mp3' : '.jpg');
        const filename = `tg_${Date.now()}${ext}`;
        triggerDownload(src, filename);
      };
      container.style.position = 'relative';
      container.appendChild(btn);
    });
  }

  // Floating Control & Batch Panel
  const floatingBtn = document.createElement('div');
  floatingBtn.className = 'tg-dl-floating-btn';
  floatingBtn.innerHTML = `<span>⚡ TG Downloader</span><span class="tg-badge" id="tgBadge">0</span>`;
  document.body.appendChild(floatingBtn);

  floatingBtn.onclick = () => toggleBatchPanel();

  function updateFloatingButton() {
    const badge = document.getElementById('tgBadge');
    if (badge) badge.textContent = detectedMedia.size;
  }

  // Drawer modal
  const drawer = document.createElement('div');
  drawer.className = 'tg-dl-drawer hidden';
  drawer.innerHTML = `
    <div class="tg-dl-header">
      <h3>TG Media Downloader</h3>
      <button class="tg-dl-close" id="tgDlClose">&times;</button>
    </div>
    <div class="tg-dl-actions">
      <button id="tgSelectAll">Select All</button>
      <button id="tgClearAll">Clear</button>
      <button id="tgBatchDownload" class="tg-btn-primary">Download Selected (<span id="tgSelCount">0</span>)</button>
    </div>
    <div class="tg-dl-list" id="tgMediaList"></div>
  `;
  document.body.appendChild(drawer);

  document.getElementById('tgDlClose').onclick = () => toggleBatchPanel(false);

  function toggleBatchPanel(forceState) {
    panelVisible = forceState !== undefined ? forceState : !panelVisible;
    if (panelVisible) {
      drawer.classList.remove('hidden');
      renderMediaList();
    } else {
      drawer.classList.add('hidden');
    }
  }

  function renderMediaList() {
    const listEl = document.getElementById('tgMediaList');
    listEl.innerHTML = '';

    if (detectedMedia.size === 0) {
      listEl.innerHTML = `<div class="tg-empty-hint">Play or preview media in chat to capture.</div>`;
      return;
    }

    detectedMedia.forEach((item, url) => {
      const row = document.createElement('div');
      row.className = 'tg-media-row';
      const ext = getMediaExtension(item.type);
      const isVideo = item.type.startsWith('video');
      const isAudio = item.type.startsWith('audio');
      const isImg = item.type.startsWith('image');

      row.innerHTML = `
        <label class="tg-item-label">
          <input type="checkbox" class="tg-item-chk" data-url="${url}" checked />
          <div class="tg-media-icon">${isVideo ? '🎬' : (isAudio ? '🎵' : '🖼️')}</div>
          <div class="tg-media-info">
            <span class="tg-name">${item.type.split('/')[1]?.toUpperCase() || 'MEDIA'} (${formatBytes(item.size)})</span>
            <span class="tg-date">${new Date(item.timestamp).toLocaleTimeString()}</span>
          </div>
        </label>
        <button class="tg-single-dl" data-url="${url}">Download</button>
      `;

      row.querySelector('.tg-single-dl').onclick = () => {
        triggerDownload(url, `tg_download_${Date.now()}${ext}`);
      };

      listEl.appendChild(row);
    });

    updateSelectedCount();
    attachCheckboxListeners();
  }

  function updateSelectedCount() {
    const checked = document.querySelectorAll('.tg-item-chk:checked').length;
    const countEl = document.getElementById('tgSelCount');
    if (countEl) countEl.textContent = checked;
  }

  function attachCheckboxListeners() {
    document.querySelectorAll('.tg-item-chk').forEach(chk => {
      chk.onchange = updateSelectedCount;
    });
  }

  document.getElementById('tgSelectAll').onclick = () => {
    const chks = document.querySelectorAll('.tg-item-chk');
    const allChecked = Array.from(chks).every(c => c.checked);
    chks.forEach(c => c.checked = !allChecked);
    updateSelectedCount();
  };

  document.getElementById('tgClearAll').onclick = () => {
    detectedMedia.clear();
    updateFloatingButton();
    renderMediaList();
  };

  document.getElementById('tgBatchDownload').onclick = () => {
    const checkedBoxes = document.querySelectorAll('.tg-item-chk:checked');
    if (checkedBoxes.length === 0) return alert('No items selected');

    const items = [];
    checkedBoxes.forEach(chk => {
      const url = chk.getAttribute('data-url');
      const meta = detectedMedia.get(url);
      if (meta) {
        items.push({
          url,
          filename: `tg_batch_${Date.now()}_${items.length}${getMediaExtension(meta.type)}`
        });
      }
    });

    chrome.runtime.sendMessage({
      type: 'BATCH_DOWNLOAD',
      payload: { items }
    });
  };
})();
