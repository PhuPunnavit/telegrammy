// TG Downloader - Content Script
// Downloads media from Telegram Web

(() => {
  'use strict';

  console.log('[TG] Content script initializing...');

  // Inject MAIN world hook first
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('inject.js');
  (document.head || document.documentElement).appendChild(script);
  script.onload = () => {
    script.remove();
    console.log('[TG] inject.js injected successfully');
  };
  script.onerror = (e) => {
    console.error('[TG] Failed to inject inject.js:', e);
  };

  const detectedMedia = new Map();
  let panelVisible = false;

  // Listen for media from inject.js
  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'TG_MEDIA_DETECTED') {
      const media = event.data.payload;
      if (media && media.url) {
        if (!detectedMedia.has(media.url)) {
          detectedMedia.set(media.url, media);
          updateFloatingButton();
          if (panelVisible) renderMediaList();
          console.log('[TG] Media captured:', media.type, formatBytes(media.size));
        }
      }
    }
  });

  // Start observing DOM with debounce
  let attachTimeout = null;
  const observer = new MutationObserver(() => {
    clearTimeout(attachTimeout);
    attachTimeout = setTimeout(() => {
      try {
        attachQuickButtons();
      } catch (e) {
        console.error('[TG] Error in attachQuickButtons:', e);
      }
    }, 100);
  });

  function startObserving() {
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
      console.log('[TG] DOM observer started');
      // Initial attachment
      attachQuickButtons();
    } else {
      console.log('[TG] Waiting for document.body...');
      setTimeout(startObserving, 100);
    }
  }

  startObserving();

  function formatBytes(bytes) {
    if (!bytes || isNaN(bytes)) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  }

  function getMediaExtension(type) {
    if (!type) return '.mp4';
    const t = type.toLowerCase();
    if (t.includes('video/webm')) return '.webm';
    if (t.includes('video/mp4')) return '.mp4';
    if (t.includes('video')) return '.mp4';
    if (t.includes('audio/ogg')) return '.ogg';
    if (t.includes('audio/mp3') || t.includes('audio/mpeg')) return '.mp3';
    if (t.includes('audio')) return '.mp3';
    if (t.includes('image/png')) return '.png';
    if (t.includes('image/webp')) return '.webp';
    if (t.includes('image/jpeg')) return '.jpg';
    if (t.includes('image')) return '.jpg';
    return '.mp4';
  }

  function triggerDownload(targetUrl, filename, type) {
    console.log('[TG] Download request:', targetUrl?.substring(0, 30), filename);

    if (!targetUrl) {
      alert('Media not ready. Please wait and try again.');
      return;
    }

    const ext = getMediaExtension(type);
    let safeFilename = (filename || `tg_${Date.now()}`).replace(/[<>:"/\\|?*]/g, '_');
    if (!safeFilename.includes('.')) {
      safeFilename += ext;
    }

    // Send to inject.js - use window.location.origin for security
    window.postMessage({
      type: 'TG_TRIGGER_DOWNLOAD',
      payload: { url: targetUrl, filename: safeFilename }
    }, window.location.origin);
  }

  function attachQuickButtons() {
    // More comprehensive selectors for Telegram Web
    const videoSelectors = [
      'video:not([data-tg-btn])',
      '.VideoPlayer video:not([data-tg-btn])',
      '.media-viewer-content video:not([data-tg-btn])',
      '.VideoMessage video:not([data-tg-btn])',
    ].join(', ');

    const audioSelectors = [
      'audio:not([data-tg-btn])',
      '.AudioPlayer audio:not([data-tg-btn])',
    ].join(', ');

    const imgSelectors = [
      'img.full-media:not([data-tg-btn])',
      '.media-photo:not([data-tg-btn])',
      '.Message img:not([data-tg-btn])',
      '.media-viewer-content img:not([data-tg-btn])',
    ].join(', ');

    const allSelectors = [videoSelectors, audioSelectors, imgSelectors].join(', ');
    const elements = document.querySelectorAll(allSelectors);

    console.log('[TG] Found', elements.length, 'media elements');

    elements.forEach((node, index) => {
      if (node.getAttribute('data-tg-btn') === 'true') return;
      node.setAttribute('data-tg-btn', 'true');

      // Find a suitable container
      let container = node.closest('.VideoPlayer, .media-viewer-content, .Message, .media-container, .bubble-content');

      if (!container) {
        container = node.parentElement;
      }

      if (!container || container.querySelector('.tg-dl-quick-btn')) {
        console.log('[TG] Skipping element', index, '- no container or button exists');
        return;
      }

      // Create button
      const btn = document.createElement('button');
      btn.className = 'tg-dl-quick-btn';
      btn.innerHTML = '<span>⬇</span>';
      btn.title = 'Download media';
      btn.style.cssText = 'position:absolute; top:8px; right:8px; z-index:9999; background:rgba(36,129,204,0.92); color:#fff; border:none; border-radius:6px; padding:6px 12px; cursor:pointer;';

      btn.onclick = (e) => {
        e.stopPropagation();
        e.preventDefault();
        console.log('[TG] Download button clicked');

        let src = node.currentSrc || node.src;

        if (!src && node.tagName === 'VIDEO') {
          src = node.poster;
          if (!src) {
            const source = node.querySelector('source');
            if (source) src = source.src;
          }
        }

        if (!src) {
          console.error('[TG] No source found for element:', node);
          alert('Media not loaded. Please wait for the media to load.');
          return;
        }

        console.log('[TG] Media source:', src);

        let fileType = 'video/mp4';
        const tag = node.tagName.toLowerCase();
        if (tag === 'audio') fileType = 'audio/mp3';
        else if (tag === 'img') fileType = 'image/jpeg';

        const ext = getMediaExtension(fileType);
        triggerDownload(src, `tg_${Date.now()}${ext}`, fileType);
      };

      // Position container and add button
      if (container) {
        const computedStyle = window.getComputedStyle(container);
        if (computedStyle.position === 'static') {
          container.style.position = 'relative';
        }
        container.appendChild(btn);
        console.log('[TG] Button attached to element', index);
      }
    });
  }

  // Create floating button
  const floatingBtn = document.createElement('div');
  floatingBtn.className = 'tg-dl-floating-btn';
  floatingBtn.innerHTML = '<span>⬇ TG</span><span class="tg-badge" id="tgBadge">0</span>';
  floatingBtn.style.cssText = 'position:fixed; bottom:24px; right:24px; z-index:100000; background:#2481cc; color:#fff; padding:10px 16px; border-radius:24px; cursor:pointer; display:flex; align-items:center; gap:8px;';
  document.body.appendChild(floatingBtn);
  floatingBtn.onclick = () => toggleBatchPanel();

  function updateFloatingButton() {
    const badge = document.getElementById('tgBadge');
    if (badge) badge.textContent = detectedMedia.size;
  }

  // Drawer
  const drawer = document.createElement('div');
  drawer.className = 'tg-dl-drawer hidden';
  drawer.innerHTML = `
    <div class="tg-dl-header">
      <h3>TG Downloader</h3>
      <button class="tg-dl-close" id="tgDlClose">×</button>
    </div>
    <div class="tg-dl-actions">
      <button id="tgSelectAll">Select All</button>
      <button id="tgClearAll">Clear</button>
      <button id="tgBatchDownload" class="tg-btn-primary">Download (<span id="tgSelCount">0</span>)</button>
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
    if (!listEl) return;

    if (detectedMedia.size === 0) {
      listEl.innerHTML = '<div class="tg-empty-hint">Play media to capture</div>';
      return;
    }

    listEl.innerHTML = '';
    detectedMedia.forEach((item, url) => {
      const row = document.createElement('div');
      row.className = 'tg-media-row';

      const ext = getMediaExtension(item.type);
      const isVideo = item.type.startsWith('video');
      const isAudio = item.type.startsWith('audio');

      row.innerHTML = `
        <label class="tg-item-label">
          <input type="checkbox" class="tg-item-chk" data-url="${url}" checked />
          <div class="tg-media-icon">${isVideo ? '🎬' : (isAudio ? '🎵' : '🖼️')}</div>
          <div class="tg-media-info">
            <span class="tg-name">${item.type.split('/')[1] || 'media'} (${formatBytes(item.size)})</span>
          </div>
        </label>
        <button class="tg-single-dl" data-url="${url}" data-type="${item.type}">⬇</button>
      `;

      row.querySelector('.tg-single-dl').onclick = () => {
        const ext = getMediaExtension(item.type);
        triggerDownload(url, `tg_download_${Date.now()}${ext}`, item.type);
      };

      listEl.appendChild(row);
    });

    updateSelectedCount();
  }

  function updateSelectedCount() {
    const checked = document.querySelectorAll('.tg-item-chk:checked').length;
    const countEl = document.getElementById('tgSelCount');
    if (countEl) countEl.textContent = checked;
  }

  document.getElementById('tgSelectAll').onclick = () => {
    document.querySelectorAll('.tg-item-chk').forEach(c => c.checked = !c.checked);
    updateSelectedCount();
  };

  document.getElementById('tgClearAll').onclick = () => {
    detectedMedia.clear();
    updateFloatingButton();
    renderMediaList();
  };

  document.getElementById('tgBatchDownload').onclick = () => {
    const checked = document.querySelectorAll('.tg-item-chk:checked');
    if (checked.length === 0) return alert('Select at least one media');

    checked.forEach((chk, idx) => {
      const url = chk.getAttribute('data-url');
      const meta = detectedMedia.get(url);
      if (meta) {
        setTimeout(() => {
          const ext = getMediaExtension(meta.type);
          triggerDownload(url, `tg_batch_${Date.now()}_${idx}${ext}`, meta.type);
        }, idx * 300);
      }
    });
  };

  document.addEventListener('change', (e) => {
    if (e.target.classList.contains('tg-item-chk')) {
      updateSelectedCount();
    }
  });

  console.log('[TG] Content script loaded successfully');
})();