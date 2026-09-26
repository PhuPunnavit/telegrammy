// Debug script for TG Downloader Extension
// To debug in Chrome DevTools:
// 1. Open web.telegram.org
// 2. Open DevTools (F12)
// 3. Run this script in Console

(() => {
  console.log('[TG Downloader] Debug script loaded');

  // Check if inject.js is loaded
  const checkInject = () => {
    try {
      const hasHook = URL.createObjectURL.toString().includes('[native code]') === false;
      console.log('[TG Downloader] URL.createObjectURL hooked:', hasHook);

      // Look for our markers
      const scripts = [...document.querySelectorAll('script')];
      const injectScript = scripts.find(s => s.src?.includes('inject.js'));
      console.log('[TG Downloader] inject.js loaded:', !!injectScript);

      return hasHook;
    } catch (e) {
      console.error('[TG Downloader] Error checking inject.js:', e);
      return false;
    }
  };

  // Check if content.js is loaded
  const checkContent = () => {
    const floatingBtn = document.querySelector('.tg-dl-floating-btn');
    const quickBtns = document.querySelectorAll('.tg-dl-quick-btn');

    console.log('[TG Downloader] Floating button present:', !!floatingBtn);
    console.log('[TG Downloader] Quick buttons count:', quickBtns.length);

    if (floatingBtn) {
      console.log('[TG Downloader] Floating button text:', floatingBtn.textContent);
    }
  };

  // Test download functionality
  const testDownload = () => {
    console.log('[TG Downloader] Testing download...');

    // Create a test blob
    const testBlob = new Blob(['Hello TG Downloader!'], { type: 'text/plain' });
    const blobUrl = URL.createObjectURL(testBlob);

    console.log('[TG Downloader] Created test blob:', blobUrl);

    // Send download message
    window.postMessage({
      type: 'TG_TRIGGER_DOWNLOAD',
      payload: {
        url: blobUrl,
        filename: 'tg_test_download.txt'
      }
    }, '*');

    console.log('[TG Downloader] Download message sent');

    // Check if extension is active
    try {
      chrome.runtime.sendMessage(
        'test extension id here', // Extension ID would be needed
        { type: 'PING' },
        (response) => {
          console.log('[TG Downloader] Extension response:', response);
        }
      );
    } catch (e) {
      console.log('[TG Downloader] Can\'t ping extension directly:', e.message);
    }
  };

  // Monitor blob creation
  const monitorBlobs = () => {
    console.log('[TG Downloader] Monitoring blob creation...');

    const origCreateObjectURL = URL.createObjectURL;

    URL.createObjectURL = function(obj) {
      const url = origCreateObjectURL.apply(this, arguments);

      if (obj instanceof Blob) {
        console.log('[TG Downloader] Blob created:', {
          url: url.substring(0, 50) + '...',
          type: obj.type,
          size: obj.size,
          isVideo: obj.type.startsWith('video/'),
          isAudio: obj.type.startsWith('audio/'),
          isImage: obj.type.startsWith('image/')
        });
      } else if (obj instanceof MediaSource) {
        console.log('[TG Downloader] MediaSource created:', url.substring(0, 50) + '...');
      }

      return url;
    };
  };

  // Run all checks
  console.log('[TG Downloader] === Debugging TG Downloader Extension ===');
  checkInject();
  checkContent();
  // monitorBlobs(); // Uncomment to monitor all blob creation

  console.log('[TG Downloader] To test download:');
  console.log('[TG Downloader] 1. Play a video/audio in Telegram Web');
  console.log('[TG Downloader] 2. Click the download button');
  console.log('[TG Downloader] 3. Check DevTools Console for logs');

  // Expose functions for manual testing
  window.tgDebug = {
    checkInject,
    checkContent,
    testDownload,
    monitorBlobs
  };

  console.log('[TG Downloader] Debug tools available: window.tgDebug');
})();