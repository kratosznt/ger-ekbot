// KRATOS v2.4 — /tracker @uye (opt-in, Riot ID in kayit takma adi)
// Never scrapes Tracker.gg. Detailed stats require an authorized HenrikDev API key.
import { EmbedBuilder, MessageFlags } from 'discord.js';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const STORE = path.join(process.cwd(), 'data', 'kratos-tracker-consent.json');
const EPHEMERAL = MessageFlags.Ephemeral;
const RANK_COLOR = 0x86bdf8;
const BASE = 'https://api.henrikdev.xyz';
const REGION = /^(eu|na|ap|kr|latam|br)$/i.test(process.env.TRACKER_REGION ?? '')
  ? process.env.TRACKER_REGION.toLowerCase() : 'eu';
const CACHE_MS = 3 * 60 * 1000;
const cache = new Map();
let writeChain = Promise.resolve();

function parseRiotId(value) {
  if (typeof value !== 'string') return null;
  const match = /^(.+?)#([^#\s]+)$/u.exec(value.trim());
  if (!match) return null;
  const name = match[1].trim();
  const tag = match[2].trim();
  if (name.length < 2 || name.length > 32 || tag.length < 2 || tag.length > 8) return null;
  if (/[\r\n<>@]/u.test(name + tag)) return null;
  return { name, tag, full: `${name}#${tag}` };
}

export function parseRegisteredRiotId(nickname) {
  if (typeof nickname !== 'string') return null;
  const match = /\(([^()]+#[^()]+)\)\s*$/u.exec(nickname);
  return match ? parseRiotId(match[1]) : null;
}

const clean = value => String(value ?? '').replace(/[`*_~|<>@\r\n]/gu, ' ').slice(0, 90);
const fmt = (n, d = 1) => Number.isFinite(n) ? n.toFixed(d) : '—';
const num = n => typeof n === 'number' && Number.isFinite(n) ? n : null;

async function getStore() {
  try {
    const obj = JSON.parse(await readFile(STORE, 'utf8'));
    if (obj && obj.version === 1 && typeof obj.users === 'object' && obj.users && !Array.isArray(obj.users)) return obj;
    throw new Error('KRATOS tracker izin dosyasi hatali bicimde.');
  } catch (err) {
    if (err.code === 'ENOENT') return { version: 1, users: {} };
    throw err;
  }
}

function changeStore(change) {
  const next = writeChain.then(async () => {
    const store = await getStore();
    await change(store);
    await mkdir(path.dirname(STORE), { recursive: true });
    const tmp = `${STORE}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
    await rename(tmp, STORE);
  });
  writeChain = next.catch(() => {});
  return next;
}

function profileUrl(id) {
  return `https://tracker.gg/valorant/profile/riot/${encodeURIComponent(id.full)}/overview`;
}

async function requestJson(url, key) {
  const signal = AbortSignal.timeout(10000);
  const res = await fetch(url, { headers: { Authorization: key, Accept: 'application/json' }, signal });
  if (res.status === 401 || res.status === 403) throw new Error('HenrikDev API anahtarı geçersiz veya erişim yetkisi yok.');
  if (res.status === 404) throw new Error('Oyuncu veya maç verisi bulunamadı. Profil gizli ya da bölgede mevcut olmayabilir.');
  if (res.status === 429) throw new Error('İstek sınırına ulaşıldı. Biraz sonra tekrar dene.');
  if (!res.ok) throw new Error(`Veri servisi HTTP ${res.status} döndürdü.`);
  const body = await res.json();
  if (body?.status && body.status !== 200) throw new Error('İstatistik servisi bu oyuncu için veri döndürmedi.');
  return body?.data ?? null;
}

function getPlayer(match, riotId) {
  const group = match?.players;
  const all = Array.isArray(group) ? group : Array.isArray(group?.all_players) ? group.all_players : [];
  return all.find(p => {
    const name = p?.name ?? p?.riot_id?.game_name ?? p?.player_name ?? '';
    const tag = p?.tag ?? p?.riot_id?.tagline ?? '';
    return `${name}#${tag}`.toLocaleLowerCase('en-US') === riotId.full.toLocaleLowerCase('en-US');
  }) ?? null;
}

function matchWon(match, player) {
  const teams = match?.teams;
  const teamId = String(player?.team_id ?? player?.team ?? '').toLowerCase();
  if (!teamId) return null;
  let team;
  if (Array.isArray(teams)) team = teams.find(t => String(t.team_id ?? t.team ?? t.id ?? '').toLowerCase() === teamId);
  else if (teams && typeof teams === 'object') team = Object.entries(teams).find(([key]) => key.toLowerCase() === teamId)?.[1];
  if (!team) return null;
  const raw = team.won ?? team.has_won ?? team.hasWon;
  return typeof raw === 'boolean' ? raw : null;
}

export function summarizeMatches(matches, riotId) {
  const tracked = [];
  for (const match of Array.isArray(matches) ? matches : []) {
    const p = getPlayer(match, riotId);
    if (!p) continue;
    const s = p.stats ?? p;
    const kills = num(s.kills);
    const deaths = num(s.deaths);
    const assists = num(s.assists);
    const hs = num(s.headshots ?? s.head_shots ?? s.head_shot);
    const bs = num(s.bodyshots ?? s.body_shots);
    const ls = num(s.legshots ?? s.leg_shots);
    const won = matchWon(match, p);
    const map = match?.metadata?.map?.name ?? match?.metadata?.map ?? 'Bilinmiyor';
    const mode = match?.metadata?.mode?.name ?? match?.metadata?.mode ?? 'Maç';
    tracked.push({ kills, deaths, assists, hs, bs, ls, won, map: clean(map), mode: clean(mode) });
  }
  const total = key => tracked.reduce((sum, game) => sum + (game[key] ?? 0), 0);
  const complete = tracked.filter(g => g.kills !== null && g.deaths !== null);
  const winKnown = tracked.filter(g => g.won !== null);
  const shotsKnown = tracked.filter(g => g.hs !== null && g.bs !== null && g.ls !== null);
  const shots = shotsKnown.reduce((sum, g) => sum + g.hs + g.bs + g.ls, 0);
  return {
    count: tracked.length,
    kd: complete.length && total('deaths') ? total('kills') / total('deaths') : null,
    kda: complete.length ? `${total('kills')}/${total('deaths')}/${total('assists')}` : null,
    winrate: winKnown.length ? winKnown.filter(g => g.won).length / winKnown.length * 100 : null,
    winsMeasured: winKnown.length,
    hs: shotsKnown.length && shots ? shotsKnown.reduce((sum,g) => sum + g.hs, 0) / shots * 100 : null,
    hsMeasured: shotsKnown.length,
    games: tracked.slice(0, 5),
  };
}

async function fetchStats(id) {
  const key = (process.env.HENRIK_API_KEY ?? '').trim();
  if (!key) return null;
  const cacheKey = `${REGION}:${id.full.toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const encode = s => encodeURIComponent(s);
  const mmrUrl = `${BASE}/valorant/v3/mmr/${REGION}/pc/${encode(id.name)}/${encode(id.tag)}`;
  const matchesUrl = `${BASE}/valorant/v4/matches/${REGION}/pc/${encode(id.name)}/${encode(id.tag)}?mode=competitive&size=10`;
  const responses = await Promise.allSettled([requestJson(mmrUrl, key), requestJson(matchesUrl, key)]);
  const mmr = responses[0].status === 'fulfilled' ? responses[0].value : null;
  const matches = responses[1].status === 'fulfilled' ? responses[1].value : null;
  if (!mmr && !matches) throw new Error(responses[0].reason?.message ?? 'İstatistik servisine erişilemiyor.');
  const value = { mmr, summary: summarizeMatches(matches, id), warning: responses.some(r => r.status === 'rejected') };
  cache.set(cacheKey, { at: Date.now(), value });
  return value;
}

async function trackerPermission(interaction) {
  const enable = interaction.options.getBoolean('ac', true);
  const id = parseRegisteredRiotId(interaction.member?.nickname ?? '') || parseRegisteredRiotId(interaction.member?.displayName ?? '');
  if (enable && !id) {
    await interaction.reply({ content: 'Önce KRATOS kayıt sisteminde `Ad (oyunadi#etiket)` şeklinde kayıt olmalısın. Oyun adın sunucu takma adında görünmüyor.', flags: EPHEMERAL });
    return true;
  }
  await changeStore(store => {
    if (enable) store.users[interaction.user.id] = { riotId: id.full, consentedAt: new Date().toISOString() };
    else delete store.users[interaction.user.id];
  });
  await interaction.reply({ content: enable
    ? `✅ **${id.full}** için KRATOS sunucusundaki diğer üyelerin istatistik sorgusu yapmasına izin verdin. Bu, Riot hesabı sahipliğini doğrulamaz; resmî RSO bağlantısı değildir. İstediğinde \`/trackerizin ac:Hayır\` ile iptal edebilirsin.`
    : '🔒 İstatistik paylaşım iznin kaldırıldı. KRATOS artık senin adına veri sorgulamayacak.', flags: EPHEMERAL });
  return true;
}

async function trackerLookup(interaction) {
  const user = interaction.options.getUser('uye', true);
  await interaction.deferReply();
  const member = await interaction.guild.members.fetch(user.id).catch(() => null);
  if (!member || member.user.bot) { await interaction.editReply('Üye bulunamadı veya bot hesabı.'); return true; }
  const id = parseRegisteredRiotId(member.nickname ?? '') || parseRegisteredRiotId(member.displayName ?? '');
  if (!id) {
    await interaction.editReply(`❌ ${member} için kayıt takma adında bir Riot ID bulamadım. Beklenen biçim: \`İsmail (kratos#33133)\`.`);
    return true;
  }
  const store = await getStore();
  const permission = store.users[member.id];
  if (!permission || permission.riotId.toLowerCase() !== id.full.toLowerCase()) {
    await interaction.editReply(`🔒 ${member} oyuncusunun istatistik paylaşma onayı yok veya oyun adı değişmiş. Önce kendisi \`/trackerizin ac:Evet\` demeli.`);
    return true;
  }

  const embed = new EmbedBuilder().setColor(RANK_COLOR).setTitle(`👑 KRATOS | ${clean(id.full)}`)
    .setDescription(`${member} · [Tracker.gg profilini aç](${profileUrl(id)})\n*İstatistikler alternatif veri kaynağından gelir; Tracker.gg verisi değildir.*`)
    .setTimestamp();
  if (!(process.env.HENRIK_API_KEY ?? '').trim()) {
    embed.addFields({ name: 'API yapılandırılmadı', value: 'İstatistik kartı için izinli HenrikDev API anahtarını `.env` içine `HENRIK_API_KEY=` şeklinde ekle. Şimdilik yalnızca profil bağlantısı hazır.' });
    await interaction.editReply({ embeds: [embed] });
    return true;
  }
  try {
    const data = await fetchStats(id);
    const current = data.mmr?.current;
    const peak = data.mmr?.peak;
    const s = data.summary;
    embed.addFields(
      { name: 'Mevcut rank', value: clean(current?.tier?.name ?? '—'), inline: true },
      { name: 'Rank puanı', value: current?.rr == null ? '—' : `${current.rr} RR`, inline: true },
      { name: 'En yüksek rank', value: clean(peak?.tier?.name ?? '—'), inline: true },
      { name: `K/D (son ${s.count} maç)`, value: fmt(s.kd, 2), inline: true },
      { name: 'Kazanma oranı', value: s.winrate === null ? '—' : `${fmt(s.winrate)}% (${s.winsMeasured} maç)`, inline: true },
      { name: 'Headshot oranı', value: s.hs === null ? '—' : `${fmt(s.hs)}% (${s.hsMeasured} maç)`, inline: true },
      { name: 'Toplam K/D/A', value: s.kda ?? '—', inline: false },
    );
    if (s.games.length) {
      embed.addFields({ name: 'Son rekabetçi maçlar', value: s.games.map((g,i) => `${i+1}. ${g.won === null ? '➖' : g.won ? '🟩' : '🟥'} **${g.map}** · ${g.mode} · ${g.kills ?? '?'}/${g.deaths ?? '?'}/${g.assists ?? '?'}`).join('\n').slice(0,1000) });
    }
    embed.setFooter({ text: `HenrikDev API · EU/PC · Son en fazla 10 rekabetçi maç · ${data.warning ? 'Kısmi veri' : 'Özet'}` });
    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error('Tracker API hata:', err);
    embed.addFields({ name: 'Veri alınamadı', value: clean(err.message) || 'Servis hatası. Daha sonra yeniden dene.' });
    await interaction.editReply({ embeds: [embed] });
  }
  return true;
}

export async function handleTrackerCommand(interaction) {
  if (!interaction.isChatInputCommand()) return false;
  if (interaction.commandName === 'trackerizin') return trackerPermission(interaction);
  if (interaction.commandName === 'tracker') return trackerLookup(interaction);
  return false;
}
