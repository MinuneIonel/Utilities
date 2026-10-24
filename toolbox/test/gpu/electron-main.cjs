// Opens the GPU check page in a hidden Electron window and prints its log.
const { app, BrowserWindow } = require("electron");

// Electron ships WebGPU on macOS and Windows; on Linux it needs the flag.
app.commandLine.appendSwitch("enable-unsafe-webgpu");

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL(process.argv[process.argv.length - 1]);
  for (;;) {
    const r = await win.webContents.executeJavaScript("window.gpuCheck ? { ...window.gpuCheck, log: document.getElementById('log').textContent } : null");
    if (r) {
      console.log(r.log);
      app.exit(r.ok ? 0 : 1);
      return;
    }
    await new Promise((res) => setTimeout(res, 250));
  }
});
