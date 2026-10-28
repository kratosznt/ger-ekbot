// KRATOS v3.3 — Bosken Guard ses kanalinda bekle; muzikte kullaniciya gec, sonra Guard'a don.
// Discord Player 7'nin kendi voice arayuzunu kullanir. Ayrica @discordjs/voice kurmayin.
import { ChannelType, Events, PermissionFlagsBits } from 'discord.js';

const DEFAULT_NAME = 'guard';
let clientRef = null;
let playerRef = null;
let guildIdRef = null;
let returnTimer = null;
let activeStarts = 0;
let returning = false;
let lastJoinAttempt = 0;
let loggedMissing = false;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const current = queue => queue?.currentTrack ?? queue?.node?.currentTrack ?? null;

function busy() {
  if (activeStarts > 0) return true;
  const q = playerRef?.nodes?.get(guildIdRef);
  if (!q) return false;
  if (current(q) || (q.tracks?.size ?? 0) > 0) return true;
  // Oynatici henuz siradaki akisi aciyorsa bekleme odasina donme.
  try { if (q.node?.isPlaying?.() || q.node?.isPaused?.()) return true; }
  catch {}
  return false;
}

async function getGuild() {
  const guild = clientRef?.guilds?.cache?.get(guildIdRef) ??
    await clientRef?.guilds?.fetch(guildIdRef).catch(() => null);
  return guild ?? null;
}

async function findGuard(guild) {
  const channels = await guild.channels.fetch();
  const exactId = process.env.GUARD_VOICE_CHANNEL_ID?.trim();
  if (exactId) {
    const picked = channels.get(exactId);
    if (!picked || picked.type !== ChannelType.GuildVoice) {
      throw new Error('GUARD_VOICE_CHANNEL_ID sesli kanala ait degil; ID yi kontrol et.');
    }
    return picked;
  }
  // Kullanici Guard adinda tek bir ses kanali olusturduysa ID gerektirme.
  const found = channels.filter(c => c?.type === ChannelType.GuildVoice &&
    c.name.toLocaleLowerCase('tr-TR').trim() === DEFAULT_NAME);
  if (found.size > 1) throw new Error('Birden fazla Guard ses kanali var. .env dosyasina GUARD_VOICE_CHANNEL_ID ekle.');
  return found.first() ?? null;
}

export function scheduleGuardReturn(ms = 3500) {
  if (returnTimer) clearTimeout(returnTimer);
  returnTimer = setTimeout(() => {
    returnTimer = null;
    goGuard().catch(err => console.warn('[KRATOS Guard] Geri donus:', err.message));
  }, ms);
  returnTimer.unref?.();
}

async function goGuard() {
  if (returning || busy() || !playerRef) return;
  const guild = await getGuild();
  if (!guild) return;
  const guard = await findGuard(guild);
  if (!guard) {
    if (!loggedMissing) console.warn('[KRATOS Guard] Guard adinda ses kanali bulunamadi. GUARD_VOICE_CHANNEL_ID ayarla.');
    loggedMissing = true;
    return;
  }
  loggedMissing = false;
  const me = await guild.members.fetchMe();
  if (!guard.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect])) {
    throw new Error('Guard kanalinda Botun Kanali Goruntule / Baglan izni eksik.');
  }
  if (busy()) return;
  const connection = playerRef.voice.getConnection(guild.id);
  if (me.voice.channelId === guard.id && connection && connection.state?.status !== 'destroyed') return;
  if (Date.now() - lastJoinAttempt < 4000) return;
  lastJoinAttempt = Date.now();
  returning = true;
  try {
    // Sadece tamamen bitmis/eski kuyrugu temizle. Aktif sarkiya dokunma.
    const q = playerRef.nodes.get(guild.id);
    if (q && !busy()) q.delete();
    if (busy()) return;
    // Discord Player'a ait ayni ses sistemiyle baglan (baska voice kutuphanesi kullanma).
    await playerRef.voice.join(guard, { selfMute: true, selfDeaf: true });
    console.log(`[KRATOS Guard] Bekleme kanali: ${guard.name}`);
  } finally {
    returning = false;
  }
}

// /play komutu ve paneldeki 📎 butonu yalniz bu yardimciyi kullansin.
export async function playInUserVoice(player, voice, url, options) {
  if (!player || !voice) throw new Error('Muzik oynaticisi veya ses kanali bulunamadi.');
  if (returnTimer) { clearTimeout(returnTimer); returnTimer = null; }
  activeStarts++;
  try {
    const q = player.nodes.get(voice.guild.id);
    if (q && current(q) && q.channel?.id !== voice.id) {
      throw new Error('Muzik baska bir kanalda caliyor; once oraya katil.');
    }
    // Bekleme modundaki ses baglantisini kapatip player.play'in kendi baglantisini ac.
    // player.play() disaridan verilen VoiceConnection'i yeniden kullanamaz.
    if (!q || (!current(q) && !(q.tracks?.size > 0))) {
      if (q) q.delete();
      const connection = player.voice.getConnection(voice.guild.id);
      if (connection && connection.joinConfig?.channelId !== voice.id) {
        connection.destroy();
        await delay(250);
      }
    }
    return await player.play(voice, url, options);
  } finally {
    activeStarts--;
    // Arama/akista hata olursa ve hala muzik yoksa Guard'a don.
    scheduleGuardReturn(6500);
  }
}

export function setupGuardVoice(client, player, guildId) {
  if (clientRef) return;
  clientRef = client;
  playerRef = player;
  guildIdRef = guildId;

  client.once(Events.ClientReady, () => scheduleGuardReturn(1500));
  for (const name of ['emptyQueue', 'queueDelete', 'disconnect', 'emptyChannel']) {
    player.events.on(name, () => scheduleGuardReturn(4500));
  }
  // Guard'dan manuel atilirsa bos moddayken yeniden katilmaya calis.
  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    if (newState.guild.id !== guildId || newState.id !== client.user?.id) return;
    if (!newState.channelId && !busy()) scheduleGuardReturn(6000);
  });
  const watchdog = setInterval(() => { if (!busy()) scheduleGuardReturn(2000); }, 60_000);
  watchdog.unref?.();
}
