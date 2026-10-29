# Selenium Studio

A local browser workflow recorder and playback app built with Node.js, Express, and Selenium WebDriver.

## Run

```powershell
npm install
npm start
```

Open http://localhost:3000 in a browser. Chrome is selected by default; Edge is also supported when it is installed.

Enter any `http://` or `https://` starting URL, choose a browser, and select **Record browser**. Interact with the Selenium-launched browser window, then return to the studio and select **Stop recording**. The captured workflow can be played back in a fresh browser session or exported as Python Selenium code.

The default starting URL is a local practice page at http://localhost:3000/demo.html, so the first recording can run without an external site.

### Restart or stop

To restart the server on the default port from PowerShell:

```powershell
$processId = (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue).OwningProcess
if ($processId) { Stop-Process -Id $processId -Force }
npm start
```

To stop the server without restarting it, run the first two lines only. If `npm start` is running in the foreground, `Ctrl+C` also stops it. Replace `3000` with your custom port when using `PORT`.

## Notes

- Browser drivers are resolved by Selenium Manager on first use.
- Chromium recording is event-driven through Selenium's Chrome DevTools Protocol connection: browser actions arrive through a runtime binding, and navigation comes from page events instead of a polling timer.
- Recordings live only in the running Node process and are cleared when the server restarts.
- Set `PORT` to use another local port, for example `$env:PORT=3100; npm start`.