import { MessageFlags, PermissionFlagsBits } from 'discord.js';

const H = PermissionFlagsBits;
const reply = content => ({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
const commandNames = new Set(['ban', 'at', 'sustur', 'susturkaldir', 'uyeinfo', 'istatistik', 'yardim']);

function cleanReason(raw, actor) {
  const text = (raw ?? 'Sebep belirtilmedi').trim().slice(0, 250);
  return `[KRATOS / ${actor.tag}] ${text}`.slice(0, 500);
}
function errorDetail(error) {
  console.error('[KRATOS Moderasyon Hata]', error);
  const code = error?.code;
  if (code === 50013) return 'Discord "Yetersiz Izinler" hatasi verdi. Botun yetkilerini ve rol sirasini kontrol et.';
  if (code === 10007 || code === 10013) return 'Bu uye sunucuda bulunamadi.';
  return 'Islem basarisiz. Discord izinlerini ve rol sirasini kontrol et; ayrinti Cursor terminalinde.';
}
async function getGuildMember(interaction, userId) {
  return interaction.guild.members.fetch(userId).catch(() => null);
}
function canModerate({ guild, actor, target, bot }) {
  if (!target) return 'Bu kullanici sunucunun uyesi degil.';
  if (target.id === guild.ownerId) return 'Sunucu sahibi hedef alinamaz.';
  if (actor.id === target.id) return 'Kendine bu islemi yapamazsin.';
  if (target.id === bot.id) return 'KRATOS kendi uzerinde bu islemi yapamaz.';
  // Discord aktorun dogrudan yetkisine de bakar; bot en ust rolde olsa da yetkili
  // altindaki kisilere karsi bot uzerinden yetki yukseltilemez.
  if (actor.id !== guild.ownerId && actor.roles.highest.comparePositionTo(target.roles.highest) <= 0) {
    return 'Hedefin en yuksek rolu seninkine esit ya da senden ustte.';
  }
  if (bot.roles.highest.comparePositionTo(target.roles.highest) <= 0) {
    return 'Botun en yuksek rolu hedefin rolunden yukarida olmali.';
  }
  return null;
}
function requiredPermission(name) {
  if (name === 'ban') return H.BanMembers;
  if (name === 'at') return H.KickMembers;
  return H.ModerateMembers;
}
function permissionName(name) {
  if (name === 'ban') return 'Uyeleri Yasakla';
  if (name === 'at') return 'Uyeleri At';
  return 'Uyeleri Zaman Asimina Ugrat';
}
async function moderation(interaction) {
  const guild = interaction.guild;
  const command = interaction.commandName;
  const perm = requiredPermission(command);
  if (!interaction.memberPermissions?.has(perm)) {
    await interaction.reply(reply(`Bu komut icin **${permissionName(command)}** yetkisi gerekli.`));
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const [actor, bot] = await Promise.all([
    guild.members.fetch(interaction.user.id), guild.members.fetchMe(),
  ]);
  if (!bot.permissions.has(perm)) {
    await interaction.editReply(`Botta **${permissionName(command)}** yetkisi yok.`);
    return;
  }
  const user = interaction.options.getUser('uye', true);
  const target = await getGuildMember(interaction, user.id);
  const denied = canModerate({ guild, actor, target, bot });
  if (denied) { await interaction.editReply(denied); return; }

  const reason = cleanReason(interaction.options.getString('sebep'), interaction.user);
  if (command === 'ban') {
    if (!target.bannable) { await interaction.editReply('Discord bu uyeyi yasaklamama izin vermiyor. Rol ve izinleri kontrol et.'); return; }
    await target.ban({ reason, deleteMessageSeconds: 0 });
    await interaction.editReply(`**${target.user.username}** yasaklandi. Sebep: ${interaction.options.getString('sebep') || 'Belirtilmedi'}`);
  } else if (command === 'at') {
    if (!target.kickable) { await interaction.editReply('Discord bu uyeyi atmama izin vermiyor. Rol ve izinleri kontrol et.'); return; }
    await target.kick(reason);
    await interaction.editReply(`**${target.user.username}** sunucudan atildi. Sebep: ${interaction.options.getString('sebep') || 'Belirtilmedi'}`);
  } else if (command === 'sustur') {
    if (!target.moderatable) { await interaction.editReply('Discord bu uyeyi susturmama izin vermiyor. Yonetici yetkisi veya rol sirasi engel olabilir.'); return; }
    const minutes = interaction.options.getInteger('dakika', true);
    await target.timeout(minutes * 60_000, reason);
    await interaction.editReply(`**${target.user.username}** ${minutes} dakika susturuldu.`);
  } else if (command === 'susturkaldir') {
    if (!target.moderatable) { await interaction.editReply('Discord bu uyenin susturmasini kaldirmama izin vermiyor.'); return; }
    if (!target.isCommunicationDisabled()) { await interaction.editReply('Bu uye su an zaman asiminda degil.'); return; }
    await target.timeout(null, cleanReason('Zaman asimi kaldirildi', interaction.user));
    await interaction.editReply(`**${target.user.username}** uyesinin susturmasi kaldirildi.`);
  }
}
async function memberInfo(interaction) {
  const user = interaction.options.getUser('uye') ?? interaction.user;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const member = await getGuildMember(interaction, user.id);
  const accountCreated = `<t:${Math.floor(user.createdTimestamp / 1000)}:D>`;
  const joined = member?.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:D>` : 'Sunucuda degil';
  const userRoles = member?.roles.cache.filter(r => r.id !== interaction.guildId).map(r => r.name).slice(0, 15) ?? [];
  await interaction.editReply({
    content: [
      `**Uye:** ${user.username} (${user.id})`,
      `**Sunucu adi:** ${member?.displayName ?? 'Sunucuda degil'}`,
      `**Hesap acilisi:** ${accountCreated}`,
      `**Sunucuya giris:** ${joined}`,
      `**Bot hesabi:** ${user.bot ? 'Evet' : 'Hayir'}`,
      `**Roller:** ${userRoles.join(', ') || 'Yok'}`,
    ].join('\n'),
    allowedMentions: { parse: [] },
  });
}
async function stats(interaction, config) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guild = interaction.guild;
  // Dogru bot/insan sayisi icin tum uyeler cagrilir (GuildMembers Intent gerekir).
  // Buyuk sunucularda bu islem zaman alabilir; hata olursa tahmin uretmeyiz.
  const members = await guild.members.fetch();
  let bots = 0, registered = 0, unregistered = 0;
  for (const member of members.values()) {
    if (member.user.bot) { bots++; continue; }
    if (member.roles.cache.has(config.memberRoleId)) registered++;
    if (member.roles.cache.has(config.unverifiedRoleId)) unregistered++;
  }
  await interaction.editReply([
    '👑 **KRATOS | Sunucu Istatistikleri**',
    `Toplam uye: **${guild.memberCount}**`,
    `Insan: **${members.size - bots}**  |  Bot: **${bots}**`,
    `Uye rolune sahip: **${registered}**`,
    `Kayitsiz rolune sahip: **${unregistered}**`,
    'Not: Rol sayilari birbiriyle cakismaya veya bazi uyelerin iki role de sahip olmamasina gore toplami vermeyebilir.',
  ].join('\n'));
}
export async function handleExtraCommand(interaction, config) {
  if (!interaction.isChatInputCommand() || !commandNames.has(interaction.commandName)) return false;
  try {
    if (['ban','at','sustur','susturkaldir'].includes(interaction.commandName)) {
      await moderation(interaction);
    } else if (interaction.commandName === 'uyeinfo') {
      await memberInfo(interaction);
    } else if (interaction.commandName === 'istatistik') {
      await stats(interaction, config);
    } else if (interaction.commandName === 'yardim') {
      await interaction.reply(reply([
        '👑 **KRATOS | Komutlar**',
        '**Kayit:** /kayitpanel, /kayit, /kayitsiz',
        '**Yonetim:** /sil, /rolver, /rolal, /ban, /at, /sustur, /susturkaldir',
        '**Bilgi:** /ping, /uyesay, /uyeinfo, /istatistik, /yardim',
        'Yetkili komutlari rol izinleriyle sinirlandirilmistir.',
      ].join('\n')));
    }
  } catch (error) {
    const content = errorDetail(error);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content }).catch(console.error);
    } else {
      await interaction.reply(reply(content)).catch(console.error);
    }
  }
  return true;
}
