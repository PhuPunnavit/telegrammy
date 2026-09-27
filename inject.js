// TG Downloader - Production-Ready Media Capture
// Hooks MediaSource API (primary), SourceBuffer.appendBuffer (chunks), and blob URLs
// This is where Telegram Web actually streams video - we capture segments here
(() => {
  console.log('[TG] *** INJECT.JS STARTING ***');

  // ============================================================================
  // STORAGE: Separate tracking for MediaSource streams vs direct blobs
  // ============================================================================

  // Track MediaSource instances and their buffers
  const mediaSourceBuffers = new Map(); // mediaSource -> { chunks: [], complete: bool }

  // Track final blobs (after combining or direct capture)
  const capturedBlobs = new Map(); // url/id -> { blob, type, timestamp, source }

  // For debugging/stats
  let mediaSourceCount = 0;
  let appendBufferCount = 0;
  let fetchCount = 0;
  let xhrCount = 0;

  // ============================================================================
  // 1. MEDIASOURCE API HOOK - PRIMARY METHOD (where Telegram streams video)
  // ============================================================================
  // Telegram uses MediaSource to stream video in chunks. By hooking SourceBuffer.appendBuffer,
  // we can capture each chunk as it arrives and combine them into a complete video.

  console.log('[TG] Installing MediaSource hooks...');

  const origMediaSourceAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function(mimeType) {
    mediaSourceCount++;
    const msId = mediaSourceCount;
    console.log(`[TG-MS] #${msId} Created MediaSource for MIME: ${mimeType}`);

    const sourceBuffer = origMediaSourceAddSourceBuffer.call(this, mimeType);

    // Hook appendBuffer to capture chunks
    const origAppendBuffer = sourceBuffer.appendBuffer;
    sourceBuffer.appendBuffer = function(data) {
      appendBufferCount++;

      let bufferSize = 0;
      if (data instanceof ArrayBuffer) {
        bufferSize = data.byteLength;
      } else if (data instanceof Uint8Array || ArrayBuffer.isView(data)) {
        bufferSize = data.byteLength;
      }

      console.log(`[TG-APPEND] #${appendBufferCount} Chunk size: ${bufferSize} bytes (MS #${msId})`);

      // Store chunk for this MediaSource
      if (!mediaSourceBuffers.has(this)) {
        mediaSourceBuffers.set(this, {
          chunks: [],
          mimeType: mimeType,
          totalSize: 0,
          complete: false,
          createdAt: Date.now()
        });
      }

      const buffer = mediaSourceBuffers.get(this);

      // Clone the data before storing (ArrayBuffer data might be reused)
      let chunkCopy;
      if (data instanceof ArrayBuffer) {
        chunkCopy = new Uint8Array(new ArrayBuffer(data.byteLength));
        chunkCopy.set(new Uint8Array(data));
      } else if (data instanceof Uint8Array) {
        chunkCopy = new Uint8Array(data);
      } else {
        chunkCopy = new Uint8Array(data);
      }

      buffer.chunks.push(chunkCopy);
      buffer.totalSize += chunkCopy.byteLength;

      console.log(`[TG-APPEND] #${appendBufferCount} Total buffered: ${(buffer.totalSize / 1024 / 1024).toFixed(2)}MB in ${buffer.chunks.length} chunks`);

      return origAppendBuffer.call(this, data);
    };

    // Hook endOfStream to know when streaming is complete
    const origEndOfStream = this.endOfStream;
    if (origEndOfStream) {
      this.endOfStream = function(error) {
        if (!error) {
          console.log(`[TG-MS] #${msId} endOfStream called - stream complete`);
          if (mediaSourceBuffers.has(sourceBuffer)) {
            const buffer = mediaSourceBuffers.get(sourceBuffer);
            buffer.complete = true;

            // Combine chunks into final blob
            if (buffer.chunks.length > 0) {
              try {
                const combinedBlob = new Blob(buffer.chunks, {
                  type: buffer.mimeType || 'video/mp4'
                });

                const blobId = `ms_${msId}_${Date.now()}`;
                capturedBlobs.set(blobId, {
                  blob: combinedBlob,
                  type: buffer.mimeType || 'video/mp4',
                  timestamp: Date.now(),
                  source: 'MediaSource',
                  chunkCount: buffer.chunks.length,
                  totalSize: buffer.totalSize
                });

                console.log(`[TG-MS] ✓✓✓ COMBINED: ${blobId}`);
                console.log(`[TG-MS]   Size: ${(combinedBlob.size / 1024 / 1024).toFixed(2)}MB`);
                console.log(`[TG-MS]   Chunks: ${buffer.chunks.length}`);
                console.log(`[TG-MS]   Type: ${buffer.mimeType}`);
              } catch (e) {
                console.error(`[TG-MS] Error combining chunks: ${e.message}`);
              }
            }
          }
        }
        return origEndOfStream?.call(this, error);
      };
    }

    return sourceBuffer;
  };

  console.log('[TG] MediaSource hooks installed');

  // ============================================================================
  // 2. BLOB URL INTERCEPTION - Secondary method (direct blob URLs)
  // ============================================================================
  // Catch blob: URLs created via URL.createObjectURL (some files load this way)

  console.log('[TG] Installing URL.createObjectURL hook...');
  const origCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = function(obj) {
    if (obj instanceof Blob) {
      console.log(`[TG-BLOB] createObjectURL: size=${obj.size}, type=${obj.type}`);

      if (obj.size > 100000) { // Only capture large blobs (likely videos)
        const blobId = `blob_${Date.now()}`;
        capturedBlobs.set(blobId, {
          blob: obj,
          type: obj.type || 'video/mp4',
          timestamp: Date.now(),
          source: 'URL.createObjectURL',
          chunkCount: 1,
          totalSize: obj.size
        });

        console.log(`[TG-BLOB] ✓ CAPTURED: ${blobId} (${(obj.size / 1024 / 1024).toFixed(2)}MB)`);
      }
    }

    return origCreateObjectURL.call(URL, obj);
  };

  console.log('[TG] URL.createObjectURL hook installed');

  // ============================================================================
  // 3. FETCH INTERCEPTION - Tertiary method (for direct video URLs)
  // ============================================================================
  // Some media might be fetched directly as complete responses

  console.log('[TG] Installing fetch hook...');
  const origFetch = window.fetch;
  window.fetch = async function(...args) {
    fetchCount++;
    const urlArg = args[0];
    const url = typeof urlArg === 'string' ? urlArg : (urlArg?.url || 'unknown');

    try {
      const response = await origFetch.apply(this, args);

      // Only process media responses
      const ct = response.headers.get('content-type') || '';
      if (ct.includes('video') || ct.includes('audio')) {
        console.log(`[TG-FETCH] #${fetchCount} Media response: ${String(url).substring(0, 80)}`);
        console.log(`[TG-FETCH] #${fetchCount} Status: ${response.status}, Content-Type: ${ct}`);

        // Clone and read blob
        const cloned = response.clone();
        try {
          const blob = await cloned.blob();
          if (blob.size > 100000) {
            const blobId = `fetch_${Date.now()}_${fetchCount}`;
            capturedBlobs.set(blobId, {
              blob: blob,
              type: ct,
              timestamp: Date.now(),
              source: 'Fetch',
              chunkCount: 1,
              totalSize: blob.size
            });
            console.log(`[TG-FETCH] ✓ CAPTURED: ${blobId} (${(blob.size / 1024 / 1024).toFixed(2)}MB)`);
          }
        } catch (e) {
          console.log(`[TG-FETCH] #${fetchCount} Blob read error: ${e.message}`);
        }
      }

      return response;
    } catch (e) {
      console.log(`[TG-FETCH] #${fetchCount} Fetch error: ${e.message}`);
      throw e;
    }
  };

  console.log('[TG] Fetch hook installed');

  // ============================================================================
  // 4. XHR INTERCEPTION - Fallback method
  // ============================================================================
  // XMLHttpRequest for older code or special scenarios

  console.log('[TG] Installing XHR hook...');
  const origXhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._tgXhrUrl = url;
    return origXhrOpen.apply(this, [method, url, ...rest]);
  };

  const origXhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function(...args) {
    const xhr = this;
    const url = this._tgXhrUrl;
    xhrCount++;
    const xhrId = xhrCount;

    xhr.addEventListener('load', function() {
      const ct = xhr.getResponseHeader('content-type') || '';
      if ((ct.includes('video') || ct.includes('audio')) && xhr.status === 200) {
        console.log(`[TG-XHR] #${xhrId} Media response: ${String(url).substring(0, 80)}`);

        let blob = null;
        if (xhr.response instanceof Blob) {
          blob = xhr.response;
        } else if (xhr.response instanceof ArrayBuffer) {
          blob = new Blob([xhr.response], { type: ct });
        } else if (xhr.response instanceof Uint8Array) {
          blob = new Blob([xhr.response], { type: ct });
        }

        if (blob && blob.size > 100000) {
          const blobId = `xhr_${Date.now()}_${xhrId}`;
          capturedBlobs.set(blobId, {
            blob: blob,
            type: ct,
            timestamp: Date.now(),
            source: 'XHR',
            chunkCount: 1,
            totalSize: blob.size
          });
          console.log(`[TG-XHR] ✓ CAPTURED: ${blobId} (${(blob.size / 1024 / 1024).toFixed(2)}MB)`);
        }
      }
    }, { once: true });

    return origXhrSend.apply(this, args);
  };

  console.log('[TG] XHR hook installed');

  // ============================================================================
  // 5. MESSAGE HANDLER - Download trigger from content script
  // ============================================================================
  window.addEventListener('message', async (e) => {
    if (!e.data || e.data.type !== 'TG_TRIGGER_DOWNLOAD') return;

    const { filename } = e.data.payload;

    console.log('[TG] *** DOWNLOAD TRIGGERED ***');
    console.log(`[TG] Total captured blobs: ${capturedBlobs.size}`);
    console.log(`[TG] MediaSources tracked: ${mediaSourceBuffers.size}`);
    console.log(`[TG] Stats: FETCH=${fetchCount}, XHR=${xhrCount}, MS=${mediaSourceCount}, Appends=${appendBufferCount}`);

    // Log all captured blobs
    for (const [id, data] of capturedBlobs) {
      console.log(`[TG]   ${id}: ${(data.totalSize / 1024 / 1024).toFixed(2)}MB (${data.source}, ${data.chunkCount} chunks)`);
    }

    // Find largest blob
    let largestEntry = null;
    let largestSize = 0;
    for (const [id, data] of capturedBlobs) {
      if (data.totalSize > largestSize) {
        largestSize = data.totalSize;
        largestEntry = [id, data];
      }
    }

    if (!largestEntry) {
      console.log('[TG] ✗ NO BLOBS CAPTURED - Check console for errors above');
      alert('No media captured. Check console for details.');
      return;
    }

    const [, blobData] = largestEntry;
    const { blob, type } = blobData;

    console.log(`[TG] ✓ Downloading largest blob: ${(blob.size / 1024 / 1024).toFixed(2)}MB (${type})`);

    try {
      const downloadUrl = origCreateObjectURL.call(URL, blob);
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = filename || `tg_${Date.now()}.mp4`;
      document.body.appendChild(a);
      a.click();
      a.remove();

      // Clean up object URL after a delay
      setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);

      console.log('[TG] ✓ DOWNLOAD COMPLETE');
    } catch (e) {
      console.error(`[TG] Download failed: ${e.message}`);
      alert(`Download failed: ${e.message}`);
    }
  });

  // ============================================================================
  // 6. EXPOSE DEBUGGING API
  // ============================================================================
  window.__TG_DEBUG = {
    capturedBlobs: capturedBlobs,
    mediaSourceBuffers: mediaSourceBuffers,
    getStats: () => ({
      capturedBlobCount: capturedBlobs.size,
      mediaSourceCount: mediaSourceCount,
      appendBufferCount: appendBufferCount,
      fetchCount: fetchCount,
      xhrCount: xhrCount,
      largestBlob: Array.from(capturedBlobs.values()).reduce((max, b) =>
        b.totalSize > (max?.totalSize || 0) ? b : max, null)
    }),
    listBlobs: () => {
      const blobs = [];
      for (const [id, data] of capturedBlobs) {
        blobs.push({
          id,
          size: `${(data.totalSize / 1024 / 1024).toFixed(2)}MB`,
          type: data.type,
          source: data.source,
          chunks: data.chunkCount
        });
      }
      return blobs;
    },
    downloadBlob: (id) => {
      const data = capturedBlobs.get(id);
      if (!data) {
        console.log(`[TG] Blob ${id} not found`);
        return;
      }
      const url = origCreateObjectURL.call(URL, data.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `tg_${id}.mp4`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  };

  console.log('[TG] *** INJECT.JS READY ***');
  console.log('[TG] Capture methods: MediaSource (primary), Blob URL, Fetch, XHR');
  console.log('[TG] Debug API: window.__TG_DEBUG.getStats(), listBlobs(), downloadBlob(id)');
})();
