// Runs in page MAIN world
(() => {
  const origCreateObjectURL = URL.createObjectURL;
  const capturedMedia = new Map();

  URL.createObjectURL = function(obj) {
    const url = origCreateObjectURL.apply(this, arguments);
    if (obj instanceof Blob) {
      let type = obj.type || '';
      const size = obj.size || 0;
      
      // Default videos/large binaries to video/mp4
      if (!type || type === 'application/octet-stream') {
        if (size > 40960) {
          type = 'video/mp4';
        }
      }
      
      const isMedia = type.startsWith('video/') || type.startsWith('audio/') || type.startsWith('image/');
      
      if (isMedia || size > 10240) {
        const item = {
          url,
          type: type || 'video/mp4',
          size,
          timestamp: Date.now()
        };
        capturedMedia.set(url, item);
        window.postMessage({ type: 'TG_MEDIA_DETECTED', payload: item }, '*');
      }
    }
    return url;
  };

  // Intercept MediaSource streaming buffers if present
  if (typeof SourceBuffer !== 'undefined' && SourceBuffer.prototype.appendBuffer) {
    const origAppend = SourceBuffer.prototype.appendBuffer;
    const streamBuffers = new WeakMap();

    SourceBuffer.prototype.appendBuffer = function(buffer) {
      try {
        let chunks = streamBuffers.get(this);
        if (!chunks) {
          chunks = [];
          streamBuffers.set(this, chunks);
          this._tgUrl = null;
        }
        chunks.push(buffer.slice ? buffer.slice(0) : buffer);

        clearTimeout(this._tgDebounce);
        this._tgDebounce = setTimeout(() => {
          try {
            const blob = new Blob(chunks, { type: 'video/mp4' });
            if (this._tgUrl) {
              try { URL.revokeObjectURL(this._tgUrl); } catch (_) {}
            }
            this._tgUrl = origCreateObjectURL.call(URL, blob);
            const item = {
              url: this._tgUrl,
              type: 'video/mp4',
              size: blob.size,
              timestamp: Date.now()
            };
            window.postMessage({ type: 'TG_MEDIA_DETECTED', payload: item }, '*');
          } catch (_) {}
        }, 600);
      } catch (_) {}
      return origAppend.apply(this, arguments);
    };
  }

  // Unblock save restrictions & context menu
  ['contextmenu', 'copy', 'selectstart', 'dragstart'].forEach(evtName => {
    window.addEventListener(evtName, (e) => {
      e.stopImmediatePropagation();
    }, true);
  });

  // Enable download helper for in-page requests
  window.addEventListener('message', async (e) => {
    if (e.data && e.data.type === 'TG_REQUEST_BLOB_CONVERT') {
      const { url, id, filename } = e.data.payload;
      try {
        const res = await fetch(url);
        const blob = await res.blob();
        const reader = new FileReader();
        reader.onloadend = () => {
          window.postMessage({
            type: 'TG_BLOB_DATA_READY',
            payload: { id, filename, dataUrl: reader.result }
          }, '*');
        };
        reader.readAsDataURL(blob);
      } catch (err) {
        window.postMessage({
          type: 'TG_BLOB_ERROR',
          payload: { id, error: err.message }
        }, '*');
      }
    }
  });
})();
