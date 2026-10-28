// KRATOS v0.9 — Muzik modulu. Kayit, log ve moderasyonla bagimsiz calisir.
// Kaynaklar: Discord Player 7 + @discord-player/extractor 7.
import { MessageFlags, ChannelType, PermissionFlagsBits } from 'discord.js';
import { Player, QueueRepeatMode } from 'discord-player';
import { DefaultExtractors } from '@discord-player/extractor';
import { setupMusicPanel } from './music-panel.js';
import { parseSpotifyLink, spotifyInput, spotifyPlayMessage } from './spotify-links.js';

const MUSIC_COMMANDS = new Set([
  'play', 'stop', 'skip', 'dongu', 'kuyruk', 'duraklat', 'devam', 'calan', 'karistir',
]);
const PRIVATE = MessageFlags.Ephemeral;
const AUDIO_FILE = /\.(mp3|m4a|ogg|opus|wav|aac|flac)(?:\?.*)?$/i;
let player;
let youtubeReady = false;

function isYouTubeLink(raw) {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' &&
      (host === 'youtu.be' || host === 'www.youtu.be' ||
       host === 'youtube.com' || host.endsWith('.youtube.com'));
  } catch { return false; }
}

function normalized(name) {
  return String(name ?? '').toLocaleLowerCase('tr-TR')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[\s_-]/g, '').replaceAll('ı','i');
}

function findMusicChannel(guild, config) {
  if (config.musicChannelId) {
    const c = guild.channels.cache.get(config.musicChannelId);
    return c?.type === ChannelType.GuildText ? c : null;
  }
  // .env MUSIC_CHANNEL_ID verilmediyse kanal ismiyle bul. Ayni isimden iki
  // kanal varsa guvenlik icin rastgele birini secmek yerine ayar iste.
  const matches = guild.channels.cache.filter(ch => ch.type === ChannelType.GuildText && normalized(ch.name) === 'muzikcal');
  return matches.size === 1 ? matches.first() : null;
}

function withoutMentions(content) {
  return { content, allowedMentions: { parse: [] } };
}

async function refuseWrongChannel(interaction, channel) {
  const where = channel ? `<#${channel.id}>` : '`#müzikçal`';
  await interaction.reply({
    ...withoutMentions(`🎵 Müzik komutları yalnızca ${where} kanalında kullanılabilir. Lütfen oraya geç.`),
    flags: PRIVATE,
  });
  // Slash komutu kullanici mesaji degildir. Sadece botun ozel uyarisi silinir.
  setTimeout(() => { interaction.deleteReply().catch(() => {}); }, 10_000);
}

async function voiceMember(interaction) {
  return interaction.guild.members.fetch(interaction.user.id);
}

function currentQueue(interaction) {
  return player?.nodes?.get(interaction.guildId) ?? null;
}

function getCurrent(queue) {
  return queue?.currentTrack ?? queue?.node?.currentTrack ?? null;
}

function label(track) {
  if (!track) return 'Bilinmeyen parça';
  const name = String(track.title || 'Adsız parça').replaceAll('`', '').slice(0, 90);
  return `**${name}**${track.duration && track.duration !== '00:00' ? ` (${track.duration})` : ''}`;
}

function playableURL(raw) {
  let url;
  try { url = new URL(raw); } catch { return false; }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  // HTTP URL girisi icin bilinen oynatilabilir kaynaklara izin veriyoruz.
  if (isYouTubeLink(raw)) return true;
  if (parseSpotifyLink(raw)) return true;
  if (host === 'soundcloud.com' || host.endsWith('.soundcloud.com')) return true;
  if (host === 'vimeo.com' || host.endsWith('.vimeo.com')) return true;
  if (!AUDIO_FILE.test(url.pathname + url.search)) return false;
  if (['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(host)) return false;
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|127\.)/.test(host)) return false;
  return true;
}

function voiceAccess(member, bot, voice) {
  const perms = voice.permissionsFor(bot);
  if (!perms?.has(PermissionFlagsBits.Connect)) return 'Botun ses kanalina **Baglan** izni yok.';
  if (!perms?.has(PermissionFlagsBits.Speak)) return 'Botun ses kanalinda **Konus** izni yok.';
  return null;
}

async function handlePlay(interaction, channel) {
  const member = await voiceMember(interaction);
  const voice = member.voice.channel;
  if (!voice) {
    await interaction.reply({ ...withoutMentions('Önce bir ses kanalına katılmalısın.'), flags: PRIVATE });
    return;
  }
  if (!voice.joinable || !voice.speakable) {
    const bot = await interaction.guild.members.fetchMe();
    await interaction.reply({ ...withoutMentions(voiceAccess(member, bot, voice) || 'Bu ses kanalına bağlanamıyorum.'), flags: PRIVATE });
    return;
  }
  const existing = currentQueue(interaction);
  if (existing?.channel && existing.channel.id !== voice.id) {
    await interaction.reply({ ...withoutMentions('Müzik başka bir ses kanalında çalışıyor. Önce o kanala katıl.'), flags: PRIVATE });
    return;
  }
  const input = interaction.options.getString('link', true).trim();
  const spotify = parseSpotifyLink(input);
  const url = spotify?.url ?? input;
  if (isYouTubeLink(url) && !youtubeReady) {
    await interaction.reply({
      ...withoutMentions('YouTube eklentisi etkin değil. Cursor terminalinde kurulum hatası var mı kontrol et; `/play` için şimdilik SoundCloud/Vimeo bağlantısı kullanabilirsin.'),
      flags: PRIVATE,
    });
    return;
  }
  if (!playableURL(url)) {
    await interaction.reply({ ...withoutMentions(spotifyInput(input)
      ? 'Spotify için open.spotify.com üzerinden tam **şarkı, albüm veya playlist** bağlantısını kopyala. Kısa spotify.link adresleri desteklenmiyor.'
      : 'Spotify / YouTube / SoundCloud / Vimeo bağlantısı veya doğrudan ses dosyası URL’si gönder.'), flags: PRIVATE });
    return;
  }
  await interaction.deferReply();
  try {
    const result = await player.play(voice, url, {
      nodeOptions: {
        metadata: { channel },
        leaveOnStop: true,
        leaveOnStopCooldown: 0,
        leaveOnEnd: true,
        leaveOnEndCooldown: 30_000,
        leaveOnEmpty: true,
        leaveOnEmptyCooldown: 60_000,
        bufferingTimeout: 20_000,
        skipOnNoStream: true,
        volume: 65,
      },
      requestedBy: interaction.user,
    });
    const message = spotify && spotifyPlayMessage(result, spotify.kind);
    await interaction.editReply(withoutMentions(message || `🎵 ${label(result?.track)} sıraya eklendi. İsteyen: ${interaction.user.displayName ?? interaction.user.username}`));
  } catch (error) {
    console.error('[KRATOS Muzik Play]', error);
    await interaction.editReply(withoutMentions(spotify
      ? 'Spotify bağlantısı okunamadı veya eşleştirilecek çalınabilir şarkı bulunamadı. Liste herkese açık olmalı; ayrıntılar Cursor terminalinde.'
      : 'Bağlantı çalınamadı. YouTube erişimi engellemiş olabilir veya ses kaynağı yayınlanamıyor. Ayrıntılar Cursor terminalinde.'));
  }
}

async function requireSameVoice(interaction, queue) {
  const member = await voiceMember(interaction);
  const botChannel = queue?.channel;
  if (!member.voice.channelId || !botChannel || member.voice.channelId !== botChannel.id) {
    await interaction.reply({ ...withoutMentions('Müziği yönetmek için botla **aynı ses kanalında** olmalısın.'), flags: PRIVATE });
    return false;
  }
  return true;
}

export async function initMusic(client) {
  player = new Player(client);
  const report = await player.extractors.loadMulti(DefaultExtractors);
  console.log('[KRATOS Spotify] Resmi Spotify metadata extractor yuklendi (stream bridge ile).');
  if (report?.error) console.warn('[KRATOS Muzik] Bazı extractorler yüklenemedi:', report.error);
  // YouTube, Discord Player 7'nin resmi extractor paketinde yok.
  // Topluluk eklentisi kuruluysa ve kaydedilebiliyorsa deneysel olarak etkinleştir.
  try {
    const mod = await import('discord-player-youtubei');
    const YoutubeExtractor = mod.YoutubeExtractor ?? mod.YoutubeiExtractor;
    if (!YoutubeExtractor) throw new Error('YouTube extractor export bulunamadı.');
    await player.extractors.register(YoutubeExtractor, {});
    youtubeReady = true;
    console.log('[KRATOS Muzik] Deneysel YouTube extractor kaydedildi.');
  } catch (error) {
    console.warn('[KRATOS Muzik] YouTube eklentisi kullanılamıyor:', error?.message ?? error);
    console.warn('[KRATOS Muzik] SoundCloud, Vimeo ve ses dosyaları çalışmaya devam edecek.');
  }
  player.events.on('error', (queue, err) => console.error('[KRATOS Muzik Kuyruk]', err));
  player.events.on('playerError', (queue, err) => console.error('[KRATOS Muzik Oynatici]', err));
  setupMusicPanel(client, player);
  console.log('KRATOS muzik modulu hazir.');
}

export async function handleMusicCommand(interaction, config) {
  if (!interaction.isChatInputCommand() || !MUSIC_COMMANDS.has(interaction.commandName)) return false;
  try {
    const channel = findMusicChannel(interaction.guild, config);
    if (!channel || channel.id !== interaction.channelId) {
      await refuseWrongChannel(interaction, channel);
      return true;
    }
    const command = interaction.commandName;
    if (command === 'play') {
      await handlePlay(interaction, channel);
      return true;
    }
    const queue = currentQueue(interaction);
    if (!queue || !getCurrent(queue)) {
      await interaction.reply({ ...withoutMentions('Şu anda çalan şarkı yok. Önce `/play` kullan.'), flags: PRIVATE });
      return true;
    }
    if (command === 'kuyruk' || command === 'calan') {
      const current = label(getCurrent(queue));
      const items = queue.tracks.toArray();
      const lines = command === 'calan' ? [] : items.slice(0, 10).map((t, i) => `${i+1}. ${label(t)}`);
      await interaction.reply(withoutMentions([
        `🎶 **Şimdi çalıyor:** ${current}`,
        ...(command === 'calan' ? [] : [lines.length ? '**Sırada:**\n' + lines.join('\n') : '*Sırada başka şarkı yok.*', items.length > 10 ? `+${items.length - 10} şarkı daha` : '']),
      ].filter(Boolean).join('\n')));
      return true;
    }
    if (!await requireSameVoice(interaction, queue)) return true;
    if (command === 'stop') {
      queue.delete();
      await interaction.reply(withoutMentions('⏹️ Müzik durduruldu, sıra temizlendi; bot ses kanalından ayrılıyor.'));
    } else if (command === 'skip') {
      const trackLoop = queue.repeatMode === QueueRepeatMode.TRACK;
      if (trackLoop) queue.setRepeatMode(QueueRepeatMode.OFF);
      const skipped = queue.node.skip();
      await interaction.reply(withoutMentions(skipped ? '⏭️ Şarkı atlandı.' + (trackLoop ? ' Tek şarkı döngüsü kapatıldı.' : '') : 'Atlanabilecek şarkı bulunamadı.'));
    } else if (command === 'dongu') {
      const mode = interaction.options.getString('mod') || 'liste';
      const modes = { liste: QueueRepeatMode.QUEUE, sarki: QueueRepeatMode.TRACK, kapali: QueueRepeatMode.OFF };
      queue.setRepeatMode(modes[mode]);
      const names = { liste: '🔁 Tüm sıra döngüde', sarki: '🔂 Tek şarkı döngüde', kapali: '➡️ Döngü kapatıldı' };
      await interaction.reply(withoutMentions(names[mode]));
    } else if (command === 'duraklat') {
      await interaction.reply(withoutMentions(queue.node.pause() ? '⏸️ Müzik duraklatıldı.' : 'Zaten duraklatılmış veya çalmıyor.'));
    } else if (command === 'devam') {
      await interaction.reply(withoutMentions(queue.node.resume() ? '▶️ Müzik devam ediyor.' : 'Müzik duraklatılmış değil.'));
    } else if (command === 'karistir') {
      if (queue.tracks.size < 2) {
        await interaction.reply({ ...withoutMentions('Karıştırmak için sırada en az 2 şarkı olmalı.'), flags: PRIVATE });
      } else {
        queue.tracks.shuffle();
        await interaction.reply(withoutMentions('🔀 Bekleyen şarkılar karıştırıldı.'));
      }
    }
  } catch (error) {
    console.error('[KRATOS Muzik Komut]', error);
    const message = withoutMentions('Müzik komutunda bir hata oluştu. Cursor terminalindeki hata mesajını kontrol et.');
    if (interaction.deferred || interaction.replied) await interaction.editReply(message).catch(() => {});
    else await interaction.reply({ ...message, flags: PRIVATE }).catch(() => {});
  }
  return true;
}
