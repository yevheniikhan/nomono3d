// Renders every frame of film.html and writes JPEGs for ffmpeg.

const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('fs');
const lang = process.argv[2] || 'en', FPS = +(process.env.FPS || 60), dir = __dirname + '/frames_' + lang;
fs.mkdirSync(dir, { recursive: true });
(async () => {
  const b = await chromium.launch();
  const page = await b.newPage({ viewport: { width: 1000, height: 600 } });
  await page.goto('http://127.0.0.1:8790/docs/film/film.html?lang=' + lang);
  await page.waitForFunction(() => window.READY, null, { timeout: 30000 });
  const N = Math.round(await page.evaluate(() => window.DURATION) * FPS);
  const t0 = Date.now();
  for (let i = 0; i < N; i += 10) {
    const batch = await page.evaluate(([i, n, fps]) => { const out = []; for (let k = i; k < Math.min(i + 10, n); k++) { window.render(k / fps); out.push(document.getElementById('c').toDataURL('image/jpeg', 0.95)); } return out; }, [i, N, FPS]);
    batch.forEach((d, k) => fs.writeFileSync(`${dir}/f${String(i + k).padStart(5, '0')}.jpg`, Buffer.from(d.split(',')[1], 'base64')));
    if (i % 300 === 0) console.log(lang, i, '/', N, ((Date.now() - t0) / 1000).toFixed(0) + ' s');
  }
  await b.close();
  console.log('done', N);
})();
