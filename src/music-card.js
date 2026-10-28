// KRATOS Music v3.1 — Spotify benzeri kompakt dinamik oynatici karti.
// Ses ve kuyruk YONETMEZ; sadece gercek verilerden PNG olusturur.
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const W = 1200;
const H = 450;
const MARK = path.join(process.cwd(), 'assets', 'kratos-mark.png');
const COVER_SIZE = 222;
const cache = new Map();
let markPromise;

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}
function limit(value, max) {
  const s = String(value ?? '').replace(/[\n\r\t]+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
function text(x, y, value, size = 24, color = '#e7f2ff', weight = 500, extra = '') {
  return `<text x="${x}" y="${y}" fill="${color}" font-family="DejaVu Sans,Arial,sans-serif" font-size="${size}" font-weight="${weight}" ${extra}>${esc(value)}</text>`;
}
function rect(x,y,w,h,fill,r=12,stroke='none') {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}"/>`;
}
function time(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '00:00';
  const seconds = Math.floor(ms / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2,'0')}:${String(seconds % 60).padStart(2,'0')}`;
}
function validImage(url) {
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    return u.protocol === 'https:' && !u.username && !u.password && !u.port &&
      h.includes('.') && !h.endsWith('.local') && !h.endsWith('.internal') &&
      !/^\d+\.\d+\.\d+\.\d+$/.test(h) && !h.includes(':');
  } catch { return false; }
}
async function coverImage(url) {
  if (!url || !validImage(url)) return null;
  if (cache.has(url)) return cache.get(url);
  let output = null;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(4000), redirect: 'error' });
    if (!response.ok || !String(response.headers.get('content-type')).startsWith('image/')) throw new Error('Bad artwork');
    if (Number(response.headers.get('content-length') || 0) > 3_000_000) throw new Error('Large artwork');
    const chunks=[]; let size=0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 3_000_000) throw new Error('Large artwork');
      chunks.push(chunk);
    }
    output = await sharp(Buffer.concat(chunks), { limitInputPixels: 14_000_000 })
      .resize(COVER_SIZE,COVER_SIZE,{fit:'cover'}).png().toBuffer();
  } catch { /* Kaynak kapak resmini reddedebilir; KRATOS logosuna don. */ }
  cache.set(url,output);
  if (cache.size > 16) cache.delete(cache.keys().next().value);
  return output;
}
async function getMark() {
  markPromise ??= readFile(MARK)
    .then(bytes=>sharp(bytes).resize(COVER_SIZE,COVER_SIZE,{fit:'contain',background:'#0a101c'}).png().toBuffer())
    .catch(async () => sharp({
      create:{width:COVER_SIZE,height:COVER_SIZE,channels:4,background:'#102039'}
    }).png().toBuffer());
  return markPromise;
}

export async function renderMusicCard({track, paused=false, volume=65, repeatMode='Kapalı',
  voice='Bağlı değil', tracks=[], timestamp=null, queueSize=0}) {
  const mark = await getMark();
  const art = (track && await coverImage(track.thumbnail)) || mark;
  const artSrc = art.toString('base64');
  const markSrc = mark.toString('base64');
  const now = Number(timestamp?.current?.value);
  const total = Number(timestamp?.total?.value);
  const prog = Number(timestamp?.progress);
  const ratio = Number.isFinite(now) && Number.isFinite(total) && total>0
    ? now/total : Number.isFinite(prog) ? prog/100 : 0;
  const progress = Math.max(0,Math.min(1,ratio));
  const status = !track ? 'BEKLEMEDE' : paused ? 'DURAKLATILDI' : 'ŞİMDİ ÇALIYOR';
  const statusColor = !track ? '#94a3b8' : paused ? '#f5ba63' : '#6ee7b7';
  const songTitle = limit(track?.title || 'Bir bağlantı girerek başla', 42);
  const songAuthor = limit(track?.author || (track ? 'Bilinmeyen sanatçı' : 'Spotify • YouTube • SoundCloud'), 54);
  const duration = Number.isFinite(total) && total>0 ? time(total) : limit(track?.duration || '00:00',12);
  const elapsed = Number.isFinite(now) && now>=0 ? time(now) : '00:00';
  const qCount = Math.max(0,Number(queueSize)||0);
  const nextName = Array.isArray(tracks) && tracks.length ? limit(tracks[0]?.title || 'Bilinmeyen',38) : 'Kuyruk boş';
  const source = limit(String(track?.source || 'MUSIC').toUpperCase(),18);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <defs>
      <linearGradient id="base" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#171d29"/><stop offset=".65" stop-color="#121823"/><stop offset="1" stop-color="#090e18"/></linearGradient>
      <linearGradient id="fill" x1="0" y1="0" x2="1" y2="0"><stop stop-color="#477de8"/><stop offset="1" stop-color="#91d4fa"/></linearGradient>
      <radialGradient id="halo"><stop stop-color="#27518c" stop-opacity=".30"/><stop offset="1" stop-color="#27518c" stop-opacity="0"/></radialGradient>
      <clipPath id="cover"><rect x="45" y="144" width="${COVER_SIZE}" height="${COVER_SIZE}" rx="17"/></clipPath>
      <clipPath id="smallLogo"><rect x="45" y="31" width="63" height="63" rx="14"/></clipPath>
    </defs>
    ${rect(0,0,W,H,'url(#base)',22,'#2a3c53')}
    <circle cx="1010" cy="175" r="390" fill="url(#halo)"/>
    <path d="M1 2 H1198" stroke="#63acff" stroke-width="4" stroke-opacity=".7"/>
    <image href="data:image/png;base64,${markSrc}" x="45" y="31" width="63" height="63" clip-path="url(#smallLogo)"/>
    ${text(126,61,'KRATOS',27,'#e8f2ff',800,'letter-spacing="3"')}
    ${text(128,88,'MUSIC PLAYER',14,'#86a9d3',650,'letter-spacing="4"')}
    ${rect(965,43,182,40,'#1d3043',20,'#34536a')}
    <circle cx="985" cy="62" r="6" fill="${statusColor}"/>
    ${text(1001,69,status,14,'#bde1ff',750)}
    <path d="M45 113 H1154" stroke="#32465d" stroke-width="1"/>
    ${rect(41,140,231,231,'#14253c',20,'#38577d')}
    <image href="data:image/png;base64,${artSrc}" x="45" y="144" width="${COVER_SIZE}" height="${COVER_SIZE}" clip-path="url(#cover)"/>
    ${text(301,166,track?'ŞU AN ÇALAN':'HAZIR',14,'#79b9ee',750,'letter-spacing="2"')}
    ${text(301,223,songTitle,35,'#f1f6ff',750)}
    ${text(301,260,songAuthor,22,'#a9bed6',450)}
    ${text(1128,261,track?source:'',14,'#6f95b9',650,'text-anchor="end"')}
    ${rect(301,309,827,10,'#344155',6)}
    ${rect(301,309,Math.max(0,Math.round(827*progress)),10,'url(#fill)',6)}
    ${text(301,350,elapsed,16,'#a6b6cb',600)}
    ${text(1128,350,duration,16,'#a6b6cb',600,'text-anchor="end"')}
    <path d="M45 387 H1154" stroke="#30445b" stroke-width="1"/>
    ${text(48,422,'SES  %'+Number(volume),17,'#b4cbe4',600)}
    ${text(320,422,'DÖNGÜ  '+limit(repeatMode,20),17,'#b4cbe4',600)}
    ${text(670,422,'KUYRUK  '+qCount+' şarkı',17,'#b4cbe4',600)}
    ${text(1150,422,limit(voice,26),16,'#8ca8c8',500,'text-anchor="end"')}
  </svg>`;
  return sharp(Buffer.from(svg)).png({compressionLevel:8}).toBuffer();
}
