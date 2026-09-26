// Runs in page MAIN world — injected at document_start
// Intercepts network requests to capture media URLs directly

(() => {
  // Stores media blobs: Map<url, {blob, type, size, timestamp}>
  const storedBlobs = new Map();
  // Track XHR responses
  const xhrResponses = new Map();
  let xhrCounter = 0;

  // Memory management - max 50 blobs
  const MAX_STORED_BLOBS = 50;

  console.log('[TG] inject.js starting - network interception method');

  // ── Hook fetch to capture media responses ────────────────────────────────────
  const origFetch = window.fetch;
  window.fetch = async function(...args) {
    const request = args[0];
    const url = request instanceof Request ? request.url : request;
    const urlStr = String(url || '');

    console.log(`[TG] fetch: ${urlStr.substring(0, 60)}`);

    const response = await origFetch.apply(this, args);

    // Clone response to avoid consuming original
    const clonedResponse = response.clone();
    const contentType = clonedResponse.headers.get('content-type') || '';
    const contentLength = clonedResponse.headers.get('content-length');
    const isMedia = contentType.startsWith('video/') ||
                    contentType.startsWith('audio/') ||
                    contentType.startsWith('image/');

    if (isMedia && response.ok) {
      try {
        const blob = await clonedResponse.blob();

        // Store by URL (the actual HTTP URL we can re-fetch)
        storeBlob(urlStr, blob, contentType);

        console.log(`[TG] Media stored: ${urlStr.substring(0, 50)} | ${contentType} | ${blob.size}`);

        _notify({
          url: urlStr,
          type: contentType || 'video/mp4',
          size: blob.size,
          timestamp: Date.now(),
          source: 'fetch'
        });
      } catch (e) {
        console.error('[TG] Error storing blob:', e);
      }
    }

    return response;
  };

  // ── Hook XMLHttpRequest ───────────────────────────────────────────────────────
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._tgUrl = url;
    this._tgXhrId = ++xhrCounter;
    console.log(`[TG] XHR.open: ${method} ${url.substring(0, 60)}`);
    return origOpen.apply(this, [method, url, ...rest]);
  };

  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function(...args) {
    const xhr = this;

    // Use addEventListener instead of property assignment to avoid conflicts
    xhr.addEventListener('readystatechange', function() {
      if (xhr.readyState === 4) {
        const status = xhr.status;
        const contentType = xhr.getResponseHeader('content-type') || '';
        const isMedia = contentType.startsWith('video/') ||
                        contentType.startsWith('audio/') ||
                        contentType.startsWith('image/');

        // Skip 206 Partial Content - only accept complete responses
        if (isMedia && status === 200) {
          try {
            const response = xhr.response;
            let blob = null;

            if (response instanceof Blob) {
              blob = response;
            } else if (response instanceof ArrayBuffer || response instanceof Uint8Array) {
              blob = new Blob([response], { type: contentType });
            }

            if (blob) {
              // Use responseURL (final URL after redirects)
              const finalUrl = xhr.responseURL || xhr._tgUrl;
              storeBlob(finalUrl, blob, contentType);

              console.log(`[TG] XHR stored: ${finalUrl.substring(0, 50)} | ${contentType} | ${blob.size}`);

              _notify({
                url: finalUrl,
                type: contentType || 'video/mp4',
                size: blob.size,
                timestamp: Date.now(),
                source: 'xhr'
              });
            }
          } catch (e) {
            console.error(`[TG] XHR error:`, e);
          }
        }
      }
    });

    return origSend.apply(this, args);
  };

  // ── Hook URL.createObjectURL to track blob URLs ──────────────────────────────
  const origCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = function(obj) {
    const blobUrl = origCreateObjectURL.apply(this, arguments);

    if (obj instanceof Blob) {
      const type = obj.type || '';
      const size = obj.size;
      const isMedia = type.startsWith('video/') || type.startsWith('audio/') || type.startsWith('image/');

      if (isMedia && size > 10240) {
        // Store by blob URL so we can look it up when download is triggered
        storeBlob(blobUrl, obj, type);

        console.log(`[TG] Blob URL created: ${blobUrl.substring(0, 50)} | ${type} | ${size}`);

        _notify({
          url: blobUrl,
          type: type || 'video/mp4',
          size: size,
          timestamp: Date.now(),
          source: 'blob_url'
        });
      }
    }

    return blobUrl;
  };

  // Block URL revocation but call original to avoid breaking page expectations
  const origRevokeObjectURL = URL.revokeObjectURL;
  URL.revokeObjectURL = function(url) {
    console.log('[TG] Revoke blocked (but called):', url?.substring(0, 30));
    // Call original to satisfy page expectations
    try {
      origRevokeObjectURL.call(this, url);
    } catch (e) {
      // Ignore errors
    }
  };

  // ── Blob storage with memory management ───────────────────────────────────────
  function storeBlob(url, blob, type) {
    storedBlobs.set(url, {
      blob: blob,
      type: type || 'video/mp4',
      size: blob.size,
      timestamp: Date.now()
    });

    // Cleanup old blobs if we exceed limit
    if (storedBlobs.size > MAX_STORED_BLOBS) {
      // Remove oldest entry
      let oldestUrl = null;
      let oldestTime = Infinity;
      for (const [url, data] of storedBlobs) {
        if (data.timestamp < oldestTime) {
          oldestTime = data.timestamp;
          oldestUrl = url;
        }
      }
      if (oldestUrl) {
        storedBlobs.delete(oldestUrl);
        console.log('[TG] Cleaned up old blob:', oldestUrl.substring(0, 40));
      }
    }
  }

  // ── Download handler ──────────────────────────────────────────────────────────
  window.addEventListener('message', async (e) => {
    if (!e.data || e.data.type !== 'TG_TRIGGER_DOWNLOAD') return;
    const { url, filename } = e.data.payload;

    console.log('[TG] Download requested:', url?.substring(0, 40));
    await performDownload(url, filename);
  });

  async function performDownload(requestUrl, filename) {
    let blob = null;
    let mimeType = 'video/mp4';

    console.log('[TG] Looking for:', requestUrl?.substring(0, 40));
    console.log('[TG] Available URLs:', Array.from(storedBlobs.keys()).map(u => u.substring(0, 40)));

    // Strategy 1: Direct lookup
    if (requestUrl && storedBlobs.has(requestUrl)) {
      const stored = storedBlobs.get(requestUrl);
      blob = stored.blob;
      mimeType = stored.type;
      console.log('[TG] Strategy 1: Direct match');
    }

    // Strategy 2: Try fetching HTTP URL
    if (!blob && requestUrl && !requestUrl.startsWith('data:') && !requestUrl.startsWith('blob:')) {
      try {
        console.log('[TG] Strategy 2: Fetching HTTP URL...');
        const response = await fetch(requestUrl, { credentials: 'include' });
        if (response.ok) {
          blob = await response.blob();
          mimeType = response.headers.get('content-type') || blob.type || 'video/mp4';
          console.log('[TG] Strategy 2: Fetched', mimeType, blob.size);
        }
      } catch (err) {
        console.log('[TG] Strategy 2 failed:', err.message);
      }
    }

    // Strategy 3: Check if any stored URL matches (strict pathname match)
    if (!blob && requestUrl) {
      try {
        const reqUrl = new URL(requestUrl);
        for (const [storedUrl, data] of storedBlobs) {
          try {
            const sUrl = new URL(storedUrl);
            if (sUrl.pathname === reqUrl.pathname) {
              blob = data.blob;
              mimeType = data.type;
              console.log('[TG] Strategy 3: Pathname match');
              break;
            }
          } catch (e) {
            // Not a valid URL, skip
          }
        }
      } catch (e) {
        // requestUrl not a valid URL
      }
    }

    // Strategy 4: Use most recent blob OF THE SAME TYPE
    if (!blob && storedBlobs.size > 0) {
      // Infer type from filename
      let expectedType = 'video/';
      if (filename && (filename.includes('.mp3') || filename.includes('.ogg'))) {
        expectedType = 'audio/';
      } else if (filename && (filename.includes('.jpg') || filename.includes('.png'))) {
        expectedType = 'image/';
      }

      let latestTime = 0;
      let latestBlob = null;
      for (const [url, data] of storedBlobs) {
        if (data.type.startsWith(expectedType) && data.timestamp > latestTime) {
          latestTime = data.timestamp;
          latestBlob = data;
        }
      }
      if (latestBlob) {
        blob = latestBlob.blob;
        mimeType = latestBlob.type;
        console.log('[TG] Strategy 4: Latest matching type');
      }
    }

    if (!blob) {
      console.error('[TG] No media found');
      alert('Media not found. Please play the video first, then try again.');
      return;
    }

    // Determine extension
    let ext = '.mp4';
    if (mimeType.includes('webm')) ext = '.webm';
    else if (mimeType.includes('audio')) ext = '.mp3';
    else if (mimeType.includes('png')) ext = '.png';
    else if (mimeType.includes('webp')) ext = '.webp';
    else if (mimeType.includes('jpeg')) ext = '.jpg';

    let safeName = (filename || `tg_${Date.now()}`).replace(/[<>:"/\\|?*]/g, '_');
    if (!safeName.includes('.')) safeName += ext;

    console.log('[TG] Downloading:', safeName, mimeType, blob.size);

    // Use blob URL directly instead of data URL to avoid size limits
    const downloadUrl = origCreateObjectURL.call(URL, blob);
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = safeName;
    a.style.display = 'none';
    document.body.appendChild(a);

    // Use MouseEvent for better compatibility
    a.dispatchEvent(new MouseEvent('click'));

    setTimeout(() => {
      a.remove();
      origRevokeObjectURL.call(URL, downloadUrl);
      console.log('[TG] Download complete:', safeName);
    }, 1000);
  }

  function _notify(payload) {
    window.postMessage({ type: 'TG_MEDIA_DETECTED', payload }, '*');
  }

  // Unblock context menu
  ['contextmenu', 'copy', 'selectstart', 'dragstart'].forEach(evt => {
    window.addEventListener(evt, e => e.stopImmediatePropagation(), true);
  });

  // Expose for debugging
  window.__TG_DOWNLOADER__ = {
    storedBlobs: storedBlobs,
    version: '2.0'
  };

  console.log('[TG] inject.js loaded - network interception active');
})();