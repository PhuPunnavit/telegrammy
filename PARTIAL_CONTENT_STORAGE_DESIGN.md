# HTTP 206 Partial Content Blob Storage Architecture

## Overview
This architecture handles storing, tracking, and combining HTTP 206 Partial Content responses for resumable downloads with out-of-order chunk delivery.

---

## 1. Data Structures

### 1.1 Chunk Definition
```
Chunk {
  url: string                    // Unique identifier for download
  startByte: number             // Inclusive start position in file
  endByte: number               // Inclusive end position in file
  data: Uint8Array              // Raw chunk data
  contentType: string           // MIME type
  timestamp: number             // When chunk was received (ms)
  etag: string                  // Optional: for validation
  isVerified: boolean           // Optional: checksum validation
}
```

### 1.2 Download Session Metadata
```
DownloadSession {
  url: string                   // Download identifier
  contentLength: number         // Total file size from Content-Length header
  contentType: string          // MIME type from first response
  lastModified: number         // From Last-Modified header (ms)
  etag: string                 // From ETag header for integrity
  chunks: Map<ByteRange, Chunk>  // See 1.3
  receivedBytes: Set<ByteRange>  // Efficient range tracking
  createdAt: number            // Session creation time
  updatedAt: number            // Last chunk received time
  status: 'pending' | 'complete' | 'failed'
}
```

### 1.3 ByteRange as Map Key
```
// Store chunks by a normalized byte range key for O(1) lookup
ByteRangeKey = "${startByte}-${endByte}"
// Example: "0-1023" for first 1KB chunk

// Alternative: Use interval tree for range queries (if gaps need detection)
ChunkMap = Map<ByteRangeKey, Chunk>
```

### 1.4 Main Storage Container
```
BlobStorage {
  sessions: Map<URL, DownloadSession>    // One session per URL
  maxMemory: number                      // Max bytes to hold in memory
  currentMemory: number                  // Track current usage
}
```

---

## 2. Core Algorithms

### 2.1 Algorithm: Add Chunk to Storage
```
FUNCTION addChunk(url, startByte, endByte, data, contentType, headers)
  // Validate input
  IF startByte > endByte THEN
    THROW InvalidChunkRange("startByte must be <= endByte")
  IF data.length != (endByte - startByte + 1) THEN
    THROW DataSizeMismatch("data length doesn't match byte range")
  
  // Get or create session
  session = sessions.get(url)
  IF session == null THEN
    contentLength = headers.get('content-length')
    IF contentLength == null THEN
      THROW MissingContentLength("206 response must include Content-Length")
    
    session = DownloadSession {
      url: url,
      contentLength: parseInt(contentLength),
      contentType: contentType,
      chunks: new Map(),
      receivedBytes: new Set(),
      status: 'pending'
    }
    sessions.set(url, session)
  
  // Check for duplicate chunk
  rangeKey = formatRangeKey(startByte, endByte)
  IF session.chunks.has(rangeKey) THEN
    existingChunk = session.chunks.get(rangeKey)
    IF isIdenticalData(existingChunk.data, data) THEN
      // Duplicate: update timestamp only
      existingChunk.timestamp = now()
      RETURN { status: 'duplicate', bytesAdded: 0 }
    ELSE
      // Conflict: data mismatch for same range
      THROW ChunkConflict("Different data for same byte range")
  
  // Check for memory constraints before storing
  bytesToAdd = data.length
  IF currentMemory + bytesToAdd > maxMemory THEN
    // Evict least-recently-used incomplete sessions if possible
    evictLRUIfNeeded(bytesToAdd)
    IF currentMemory + bytesToAdd > maxMemory THEN
      THROW OutOfMemory("Cannot store chunk - memory limit exceeded")
  
  // Store chunk
  chunk = Chunk {
    url: url,
    startByte: startByte,
    endByte: endByte,
    data: data,
    contentType: contentType,
    timestamp: now(),
    isVerified: false
  }
  session.chunks.set(rangeKey, chunk)
  session.receivedBytes.add({start: startByte, end: endByte})
  session.updatedAt = now()
  currentMemory += bytesToAdd
  
  // Check if download is complete
  isComplete = isDownloadComplete(session)
  IF isComplete THEN
    session.status = 'complete'
    onDownloadComplete(url, session)
  
  RETURN {
    status: 'stored',
    bytesAdded: bytesToAdd,
    isComplete: isComplete,
    percentComplete: calculateProgress(session)
  }
END FUNCTION
```

### 2.2 Algorithm: Detect Complete Download
```
FUNCTION isDownloadComplete(session)
  // Check if total received bytes match Content-Length
  totalReceived = 0
  
  FOR EACH chunk IN session.chunks.values() DO
    totalReceived += chunk.endByte - chunk.startByte + 1
  
  IF totalReceived != session.contentLength THEN
    RETURN false
  
  // Verify no gaps: reconstruct sorted ranges
  sortedChunks = sortChunksByStartByte(session.chunks.values())
  expectedPosition = 0
  
  FOR EACH chunk IN sortedChunks DO
    IF chunk.startByte != expectedPosition THEN
      // Gap detected
      RETURN false
    expectedPosition = chunk.endByte + 1
  
  // Verify coverage to end of file
  IF expectedPosition != session.contentLength THEN
    RETURN false
  
  RETURN true
END FUNCTION
```

### 2.3 Algorithm: Combine Chunks into Final Data
```
FUNCTION combineChunks(session)
  // Validate complete state
  IF session.status != 'complete' THEN
    THROW IncompleteDownload("Cannot combine - download not complete")
  
  IF not isDownloadComplete(session) THEN
    THROW InconsistentState("Marked complete but chunks are missing")
  
  // Sort chunks by byte position
  sortedChunks = sortChunksByStartByte(session.chunks.values())
  
  // Pre-allocate output buffer
  combinedData = new Uint8Array(session.contentLength)
  writeOffset = 0
  
  // Copy chunks in order (validates contiguous coverage)
  FOR EACH chunk IN sortedChunks DO
    IF chunk.startByte != writeOffset THEN
      THROW UnexpectedGap(
        "Gap or overlap at byte " + writeOffset +
        ", found chunk starting at " + chunk.startByte
      )
    
    // Copy chunk data to correct position
    combinedData.set(chunk.data, writeOffset)
    writeOffset = chunk.endByte + 1
  
  RETURN {
    data: combinedData,
    contentType: session.contentType,
    size: session.contentLength,
    receivedAt: session.updatedAt
  }
END FUNCTION
```

### 2.4 Algorithm: Handle Out-of-Order Chunks
```
// The addChunk algorithm (2.1) already handles this:
// - Chunks stored by byte range key, not insertion order
// - Completion detection sorts chunks before verification
// - Combining algorithm sorts chunks by startByte
//
// No special handling needed - out-of-order is handled transparently

EXAMPLE:
  Receive chunk 1024-2047
  Receive chunk 0-1023      <- Out of order, but still stored correctly
  Receive chunk 2048-3071
  Result: All stored in correct positions, combined in order
```

### 2.5 Algorithm: Detect Missing Chunks / Gaps
```
FUNCTION findMissingRanges(session)
  IF session.contentLength == null THEN
    RETURN [{ message: "Content-Length unknown, cannot determine gaps" }]
  
  sortedChunks = sortChunksByStartByte(session.chunks.values())
  missingRanges = []
  expectedPosition = 0
  
  FOR EACH chunk IN sortedChunks DO
    IF chunk.startByte > expectedPosition THEN
      // Gap found
      missingRanges.push({
        startByte: expectedPosition,
        endByte: chunk.startByte - 1,
        size: chunk.startByte - expectedPosition
      })
    
    expectedPosition = chunk.endByte + 1
  
  // Check if there's a gap at the end
  IF expectedPosition < session.contentLength THEN
    missingRanges.push({
      startByte: expectedPosition,
      endByte: session.contentLength - 1,
      size: session.contentLength - expectedPosition
    })
  
  RETURN missingRanges
END FUNCTION
```

### 2.6 Algorithm: Memory-Efficient Range Tracking
```
FUNCTION trackReceivedBytes(session, startByte, endByte)
  // Use a sorted set of merged ranges to avoid duplicates in memory
  // Instead of storing every byte, store contiguous range objects
  
  newRange = { start: startByte, end: endByte }
  mergedRanges = []
  
  FOR EACH range IN session.receivedBytes (sorted) DO
    IF range.end < startByte - 1 THEN
      // No overlap, add to result
      mergedRanges.push(range)
    ELSE IF range.start > endByte + 1 THEN
      // No overlap, but comes after new range
      BREAK
    ELSE
      // Overlap or adjacent: merge
      newRange.start = min(newRange.start, range.start)
      newRange.end = max(newRange.end, range.end)
  
  // Add merged range
  mergedRanges.push(newRange)
  
  // Add remaining ranges
  FOR EACH range IN session.receivedBytes (from where we broke) DO
    mergedRanges.push(range)
  
  session.receivedBytes = mergedRanges
  
  RETURN mergedRanges
END FUNCTION
```

### 2.7 Algorithm: Calculate Download Progress
```
FUNCTION calculateProgress(session)
  IF session.contentLength == null OR session.contentLength == 0 THEN
    RETURN { percent: 0, bytesReceived: 0, totalBytes: null }
  
  bytesReceived = 0
  FOR EACH chunk IN session.chunks.values() DO
    bytesReceived += chunk.endByte - chunk.startByte + 1
  
  RETURN {
    percent: (bytesReceived / session.contentLength) * 100,
    bytesReceived: bytesReceived,
    totalBytes: session.contentLength,
    remainingBytes: session.contentLength - bytesReceived
  }
END FUNCTION
```

---

## 3. Error Handling

### 3.1 Error Scenarios and Handling

```
ERROR: MissingContentLength
  Cause: Server didn't return Content-Length header in 206 response
  Solution: 
    - For HTTP/1.1: Required to complete download, reject download
    - For HTTP/2: Use stream end as indicator, store session with unknown length
  Code: 400-like status

ERROR: ChunkConflict (Data Mismatch)
  Cause: Same byte range received with different data
  Solution: 
    - Log conflict with etag/timestamp
    - Keep first received, reject second
    - Mark session as needs-verification
    - Could indicate corruption or resume from different source
  Code: 409-like status

ERROR: DataSizeMismatch
  Cause: Chunk data length != (endByte - startByte + 1)
  Solution:
    - Reject chunk immediately
    - Request retransmission from server
  Code: 422-like status

ERROR: InvalidChunkRange
  Cause: startByte > endByte or negative values
  Solution:
    - Reject chunk
    - Log as malformed response
  Code: 400-like status

ERROR: OutOfMemory
  Cause: Total stored chunks exceed maxMemory limit
  Solution:
    - Evict LRU incomplete sessions
    - If still over, reject new chunks
    - Write old chunks to disk cache
  Code: 507-like status

ERROR: GapInRange
  Cause: Attempted to combine chunks with missing ranges
  Solution:
    - Throw before combining
    - Return list of missing ranges to client
    - Allow resuming download from missing ranges
```

### 3.2 Validation on Combination
```
FUNCTION validateBeforeCombine(session)
  errors = []
  
  IF session.status != 'complete' THEN
    errors.push("Download not marked complete")
  
  IF not isDownloadComplete(session) THEN
    errors.push("Chunks don't cover entire file")
  
  gaps = findMissingRanges(session)
  IF gaps.length > 0 THEN
    errors.push({
      message: "Missing byte ranges",
      gaps: gaps
    })
  
  IF session.contentLength == null THEN
    errors.push("Content-Length unknown - cannot validate")
  
  IF errors.length > 0 THEN
    RETURN { valid: false, errors: errors }
  
  RETURN { valid: true }
END FUNCTION
```

---

## 4. Memory Management Strategies

### 4.1 Memory Tracking
```
FUNCTION updateMemoryUsage()
  totalMemory = 0
  
  FOR EACH session IN sessions.values() DO
    FOR EACH chunk IN session.chunks.values() DO
      totalMemory += chunk.data.byteLength
      // Add overhead: ~200 bytes per chunk object
      totalMemory += 200
    
    // Session metadata overhead: ~500 bytes
    totalMemory += 500
  
  currentMemory = totalMemory
  RETURN currentMemory
END FUNCTION
```

### 4.2 LRU Eviction Policy
```
FUNCTION evictLRUIfNeeded(requiredBytes)
  targetMemory = maxMemory * 0.8  // Free up 20% headroom
  
  WHILE currentMemory + requiredBytes > maxMemory DO
    // Find least-recently-used incomplete session
    lruSession = null
    lruTime = infinity
    
    FOR EACH session IN sessions.values() DO
      IF session.status == 'pending' AND session.updatedAt < lruTime THEN
        lruSession = session
        lruTime = session.updatedAt
    
    IF lruSession == null THEN
      // No pending sessions to evict
      BREAK
    
    // Evict LRU session
    bytesFreed = removeSession(lruSession.url)
    currentMemory -= bytesFreed
    
    logWarning("Evicted incomplete download: " + lruSession.url)
  
  IF currentMemory + requiredBytes > maxMemory THEN
    THROW OutOfMemory("Cannot free sufficient memory")
END FUNCTION
```

### 4.3 Cleanup Strategies
```
FUNCTION cleanupOldSessions(maxAgeMs)
  now = currentTime()
  toRemove = []
  
  FOR EACH session IN sessions.values() DO
    age = now - session.updatedAt
    
    IF age > maxAgeMs THEN
      IF session.status == 'complete' THEN
        // Remove completed downloads after age limit
        toRemove.push(session.url)
      ELSE IF age > maxAgeMs * 2 THEN
        // Remove stale incomplete downloads after 2x age
        toRemove.push(session.url)
  
  FOR EACH url IN toRemove DO
    removeSession(url)
  
  RETURN toRemove.length
END FUNCTION
```

---

## 5. Advanced Features

### 5.1 Parallel Range Requests
```
// When server supports it, request multiple ranges simultaneously

FUNCTION requestOptimalRanges(session, chunkSize = 1MB)
  missingRanges = findMissingRanges(session)
  
  // Group ranges to minimize requests (combine small gaps)
  optimizedRanges = []
  currentRange = null
  
  FOR EACH gap IN missingRanges DO
    IF currentRange == null THEN
      currentRange = gap
    ELSE IF gap.startByte - currentRange.endByte < 64KB THEN
      // Combine small gaps into single request
      currentRange.endByte = gap.endByte
    ELSE
      optimizedRanges.push(currentRange)
      currentRange = gap
  
  IF currentRange != null THEN
    optimizedRanges.push(currentRange)
  
  // Split large ranges into chunks
  requests = []
  FOR EACH range IN optimizedRanges DO
    pos = range.startByte
    WHILE pos <= range.endByte DO
      endPos = min(pos + chunkSize - 1, range.endByte)
      requests.push({ start: pos, end: endPos })
      pos = endPos + 1
  
  RETURN requests
END FUNCTION
```

### 5.2 Checksum Verification
```
FUNCTION verifyChunkIntegrity(chunk, expectedHash)
  // Optional: verify chunk wasn't corrupted in transit
  actualHash = sha256(chunk.data)
  
  IF actualHash != expectedHash THEN
    RETURN {
      valid: false,
      error: "Checksum mismatch",
      expected: expectedHash,
      actual: actualHash
    }
  
  chunk.isVerified = true
  RETURN { valid: true }
END FUNCTION
```

### 5.3 Resume Information Export
```
FUNCTION exportResumeInfo(url)
  session = sessions.get(url)
  IF session == null THEN
    RETURN null
  
  RETURN {
    url: url,
    contentLength: session.contentLength,
    contentType: session.contentType,
    etag: session.etag,
    lastModified: session.lastModified,
    receivedRanges: extractReceivedRanges(session),
    missingRanges: findMissingRanges(session),
    createdAt: session.createdAt,
    progress: calculateProgress(session)
  }
END FUNCTION
```

---

## 6. Usage Examples

### Example 1: Downloading with Out-of-Order Chunks
```
// Initialize storage
storage = new BlobStorage(maxMemory: 100MB)

// Request chunk 1
response1 = httpGet("http://example.com/file.bin",
  headers: { "Range": "bytes=0-1023" })
// Returns: 206, Content-Range: 0-1023/5000, data: [1024 bytes]
storage.addChunk("http://example.com/file.bin", 0, 1023,
  response1.data, response1.contentType, response1.headers)
// Result: { status: 'stored', bytesAdded: 1024, isComplete: false, percentComplete: 20.5% }

// Request chunk 3 (out of order)
response3 = httpGet("http://example.com/file.bin",
  headers: { "Range": "bytes=2048-4999" })
storage.addChunk("http://example.com/file.bin", 2048, 4999,
  response3.data, response3.contentType, response3.headers)
// Result: { status: 'stored', bytesAdded: 2952, isComplete: false }

// Request chunk 2 (fills gap)
response2 = httpGet("http://example.com/file.bin",
  headers: { "Range": "bytes=1024-2047" })
storage.addChunk("http://example.com/file.bin", 1024, 2047,
  response2.data, response2.contentType, response2.headers)
// Result: { status: 'stored', bytesAdded: 1024, isComplete: true }

// All chunks present - download complete!
result = storage.combineChunks("http://example.com/file.bin")
// Result: { data: [5000 bytes], contentType: "application/octet-stream", size: 5000 }
```

### Example 2: Handling Duplicates
```
// Request chunk 1 again (duplicate)
response1_dup = httpGet("http://example.com/file.bin",
  headers: { "Range": "bytes=0-1023" })
storage.addChunk("http://example.com/file.bin", 0, 1023,
  response1_dup.data, response1_dup.contentType, response1_dup.headers)
// Result: { status: 'duplicate', bytesAdded: 0 }
// Duplicate detected and ignored, memory not wasted
```

### Example 3: Detecting Missing Chunks
```
// Only have chunks 0-1023 and 2048-4999, missing 1024-2047
gaps = storage.findMissingRanges("http://example.com/file.bin")
// Result: [{
//   startByte: 1024,
//   endByte: 2047,
//   size: 1024
// }]

// Attempt to combine fails
result = storage.combineChunks("http://example.com/file.bin")
// Throws: IncompleteDownload("Chunks don't cover entire file")
// With details on missing ranges from error handling
```

### Example 4: Memory Management
```
// Storage at capacity
storage = new BlobStorage(maxMemory: 10MB)
// 8 pending downloads taking 8MB
// New 206 response arrives with 3MB chunk

storage.addChunk("http://example.com/large.bin", ...)
// Triggers memory check:
// - currentMemory (8MB) + bytesToAdd (3MB) > maxMemory (10MB)
// - Evicts LRU incomplete session (e.g., oldest pending download)
// - If successful: stores new chunk
// - If insufficient space: throws OutOfMemory error
```

---

## 7. Implementation Considerations

### 7.1 Language-Specific Notes

**JavaScript/TypeScript:**
- Use `Map` for session storage (better performance than objects)
- Use `Uint8Array` for binary data
- Consider `ArrayBuffer` views for zero-copy operations

**Python:**
- Use `dict` with tuple keys for ranges: `(start, end)`
- Use `bytearray` or `bytes` for data storage
- Use `heapq` for LRU priority queue

**Go:**
- Use `sync.Map` for concurrent access (if multi-threaded)
- Use `[]byte` for chunk data
- Consider `mmap` for large files

**Java:**
- Use `ConcurrentHashMap` for thread safety
- Use `TreeMap` to keep ranges sorted
- Use `ByteBuffer` for efficient memory management

### 7.2 Performance Optimizations
- Pre-allocate buffer in `combineChunks()` to avoid reallocation
- Use sorted ranges to skip unnecessary comparisons
- Cache `isDownloadComplete()` result until new chunk arrives
- Use binary search for range lookups if hundreds of chunks

### 7.3 Testing Strategy
```
Test Cases:
1. Sequential chunks (0-1023, 1024-2047, etc.)
2. Out-of-order chunks (2048-3071, 0-1023, 1024-2047)
3. Duplicate chunks (same range twice with identical data)
4. Conflicting chunks (same range twice with different data)
5. Missing ranges (gaps between chunks)
6. Single chunk (entire file in one 206 response)
7. Overlapping ranges (should be rejected)
8. Invalid ranges (startByte > endByte)
9. Size mismatch (data.length != range size)
10. Memory limits (eviction of LRU sessions)
11. Missing Content-Length header
12. Complete download detection
13. Progress calculation accuracy
```

---

## Summary

This architecture provides:
- **Efficient tracking** via Map-based storage with byte-range keys
- **Transparent out-of-order handling** through sorted combination
- **Duplicate detection** by comparing stored vs. incoming chunks
- **Gap detection** via sorted range validation
- **Memory efficiency** through LRU eviction and range merging
- **Error resilience** with comprehensive validation
- **Resume capability** through exportable session state
