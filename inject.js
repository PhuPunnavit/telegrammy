// TG Downloader - HTTP 206 Chunk Assembly with Bulletproof Byte-Range Handling
// Captures media chunks, parses Content-Range headers, assembles in strict byte order

(() => {
  'use strict';

  console.log('[TG] *** HTTP 206 CHUNK ASSEMBLY INJECT.JS STARTING ***');

  // ============================================================================
  // STORAGE: Track chunks by byte range with strict ordering
  // ============================================================================
  const chunkRegistry = new Map(); // url -> { chunks: Map<startByte, chunkData>, totalSize, contentType, complete }
  const capturedBlobs = new Map(); // id -> {blob, type, timestamp, source}
  let chunkCounter = 0;
  let downloadCounter = 0;

  // ============================================================================
  // UTILITY: Parse Content-Range header
  // Example: "bytes 0-524287/1048576" → {start: 0, end: 524287, total: 1048576}
  // ============================================================================
  function parseContentRange(rangeHeader) {
    if (!rangeHeader) return null;

    const match = rangeHeader.match(/bytes\s+(\d+)-(\d+)\/(\d+)/i);
    if (!match) {
      console.warn('[TG] Invalid Content-Range format:', rangeHeader);
      return null;
    }

    const start = parseInt(match[1], 10);
    const end = parseInt(match[2], 10);
    const total = parseInt(match[3], 10);

    console.log(`[TG-RANGE] Parsed: bytes ${start}-${end}/${total}`);

    return { start, end, total };
  }

  // ============================================================================
  // CORE: Store chunk with strict byte-range tracking
  // ============================================================================
  async function storeChunk(url, data, contentType, rangeHeader) {
    try {
      chunkCounter++;
      const chunkId = chunkCounter;

      console.log(`[TG-CHUNK] #${chunkId} Storing chunk for URL: ${url.substring(0, 60)}`);

      // Parse Content-Range header
      const range = parseContentRange(rangeHeader);
      if (!range) {
        console.warn(`[TG-CHUNK] #${chunkId} No valid Content-Range header, treating as complete`);
        // If no range header, treat as single complete blob
        const blob = data instanceof Blob ? data : new Blob([data], { type: contentType });
        const blobId = `single_${Date.now()}_${chunkId}`;
        capturedBlobs.set(blobId, {
          blob: blob,
          type: contentType,
          timestamp: Date.now(),
          source: 'single_response'
        });
        return;
      }

      // Initialize registry for this URL if needed
      if (!chunkRegistry.has(url)) {
        chunkRegistry.set(url, {
          chunks: new Map(), // startByte -> {data, end}
          totalSize: range.total,
          contentType: contentType,
          complete: false,
          createdAt: Date.now()
        });
        console.log(`[TG-CHUNK] #${chunkId} Created new entry for URL, total size: ${range.total} bytes`);
      }

      const registry = chunkRegistry.get(url);

      // Validate total size consistency
      if (registry.totalSize !== range.total) {
        console.warn(`[TG-CHUNK] #${chunkId} Total size mismatch! Expected ${registry.totalSize}, got ${range.total}`);
      }

      // Store chunk by its start byte
      const chunkSize = range.end - range.start + 1;

      // Verify data size matches range
      const dataSize = data instanceof Blob ? data.size : (data instanceof ArrayBuffer ? data.byteLength : data.length);
      if (dataSize !== chunkSize) {
        console.error(`[TG-CHUNK] #${chunkId} Data size mismatch! Expected ${chunkSize}, got ${dataSize}`);
        return;
      }

      // Convert data to Uint8Array for storage
      let uint8Data;
      if (data instanceof Blob) {
        uint8Data = new Uint8Array(await data.arrayBuffer());
      } else if (data instanceof ArrayBuffer) {
        uint8Data = new Uint8Array(data);
      } else if (data instanceof Uint8Array) {
        uint8Data = data;
      } else {
        uint8Data = new Uint8Array(data);
      }

      // Store chunk
      registry.chunks.set(range.start, {
        data: uint8Data,
        start: range.start,
        end: range.end,
        size: chunkSize
      });

      console.log(`[TG-CHUNK] #${chunkId} Stored: bytes ${range.start}-${range.end} (${chunkSize} bytes)`);
      console.log(`[TG-CHUNK] #${chunkId} Total chunks: ${registry.chunks.size}`);

      // Check if download is complete
      if (isDownloadComplete(url)) {
        console.log(`[TG-CHUNK] ✓✓✓ DOWNLOAD COMPLETE - All byte ranges present!`);
        registry.complete = true;
        await combineAndStoreBlob(url);
      }

    } catch (e) {
      console.error('[TG-CHUNK] Error storing chunk:', e.message);
    }
  }

  // ============================================================================
  // VALIDATION: Check if all byte ranges are present (no gaps)
  // ============================================================================
  function isDownloadComplete(url) {
    const registry = chunkRegistry.get(url);
    if (!registry) return false;

    console.log(`[TG-VALIDATE] Checking completeness for: ${url.substring(0, 50)}`);
    console.log(`[TG-VALIDATE]   Total size: ${registry.totalSize} bytes`);
    console.log(`[TG-VALIDATE]   Chunks stored: ${registry.chunks.size}`);

    // Get sorted chunk starts
    const startBytes = Array.from(registry.chunks.keys()).sort((a, b) => a - b);

    console.log(`[TG-VALIDATE]   Byte ranges: ${startBytes.map(s => {
      const chunk = registry.chunks.get(s);
      return `${s}-${chunk.end}`;
    }).join(', ')}`);

    // Verify byte 0 is present (critical for MP4/WebM headers)
    if (!registry.chunks.has(0)) {
      console.warn('[TG-VALIDATE] ✗ CRITICAL: Byte 0 missing! MP4/WebM headers not present');
      return false;
    }

    // Check for gaps and verify sequential coverage
    let expectedByte = 0;
    for (const startByte of startBytes) {
      if (startByte !== expectedByte) {
        console.warn(`[TG-VALIDATE] ✗ GAP DETECTED: Expected byte ${expectedByte}, but next chunk starts at ${startByte}`);
        return false;
      }

      const chunk = registry.chunks.get(startByte);
      expectedByte = chunk.end + 1;
    }

    // Verify we've covered all bytes
    if (expectedByte !== registry.totalSize) {
      console.warn(`[TG-VALIDATE] ✗ INCOMPLETE: Expected to reach byte ${registry.totalSize}, only reached ${expectedByte}`);
      return false;
    }

    console.log('[TG-VALIDATE] ✓ COMPLETE: All byte ranges present, no gaps');
    return true;
  }

  // ============================================================================
  // ASSEMBLY: Combine chunks in strict byte order into final Blob
  // ============================================================================
  async function combineAndStoreBlob(url) {
    try {
      downloadCounter++;
      const downloadId = downloadCounter;

      const registry = chunkRegistry.get(url);
      if (!registry) {
        console.error('[TG-COMBINE] Registry not found for URL');
        return;
      }

      console.log(`[TG-COMBINE] #${downloadId} Starting blob combination`);
      console.log(`[TG-COMBINE] #${downloadId} Total chunks: ${registry.chunks.size}`);
      console.log(`[TG-COMBINE] #${downloadId} Expected total size: ${registry.totalSize} bytes`);

      // Get chunks sorted by start byte
      const chunks = Array.from(registry.chunks.values())
        .sort((a, b) => a.start - b.start);

      // Verify sequential order
      console.log('[TG-COMBINE] #' + downloadId + ' Chunk order:');
      chunks.forEach((chunk, idx) => {
        console.log(`[TG-COMBINE] #${downloadId}   [${idx}] bytes ${chunk.start}-${chunk.end} (${chunk.size} bytes)`);
      });

      // Combine chunks into single Uint8Array
      const combinedArray = new Uint8Array(registry.totalSize);
      let offset = 0;

      for (const chunk of chunks) {
        // Verify no overlap or gap
        if (chunk.start !== offset) {
          console.error(`[TG-COMBINE] #${downloadId} Chunk position mismatch: expected offset ${offset}, got chunk.start ${chunk.start}`);
          throw new Error('Chunk ordering violation');
        }

        // Copy chunk data to correct position
        combinedArray.set(chunk.data, offset);
        offset += chunk.size;

        console.log(`[TG-COMBINE] #${downloadId} Copied bytes ${chunk.start}-${chunk.end} to array offset ${offset - chunk.size}`);
      }

      // Verify final size
      if (offset !== registry.totalSize) {
        console.error(`[TG-COMBINE] #${downloadId} Size mismatch after combining: expected ${registry.totalSize}, got ${offset}`);
        throw new Error('Combined size mismatch');
      }

      // Create final Blob
      const finalBlob = new Blob([combinedArray], { type: registry.contentType });

      const blobId = `combined_${downloadId}_${Date.now()}`;
      capturedBlobs.set(blobId, {
        blob: finalBlob,
        type: registry.contentType,
        timestamp: Date.now(),
        source: 'combined_chunks',
        chunkCount: chunks.length,
        byteCount: registry.totalSize
      });

      console.log(`[TG-COMBINE] ✓✓✓ BLOB CREATED: ${blobId}`);
      console.log(`[TG-COMBINE] #${downloadId}   Size: ${(finalBlob.size / 1024 / 1024).toFixed(2)}MB`);
      console.log(`[TG-COMBINE] #${downloadId}   Type: ${registry.contentType}`);
      console.log(`[TG-COMBINE] #${downloadId}   Chunks assembled: ${chunks.length}`);

      notifyMediaDetected(blobId, registry.contentType, finalBlob.size);

    } catch (e) {
      console.error('[TG-COMBINE] Error combining blob:', e.message);
    }
  }

  // ============================================================================
  // HOOK: Intercept fetch responses and extract chunks
  // ============================================================================
  const origFetch = window.fetch;
  window.fetch = async function(...args) {
    const response = await origFetch.apply(this, args);

    try {
      const url = args[0] instanceof Request ? args[0].url : String(args[0] || '');
      const contentType = response.headers.get('content-type') || '';
      const contentRange = response.headers.get('content-range');
      const status = response.status;

      const isMedia = contentType.includes('video') || contentType.includes('audio');

      if (isMedia && (status === 200 || status === 206)) {
        const cloned = response.clone();
        const blob = await cloned.blob();

        console.log(`[TG-FETCH] ${status} ${contentType} | Size: ${blob.size} | Range: ${contentRange || 'none'}`);

        // Store chunk with range header
        await storeChunk(url, blob, contentType, contentRange);

        notifyMediaDetected(url, contentType, blob.size);
      }

      return response;
    } catch (e) {
      console.error('[TG-FETCH] Error in fetch hook:', e.message);
      return response;
    }
  };

  // ============================================================================
  // HOOK: Intercept XHR responses
  // ============================================================================
  const origXhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._tgUrl = url;
    return origXhrOpen.apply(this, [method, url, ...rest]);
  };

  const origXhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function(...args) {
    const xhr = this;

    xhr.addEventListener('readystatechange', function() {
      if (xhr.readyState === 4 && (xhr.status === 200 || xhr.status === 206)) {
        const contentType = xhr.getResponseHeader('content-type') || '';
        const contentRange = xhr.getResponseHeader('content-range');
        const isMedia = contentType.includes('video') || contentType.includes('audio');

        if (isMedia && xhr.response) {
          try {
            let blob = null;
            if (xhr.response instanceof Blob) {
              blob = xhr.response;
            } else if (xhr.response instanceof ArrayBuffer) {
              blob = new Blob([xhr.response], { type: contentType });
            }

            if (blob) {
              const finalUrl = xhr.responseURL || xhr._tgUrl;
              console.log(`[TG-XHR] ${xhr.status} ${contentType} | Size: ${blob.size} | Range: ${contentRange || 'none'}`);

              storeChunk(finalUrl, blob, contentType, contentRange);
              notifyMediaDetected(finalUrl, contentType, blob.size);
            }
          } catch (e) {
            console.error('[TG-XHR] Error in XHR hook:', e.message);
          }
        }
      }
    });

    return origXhrSend.apply(this, args);
  };

  // ============================================================================
  // DOWNLOAD HANDLER
  // ============================================================================
  window.addEventListener('message', async (e) => {
    if (!e.data || e.data.type !== 'TG_TRIGGER_DOWNLOAD') return;

    const { filename } = e.data.payload;

    console.log('[TG] *** DOWNLOAD TRIGGERED ***');
    console.log('[TG] Captured blobs:', capturedBlobs.size);

    Array.from(capturedBlobs.entries()).forEach(([id, entry]) => {
      console.log(`[TG]   ${id}: ${(entry.blob.size / 1024 / 1024).toFixed(2)}MB (${entry.source})`);
    });

    let blob = null;

    // Get largest blob
    if (capturedBlobs.size > 0) {
      let largest = null;
      let largestSize = 0;

      for (const [_, entry] of capturedBlobs) {
        if (entry.blob.size > largestSize) {
          largestSize = entry.blob.size;
          largest = entry;
        }
      }

      blob = largest?.blob;
    }

    if (!blob) {
      console.log('[TG] ✗ NO MEDIA CAPTURED');
      alert('No media captured. Please play a video first.');
      return;
    }

    console.log('[TG] ✓ Downloading:', (blob.size / 1024 / 1024).toFixed(2), 'MB');

    // Determine extension
    let ext = '.webm';
    if (blob.type.includes('mp4')) ext = '.mp4';
    else if (blob.type.includes('webm')) ext = '.webm';

    let safeName = (filename || `tg_${Date.now()}`).replace(/[<>:"/\\|?*]/g, '_');
    if (!safeName.includes('.')) safeName += ext;

    // Create download
    const downloadUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = safeName;
    document.body.appendChild(a);
    a.click();
    a.remove();

    console.log('[TG] ✓ Download complete');
  });

  // ============================================================================
  // DEBUG API
  // ============================================================================
  window.__TG_DEBUG = {
    getChunks: (url) => {
      const reg = chunkRegistry.get(url);
      if (!reg) return null;
      return {
        chunks: Array.from(reg.chunks.entries()).map(([start, chunk]) => ({
          start,
          end: chunk.end,
          size: chunk.size
        })),
        totalSize: reg.totalSize,
        complete: reg.complete
      };
    },

    listBlobs: () => {
      const list = [];
      for (const [id, entry] of capturedBlobs) {
        list.push({
          id,
          size: (entry.blob.size / 1024 / 1024).toFixed(2) + ' MB',
          source: entry.source
        });
      }
      return list;
    }
  };

  function notifyMediaDetected(url, type, size) {
    window.postMessage({
      type: 'TG_MEDIA_DETECTED',
      payload: { url, type, size, timestamp: Date.now() }
    }, '*');
  }

  // Unblock context menu
  ['contextmenu', 'copy', 'selectstart', 'dragstart'].forEach(evt => {
    window.addEventListener(evt, e => e.stopImmediatePropagation(), true);
  });

  console.log('[TG] ✓ inject.js ready - HTTP 206 chunk assembly active');
  console.log('[TG] Debug API: window.__TG_DEBUG');
})();
