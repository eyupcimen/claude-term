// Renders ads.json into PNGs: carousel 1080x1350 and story 1080x1920, TR + EN.
// Run with Electron: npx electron ads/render.js <shots dir> <out dir>
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const [shots, out] = process.argv.slice(-2);
const spec = JSON.parse(fs.readFileSync(path.join(__dirname, 'ads.json'), 'utf8'));
const FORMATS = { carousel: [1080, 1350], story: [1080, 1920] };

app.on('window-all-closed', () => {}); // keep going between formats
app.whenReady().then(async () => {
  for (const [format, [width, height]] of Object.entries(FORMATS)) {
    const win = new BrowserWindow({ width, height, show: false, useContentSize: true, webPreferences: { offscreen: true } });
    for (const lang of ['tr', 'en']) {
      const dir = path.join(out, lang);
      fs.mkdirSync(dir, { recursive: true });
      for (const [i, slide] of spec.slides.entries()) {
        const [title, sub] = slide[lang];
        const q = new URLSearchParams({
          title, sub, format, link: spec.link, crop: slide.crop || '',
          shot: pathToFileURL(path.resolve(shots, `${slide.shot}.png`)).href,
        });
        await win.loadURL(`${pathToFileURL(path.join(__dirname, 'template.html')).href}?${q}`);
        await new Promise((r) => setTimeout(r, 300));
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(dir, `${format}-${i + 1}.png`), img.resize({ width, height }).toPNG());
      }
    }
    win.destroy();
  }
  app.quit();
});
