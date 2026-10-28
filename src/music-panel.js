// KRATOS v3.2.3 — iki satirli ikonlu kontrol paneli ve 0–200 ses ayari.
// Mevcut tek Discord Player nesnesini kullanir. Kayit / log / moderasyona dokunmaz.
import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChannelType,
  ContainerBuilder, SectionBuilder, ThumbnailBuilder, MediaGalleryBuilder, MediaGalleryItemBuilder,
  TextDisplayBuilder, SeparatorBuilder, Events, StringSelectMenuBuilder,
  MessageFlags, ModalBuilder, PermissionFlagsBits, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { QueueRepeatMode } from 'discord-player';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { renderMusicCard } from './music-card.js';
import { config } from './config.js';
import { parseSpotifyLink, spotifyInput, spotifyPlayMessage } from './spotify-links.js';

const KEY = 'kratos_music';
const CARD_NAME = 'kratos-music-card.png';
const LOGO_NAME = 'kratos-music-logo.png';
const LOGO_PATH = path.join(process.cwd(), 'assets', 'kratos-mark.png');
let logoCache = null;
async function logoFile() {
  logoCache ??= readFile(LOGO_PATH).then(bytes => sharp(bytes).resize(160, 160, { fit: 'contain' }).png().toBuffer());
  return new AttachmentBuilder(await logoCache, { name: LOGO_NAME });
}
const DATA = path.join(process.cwd(), 'data', 'kratos-music-panel.json');
const ME = MessageFlags.Ephemeral;
const MUSIC_FILE = /\.(mp3|m4a|ogg|opus|wav|aac|flac)$/i;
let panel = { channelId: null, messageId: null, volume: 65 };
let ready = false;
let playerRef = null;
let clientRef = null;
let opening = null;
let refreshTimer = null;
let refreshing = false;
let lastRefresh = 0;

function clean(text, max = 100) {
  const s = String(text ?? '').replace(/[`\r\n]/g, ' ').replace(/[@<>]/g, '');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
function musicChannelName(name) {
  return String(name ?? '').toLocaleLowerCase('tr-TR')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replaceAll('ı', 'i').replace(/[\s_-]/g, '') === 'muzikcal';
}
async function musicChannel(guild) {
  if (config.musicChannelId) {
    const ch = await guild.channels.fetch(config.musicChannelId).catch(() => null);
    return ch?.type === ChannelType.GuildText ? ch : null;
  }
  // .env MUSIC_CHANNEL_ID yoksa, tam bir tane #muzikcal varsa onu sec.
  await guild.channels.fetch().catch(() => {});
  const found = guild.channels.cache.filter(c => c.type === ChannelType.GuildText && musicChannelName(c.name));
  return found.size === 1 ? found.first() : null;
}
function getQueue(guildId) { return playerRef?.nodes?.get(guildId) ?? null; }
function current(queue) { return queue?.currentTrack ?? queue?.node?.currentTrack ?? null; }
function modeName(mode) {
  return mode === QueueRepeatMode.TRACK ? '🔂 Tek şarkı' :
    mode === QueueRepeatMode.QUEUE ? '🔁 Tüm liste' : 'Kapalı';
}
function button(label, id, style = ButtonStyle.Secondary, emoji) {
  const b = new ButtonBuilder().setCustomId(`${KEY}:${id}`).setLabel(label).setStyle(style);
  if (emoji) b.setEmoji(emoji);
  return b;
}
// Gercek Discord butonlari emoji-only olabilir; telefon ve PC'de kompakt gorunur.
function iconButton(id, emoji, style = ButtonStyle.Secondary, disabled = false) {
  return new ButtonBuilder()
    .setCustomId(`${KEY}:${id}`)
    .setEmoji(emoji)
    .setStyle(style)
    .setDisabled(disabled);
}
async function createUI() {
  const queue = getQueue(config.guildId);
  const track = current(queue);
  const tracks = queue?.tracks?.toArray?.() ?? [];
  const paused = !!queue?.node?.isPaused?.();
  let timestamp = null;
  try { timestamp = queue?.node?.getTimestamp?.() || null; } catch {}
  const voice = queue?.channel?.name || 'Bağlı değil';
  const card = await renderMusicCard({
    track, paused, volume: panel.volume, repeatMode: modeName(queue?.repeatMode),
    voice, tracks, timestamp, queueSize: tracks.length,
  });
  const running = Boolean(track);
  const shuffled = Boolean(queue?.isShuffling);
  const repeat = queue?.repeatMode ?? QueueRepeatMode.OFF;
  const status = !running ? 'Hazır' : paused ? 'Duraklatıldı' : 'Şimdi çalıyor';

  // Components V2 ile ikonlu araclari PNG'nin USTUNE, temel 5 kontrolu ALTINA koyuyoruz.
  const header = new SectionBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `## KRATOS MUSIC CENTER\n${status} · Ses %${panel.volume} · ${tracks.length} sıradaki şarkı`,
    ))
    .setThumbnailAccessory(new ThumbnailBuilder().setURL(`attachment://${LOGO_NAME}`));
  // Ust satir: link, ses, kuyruk ve durdur. Yenileme zamanlayiciyla otomatik yapilir.
  // Ses +10/-10, ses secim menusu uzerinden gereksiz hale geliyor.
  const tools = new ActionRowBuilder().addComponents(
    iconButton('play', '📎', ButtonStyle.Success),
    iconButton('volume', '🔊'),
    iconButton('queue', '📋'),
    iconButton('stop', '⏹️', ButtonStyle.Danger, !running),
  );
  const gallery = new MediaGalleryBuilder().addItems(
    new MediaGalleryItemBuilder().setURL(`attachment://${CARD_NAME}`)
      .setDescription(track ? clean(track.title, 95) : 'KRATOS MUSIC — Hazır'),
  );
  const playback = new ActionRowBuilder().addComponents(
    iconButton('shuffle', '🔀', shuffled ? ButtonStyle.Success : ButtonStyle.Secondary, !running),
    iconButton('previous', '⏮️', ButtonStyle.Secondary, !running),
    iconButton('pause', paused || !running ? '▶️' : '⏸️', ButtonStyle.Primary, !running),
    iconButton('skip', '⏭️', ButtonStyle.Secondary, !running),
    iconButton('loop', repeat === QueueRepeatMode.TRACK ? '🔂' : '🔁',
      repeat !== QueueRepeatMode.OFF ? ButtonStyle.Success : ButtonStyle.Secondary, !running),
  );
  const layout = new ContainerBuilder().setAccentColor(0x72adf4)
    .addSectionComponents(header)
    .addSeparatorComponents(new SeparatorBuilder())
    .addActionRowComponents(tools)
    .addMediaGalleryComponents(gallery)
    .addActionRowComponents(playback);
  return {
    flags: MessageFlags.IsComponentsV2,
    components: [layout],
    files: [new AttachmentBuilder(card, { name: CARD_NAME }), await logoFile()],
    allowedMentions: { parse: [] },
  };
}
async function updateCard(message) {
  // V2 mesaj duzenlenirken eski ekler biriktirilmez.
  const ui = await createUI();
  if (message.flags?.has?.(MessageFlags.IsComponentsV2)) {
    return message.edit({ ...ui, attachments: [] });
  }
  // Legacy embed'den V2'ye geciste onceki embed ve metni temizle.
  return message.edit({ ...ui, content: null, embeds: [], attachments: [] });
}

async function loadState() {
  try {
    const saved = JSON.parse(await readFile(DATA, 'utf8'));
    if (typeof saved.channelId === 'string') panel.channelId = saved.channelId;
    if (typeof saved.messageId === 'string') panel.messageId = saved.messageId;
    if (Number.isInteger(saved.volume) && saved.volume >= 0 && saved.volume <= 200) panel.volume = saved.volume;
  } catch (error) { if (error.code !== 'ENOENT') console.warn('[KRATOS Panel] Kayit okunamadi:', error.message); }
}
async function saveState() {
  await mkdir(path.dirname(DATA), { recursive: true });
  const temp = DATA + '.tmp';
  await writeFile(temp, JSON.stringify(panel, null, 2) + '\n', 'utf8');
  await rename(temp, DATA);
}
async function getGuild() {
  return clientRef?.guilds.cache.get(config.guildId) || await clientRef?.guilds.fetch(config.guildId).catch(() => null);
}
async function ensurePanel() {
  if (opening) return opening;
  opening = (async () => {
    const guild = await getGuild();
    if (!guild) throw new Error('Discord sunucusu bulunamadi.');
    const channel = await musicChannel(guild);
    if (!channel) throw new Error('.env MUSIC_CHANNEL_ID, #müzikçal kanalıyla eşleşmiyor.');
    const me = await guild.members.fetchMe();
    if (!channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory])) {
      throw new Error('Botun #müzikçal için Kanalı Görüntüle / Mesaj Gönder / Bağlantı Yerleştir / Mesaj Geçmişini Oku izni eksik.');
    }
    let old = null;
    if (panel.channelId === channel.id && panel.messageId) {
      old = await channel.messages.fetch(panel.messageId).catch(() => null);
      if (old?.author?.id === clientRef.user?.id) {
        try { return await updateCard(old); }
        catch (err) { console.warn('[KRATOS Panel] Eski panel V2’ye cevrilemedi; yeni mesaj denenecek:', err.message); }
      }
    }
    // V2'ye geciste eski mesaji duzenlemek Discord tarafindan reddedilirse yeni panel olustur.
    const msg = await channel.send(await createUI());
    panel.channelId = channel.id;
    panel.messageId = msg.id;
    await saveState();
    await msg.pin().catch(() => {}); // ManageMessages yoksa panel yine de calisir.
    if (old && old.id !== msg.id && old.author.id === clientRef.user.id) {
      await old.delete().catch(err => console.warn('[KRATOS Panel] Eski panel elle silinmeli:', err.message));
    }
    return msg;
  })();
  try { return await opening; } finally { opening = null; }
}
async function refreshPanel() {
  if (!ready || !panel.messageId || refreshing) return;
  refreshing = true;
  try {
    const guild = await getGuild();
    const channel = guild ? await musicChannel(guild) : null;
    if (!channel || channel.id !== panel.channelId) return;
    const msg = await channel.messages.fetch(panel.messageId).catch(() => null);
    if (msg) {
      await updateCard(msg);
      lastRefresh = Date.now();
    }
  } catch (e) { console.warn('[KRATOS Panel] Güncelleme:', e.message); }
  finally { refreshing = false; }
}
function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(async () => {
    refreshTimer = null;
    await refreshPanel();
  }, Math.max(1000, 3500 - (Date.now() - lastRefresh)));
}

async function say(interaction, message) {
  const payload = { content: message, flags: ME, allowedMentions: { parse: [] } };
  if (interaction.deferred || interaction.replied) return interaction.editReply({ content: message, allowedMentions: { parse: [] } });
  return interaction.reply(payload);
}
async function sameVoice(interaction, queue) {
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!member.voice.channelId) return 'Önce bir ses kanalına gir.';
  if (queue?.channel && queue.channel.id !== member.voice.channelId) {
    return 'Kontrol etmek için botun bulunduğu ses kanalında olmalısın.';
  }
  return null;
}
function sourceOK(raw) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  if (['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(host) || host.endsWith('.local')) return false;
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|127\.)/.test(host)) return false;
  if (parseSpotifyLink(raw)) return true;
  if (host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com')) return true;
  if (host === 'soundcloud.com' || host.endsWith('.soundcloud.com')) return true;
  if (host === 'vimeo.com' || host.endsWith('.vimeo.com')) return true;
  return MUSIC_FILE.test(u.pathname);
}
function modal(id, title, fieldId, fieldLabel, placeholder, maxLength = 400) {
  const input = new TextInputBuilder().setCustomId(fieldId).setLabel(fieldLabel)
    .setPlaceholder(placeholder).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(maxLength);
  return new ModalBuilder().setCustomId(`${KEY}:${id}`).setTitle(title)
    .addComponents(new ActionRowBuilder().addComponents(input));
}
async function onModal(interaction) {
  if (interaction.customId === `${KEY}:play_submit`) {
    const input = interaction.fields.getTextInputValue('link').trim();
    const spotify = parseSpotifyLink(input);
    const url = spotify?.url ?? input;
    if (!sourceOK(url)) return say(interaction, spotifyInput(input)
      ? 'Tam Spotify şarkı, albüm veya playlist bağlantısını open.spotify.com üzerinden kopyala. Kısa spotify.link bağlantıları desteklenmiyor.'
      : 'Spotify / YouTube / SoundCloud / Vimeo veya doğrudan HTTPS ses dosyası bağlantısı gir.');
    const member = await interaction.guild.members.fetch(interaction.user.id);
    const voice = member.voice.channel;
    if (!voice) return say(interaction, 'Önce ses kanalına katılmalısın.');
    const q = getQueue(interaction.guildId);
    const voiceError = await sameVoice(interaction, q);
    if (voiceError) return say(interaction, voiceError);
    const me = await interaction.guild.members.fetchMe();
    const permissions = voice.permissionsFor(me);
    if (!permissions?.has([PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) {
      return say(interaction, 'Botun bu ses kanalında **Bağlan** ve **Konuş** izinleri eksik.');
    }
    await interaction.deferReply({ flags: ME });
    try {
      const result = await playerRef.play(voice, url, {
        requestedBy: interaction.user,
        nodeOptions: {
          metadata: { channel: interaction.channel },
          volume: panel.volume,
          leaveOnStop: true, leaveOnStopCooldown: 0,
          leaveOnEnd: true, leaveOnEndCooldown: 30_000,
          leaveOnEmpty: true, leaveOnEmptyCooldown: 60_000,
          bufferingTimeout: 20_000, skipOnNoStream: true,
        },
      });
      getQueue(interaction.guildId)?.node?.setVolume?.(panel.volume);
      const spotifyMessage = spotify && spotifyPlayMessage(result, spotify.kind);
      await say(interaction, spotifyMessage || `✅ **${clean(result?.track?.title || 'Şarkı', 145)}** çalınıyor / sıraya eklendi.`);
      scheduleRefresh();
    } catch (err) {
      console.error('[KRATOS Panel] Çal:', err);
      await say(interaction, spotify
        ? 'Spotify bağlantısı çözümlenemedi veya şarkılar başka ses kaynaklarında bulunamadı. Liste herkese açık olmalı. Ayrıntılar terminalde.'
        : 'Bağlantı çalınamadı. Kaynak erişimi engellenmiş veya müzik akışı başarısız olabilir; terminali kontrol et.');
    }
  } else if (interaction.customId === `${KEY}:volume_submit`) {
    const raw = interaction.fields.getTextInputValue('percent').trim();
    if (!/^\d{1,3}$/.test(raw) || Number(raw) > 200) return say(interaction, '0 ile 200 arasında bir tam sayı gir.');
    const q = getQueue(interaction.guildId);
    if (q && (await sameVoice(interaction, q))) return say(interaction, 'Sesi değiştirmek için botla aynı ses kanalına gir.');
    panel.volume = Number(raw);
    if (q) q.node.setVolume(panel.volume);
    await saveState();
    scheduleRefresh();
    return say(interaction, `🔊 Ses seviyesi **%${panel.volume}** olarak ayarlandı.`);
  }
}
async function onButton(interaction) {
  const action = interaction.customId.slice(`${KEY}:`.length);
  const q = getQueue(interaction.guildId);
  if (action === 'play') {
    const member = await interaction.guild.members.fetch(interaction.user.id);
    if (!member.voice.channelId) return say(interaction, 'Önce ses kanalına katıl, sonra **Çal** butonuna bas.');
    if (q && (await sameVoice(interaction, q))) return say(interaction, 'Botun bulunduğu ses kanalına gir.');
    return interaction.showModal(modal('play_submit', 'KRATOS | Şarkı Çal', 'link', 'Spotify / YouTube / SoundCloud linki', 'https://open.spotify.com/track/...', 500));
  }
  if (action === 'volume') {
    if (q && (await sameVoice(interaction, q))) return say(interaction, 'Botun bulunduğu ses kanalına gir.');
    return interaction.reply({
      content: '🔊 **Ses seviyesini seç (0–200)**\nBir değer seç veya ✏️ ile tam sayı gir. %100 üstü ses bozulmaya neden olabilir.',
      components: [new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId(`${KEY}:volume_select`)
          .setPlaceholder(`Ses: %${panel.volume} — bir değer seç`)
          .addOptions([0,25,50,75,100,125,150,175,200].map(v => ({ label: `%${v}`, value: String(v) }))),
      ), new ActionRowBuilder().addComponents(
        iconButton('volume_exact', '✏️'),
      )],
      flags: ME,
    });
  }
  if (action === 'volume_exact') {
    return interaction.showModal(modal('volume_submit', 'KRATOS | Ses Seviyesi', 'percent', 'Ses seviyesi (0–200)', String(panel.volume), 3));
  }
  if (action === 'vol_down' || action === 'vol_up') {
    if (q && (await sameVoice(interaction, q))) return say(interaction, 'Sesi değiştirmek için botla aynı ses kanalında olmalısın.');
    panel.volume = Math.max(0, Math.min(200, panel.volume + (action === 'vol_up' ? 10 : -10)));
    if (q) q.node.setVolume(panel.volume);
    await saveState();
    scheduleRefresh();
    return say(interaction, `🔊 Ses: **%${panel.volume}**`);
  }
  if (action === 'refresh') {
    await interaction.deferReply({ flags: ME });
    await refreshPanel();
    return say(interaction, '🔄 Panel yenilendi.');
  }
  if (action === 'queue') {
    const tracks = q?.tracks?.toArray?.() ?? [];
    const next = tracks.slice(0, 15).map((t, i) => `${i + 1}. ${clean(t.title, 85)}`);
    return say(interaction, [
      `🎶 **Çalan:** ${clean(current(q)?.title || 'Yok', 130)}`,
      next.length ? `**Sıradakiler:**\n${next.join('\n')}` : '*Kuyruk boş.*',
      tracks.length > 15 ? `*+${tracks.length - 15} şarkı daha*` : '',
    ].filter(Boolean).join('\n'));
  }
  if (!q || !current(q)) return say(interaction, 'Henüz şarkı çalmıyor. **Çal** butonundan şarkı başlat.');
  const vErr = await sameVoice(interaction, q);
  if (vErr) return say(interaction, vErr);
  await interaction.deferReply({ flags: ME });
  let answer = '';
  if (action === 'pause') {
    const paused = q.node.isPaused();
    q.node.setPaused(!paused);
    answer = paused ? '▶️ Çalma devam ediyor.' : '⏸️ Müzik duraklatıldı.';
  } else if (action === 'stop') {
    q.delete();
    answer = '⏹️ Müzik durduruldu. Kuyruk temizlendi.';
  } else if (action === 'previous') {
    // Discord Player 7, onceki sarkilari GuildQueueHistory icinde saklar.
    // Gecmiste sarki yoksa yeni oynatma baslatmayiz.
    if (!q.history?.previousTrack) {
      answer = '⏮️ Henüz geri dönülecek bir şarkı yok.';
    } else {
      try {
        await q.history.previous(true);
        answer = '⏮️ Önceki şarkıya dönüldü.';
      } catch (err) {
        console.error('[KRATOS Panel] Önceki şarkı:', err);
        answer = 'Önceki şarkı açılamadı. Oynatma geçmişini kontrol et.';
      }
    }
  } else if (action === 'back10' || action === 'forward10') {
    const stamp = q.node.getTimestamp?.();
    const elapsed = Number(stamp?.current?.value);
    const duration = Number(stamp?.total?.value);
    if (!Number.isFinite(elapsed) || !Number.isFinite(duration) || duration <= 0) {
      answer = 'Bu şarkının süre bilgisi yok; ileri/geri sarma kullanılamıyor.';
    } else {
      const delta = action === 'forward10' ? 10_000 : -10_000;
      const target = Math.max(0, Math.min(Math.max(0, duration - 1000), elapsed + delta));
      try {
        const ok = await q.node.seek(target);
        answer = ok ? `${action === 'forward10' ? '⏩' : '⏪'} ${Math.floor(target / 60000)}:${String(Math.floor(target / 1000) % 60).padStart(2, '0')} konumuna sarıldı.`
          : 'Kaynak bu şarkıda ileri/geri sarmayı desteklemiyor.';
      } catch (err) {
        console.error('[KRATOS Panel] Seek:', err);
        answer = 'Kaynak bu şarkıda ileri/geri sarmayı desteklemiyor.';
      }
    }
  } else if (action === 'skip') {
    if (q.repeatMode === QueueRepeatMode.TRACK) q.setRepeatMode(QueueRepeatMode.OFF);
    answer = q.node.skip() ? '⏭️ Sonraki şarkıya geçildi.' : 'Atlanacak şarkı bulunamadı.';
  } else if (action === 'loop') {
    const next = q.repeatMode === QueueRepeatMode.OFF ? QueueRepeatMode.QUEUE :
      q.repeatMode === QueueRepeatMode.QUEUE ? QueueRepeatMode.TRACK : QueueRepeatMode.OFF;
    q.setRepeatMode(next);
    answer = `🔁 Döngü modu: **${modeName(next)}**`;
  } else if (action === 'shuffle') {
    // Dynamic shuffle durumu panelin yesil kontrol tusunda gosterilir.
    if (q.isShuffling) {
      q.disableShuffle();
      answer = '🔀 Karışık çalma kapatıldı.';
    } else if (q.tracks.size < 2) {
      answer = 'Karışık çalma için sırada en az iki şarkı olmalı.';
    } else {
      q.enableShuffle(true);
      answer = '🔀 Karışık çalma açıldı.';
    }
  } else {
    answer = 'Bilinmeyen müzik işlemi.';
  }
  scheduleRefresh();
  return say(interaction, answer);
}
async function onInteraction(interaction) {
  if (interaction.guildId !== config.guildId) return;
  if (interaction.isChatInputCommand() && interaction.commandName === 'muzikpanel') {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await say(interaction, 'Bu işlem için Sunucuyu Yönet yetkisi gerekiyor.');
      return;
    }
    await interaction.deferReply({ flags: ME });
    try {
      const msg = await ensurePanel();
      await say(interaction, `✅ Tek müzik paneli hazır: <#${msg.channelId}>. Mesajı yenilemek için bu komutu yeniden kullanabilirsin.`);
    } catch (err) {
      await say(interaction, `Panel açılamadı: ${clean(err.message, 400)}`);
    }
    return;
  }
  if (!(interaction.isButton() || interaction.isModalSubmit() || interaction.isStringSelectMenu()) || !interaction.customId.startsWith(`${KEY}:`)) return;
  // Panelin baska kanaldaki veya eski kopyasindaki butonlarini kabul etmiyoruz.
  if (!ready || interaction.channelId !== panel.channelId ||
      (interaction.isButton() && interaction.customId !== `${KEY}:volume_exact` && interaction.message.id !== panel.messageId)) {
    await say(interaction, 'Bu eski veya yanlış kanaldaki panel. Güncel #müzikçal paneline geç.');
    return;
  }
  try {
    if (interaction.isModalSubmit()) await onModal(interaction);
    else if (interaction.isStringSelectMenu() && interaction.customId === `${KEY}:volume_select`) {
      const q = getQueue(interaction.guildId);
      const voiceError = q ? await sameVoice(interaction, q) : null;
      if (voiceError) return say(interaction, voiceError);
      const value = Number(interaction.values[0]);
      if (!Number.isInteger(value) || value < 0 || value > 200) return say(interaction, 'Geçersiz ses değeri.');
      panel.volume = value;
      if (q) q.node.setVolume(value);
      await saveState();
      scheduleRefresh();
      await interaction.update({ content: `🔊 Ses seviyesi **%${value}** olarak ayarlandı.`, components: [] });
    }
    else await onButton(interaction);
  } catch (err) {
    console.error('[KRATOS Panel] Etkileşim hatası:', err);
    await say(interaction, 'İşlem sırasında hata oluştu. Cursor terminalini kontrol et.').catch(() => {});
  }
}

export function setupMusicPanel(client, player) {
  playerRef = player;
  clientRef = client;
  client.once(Events.ClientReady, async () => {
    await loadState();
    ready = true;
    try {
      await ensurePanel();
      console.log('[KRATOS Panel] #müzikçal kontrol paneli hazır.');
    } catch (err) { console.warn('[KRATOS Panel] Panel kurulamadı, /muzikpanel ile deneyebilirsin:', err.message); }
  });
  client.on(Events.InteractionCreate, interaction => { onInteraction(interaction).catch(e => console.error('[KRATOS Panel]', e)); });
  // Ilerleme cubugu icin 10 saniyede bir yenile (bosken bosuna API istegi yok).
  const clock = setInterval(() => { const q = getQueue(config.guildId); if (current(q) && !q?.node?.isPaused?.()) scheduleRefresh(); }, 10_000);
  clock.unref?.();
  for (const event of ['playerStart', 'audioTrackAdd', 'audioTracksAdd', 'playerFinish', 'emptyQueue', 'disconnect', 'playerSkip', 'playerPause', 'playerResume']) {
    player.events.on(event, scheduleRefresh);
  }
}
