const { app, BrowserWindow } = require('electron');
const path = require('path');
const log = (...a) => console.log('STEP ' + a.join(' '));
const results = [];

app.whenReady().then(async () => {
  log('ready');
  const win = new BrowserWindow({
    width: 400, height: 300, show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-probe.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  log('window created');
  win.webContents.on('did-finish-load', () => log('did-finish-load'));
  win.webContents.on('render-process-gone', (_e, d) => log('render-process-gone ' + JSON.stringify(d)));
  win.webContents.on('preload-error', (_e, p, e) => log('preload-error ' + p + ' ' + e));
  try {
    await win.loadURL('about:blank');
    log('loaded about:blank');
  } catch (e) { log('loadURL FAILED ' + String(e)); }
  for (const [label, expr] of [
    ['electronAPI exists', 'typeof window.electronAPI'],
    ['getPlatform()', 'window.electronAPI.getPlatform()'],
    ['storageGet is fn', 'typeof window.electronAPI.storageGet'],
  ]) {
    try {
      const v = await win.webContents.executeJavaScript(expr);
      log('probe ' + label + ' = ' + String(v));
      results.push({ check: label, ok: v !== undefined && v !== null, detail: String(v) });
    } catch (e) { log('probe FAILED ' + label + ' ' + String(e)); results.push({ check: label, ok: false, detail: String(e) }); }
  }
  win.destroy();
  console.log('PROBE_RESULT ' + JSON.stringify(results));
  app.exit(0);
}).catch((e) => { console.log('STEP whenReady FAILED ' + String(e)); app.exit(1); });
setTimeout(() => { console.log('PROBE_TIMEOUT'); process.exit(2); }, 25000).unref();
