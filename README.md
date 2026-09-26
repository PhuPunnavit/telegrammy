# TG Downloader — Telegram Media Downloader Extension

A Chrome extension that adds one-click download buttons to Telegram Web for videos, audio, images, and voice notes — including save-restricted content.

## Features

- **One-click download** overlay button on every video, audio, and image in chat
- **Batch panel** drawer — select & download multiple files at once
- **Captures blob URLs** via `URL.createObjectURL` hook (works with restricted channels)
- **MediaSource stream stitching** — captures segmented video streams automatically
- **Downloads as `.mp4`** — no more `.bin` or `.webm` surprises
- **No play/open required** — blob is captured as soon as media loads

## Installation

1. Clone or download this repo
2. Open Chrome → `chrome://extensions/`
3. Enable **Developer Mode** (top-right toggle)
4. Click **Load unpacked** → select this folder
5. Open [web.telegram.org](https://web.telegram.org/) and browse normally

> Or run `launch_with_extension.bat` to open an isolated Chrome session with the extension pre-loaded.

## How it Works

| File | Role |
|---|---|
| `manifest.json` | Extension config, permissions |
| `inject.js` | Injected into page MAIN world; hooks `URL.createObjectURL` + `SourceBuffer.appendBuffer` |
| `content.js` | Receives detected media, renders UI (overlay buttons + batch drawer) |
| `background.js` | Handles `chrome.downloads` API calls, forces `.mp4` extension |
| `content.css` | Styles for overlay buttons and drawer |
| `popup.html` | Extension popup info page |

## Files Downloaded To

`~/Downloads/TG_Downloads/`

## License

MIT
