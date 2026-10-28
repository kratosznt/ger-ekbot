import {
  AuditLogEvent,
  ChannelType,
  EmbedBuilder,
  Events,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';

/**
 * KRATOS v0.8 — mevcut kanalları ismine göre bulan, yeni kategori/kanal oluşturmayan log sistemi.
 * Bu modül token, başka bot ve kayıt akışına dokunmaz. Yalnızca config.guildId izlenir.
 */
export const LOG_CHANNELS = Object.freeze({
  member: 'giriş-çıkış-log',
  kick: 'kick-log',
  ban: 'ban-log',
  timeout: 'timeout-log',
  voice: 'voice-log',
  rename: 'rename-log',
  message: 'message-log',
  role: 'role-log',
  server: 'server-log',
});

const P = PermissionFlagsBits;
const recentMod = new Map(); // GuildAuditLogEntryCreate ile memberRemove yarışmasını önler.
const TERMINAL_PREFIX = '[KRATOS LOG]';
const CUT = (value, max = 900) => {
  const s = String(value ?? '').replaceAll('\u0000', '').replaceAll('```', "''' ");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const who = user => user ? `<@${user.id}> (\`${user.id}\`)` : 'Bilinmiyor';
const stamp = timestamp => `<t:${Math.floor((timestamp || Date.now()) / 1000)}:f>`;
const contains = (guild, config) => guild?.id === config.guildId;
const norm = value => String(value ?? '').toLocaleLowerCase('tr-TR');

function isLogName(channel) {
  return !!channel && Object.values(LOG_CHANNELS).some(name => norm(channel.name) === norm(name));
}
function channelMatches(guild, key) {
  const desired = LOG_CHANNELS[key];
  return guild.channels.cache.filter(c => c.type === ChannelType.GuildText && norm(c.name) === norm(desired));
}
function logChannel(guild, key) {
  const matches = channelMatches(guild, key);
  // Birden fazla aynı isimli kanal varsa yanlış kanala log göndermemek için dur.
  return matches.size === 1 ? matches.first() : null;
}
function embed(title, lines, color = 0x80aaff) {
  return new EmbedBuilder().setTitle(CUT(title, 250))
    .setDescription(CUT(lines.filter(Boolean).join('\n'), 3900))
    .setColor(color).setTimestamp();
}
async function emit(guild, key, title, lines, color) {
  if (!guild) return;
  const channel = logChannel(guild, key);
  if (!channel) return;
  const me = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
  if (!me || !channel.permissionsFor(me)?.has([P.ViewChannel, P.SendMessages, P.EmbedLinks])) return;
  try {
    await channel.send({ embeds: [embed(title, lines, color)], allowedMentions: { parse: [] } });
  } catch (error) {
    console.error(`${TERMINAL_PREFIX} ${LOG_CHANNELS[key]} mesaj gönderilemedi:`, error);
  }
}
function guard(label, handler) {
  return (...args) => { Promise.resolve().then(() => handler(...args)).catch(error => {
    console.error(`${TERMINAL_PREFIX} ${label}:`, error);
  }); };
}
function noteMod(guildId, userId, action) {
  recentMod.set(`${guildId}:${userId}`, { action, at: Date.now() });
  // Hafızadaki eskimiş kayıtları küçük tut.
  if (recentMod.size > 300) {
    for (const [key, item] of recentMod) if (Date.now() - item.at > 30_000) recentMod.delete(key);
  }
}
function knownMod(guildId, userId) {
  const item = recentMod.get(`${guildId}:${userId}`);
  return item && Date.now() - item.at < 12_000 ? item.action : null;
}
async function auditRemovalType(guild, userId) {
  if (!guild.members.me?.permissions.has(P.ViewAuditLog)) return null;
  // Zamanlamalar değişebileceğinden yalnızca aynı hedefe ait çok yeni kayıtlar geçerlidir.
  for (const action of [AuditLogEvent.MemberKick, AuditLogEvent.MemberBanAdd]) {
    const logs = await guild.fetchAuditLogs({ type: action, limit: 6 }).catch(() => null);
    if (logs?.entries.some(entry => entry.targetId === userId && Date.now() - entry.createdTimestamp < 12_000)) {
      return action === AuditLogEvent.MemberKick ? 'kick' : 'ban';
    }
  }
  return null;
}

export function setupLogs(client, config) {
  client.once(Events.ClientReady, guard('başlatma', async () => {
    const guild = await client.guilds.fetch(config.guildId).catch(() => null);
    if (!guild) { console.warn(`${TERMINAL_PREFIX} İzlenecek sunucuya erişilemiyor.`); return; }
    console.log(`${TERMINAL_PREFIX} Dokuz log türü izleniyor. Sunucuda /logkontrol yaz.`);
  }));

  // Giriş ve çıkış. Atılma/ban olayları çıkış gibi yanlış gösterilmesin.
  client.on(Events.GuildMemberAdd, guard('giriş', async member => {
    if (!contains(member.guild, config)) return;
    await emit(member.guild, 'member', '📥 Üye sunucuya katıldı', [
      `**Üye:** ${who(member.user)}`,
      `**Hesap açılışı:** ${stamp(member.user.createdTimestamp)}`,
      `**Sunucu üye sayısı:** ${member.guild.memberCount}`,
    ], 0x2ecc71);
  }));

  client.on(Events.GuildMemberRemove, guard('çıkış', async member => {
    if (!contains(member.guild, config)) return;
    // Discord kick/ban audit olayları memberRemove'dan biraz sonra gelebilir.
    await new Promise(resolve => setTimeout(resolve, 4500));
    const mod = knownMod(member.guild.id, member.id) ?? await auditRemovalType(member.guild, member.id);
    if (mod === 'kick' || mod === 'ban') return;
    await emit(member.guild, 'member', '📤 Üye sunucudan ayrıldı', [
      `**Üye:** ${who(member.user)}`,
      `**Önceki takma adı:** ${CUT(member.nickname ?? member.user?.username ?? 'Bilinmiyor', 120)}`,
      '**Not:** Audit log erişimi yoksa atılma olayı ayrılma gibi görünebilir.',
    ], 0xe67e22);
  }));

  // Audit kayıtları: gerçek yönetim işlemi ve işlemi yapan kişi.
  client.on(Events.GuildAuditLogEntryCreate, guard('audit', async (entry, guild) => {
    if (!contains(guild, config)) return;
    const target = entry.targetId ? `<@${entry.targetId}> (\`${entry.targetId}\`)` : 'Bilinmiyor';
    const actor = entry.executorId ? `<@${entry.executorId}> (\`${entry.executorId}\`)` : 'Bilinmiyor';
    const reason = entry.reason ? CUT(entry.reason) : 'Belirtilmedi';
    if (entry.action === AuditLogEvent.MemberKick) {
      if (entry.targetId) noteMod(guild.id, entry.targetId, 'kick');
      await emit(guild, 'kick', '👢 Üye sunucudan atıldı', [
        `**Üye:** ${target}`, `**Yetkili:** ${actor}`, `**Sebep:** ${reason}`,
      ], 0xe67e22);
    } else if (entry.action === AuditLogEvent.MemberBanAdd) {
      if (entry.targetId) noteMod(guild.id, entry.targetId, 'ban');
      await emit(guild, 'ban', '🔨 Üye yasaklandı', [
        `**Üye:** ${target}`, `**Yetkili:** ${actor}`, `**Sebep:** ${reason}`,
      ], 0xe74c3c);
    } else if (entry.action === AuditLogEvent.MemberBanRemove) {
      await emit(guild, 'ban', '✅ Üyenin yasağı kaldırıldı', [
        `**Üye:** ${target}`, `**Yetkili:** ${actor}`, `**Sebep:** ${reason}`,
      ], 0x2ecc71);
    }
  }));

  client.on(Events.GuildMemberUpdate, guard('üye değişimi', async (before, after) => {
    if (!contains(after.guild, config)) return;
    if (before.nickname !== after.nickname) {
      await emit(after.guild, 'rename', '✏️ Sunucu takma adı değişti', [
        `**Üye:** ${who(after.user)}`,
        `**Önce:** ${CUT(before.nickname ?? before.user?.username ?? 'Yok')}`,
        `**Sonra:** ${CUT(after.nickname ?? after.user?.username ?? 'Yok')}`,
      ]);
    }
    const gained = after.roles.cache.filter(role => !before.roles.cache.has(role.id) && role.id !== after.guild.id);
    const lost = before.roles.cache.filter(role => !after.roles.cache.has(role.id) && role.id !== after.guild.id);
    if (gained.size || lost.size) {
      await emit(after.guild, 'role', '🎭 Üye rolleri değişti', [
        `**Üye:** ${who(after.user)}`,
        gained.size ? `**Verilen:** ${CUT(gained.map(role => role.name).join(', '))}` : null,
        lost.size ? `**Alınan:** ${CUT(lost.map(role => role.name).join(', '))}` : null,
      ]);
    }
    const oldUntil = before.communicationDisabledUntilTimestamp ?? 0;
    const newUntil = after.communicationDisabledUntilTimestamp ?? 0;
    if (oldUntil !== newUntil) {
      const active = newUntil > Date.now();
      await emit(after.guild, 'timeout', active ? '🔇 Üye zaman aşımına alındı' : '🔊 Zaman aşımı kaldırıldı', [
        `**Üye:** ${who(after.user)}`,
        active ? `**Bitiş:** ${stamp(newUntil)}` : '**Durum:** Susturma kaldırıldı veya süresi doldu',
      ], active ? 0xe67e22 : 0x2ecc71);
    }
  }));

  client.on(Events.VoiceStateUpdate, guard('ses', async (before, after) => {
    const guild = after.guild ?? before.guild;
    if (!contains(guild, config)) return;
    const user = after.member?.user ?? before.member?.user;
    const target = who(user) || `<@${after.id}>`;
    const oldChannel = before.channel?.name ?? 'Ses kanalı';
    const newChannel = after.channel?.name ?? 'Ses kanalı';
    let title = null, details = [];
    if (!before.channelId && after.channelId) {
      title = '🔊 Ses kanalına katıldı'; details = [`**Kanal:** ${CUT(newChannel)}`];
    } else if (before.channelId && !after.channelId) {
      title = '🔇 Ses kanalından ayrıldı'; details = [`**Kanal:** ${CUT(oldChannel)}`];
    } else if (before.channelId !== after.channelId) {
      title = '🔀 Ses kanalı değiştirdi'; details = [`**Önce:** ${CUT(oldChannel)}`, `**Sonra:** ${CUT(newChannel)}`];
    } else if (before.serverMute !== after.serverMute || before.serverDeaf !== after.serverDeaf) {
      title = '🎙️ Sunucu ses durumu değişti';
      if (before.serverMute !== after.serverMute) details.push(`**Sunucu susturması:** ${after.serverMute ? 'Açıldı' : 'Kapatıldı'}`);
      if (before.serverDeaf !== after.serverDeaf) details.push(`**Sunucu sağırlaştırması:** ${after.serverDeaf ? 'Açıldı' : 'Kapatıldı'}`);
    }
    if (title) await emit(guild, 'voice', title, [`**Üye:** ${target}`, ...details]);
  }));

  // Mesajın silinmiş içeriklerini sadece Discord botuna iletmişse görebiliriz.
  // Kanal/cache geçmişi yoksa içerik uydurmayız.
  client.on(Events.MessageDelete, guard('mesaj silme', async message => {
    if (!message.guild || !contains(message.guild, config) || isLogName(message.channel)) return;
    if (message.author?.bot) return;
    await emit(message.guild, 'message', '🗑️ Mesaj silindi', [
      `**Gönderen:** ${who(message.author)}`,
      `**Kanal:** <#${message.channelId}>`,
      `**Mesaj ID:** \`${message.id}\``,
      `**İçerik:** ${message.partial || message.content == null ? '(Önbellekte yok / içerik alınamadı)' : CUT(message.content || '(Yazı yok)')}`,
      message.attachments?.size ? `**Ek sayısı:** ${message.attachments.size}` : null,
    ], 0xe74c3c);
  }));

  client.on(Events.MessageDeleteBulk, guard('toplu silme', async (messages, channel) => {
    const guild = channel.guild;
    if (!contains(guild, config) || isLogName(channel)) return;
    await emit(guild, 'message', '🧹 Toplu mesaj silme', [
      `**Kanal:** <#${channel.id}>`,
      `**Silinen mesaj sayısı:** ${messages.size}`,
      '**Not:** Çoklu silmede eski mesaj içerikleri her zaman erişilebilir değildir.',
    ], 0xe74c3c);
  }));

  client.on(Events.MessageUpdate, guard('mesaj düzenleme', async (before, after) => {
    if (!after.guild || !contains(after.guild, config) || isLogName(after.channel)) return;
    if (after.author?.bot) return;
    if (before.content === after.content) return;
    // Edit olayında sadece embed yüklenmesi gibi değişimler de gelebilir.
    if (typeof before.content !== 'string' || typeof after.content !== 'string') return;
    await emit(after.guild, 'message', '📝 Mesaj düzenlendi', [
      `**Gönderen:** ${who(after.author)}`,
      `**Kanal:** <#${after.channelId}>`,
      `**Önce:** ${CUT(before.content || '(boş)')}`,
      `**Sonra:** ${CUT(after.content || '(boş)')}`,
      after.url ? `**Mesaj:** [Git](${after.url})` : null,
    ]);
  }));

  for (const [event, title] of [
    [Events.RoleCreate, '➕ Rol oluşturuldu'],
    [Events.RoleDelete, '➖ Rol silindi'],
  ]) {
    client.on(event, guard('rol yapılandırması', async role => {
      if (!contains(role.guild, config)) return;
      await emit(role.guild, 'role', title, [
        `**Rol:** ${CUT(role.name, 120)}`,
        `**ID:** \`${role.id}\``,
      ]);
    }));
  }
  client.on(Events.RoleUpdate, guard('rol düzenleme', async (oldRole, role) => {
    if (!contains(role.guild, config)) return;
    const lines = [`**Rol:** ${CUT(role.name, 120)} (\`${role.id}\`)`];
    if (oldRole.name !== role.name) lines.push(`**İsim:** ${CUT(oldRole.name, 90)} → ${CUT(role.name, 90)}`);
    if (oldRole.permissions.bitfield !== role.permissions.bitfield) lines.push('**Yetkileri:** Değişti');
    if (oldRole.color !== role.color) lines.push('**Renk:** Değişti');
    if (oldRole.hoist !== role.hoist) lines.push(`**Ayrı göster:** ${role.hoist ? 'Evet' : 'Hayır'}`);
    if (lines.length > 1) await emit(role.guild, 'role', '⚙️ Rol düzenlendi', lines);
  }));

  for (const [event, title] of [
    [Events.ChannelCreate, '📁 Kanal oluşturuldu'],
    [Events.ChannelDelete, '🗑️ Kanal silindi'],
  ]) {
    client.on(event, guard('kanal değişimi', async channel => {
      if (!contains(channel.guild, config)) return;
      // Log kanalı silinirse raporlama kendi kendine döngü üretmesin.
      if (isLogName(channel)) return;
      await emit(channel.guild, 'server', title, [
        `**Kanal:** ${CUT(channel.name, 150)}`,
        `**ID:** \`${channel.id}\``,
      ]);
    }));
  }
  client.on(Events.ChannelUpdate, guard('kanal düzenleme', async (oldCh, channel) => {
    if (!contains(channel.guild, config) || isLogName(channel)) return;
    const lines = [`**Kanal:** ${CUT(channel.name, 150)} (\`${channel.id}\`)`];
    if (oldCh.name !== channel.name) lines.push(`**İsim:** ${CUT(oldCh.name, 100)} → ${CUT(channel.name, 100)}`);
    if (oldCh.parentId !== channel.parentId) lines.push('**Kategori:** Değişti');
    if ('topic' in channel && oldCh.topic !== channel.topic) lines.push('**Konu:** Değişti');
    const permissions = ch => ch.permissionOverwrites?.cache?.map(o => `${o.id}:${o.allow.bitfield}:${o.deny.bitfield}`).sort().join('|') ?? '';
    if (permissions(oldCh) !== permissions(channel)) lines.push('**Kanal izinleri:** Değişti');
    if (lines.length > 1) await emit(channel.guild, 'server', '⚙️ Kanal düzenlendi', lines);
  }));
  client.on(Events.GuildUpdate, guard('sunucu değişimi', async (before, after) => {
    if (!contains(after, config)) return;
    const lines = [];
    if (before.name !== after.name) lines.push(`**Sunucu ismi:** ${CUT(before.name)} → ${CUT(after.name)}`);
    if (before.description !== after.description) lines.push('**Açıklama:** Değişti');
    if (before.verificationLevel !== after.verificationLevel) lines.push('**Doğrulama seviyesi:** Değişti');
    if (before.icon !== after.icon) lines.push('**Sunucu simgesi:** Değişti');
    if (lines.length) await emit(after, 'server', '🏰 Sunucu ayarları değişti', lines);
  }));
}

export async function handleLogCommand(interaction, config) {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'logkontrol') return false;
  if (!contains(interaction.guild, config)) return true;
  if (!interaction.memberPermissions?.has(P.ManageGuild)) {
    await interaction.reply({ content: 'Bu komut için Sunucuyu Yönet yetkisi gerekiyor.', flags: MessageFlags.Ephemeral });
    return true;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await interaction.guild.channels.fetch().catch(() => null);
  const me = await interaction.guild.members.fetchMe().catch(() => null);
  const lines = ['👑 **KRATOS | Log Durumu**'];
  for (const [key, channelName] of Object.entries(LOG_CHANNELS)) {
    const matches = channelMatches(interaction.guild, key);
    if (matches.size === 0) lines.push(`❌ \`${channelName}\` — kanal bulunamadı`);
    else if (matches.size > 1) lines.push(`❌ \`${channelName}\` — aynı isimde birden çok kanal var`);
    else {
      const ch = matches.first();
      const ok = !!me && ch.permissionsFor(me)?.has([P.ViewChannel, P.SendMessages, P.EmbedLinks]);
      lines.push(`${ok ? '✅' : '⚠️'} <#${ch.id}> — ${ok ? 'hazır' : 'botun Kanalı Gör, Mesaj Gönder ve Bağlantı Yerleştir izinlerini kontrol et'}`);
    }
  }
  lines.push(`**Denetim kaydı izni:** ${me?.permissions.has(P.ViewAuditLog) ? '✅ Açık' : '❌ Eksik (kick ve ban yapan kişi loglanamaz)'}`);
  lines.push('**Mesaj metni:** Developer Portal > Bot > Message Content Intent açık olmalı. Önceden silinmiş mesajların içeriği geriye dönük kurtarılamaz.');
  await interaction.editReply({ content: lines.join('\n'), allowedMentions: { parse: [] } });
  return true;
}
