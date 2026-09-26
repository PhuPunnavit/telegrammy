# TG Downloader - Troubleshooting Guide

## Download Issues

### Problem: Download ไม่ได้ หรือโหลด .htm file

**Root causes:**
1. Blob URL ถูก revoke ก่อนที่จะใช้งาน
2. Media ไม่ได้ load ให้ชัดเจน
3. URL ที่ส่งไปไม่ตรงกับ blob ที่เก็บไว้

### Solution: Debug Steps

#### Step 1: Reload Extension
1. เปิด `chrome://extensions/`
2. กด **Reload** (🔄) บน TG Downloader

#### Step 2: Check Console Logs
1. เปิด Telegram Web: https://web.telegram.org/
2. เปิด DevTools: กด **F12** → **Console** tab
3. ดูข้อความ `[TG]` ในลำดับการทำงาน

**ตัวอย่างผลลัพธ์ที่ถูกต้อง:**
```
[TG] inject.js loaded
[TG] Blob stored: video/mp4 2540012 bytes
[TG] Download request: blob:https://web...
[TG] Found in blobStorage
[TG] Downloading: tg_xxx.mp4 video/mp4 2540012 bytes
[TG] Download triggered: tg_xxx.mp4
```

#### Step 3: Play Media Properly
- ❌ **ไม่ดี**: แค่เล่นวิดีโอ 1 วินาที แล้วปิด
- ✅ **ดี**: เล่นวิดีโอให้ load สักครู่ ดูจนเห็น progress bar

#### Step 4: Check if Media is Captured
1. ใน Console พิมพ์: `window.tgDebug?.checkContent()`
2. ดูว่า floating button แสดงตัวเลขไหม (จำนวน media ที่ capture)

---

## Testing

### Test 1: Single Download
1. เล่น video ใน chat
2. กด ⬇ ปุ่ม download ที่ corner ของ video
3. ดูว่า download ได้ไหม

### Test 2: Batch Download
1. เล่นหลาย video
2. กด ⚡ TG Downloader floating button
3. Select All
4. Click Download

### Test 3: Check Downloaded File
```bash
# Windows
cd %USERPROFILE%\Downloads\TG_Downloads
dir /s

# Mac/Linux
cd ~/Downloads/TG_Downloads
ls -la
```

---

## Common Issues & Fixes

### Issue: ได้ไฟล์ .htm แทนที่ .mp4
**ความหมาย**: URL ที่ส่งไปไม่ถูกต้อง เป็นหน้า HTML แทนที่จะเป็น media blob

**วิธีแก้**:
1. เล่นวิดีโอให้ load เต็มที่
2. รอสัก 2-3 วินาที
3. ลองกด download อีกครั้ง
4. ดูใน Console ว่ามี `[TG] Blob stored:` ที่ขนาดใหญ่ไหม

### Issue: ปุ่ม Download ไม่ปรากฏ
**วิธีแก้**:
1. Reload extension
2. Reload web.telegram.org
3. ดูใน Console ว่ามี error ไหม

### Issue: Download เริ่มแล้วแต่ fail
**วิธีแก้**:
1. ตรวจสอบ Downloads folder ว่าไม่เต็ม
2. ลองปิด Chrome ทั้งหมด แล้วเปิดใหม่
3. ตรวจสอบ Windows Defender ไม่ block download

---

## Advanced Debugging

### View All Captured Blobs (in Console)
```javascript
// Run this in DevTools Console:
window.tgDebug?.showAllBlobs?.()  // if available
```

### Manual Download Test
```javascript
// Create a test blob and try download
const testBlob = new Blob(['Test content'], {type: 'text/plain'});
const url = URL.createObjectURL(testBlob);
window.postMessage({
  type: 'TG_TRIGGER_DOWNLOAD',
  payload: { url: url, filename: 'test.txt' }
}, '*');
```

### Check if Extension Content Script Loaded
```javascript
// Run in Console:
document.querySelector('.tg-dl-floating-btn') ? 'Loaded ✓' : 'Not loaded ✗'
```

---

## Files to Check

- `inject.js` - Hooks blob capture (page world)
- `content.js` - UI and download triggering (content script world)
- `background.js` - Background service worker
- `manifest.json` - Extension permissions

---

## If Still Not Working

1. **Export Chrome Debug Logs**:
   - Open DevTools → Console
   - Right-click → Save as...
   - Attach the log file

2. **Check Extension Permissions**:
   - `chrome://extensions/`
   - Click TG Downloader
   - See if any permissions are blocked

3. **Try Incognito Mode**:
   - Open Telegram Web in Incognito
   - Test download there
   - If it works, something is interfering

---

## Performance Notes

- First video play captures the blob (may take a few seconds)
- Large videos (>500MB) will take time to download
- Multiple simultaneous downloads may slow browser
