// Help: loads help/uk.html or help/en.html into an overlay.
import { $, LANG, savePref, S } from './state.js';
import { applyLang } from './editor.js';

const cache = {};
async function load(lang) {
  if (cache[lang]) return cache[lang];
  try {
    const r = await fetch(`help/${lang}.html`, { cache: 'no-cache' });
    if (!r.ok) throw new Error(r.status);
    cache[lang] = await r.text();
  } catch (e) {
    cache[lang] = lang === 'en'
      ? '<h2>Help</h2><p>The help file could not be loaded. Open the site through a web server (https) and make sure the <code>help/</code> folder was uploaded.</p>'
      : '<h2>Довідка</h2><p>Не вдалося завантажити файл довідки. Відкрийте сайт через веб-сервер (https) і перевірте, що папку <code>help/</code> завантажено на хостинг.</p>';
  }
  return cache[lang];
}
async function show(lang) {
  LANG.cur = lang; savePref('lang', lang);
  $('helpUk').classList.toggle('on', lang === 'uk');
  $('helpEn').classList.toggle('on', lang === 'en');
  $('helpBody').innerHTML = await load(lang);
  applyLang();
  // in-page section links scroll within the overlay
  $('helpBody').querySelectorAll('a[href^="#"]').forEach(a => a.addEventListener('click', e => {
    const el = $('helpBody').querySelector(a.getAttribute('href'));
    if (el) { e.preventDefault(); el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  }));
}
export async function openHelp(section) {
  const h = $('help');
  // in full screen only #stage is visible, so move the help overlay into it
  const stage = $('stage');
  if (stage.classList.contains('on')) { if (h.parentElement !== stage) stage.appendChild(h); }
  else if (h.parentElement !== document.body) document.body.appendChild(h);
  h.classList.add('on');
  await show(LANG.cur);
  h.scrollTop = 0;
  if (section) { const el = $('helpBody').querySelector('#' + section); if (el) el.scrollIntoView(); }
}
export function closeHelp() { $('help').classList.remove('on'); }
export function initHelp() {
  $('helpUk').addEventListener('click', () => show('uk'));
  $('helpEn').addEventListener('click', () => show('en'));
  $('helpClose').addEventListener('click', closeHelp);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('help').classList.contains('on')) closeHelp(); });
  $('help').addEventListener('click', e => { if (e.target === $('help')) closeHelp(); });
}
