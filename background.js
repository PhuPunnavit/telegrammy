chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'DOWNLOAD_FILE') {
    let { url, filename } = msg.payload;
    let cleanName = (filename || `tg_video_${Date.now()}.mp4`).replace(/[<>:"/\\|?*]/g, '_');
    
    // Force .mp4 extension for videos and clean up .bin / .webm
    if (!cleanName.includes('.')) {
      cleanName += '.mp4';
    } else if (cleanName.endsWith('.bin') || cleanName.endsWith('.webm')) {
      cleanName = cleanName.replace(/\.(bin|webm)$/i, '.mp4');
    }
    
    chrome.downloads.download({
      url: url,
      filename: `TG_Downloads/${cleanName}`,
      saveAs: false
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ success: true, downloadId });
      }
    });
    return true;
  }

  if (msg.type === 'BATCH_DOWNLOAD') {
    const items = msg.payload.items || [];
    items.forEach((item, idx) => {
      let cleanName = (item.filename || `tg_video_${Date.now()}_${idx}.mp4`).replace(/[<>:"/\\|?*]/g, '_');
      if (!cleanName.includes('.')) {
        cleanName += '.mp4';
      } else if (cleanName.endsWith('.bin') || cleanName.endsWith('.webm')) {
        cleanName = cleanName.replace(/\.(bin|webm)$/i, '.mp4');
      }
      setTimeout(() => {
        chrome.downloads.download({
          url: item.url,
          filename: `TG_Downloads/${cleanName}`,
          saveAs: false
        });
      }, idx * 250);
    });
    sendResponse({ success: true, count: items.length });
    return true;
  }
});
