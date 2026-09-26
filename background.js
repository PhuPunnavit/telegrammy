// Background script for TG Downloader Extension
// Handles Chrome downloads API

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'DOWNLOAD_DATA_URL') {
    // Handle data URL download (converted from blob)
    const { dataUrl, filename } = msg.payload;
    console.log('[TG Downloader Background] Data URL download:', filename);

    const cleanName = _ensureFilename(filename);

    chrome.downloads.download({
      url: dataUrl,
      filename: `TG_Downloads/${cleanName}`,
      saveAs: false
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        console.error('[TG Downloader Background] Download error:', chrome.runtime.lastError);
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else {
        console.log('[TG Downloader Background] Download started:', downloadId);
        sendResponse({ success: true, downloadId });
      }
    });
    return true;
  }

  if (msg.type === 'DOWNLOAD_FILE') {
    let { url, filename } = msg.payload;

    console.log('[TG Downloader Background] Download request:', { url, filename });

    if (!url) {
      console.error('[TG Downloader Background] No URL provided');
      sendResponse({ success: false, error: 'No URL provided' });
      return true;
    }

    // For blob URLs, redirect to inject.js
    if (url.startsWith('blob:')) {
      console.log('[TG Downloader Background] Blob URL - inject.js should handle');
      sendResponse({ success: false, error: 'Blob URL - handled by page script' });
      return true;
    }

    const cleanName = _ensureFilename(filename);

    try {
      chrome.downloads.download({
        url: url,
        filename: `TG_Downloads/${cleanName}`,
        saveAs: false
      }, (downloadId) => {
        if (chrome.runtime.lastError) {
          console.error('[TG Downloader Background] Download error:', chrome.runtime.lastError);
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          console.log('[TG Downloader Background] Download started:', downloadId);
          sendResponse({ success: true, downloadId });
        }
      });
    } catch (e) {
      console.error('[TG Downloader Background] Exception:', e);
      sendResponse({ success: false, error: e.message });
    }
    return true;
  }

  if (msg.type === 'BATCH_DOWNLOAD') {
    const items = msg.payload.items || [];
    console.log('[TG Downloader Background] Batch download:', items.length, 'items');

    let completed = 0;
    items.forEach((item, idx) => {
      let { url, filename } = item;

      if (!url) {
        console.warn('[TG Downloader Background] Skipping item', idx, '- no URL');
        return;
      }

      const cleanName = _ensureFilename(filename);

      setTimeout(() => {
        if (url.startsWith('blob:')) {
          console.log('[TG Downloader Background] Skipping blob URL in batch');
          return;
        }

        chrome.downloads.download({
          url: url,
          filename: `TG_Downloads/${cleanName}`,
          saveAs: false
        }, (downloadId) => {
          completed++;
          if (chrome.runtime.lastError) {
            console.error('[TG Downloader Background] Batch item', idx, 'error:', chrome.runtime.lastError);
          } else {
            console.log('[TG Downloader Background] Batch item', idx, 'started:', downloadId);
          }
        });
      }, idx * 500);
    });

    sendResponse({ success: true, count: items.length });
    return true;
  }
});

function _ensureFilename(filename) {
  if (!filename) {
    filename = `tg_video_${Date.now()}.mp4`;
  }

  // Clean invalid characters
  let cleanName = filename.replace(/[<>:"/\\|?*]/g, '_');

  // If no extension, add mp4
  if (!cleanName.includes('.')) {
    cleanName += '.mp4';
  }

  return cleanName;
}

console.log('[TG Downloader] Background script loaded');