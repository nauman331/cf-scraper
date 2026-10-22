# Scrapper

Similarweb report scraper with a local GUI.

## Requirements

- Node.js 18 or newer
- Google Chrome installed
- Windows, macOS or Linux

## First-time setup

```powershell
npm install
```

## Run the GUI

```powershell
npm run gui
```

This starts the app at http://127.0.0.1:4173 and opens it in your browser.
Press Ctrl+C in the terminal to stop it.

1. Type or paste one or more websites, one per line.
2. Start the scrape and watch the console.
3. Click a finished site to see its report. Files are saved in the data folder.

If Similarweb shows a verification challenge, turn on "Show browser window" and try again.

## Settings

Chrome location, timeout and browser visibility are in the GUI. You can also set them before starting:

```powershell
$env:CHROME_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe"
$env:SCRAPER_TIMEOUT_MS=90000
$env:GUI_PORT=4180
npm run gui
```

On macOS or Linux, set Chrome's path with CHROME_PATH, for example:

```bash
CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm run gui
```

## Command line (unchanged)

```powershell
npm run scrape:similarweb
node similarweb-scraper.mjs https://www.similarweb.com/website/example.com/
$env:HEADLESS="false"; npm run scrape:similarweb
npm start
```

## Files

- similarweb-scraper.mjs: the scraper
- multi-scraper.mjs: the multi-site scraper
- similarweb-gui.mjs: local server for the GUI
- gui/index.html: the GUI page
- data/: saved CSV, JSON, HTML and text files
