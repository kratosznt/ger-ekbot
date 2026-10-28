import { setupKratosAI } from './kratos-ai.js';
import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import { config } from './config.js';
import { handleTrackerCommand } from './tracker.js';
import { handleAnnouncementInteraction } from './announcements.js';
import { handleRegistrationInteraction, postRegistrationPanel, removeRankRolesFromMember, resumePendingArchives } from './registration.js';
import { handleExtraCommand } from './moderation.js';
import { setupLogs, handleLogCommand } from './logs.js';
import { initMusic, handleMusicCommand } from './music.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Message, Partials.Channel],
});

// Ayrı modül: kayıt / moderasyon kodunu değiştirmeden dokuz log kanalını izler.
setupLogs(client, config);
// KRATOS v0.9: muzik; kayit, arsiv ve dokuz log modulu degismiyor.
await initMusic(client);

const privateReply = content => ({ content, flags: MessageFlags.Ephemeral });

async function getTarget(interaction) {
  const user = interaction.options.getUser('uye', true);
  return interaction.guild.members.fetch(user.id);
}

async function getActor(interaction) {
  return interaction.guild.members.fetch(interaction.user.id);
}

async function getBotMember(guild) {
  return guild.members.fetchMe();
}

function canManageRole(role, actor, bot, guild) {
  if (!role || role.id === guild.id || role.managed) {
    return 'Bu rol botla degistirilemez.';
  }
  if (!bot.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return 'Botun Rolleri Yonet izni yok.';
  }
  if (bot.roles.highest.comparePositionTo(role) <= 0) {
    return 'Bot rolu, degistirilecek rolden daha yukarida olmali.';
  }
  if (actor.id !== guild.ownerId && actor.roles.highest.comparePositionTo(role) <= 0) {
    return 'Bu rolu degistirmek icin senin en ust rolun daha yukarida olmali.';
  }
  return null;
}

function canManageMember(target, actor, guild) {
  if (target.id === guild.ownerId) {
    return 'Sunucu sahibinin rollerini bu komutla degistirmiyoruz.';
  }
  if (actor.id !== guild.ownerId && actor.id !== target.id &&
      actor.roles.highest.comparePositionTo(target.roles.highest) <= 0) {
    return 'Kendi rolune esit veya daha yuksek yetkideki birinin rollerini degistiremezsin.';
  }
  return null;
}

client.once(Events.ClientReady, async readyClient => {
  console.log(`KRATOS aktif: ${readyClient.user.tag}`);
  try { await resumePendingArchives(readyClient, config); }
  catch (err) { console.error('Bekleyen kayıt arşivleri kontrol edilemedi:', err); }
});

// Bot calisirken sunucuya yeni gelen UYELERE otomatik Kayitsiz rolu ekler.
client.on(Events.GuildMemberAdd, async member => {
  if (member.guild.id !== config.guildId || member.user.bot) return;

  try {
    const role = await member.guild.roles.fetch(config.unverifiedRoleId);
    const bot = await getBotMember(member.guild);
    if (!role || bot.roles.highest.comparePositionTo(role) <= 0) {
      console.error('Otomatik rol verilemedi: Kayitsiz rolu bulunamadi veya bot rolunun ustunde.');
      return;
    }
    await member.roles.add(role, 'KRATOS: Sunucuya yeni katilan uye');

    // #welcome kanalinda kalici kayit paneli var.
    // Yeni katilan herkese ayri acik hos geldin mesaji gondermiyoruz.
  } catch (error) {
    console.error(`Yeni uye rol hatasi (${member.id}):`, error);
  }
});

client.on(Events.InteractionCreate, async interaction => {
  if (interaction.guildId !== config.guildId) return;

  // KRATOS v2.2: butonlu duyurulari diger islemlerden once yakala.
    if (await handleAnnouncementInteraction(interaction)) return;

  try {
    if (await handleRegistrationInteraction(interaction, config)) return;
  } catch (error) {
    console.error('Kayit etkilesim hatasi:', error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply(privateReply('Kayıt işlemi sırasında hata oluştu. Yetkiliye bildir.')).catch(console.error);
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  try {
    const guild = interaction.guild;
    const command = interaction.commandName;

    // Ek komutlar kendi izin ve rol hiyerarsisi kontrollerini yapar.
    if (await handleTrackerCommand(interaction)) return;
    if (await handleMusicCommand(interaction, config)) return;
    if (await handleLogCommand(interaction, config)) return;
    if (await handleExtraCommand(interaction, config)) return;

    if (command === 'kayitpanel') {
      await postRegistrationPanel(interaction, config);
      return;
    }

    if (command === 'ping') {
      await interaction.reply(privateReply('Pong! KRATOS calisiyor.'));
      return;
    }

    if (command === 'uyesay') {
      await interaction.reply(`Sunucudaki toplam uye (botlar dahil): **${guild.memberCount}**`);
      return;
    }

    if (command === 'sil') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
        await interaction.reply(privateReply('Bu komut icin Mesajlari Yonet izni gerekiyor.'));
        return;
      }
      const channel = interaction.channel;
      const botMember = await getBotMember(guild);
      if (!channel?.isTextBased() || !('bulkDelete' in channel) ||
          !channel.permissionsFor(botMember)?.has(PermissionFlagsBits.ManageMessages)) {
        await interaction.reply(privateReply('Bu kanalda mesaj silemiyorum. Botun Mesajlari Yonet iznini kontrol et.'));
        return;
      }

      const count = interaction.options.getInteger('sayi', true);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      // Sadece son 14 gunluk mesajlar toplu silinebilir (Discord siniri).
      const messages = await channel.messages.fetch({ limit: count });
      const recent = messages.filter(message => Date.now() - message.createdTimestamp < 14 * 24 * 60 * 60 * 1000);
      let deleted = 0;
      if (recent.size === 1) {
        await recent.first().delete();
        deleted = 1;
      } else if (recent.size > 1) {
        const result = await channel.bulkDelete(recent, true);
        deleted = result.size;
      }
      await interaction.editReply(`**${deleted}** mesaj silindi. (14 gunden eski olanlar atlandi.)`);
      return;
    }

    if (['rolver', 'rolal', 'kayit', 'kayitsiz'].includes(command)) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles)) {
        await interaction.reply(privateReply('Bu komut icin Rolleri Yonet izni gerekiyor.'));
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const [target, actor, bot] = await Promise.all([
        getTarget(interaction), getActor(interaction), getBotMember(guild),
      ]);
      const memberError = canManageMember(target, actor, guild);
      if (memberError) {
        await interaction.editReply(memberError);
        return;
      }

      if (command === 'rolver' || command === 'rolal') {
        const role = interaction.options.getRole('rol', true);
        const problem = canManageRole(role, actor, bot, guild);
        if (problem) {
          await interaction.editReply(problem);
          return;
        }
        if (command === 'rolver') {
          await target.roles.add(role, `KRATOS: ${interaction.user.tag} tarafindan rol verildi`);
          await interaction.editReply(`${target} kullanicisina **${role.name}** rolu verildi.`);
        } else {
          await target.roles.remove(role, `KRATOS: ${interaction.user.tag} tarafindan rol alindi`);
          await interaction.editReply(`${target} kullanicisindan **${role.name}** rolu alindi.`);
        }
        return;
      }

      if (target.user.bot) {
        await interaction.editReply('Bot hesaplarini kayit sistemiyle degistirmiyoruz.');
        return;
      }

      const memberRole = await guild.roles.fetch(config.memberRoleId);
      const unverifiedRole = await guild.roles.fetch(config.unverifiedRoleId);
      if (!memberRole || !unverifiedRole) {
        await interaction.editReply('Uye veya Kayitsiz rolu bulunamadi. .env ID bilgilerini kontrol et.');
        return;
      }
      for (const role of [memberRole, unverifiedRole]) {
        const problem = canManageRole(role, actor, bot, guild);
        if (problem) {
          await interaction.editReply(`${role.name}: ${problem}`);
          return;
        }
      }

      if (command === 'kayit') {
        await target.roles.add(memberRole, `KRATOS kayit: ${interaction.user.tag}`);
        await target.roles.remove(unverifiedRole, `KRATOS kayit: ${interaction.user.tag}`);
        await interaction.editReply(`${target} kaydedildi; **Uye** rolu verildi, **Kayitsiz** rolu kaldirildi.`);
      } else {
        await target.roles.add(unverifiedRole, `KRATOS kayitsiz: ${interaction.user.tag}`);
        await target.roles.remove(memberRole, `KRATOS kayitsiz: ${interaction.user.tag}`);
        await removeRankRolesFromMember(target);
        await interaction.editReply(`${target} kayitsiza alindi; **Uye** rolu kaldirildi.`);
      }
    }
  } catch (error) {
    console.error('Komut hatasi:', error);
    const message = privateReply('Islem gerceklestirilemedi. Bot izinlerini ve rol siralamasini kontrol et.');
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: message.content }).catch(console.error);
    } else {
      await interaction.reply(message).catch(console.error);
    }
  }
});

setupKratosAI(client);


client.login(config.token);
