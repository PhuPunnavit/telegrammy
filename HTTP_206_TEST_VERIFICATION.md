# HTTP 206 Chunk Combination Implementation - Test Verification

## Implementation Overview
The code in `inject.js` implements HTTP 206 Partial Content support with the following components:
- **chunkStorage**: Map tracking chunks by URL with byte ranges
- **parseContentRange()**: Parses `Content-Range` header (e.g., "bytes 0-1023/10240")
- **isFileComplete()**: Checks if all chunks form a contiguous byte range 0 to total-1
- **combineChunks()**: Merges sorted chunks into single Blob, handling overlaps/gaps
- **storeChunk()**: Entry point for storing either 206 chunks or 200 full responses
- **fetch/XHR hooks**: Capture both fetch and XMLHttpRequest media responses

---

## Test Scenario 1: Out-of-Order Chunks

### Test Input
Chunks arrive for a 1000-byte file in this order:
1. Chunk 1: bytes 500-799 (300 bytes) - arrives first
2. Chunk 2: bytes 0-249 (250 bytes) - arrives second
3. Chunk 3: bytes 800-999 (200 bytes) - arrives third
4. Chunk 4: bytes 250-499 (250 bytes) - arrives fourth

### Expected Output
Final combined Blob of exactly 1000 bytes with all bytes in correct positions (0-999)

### How Code Handles It ✓ CORRECT
```javascript
// combineChunks() at line 82-84:
const sortedChunks = Array.from(storage.chunks.values())
  .sort((a, b) => a.start - b.start);
```
**Key mechanism**: Chunks are re-sorted by `start` byte before combining, regardless of arrival order.

**Process**:
1. Each chunk stored with key = `range.start` (line 160)
2. When combining, sorts chunks by `a.start - b.start` (line 84)
3. Loops through sorted array and appends data in order (line 96-113)

**Result**: Out-of-order arrival is completely masked by sorting. Final blob will be correct.

---

## Test Scenario 2: Duplicate Chunks

### Test Input
Same byte range arrives twice:
1. Chunk 1: bytes 0-99 (100 bytes) - first arrival
2. Chunk 2: bytes 100-199 (100 bytes)
3. Chunk 1 again: bytes 0-99 (100 bytes) - duplicate

### Expected Output
Duplicate ignored, first occurrence used. Final blob has correct 200 bytes.

### How Code Handles It ✓ CORRECT
```javascript
// storeChunk() at line 160-171:
const chunkKey = range.start;

// Store chunk, overwrite if duplicate (same byte range)
storage.chunks.set(chunkKey, {
  start: range.start,
  endByte: range.end,
  data: blob,
  receivedAt: Date.now()
});
```
**Key mechanism**: Uses `range.start` as Map key. Same byte range = same key = overwrites.

**Behavior**:
- First arrival: creates entry at key `0`
- Duplicate arrival: calls `set(0, {...})` again, overwrites first entry
- However, the second entry has identical boundaries, so `combineChunks()` sees no difference

**Result**: USES FIRST, OVERWRITES WITH SECOND (actually stores second, but final result is identical since byte ranges match). If you need the first specifically, this could be modified to check existence before storing.

**Note**: The code comment says "use first, discard duplicate" but actually overwrites. Both behaviors produce identical results if chunk data is identical, but should document that it keeps the _latest_ arrival.

---

## Test Scenario 3: Overlapping Chunks

### Test Input
Overlapping byte ranges:
1. Chunk 1: bytes 0-99 (100 bytes)
2. Chunk 2: bytes 50-149 (100 bytes) - overlaps with Chunk 1 at bytes 50-99
3. Total file: 150 bytes

### Expected Output
Final blob: 150 bytes, bytes 0-149. The overlapping region (50-99) should appear exactly once.

### How Code Handles It ⚠ PARTIALLY CORRECT (but with logic error)

```javascript
// combineChunks() at line 96-113:
for (const chunk of sortedChunks) {
  // Detect and warn about gaps
  if (chunk.start > lastEnd + 1) {
    console.warn(`[TG] Gap detected: bytes ${lastEnd + 1} to ${chunk.start - 1} missing!`);
  }

  // Detect and skip overlaps
  if (chunk.start <= lastEnd) {
    const overlapStart = lastEnd + 1;
    const overlapBytes = chunk.data.slice(overlapStart - chunk.start);
    console.log(`[TG] Overlap detected at byte ${chunk.start}: using bytes ${overlapStart}-${chunk.endByte}`);
    blobParts.push(new Blob([overlapBytes], { type: 'application/octet-stream' }));
  } else {
    blobParts.push(new Blob([chunk.data], { type: 'application/octet-stream' }));
  }

  lastEnd = chunk.endByte;
}
```

**Analysis**:
- **Scenario**: lastEnd=99 (just finished bytes 0-99), new chunk is bytes 50-149
- **Condition check**: `chunk.start (50) <= lastEnd (99)` → TRUE (overlap detected)
- **Slice calculation**: 
  - `overlapStart = lastEnd + 1 = 100`
  - `overlapBytes = chunk.data.slice(100 - 50) = chunk.data.slice(50)`
  - This takes bytes [50:] from chunk.data, which are bytes 100-149 of the file
- **Appended**: Only bytes 100-149, skipping 50-99 (the overlap)
- **lastEnd updated**: to 149

**Result**: ✓ CORRECT. Produces 150-byte blob with no duplication.

---

## Test Scenario 4: Missing Chunks (Gap Detection)

### Test Input
File is 500 bytes, but only these chunks received:
1. Chunk 1: bytes 0-99 (100 bytes)
2. Chunk 2: bytes 200-299 (100 bytes) - GAP at bytes 100-199
3. Chunk 3: bytes 400-499 (100 bytes) - GAP at bytes 300-399

### Expected Output
Detection: "Gap detected at byte 100" and "Gap detected at byte 300"
File marked as incomplete, not combined

### How Code Handles It ✓ CORRECT (detection only)

**Gap detection in combineChunks() at line 98-100**:
```javascript
if (chunk.start > lastEnd + 1) {
  console.warn(`[TG] Gap detected: bytes ${lastEnd + 1} to ${chunk.start - 1} missing!`);
}
```
- After chunk 0-99: `lastEnd = 99`
- Next chunk starts at 200: `200 > (99 + 1)` → TRUE
- Logs warning

**Completion check in isFileComplete() at line 54-61**:
```javascript
let expectedStart = 0;
for (const range of ranges) {
  if (range.start !== expectedStart) {
    console.log(`[TG]   ✗ Gap detected at byte ${expectedStart}`);
    return false;
  }
  expectedStart = range.end + 1;
}

const isComplete = expectedStart === storage.contentLength;
```
- Checks: 0→100→200 (expected 100, got 200, returns false)
- File never marked as complete
- combineChunks() never called (line 176 condition fails)

**Result**: ✓ CORRECT. Gap prevents completion. Partial file not combined/stored.

---

## Test Scenario 5: Single 200 Response (Not Chunked)

### Test Input
Single HTTP 200 OK response:
- Content-Type: video/mp4
- Content-Range: (none - single response)
- Response body: 5MB blob

### Expected Output
Blob stored as complete media, ready for download. No chunking logic triggered.

### How Code Handles It ✓ CORRECT

**In storeChunk() at line 155-196**:
```javascript
const range = parseContentRange(rangeHeader);

if (range) {
  // 206 Partial Content response
  // ... chunking logic ...
} else {
  // 200 OK or other full response (not chunked)
  console.log(`[TG] Full response (not chunked): ${blob.size} bytes`);
  storage.contentLength = blob.size;
  storage.chunks.set(0, {
    start: 0,
    endByte: blob.size - 1,
    data: blob,
    receivedAt: Date.now()
  });
  storeBlob(url, blob, contentType, true);
}
```

**Process**:
1. `rangeHeader` is null/undefined for 200 OK
2. `parseContentRange(null)` returns null (line 24)
3. Enters else branch
4. Creates single entry covering entire blob (0 to size-1)
5. Immediately calls `storeBlob()` with `complete=true`

**Result**: ✓ CORRECT. Works exactly as before, 200 responses unaffected.

---

## Test Scenario 6: Multiple Files - Simultaneous Streaming

### Test Input
Two different URLs streaming simultaneously:
- URL A: `https://example.com/video1.mp4` (chunks 1, 2, 3)
- URL B: `https://example.com/video2.webm` (chunks 1, 2, 3)
- Interleaved: A1, B1, A2, B2, A3, B3

### Expected Output
- video1.mp4: complete 3-chunk blob
- video2.webm: complete 3-chunk blob
- No cross-contamination (video1 data in video2, etc.)

### How Code Handles It ✓ CORRECT

**Key isolation mechanism**:
- `chunkStorage = new Map()` - separate storage per URL (line 10)
- `storeChunk(url, blob, ...)` uses `url` as key (line 140)
- Each URL gets its own storage object: `{ chunks: Map(), contentLength, ... }`

```javascript
// storeChunk() at line 140-148:
if (!chunkStorage.has(url)) {
  chunkStorage.set(url, {
    chunks: new Map(),
    contentLength: null,
    contentType: contentType,
    lastUpdate: Date.now()
  });
}

const storage = chunkStorage.get(url);  // Fetches URL-specific storage
```

**Process**:
1. A1 arrives → creates storage for URL A, stores chunk 1
2. B1 arrives → creates storage for URL B, stores chunk 1
3. A2 arrives → fetches storage for URL A, stores chunk 2
4. B2 arrives → fetches storage for URL B, stores chunk 2
5. Each URL's `chunks` Map is independent

**Completion check**:
- `isFileComplete(url)` fetches `chunkStorage.get(url)` (line 38)
- Only checks ranges within that specific URL's storage
- No possibility of mixing

**Result**: ✓ CORRECT. Each URL has completely isolated storage. No cross-contamination.

---

## Test Scenario 7: Large Files >100MB Split Into Many Chunks

### Test Input
500MB file split into 1000 chunks of 512KB each:
- Chunks streamed continuously
- Total memory footprint should grow linearly, not exponentially

### Expected Output
- All chunks stored efficiently in individual Blob objects
- Final combined blob correct
- Memory cleanup after combination (old chunks released)

### How Code Handles It ✓ MOSTLY CORRECT (with caveats)

**Memory efficiency**:
```javascript
// chunkStorage structure (line 8-9):
// storage.chunks = Map<startByte, {data: Blob, ...}>
```
- Each chunk stored as separate Blob (not concatenated in memory)
- Map keys are start bytes (efficient lookup by range)
- No unnecessary copying during storage

**Combination process (line 72-128)**:
```javascript
const blobParts = [];
for (const chunk of sortedChunks) {
  // Handle gaps/overlaps...
  blobParts.push(new Blob([chunk.data], { type: 'application/octet-stream' }));
}
const combinedBlob = new Blob(blobParts, { type: storage.contentType || 'video/mp4' });
```

**Process**:
1. Creates `blobParts` array of Blobs (references, not copies)
2. Blob constructor with array creates final Blob with "lazy" concatenation
3. Combined blob is stored in `storedBlobs`

**Cleanup (line 214-228)**:
```javascript
if (storedBlobs.size > MAX_STORED_BLOBS) {  // MAX = 50
  let oldestUrl = null;
  let oldestTime = Infinity;
  for (const [u, data] of storedBlobs) {
    if (data.timestamp < oldestTime) {
      oldestTime = data.timestamp;
      oldestUrl = u;
    }
  }
  if (oldestUrl) {
    storedBlobs.delete(oldestUrl);
    chunkStorage.delete(oldestUrl);  // Releases all chunks for this URL
  }
}
```

**Result**: ✓ MOSTLY CORRECT with notes:

**Strengths**:
- Individual Blobs prevent memory explosion during streaming
- Chunk Map allows efficient random access
- Cleanup releases entire URL's chunk storage when needed

**Potential concerns**:
- During combination, `blobParts` array holds all chunk references simultaneously (could be memory-intensive for 500MB)
- However, Blob constructor should handle this efficiently
- After combination, original chunks still in `chunkStorage` (not cleared automatically)
- Should consider clearing chunk storage after successful combination

**Recommendation**: Add cleanup of `chunkStorage[url]` after successful combination to free memory:
```javascript
// After storeBlob() at line 181:
chunkStorage.delete(url);  // Clear individual chunks after combining
```

---

## Test Scenario 8: Edge Cases

### 8a. Empty Response
**Input**: 0-byte chunk
**Code**: 
```javascript
if (!url || !blob) return;  // line 134
```
**Result**: ✓ Skipped safely

### 8b. Content-Range Parsing Edge Cases
**Input**: Malformed Content-Range header
```javascript
const match = rangeHeader.match(/bytes\s+(\d+)-(\d+)\/(\d+)/i);
if (!match) return null;  // line 25-26
```
**Result**: ✓ Returns null, treats as 200 OK response

### 8c. Size Mismatch After Combination
**Code at line 119-121**:
```javascript
if (combinedBlob.size !== storage.contentLength) {
  console.warn(`[TG] ⚠ Size mismatch: combined ${combinedBlob.size} vs expected ${storage.contentLength}`);
}
```
**Result**: ⚠ Warns but still stores blob. Could fail gracefully instead.

---

## Summary of Correctness

| Scenario | Status | Notes |
|----------|--------|-------|
| 1. Out-of-order chunks | ✓ CORRECT | Sorted before combining |
| 2. Duplicate chunks | ✓ CORRECT* | Overwrites earlier, but result identical |
| 3. Overlapping chunks | ✓ CORRECT | Slices non-overlapping portion |
| 4. Missing chunks (gaps) | ✓ CORRECT | Detected, file not combined |
| 5. Single 200 response | ✓ CORRECT | Backward compatible |
| 6. Multiple simultaneous URLs | ✓ CORRECT | Complete isolation per URL |
| 7. Large files >100MB | ✓ MOSTLY CORRECT | Memory efficient, consider clearing chunks post-combination |
| 8. Edge cases | ✓ MOSTLY CORRECT | Handles safely, minor logging on mismatches |

---

## Code Quality Issues Found

### Issue 1: Duplicate Behavior Mismatch (Line 165 comment)
**Current**: Comment says "use first, discard duplicate" but code overwrites with latest
**Impact**: Minimal (results identical if data matches)
**Fix**: Update comment to "overwrites with latest arrival"

### Issue 2: No Post-Combination Cleanup (Line 181)
**Current**: After combining chunks into single blob, original chunks stay in `chunkStorage`
**Impact**: Memory not fully released on large files
**Fix**: Add `chunkStorage.delete(url)` after successful combination

### Issue 3: Size Mismatch Not Fatal (Line 119-121)
**Current**: Warns but stores incomplete blob anyway
**Impact**: Could corrupt download if gap wasn't detected
**Fix**: Consider `throw Error` instead of warn, or require manual retry

### Issue 4: No Timeout on Incomplete Files (Line 10-12)
**Current**: Chunks stored indefinitely; incomplete files never cleaned
**Impact**: Old incomplete downloads accumulate in memory
**Fix**: Implement age-based cleanup: if no new chunks in 60s, mark failed

---

## Testing Recommendations

### Test Code Template (JavaScript)

```javascript
// Test 1: Out-of-order chunks
async function testOutOfOrder() {
  const url = 'https://example.com/test.mp4';
  const chunks = [
    { range: 'bytes 500-799/1000', data: new Uint8Array(300) },
    { range: 'bytes 0-249/1000', data: new Uint8Array(250) },
    { range: 'bytes 800-999/1000', data: new Uint8Array(200) },
    { range: 'bytes 250-499/1000', data: new Uint8Array(250) },
  ];
  
  // Simulate chunk arrivals
  for (const chunk of chunks) {
    await window.__TG_DOWNLOADER__.storeChunk(
      url,
      new Blob([chunk.data]),
      'video/mp4',
      chunk.range
    );
  }
  
  // Verify final blob is 1000 bytes
  const stored = window.__TG_DOWNLOADER__.storedBlobs.get(url);
  console.assert(stored.blob.size === 1000, 'Out-of-order test failed');
}

// Test 2: Duplicate chunks
async function testDuplicates() {
  const url = 'https://example.com/test2.mp4';
  const chunk = new Uint8Array(100);
  
  // Send chunk twice
  await window.__TG_DOWNLOADER__.storeChunk(
    url, new Blob([chunk]), 'video/mp4', 'bytes 0-99/200'
  );
  await window.__TG_DOWNLOADER__.storeChunk(
    url, new Blob([chunk]), 'video/mp4', 'bytes 0-99/200'
  );
  
  // Verify only one stored
  const chunks = window.__TG_DOWNLOADER__.chunkStorage.get(url).chunks;
  console.assert(chunks.size === 1, 'Duplicate test failed');
}

// Test 3: Gap detection
async function testGapDetection() {
  const url = 'https://example.com/test3.mp4';
  
  // Send with gap
  await window.__TG_DOWNLOADER__.storeChunk(
    url, new Blob([new Uint8Array(100)]), 'video/mp4', 'bytes 0-99/300'
  );
  await window.__TG_DOWNLOADER__.storeChunk(
    url, new Blob([new Uint8Array(100)]), 'video/mp4', 'bytes 200-299/300'
  );
  
  // Should NOT be marked complete
  const storage = window.__TG_DOWNLOADER__.chunkStorage.get(url);
  console.assert(!storage.complete, 'Gap detection failed');
}

// Test 4: Multiple URLs
async function testMultipleURLs() {
  const url1 = 'https://example.com/video1.mp4';
  const url2 = 'https://example.com/video2.mp4';
  
  await window.__TG_DOWNLOADER__.storeChunk(
    url1, new Blob([new Uint8Array(100)]), 'video/mp4', 'bytes 0-99/100'
  );
  await window.__TG_DOWNLOADER__.storeChunk(
    url2, new Blob([new Uint8Array(200)]), 'video/mp4', 'bytes 0-199/200'
  );
  
  const s1 = window.__TG_DOWNLOADER__.chunkStorage.get(url1);
  const s2 = window.__TG_DOWNLOADER__.chunkStorage.get(url2);
  
  console.assert(s1.contentLength === 100, 'URL1 size wrong');
  console.assert(s2.contentLength === 200, 'URL2 size wrong');
}
```

### Manual Testing Steps

1. **Out-of-order**: Open DevTools network throttling, play a video with adaptive streaming, check console logs show chunks arriving non-sequentially
2. **Duplicates**: Monitor `__TG_DOWNLOADER__.chunkStorage` for Map size staying at expected count despite duplicate headers
3. **Gaps**: Pause video mid-stream, check that file doesn't auto-download until all chunks received
4. **Large file**: Download 500MB+ file, monitor memory in DevTools Task Manager
5. **Multiple files**: Open multiple video tabs in same page, verify separate downloads don't interfere

