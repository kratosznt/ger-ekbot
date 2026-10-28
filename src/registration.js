import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { fileURLToPath } from 'node:url';
import * as DiscordDisplay from 'discord.js';

export const RANKS = Object.freeze([
  { key: 'demir', name: 'Demir', emoji: '⚒️' },
  { key: 'bronz', name: 'Bronz', emoji: '🥉' },
  { key: 'gumus', name: 'Gümüş', emoji: '🥈' },
  { key: 'altin', name: 'Altın', emoji: '🥇' },
  { key: 'platin', name: 'Platin', emoji: '💠' },
  { key: 'elmas', name: 'Elmas', emoji: '💎' },
  { key: 'yucelik', name: 'Yücelik', emoji: '✨' },
  { key: 'olumsuzluk', name: 'Ölümsüzlük', emoji: '🔮' },
  { key: 'radyant', name: 'Radyant', emoji: '👑' },
]);

const IDS = Object.freeze({
  open: 'kratos_private_reg_open_v3',
  help: 'kratos_private_reg_help_v25',
  welcomeMenu: 'kratos_welcome_menu_v27',
  form: 'kratos_private_reg_form_v3',
  modal: 'kratos_private_reg_modal_v3',
  realName: 'kratos_reg_real_name',
  gameName: 'kratos_reg_game_name',
  select: 'kratos_private_reg_rank_v3',
  rankButton: 'kratos_private_reg_rank_button_v28',
  questionButton: 'kratos_private_reg_question_button_v28',
  questionModal: 'kratos_private_reg_question_modal_v28',
  questionText: 'kratos_private_reg_question_text_v28',
  questionSubject: 'kratos_question_subject_v30',
  welcomeQuestionModal: 'kratos_welcome_question_modal_v30',
});

const pending = new Map(); // userId => { nickname, channelId, expiresAt }
const processing = new Set();
const creationQueues = new Map();
const PENDING_MS = 15 * 60 * 1000;
const REG_TOPIC = 'KRATOS_REGISTER_USER:';
const ARCHIVE_MARKER = '|ARCHIVE_AFTER:';
const ARCHIVE_NICK_MARKER = '|ARCHIVE_NICK:';
const ARCHIVE_NAME = 'KAYIT ARŞİVİ';
const QUESTIONS_NAME = 'SORULAR';
const QUESTION_COOLDOWN_MS = 60_000; // Aynı üye 1 dakika içinde tekrar soru kanalı oluşturamasın.
const questionLastCreated = new Map();
const archiveTimers = new Map();
const TICKET_TOPIC_PATTERN = /^KRATOS_REGISTER_USER:(\d{17,20})(?:\|ARCHIVE_AFTER:(\d{13}))?(?:\|ARCHIVE_NICK:([^|]+))?$/u;

const UNSAFE_ROLE_PERMISSIONS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ManageNicknames,
  PermissionFlagsBits.MentionEveryone,
];
const WELCOME_RULES = [
  '1. Üyelere saygılı davran; hakaret, taciz ve ayrımcılık yapma.',
  '2. Spam, flood, izinsiz reklam veya zararlı bağlantı paylaşma.',
  '3. Metin ve ses kanallarını amaçlarına uygun kullan.',
  '4. Kişisel bilgilerini ve başkalarının özel verilerini paylaşma.',
  '5. Kayıt sırasında adını, Riot ID’ni ve rankını doğru gir.',
];
const rulesText = () => WELCOME_RULES.join('\n');

const privateReply = content => ({ content, flags: MessageFlags.Ephemeral });
const safe = value => value.replaceAll('\\', '\\\\').replaceAll('*', '\\*').replaceAll('_', '\\_').replaceAll('`', '\\`');

function unsafeMemberRole(role) {
  return !role || UNSAFE_ROLE_PERMISSIONS.some(perm => role.permissions.has(perm));
}
function manageableRole(role, bot, guild) {
  return !!role && role.id !== guild.id && !role.managed &&
    bot.permissions.has(PermissionFlagsBits.ManageRoles) &&
    bot.roles.highest.comparePositionTo(role) > 0;
}
async function findRanks(guild) {
  const roles = await guild.roles.fetch();
  return new Map(RANKS.map(rank => [rank.key, roles.find(role => role.name === rank.name) ?? null]));
}
export async function removeRankRolesFromMember(member) {
  const ranks = await findRanks(member.guild);
  for (const role of ranks.values()) {
    if (role && member.roles.cache.has(role.id)) {
      await member.roles.remove(role, 'KRATOS: Kayitsiz hale getirildi');
    }
  }
}

// The welcome channel is the single source of truth: private tickets are created
// beneath the SAME Discord category as welcome, with no new .env key.
async function getWelcome(guild, config) {
  if (!config.welcomeChannelId) return null;
  const channel = await guild.channels.fetch(config.welcomeChannelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText || !channel.parentId) return null;
  return channel;
}

async function ensureRoles(guild, config) {
  const bot = await guild.members.fetchMe();
  const memberRole = await guild.roles.fetch(config.memberRoleId);
  const unverifiedRole = await guild.roles.fetch(config.unverifiedRoleId);
  if (unsafeMemberRole(memberRole)) throw new Error('Üye rolünde yönetim/moderasyon yetkisi var veya rol bulunamadı.');
  if (![memberRole, unverifiedRole].every(role => manageableRole(role, bot, guild))) {
    throw new Error('Bot rolü, Üye ve Kayıtsız rollerinden yukarıda olmalı.');
  }
  const roles = await findRanks(guild);
  const added = [];
  for (const rank of RANKS) {
    let role = roles.get(rank.key);
    if (!role) {
      role = await guild.roles.create({
        name: rank.name, permissions: [], mentionable: false, hoist: false,
        reason: 'KRATOS kayıt sistemi: Rank rolü',
      });
      added.push(rank.name);
    }
    if (role.permissions.bitfield !== 0n) {
      throw new Error(`${rank.name} rolüne sunucu yetkileri verilmiş. Bu rolü yetkisiz yap.`);
    }
    if (!manageableRole(role, bot, guild)) {
      throw new Error(`${rank.name} rolünü KRATOS rolünün altına taşı.`);
    }
  }
  return added;
}

export async function postRegistrationPanel(interaction, config) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles)) {
    await interaction.reply(privateReply('Bu komut yalnızca Rolleri Yönet yetkisi olanlar içindir.'));
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guild = interaction.guild;
  const welcome = await getWelcome(guild, config);
  if (!welcome) {
    await interaction.editReply('`.env` içindeki WELCOME_CHANNEL_ID, Register kategorisindeki #welcome kanalını göstermeli. Kanalın bir kategoriye bağlı olduğundan emin ol.');
    return;
  }
  const bot = await guild.members.fetchMe();
  if (!bot.permissions.has(PermissionFlagsBits.ManageChannels) ||
      !welcome.permissionsFor(bot)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
    await interaction.editReply('Bot için Kanalları Yönet, Kanalı Görüntüle, Mesaj Gönder ve Bağlantı Yerleştir izinlerini aç.');
    return;
  }
  let added;
  try { added = await ensureRoles(guild, config); }
  catch (err) { await interaction.editReply(`Rol kontrolü başarısız: ${err.message}`); return; }

  // v2.9: Discord Classic Embed görseli küçük gösteriyor.
  // Aynı PNG dosyasını (piksel değiştirmeden) Components V2 Media Gallery ile
  // daha geniş bir yerleşimde göstermeyi deniyoruz.
  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(IDS.welcomeMenu)
      .setPlaceholder('Bir işlem seç...')
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(
        { label: 'Kayıt olmak istiyorum', description: 'Sana özel kayıt odasını aç', value: 'register', emoji: '📝' },
        { label: 'Soru sormak istiyorum', description: 'Kalıcı özel soru kanalı oluştur', value: 'question', emoji: '❔' },
        { label: 'Kuralları tekrar görmek istiyorum', description: 'Sunucu kurallarını özel olarak göster', value: 'rules', emoji: '📜' },
      ),
  );
  const banner = new AttachmentBuilder(fileURLToPath(new URL('../assets/kratos-welcome.png', import.meta.url)), {
    name: 'kratos-welcome.png',
  });
  const thumbnail = new AttachmentBuilder(fileURLToPath(new URL('../assets/kratos-thumbnail.png', import.meta.url)), {
    name: 'kratos-thumbnail.png',
  });

  const canUseV2 = DiscordDisplay.ContainerBuilder && DiscordDisplay.SectionBuilder &&
    DiscordDisplay.MediaGalleryBuilder && MessageFlags.IsComponentsV2;
  let message;
  if (canUseV2) {
    try {
      const header = new DiscordDisplay.SectionBuilder()
        .addTextDisplayComponents(text => text.setContent(
          '## 👑 KRATOS | Kayıt Sistemi\n' +
          '**KRATOS sunucusuna hoş geldin!**\n' +
          'Aramıza katılmak için önce aşağıdaki kuralları oku, ardından menüden bir işlem seç.'
        ))
        .setThumbnailAccessory(thumb => thumb
          .setURL('attachment://kratos-thumbnail.png')
          .setDescription('KRATOS taçlı K logosu'));
      const layout = new DiscordDisplay.ContainerBuilder()
        .setAccentColor(0x70B7F3)
        .addSectionComponents(header)
        .addSeparatorComponents(separator => separator.setDivider(true))
        .addTextDisplayComponents(text => text.setContent(
          '### 📜 SUNUCU KURALLARI\n' + rulesText() +
          '\n\n### ✦ KAYIT HAKKINDA\n' +
          'Özel kayıt odanda gerçek adını ve **Riot ID** bilgini gir, ardından ' +
          'VALORANT rankını seç. **Üye** ve rank rollerin otomatik verilir.'
        ))
        .addMediaGalleryComponents(gallery => gallery.addItems(
          item => item.setURL('attachment://kratos-welcome.png')
            .setDescription('KRATOS metalik mavi büyük kayıt bannerı')
        ))
        .addTextDisplayComponents(text => text.setContent(
          '-# KRATOS • Aşağıdaki menüden yapmak istediğin işlemi seç.'
        ))
        .addActionRowComponents(row);
      message = await welcome.send({
        components: [layout],
        files: [banner, thumbnail],
        flags: MessageFlags.IsComponentsV2,
      });
    } catch (error) {
      console.error('[KRATOS] Geniş kayıt paneli gönderilemedi; klasik panele dönülüyor:', error);
    }
  }
  if (!message) {
    // Eski Discord.js sürümleri için güvenli dönüş. Görsel burada daha dar görünür.
    const embed = new EmbedBuilder()
      .setColor(0x70B7F3)
      .setTitle('👑 KRATOS  |  Kayıt Sistemi')
      .setDescription('**KRATOS sunucusuna hoş geldin!**\nAramıza katılmak için önce aşağıdaki kuralları oku, ardından menüden bir işlem seç.')
      .addFields(
        { name: '📜  SUNUCU KURALLARI', value: rulesText(), inline: false },
        { name: '✦  KAYIT HAKKINDA', value: 'Özel kayıt odanda gerçek adını ve **Riot ID** bilgini gir, ardından VALORANT rankını seç. **Üye** ve rank rollerin otomatik verilir.', inline: false },
      )
      .setImage('attachment://kratos-welcome.png')
      .setThumbnail('attachment://kratos-thumbnail.png')
      .setFooter({ text: 'KRATOS • Aşağıdaki menüden yapmak istediğin işlemi seç.' });
    message = await welcome.send({ embeds: [embed], components: [row], files: [banner, thumbnail] });
  }
  await interaction.editReply(
    `✅ Kayıt paneli ${welcome} kanalına gönderildi: ${message.url}\n` +
    `Özel kayıt kanalları **${welcome.parent?.name ?? 'aynı kategori'}** altında açılacak.\n` +
    (added.length ? `Oluşturulan ranklar: ${added.join(', ')}` : 'Rank rolleri hazır.') +
    '\nEski kayıt paneli varsa silip yalnızca bu yeni mesajı sabitle.',
  );
}

function cleanInput(input) {
  return input.trim().replace(/\s+/gu, ' ').replace(/[\x00-\x1f\x7f]/gu, '');
}
function modalFor(userId) {
  const realName = new TextInputBuilder()
    .setCustomId(IDS.realName).setLabel('Gerçek adın')
    .setPlaceholder('Örn: İsmail').setMinLength(2).setMaxLength(18)
    .setRequired(true).setStyle(TextInputStyle.Short);
  const gameName = new TextInputBuilder()
    .setCustomId(IDS.gameName).setLabel('Oyun içi adın ve etiketin')
    .setPlaceholder('Örn: kratos#33133').setMinLength(3).setMaxLength(24)
    .setRequired(true).setStyle(TextInputStyle.Short);
  return new ModalBuilder().setCustomId(`${IDS.modal}:${userId}`)
    .setTitle('KRATOS | Üye Kaydı')
    .addComponents(new ActionRowBuilder().addComponents(realName), new ActionRowBuilder().addComponents(gameName));
}
function rankMenu(userId) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(`${IDS.select}:${userId}`)
      .setPlaceholder('VALORANT rankını seç').setMinValues(1).setMaxValues(1)
      .addOptions(RANKS.map(rank => ({ label: rank.name, value: rank.key, emoji: rank.emoji }))),
  );
}
// Kayıt odası: 3 işlevsel buton, aynı banner ve sağ üstte K thumbnail.
// Components V2 varsa örnekteki gibi butonlar büyük görselin ÜSTÜNDE olur.
// Eski discord.js sürümlerinde klasik embed düzenine güvenli geri dönüş yapılır.
async function sendPremiumPrivatePanel(channel, userId) {
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${IDS.form}:${userId}`)
      .setLabel('Kayıt Ol').setEmoji('📝').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${IDS.rankButton}:${userId}`)
      .setLabel('Rankını Seç').setEmoji('💎').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${IDS.questionButton}:${userId}`)
      .setLabel('Soru Sor').setEmoji('❔').setStyle(ButtonStyle.Secondary),
  );
  const file = relative => fileURLToPath(new URL(`../assets/${relative}`, import.meta.url));
  const files = () => [
    new AttachmentBuilder(file('kratos-welcome.png'), { name: 'kratos-welcome.png' }),
    new AttachmentBuilder(file('kratos-thumbnail.png'), { name: 'kratos-thumbnail.png' }),
  ];

  const canUseV2 = DiscordDisplay.ContainerBuilder && DiscordDisplay.SectionBuilder &&
    DiscordDisplay.MediaGalleryBuilder && MessageFlags.IsComponentsV2;
  if (canUseV2) {
    try {
      const section = new DiscordDisplay.SectionBuilder()
        .addTextDisplayComponents(text => text.setContent(
          `## 👑 KRATOS | Özel Kayıt Odası\nHoş geldin <@${userId}>!\nKayıt için aşağıdaki işlemleri sırayla tamamla.`,
        ))
        .setThumbnailAccessory(thumb => thumb
          .setURL('attachment://kratos-thumbnail.png')
          .setDescription('KRATOS taçlı K logosu'));
      const panel = new DiscordDisplay.ContainerBuilder()
        .setAccentColor(0x70B7F3)
        .addSectionComponents(section)
        .addTextDisplayComponents(text => text.setContent(
          '**01 — Kayıt Ol** · Gerçek adını ve Riot ID\'ni gir.\n' +
          '**02 — Rankını Seç** · Bilgilerini girdikten sonra VALORANT rankını belirle.\n' +
          '**03 — Soru Sor** · Kalıcı özel soru kanalı aç ve sorunu yaz.'
        ))
        .addActionRowComponents(buttons)
        .addSeparatorComponents(sep => sep.setDivider(true))
        .addMediaGalleryComponents(gallery => gallery.addItems(
          item => item.setURL('attachment://kratos-welcome.png')
            .setDescription('KRATOS metalik mavi sunucu bannerı'),
        ))
        .addTextDisplayComponents(text => text.setContent(
          '-# KRATOS • Kayıt tamamlanınca oda 30 saniye sonra özel arşive taşınır.'
        ));
      await channel.send({
        components: [panel],
        files: files(),
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: { users: [userId] },
      });
      return;
    } catch (error) {
      console.warn('KRATOS özel kayıt: Components V2 kullanılamadı, klasik panele geçiliyor:', error);
    }
  }

  // Güvenli fallback: kayıt işleminden ödün vermeden klasik discord.js embed.
  await channel.send({
    content: `<@${userId}>`,
    embeds: [new EmbedBuilder()
      .setColor(0x70B7F3)
      .setTitle('👑 KRATOS | Özel Kayıt Odası')
      .setDescription('**01 / Kayıt Ol**\nGerçek adını ve Riot ID bilgini gir.\n\n' +
        '**02 / Rankını Seç**\nAdını girdikten sonra rankını seç.\n\n' +
        '**03 / Soru Sor**\nKalıcı özel soru kanalında destek al.')
      .setThumbnail('attachment://kratos-thumbnail.png')
      .setImage('attachment://kratos-welcome.png')
      .setFooter({ text: 'KRATOS • Kayıt bitince 30 saniye sonra arşivlenir' })],
    components: [buttons],
    files: files(),
    allowedMentions: { users: [userId] },
  });
}

function questionModalFor(userId, source = 'private') {
  const subject = new TextInputBuilder()
    .setCustomId(IDS.questionSubject)
    .setLabel('Soru başlığı')
    .setPlaceholder('Örn: Kayıt hakkında yardım')
    .setMinLength(3).setMaxLength(80)
    .setRequired(true).setStyle(TextInputStyle.Short);
  const body = new TextInputBuilder()
    .setCustomId(IDS.questionText)
    .setLabel('Sorun nedir?')
    .setPlaceholder('Sorunu ayrıntılı şekilde yaz...')
    .setMinLength(5).setMaxLength(1200)
    .setRequired(true).setStyle(TextInputStyle.Paragraph);
  const modalId = source === 'welcome' ? IDS.welcomeQuestionModal : IDS.questionModal;
  return new ModalBuilder()
    .setCustomId(`${modalId}:${userId}`)
    .setTitle('KRATOS | Soru ve Destek')
    .addComponents(
      new ActionRowBuilder().addComponents(subject),
      new ActionRowBuilder().addComponents(body),
    );
}

// Her soru bir özel metin kanalı olarak kalır. Kayıt arşivinin 30 saniyelik
// taşıma zamanlayıcısıyla hiçbir bağlantısı yoktur; kendiliğinden silinmez.
function questionCategoryName(index) {
  return index === 1 ? QUESTIONS_NAME : `${QUESTIONS_NAME} ${index}`;
}

function questionArchivePermissions(guild, botId) {
  const visible = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];
  return [
    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: guild.ownerId, allow: [...visible, PermissionFlagsBits.SendMessages] },
    { id: botId, allow: [...visible, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] },
  ];
}

async function ensureQuestionCategory(guild, bot) {
  const channels = await guild.channels.fetch();
  let category = null;
  let newIndex = 1;
  for (let i = 1; i <= 100; i++) {
    const name = questionCategoryName(i);
    const existing = channels.find(ch => ch?.type === ChannelType.GuildCategory && ch.name === name);
    if (!existing) { newIndex = i; break; }
    const childrenCount = channels.filter(ch => ch?.parentId === existing.id).size;
    if (childrenCount < 50) { category = existing; break; }
    newIndex = i + 1;
  }
  if (!category) {
    if (newIndex > 100) throw new Error('Soru kategorileri dolu; yetkiliye haber ver.');
    category = await guild.channels.create({
      name: questionCategoryName(newIndex),
      type: ChannelType.GuildCategory,
      permissionOverwrites: questionArchivePermissions(guild, bot.id),
      reason: 'KRATOS: Kalıcı özel soru ve destek kategorisi',
    });
  }
  // Yeni soru kategorisi sunucu listesinin en sonunda, kayıt arşivinin altında kalsın.
  // Mevcut kategori en alttaysa gereksiz işlem yapma.
  const all = await guild.channels.fetch();
  const last = Math.max(0, ...all.filter(ch => ch?.type === ChannelType.GuildCategory)
    .map(ch => ch.rawPosition));
  if (category.rawPosition < last) {
    await category.setPosition(last + 1).catch(err =>
      console.warn('[KRATOS soru] SORULAR kategorisi en alta taşınamadı:', err.message));
  }
  return category;
}

function nextQuestionChannelName(channels, parentId) {
  const used = new Set();
  for (const channel of channels.values()) {
    if (channel?.parentId !== parentId) continue;
    const match = /^soru-(\d+)$/u.exec(channel.name);
    if (match) used.add(Number(match[1]));
  }
  let n = 1;
  while (used.has(n)) n++;
  return `soru-${n}`;
}

function cleanQuestionValue(value) {
  return String(value).trim().replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/gu, '')
    .replace(/\r\n?/gu, '\n');
}

async function createPermanentQuestion(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guild = interaction.guild;
  const userId = interaction.user.id;
  const subject = cleanQuestionValue(interaction.fields.getTextInputValue(IDS.questionSubject));
  const body = cleanQuestionValue(interaction.fields.getTextInputValue(IDS.questionText));
  if (subject.length < 3 || body.length < 5) {
    await interaction.editReply('❌ Başlık ve soru metni çok kısa. Lütfen yeniden dene.');
    return;
  }
  const lastCreated = questionLastCreated.get(userId) || 0;
  if (Date.now() - lastCreated < QUESTION_COOLDOWN_MS) {
    const seconds = Math.ceil((QUESTION_COOLDOWN_MS - (Date.now() - lastCreated)) / 1000);
    await interaction.editReply(`⌛ Yeni bir soru oluşturmadan önce ${seconds} saniye bekle. Mevcut soru kanalında yazışmaya devam edebilirsin.`);
    return;
  }
  try {
    const bot = await guild.members.fetchMe();
    if (!bot.permissions.has(PermissionFlagsBits.ManageChannels)) {
      await interaction.editReply('❌ KRATOS botuna **Kanalları Yönet** yetkisi verilmesi gerekiyor.');
      return;
    }
    const member = await guild.members.fetch(userId);
    const question = await withCreationLock(guild.id, async () => {
      // Paralel açılışlarda gereksiz kategori/kanal çakışmalarını önle.
      const category = await ensureQuestionCategory(guild, bot);
      const channels = await guild.channels.fetch();
      const name = nextQuestionChannelName(channels, category.id);
      const channel = await guild.channels.create({
        name,
        type: ChannelType.GuildText,
        parent: category.id,
        topic: `KRATOS_QUESTION_USER:${userId}|CREATED:${Date.now()}`,
        reason: `KRATOS: ${interaction.user.username} için kalıcı soru kanalı`,
        permissionOverwrites: [
          { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: guild.ownerId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessages] },
          { id: userId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessages] },
          { id: bot.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] },
        ],
      });
      try {
        let fresh = await guild.channels.fetch(channel.id, { force: true });
        const needed = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory];
        if (!fresh.permissionsFor(member)?.has(needed)) {
          await fresh.permissionOverwrites.edit(userId, {
            ViewChannel: true, SendMessages: true, ReadMessageHistory: true,
          }, { reason: 'KRATOS: Soru sahibinin kalıcı kanal erişimi' });
          fresh = await guild.channels.fetch(channel.id, { force: true });
        }
        if (!fresh.permissionsFor(member)?.has(needed)) {
          throw new Error('Soru kanalındaki erişim izni doğrulanamadı.');
        }
        await channel.send({
          content: `<@${userId}>`,
          embeds: [new EmbedBuilder()
            .setColor(0x70B7F3)
            .setTitle(`❔ KRATOS | ${subject.slice(0, 80)}`)
            .setDescription(`**Soru sahibi:** <@${userId}>\n\n**Sorusu:**\n${safe(body)}\n\nYetkili buradan cevap verebilir. Bu kanal otomatik silinmez.`)
            .setFooter({ text: 'KRATOS • Kalıcı özel soru kanalı' })
            .setTimestamp()],
          allowedMentions: { users: [userId], parse: [] },
        });
      } catch (err) {
        await channel.delete('KRATOS: Soru mesajı / kullanıcı erişimi başarısız').catch(() => {});
        throw err;
      }
      return channel;
    });
    questionLastCreated.set(userId, Date.now());
    await interaction.editReply(`✅ **Sorun kaydedildi!**\nKalıcı soru kanalın: ${question}\n🔗 ${question.url}\n\nBu kanal **SORULAR** kategorisinde duracak; silinmediği ve sunucuda bulunduğun sürece her zaman erişebileceksin. Cevap için buradan yazışabilirsin.`);
  } catch (error) {
    console.error('[KRATOS] Kalıcı soru kanalı açılamadı:', error);
    await interaction.editReply('❌ Soru kanalı oluşturulamadı. KRATOS botunun **Kanalları Yönet**, **Kanalı Görüntüle** ve **Mesaj Gönder** yetkilerini kontrol et. Ayrıntı Cursor terminalinde.').catch(console.error);
  }
}

function ticketDetails(channel) {
  if (channel?.type !== ChannelType.GuildText) return null;
  const match = TICKET_TOPIC_PATTERN.exec(channel.topic ?? '');
  if (!match) return null;
  let nickname = null;
  if (match[3]) {
    try { nickname = decodeURIComponent(match[3]); }
    catch (error) { console.warn('Kayıt arşivi: Takma ad bilgisi çözümlenemedi:', error); }
  }
  return { ownerId: match[1], archiveAfter: match[2] ? Number(match[2]) : null, nickname };
}
function userOfTicket(channel) {
  return ticketDetails(channel)?.ownerId ?? null;
}

async function isValidTicket(interaction, ownerId, config) {
  const owner = userOfTicket(interaction.channel);
  const welcome = await getWelcome(interaction.guild, config);
  return !!welcome && owner === ownerId && interaction.user.id === ownerId &&
    interaction.channel.parentId === welcome.parentId && interaction.channel.id !== welcome.id;
}
// After registration, move (never delete) the SAME channel to a private archive.
// Category #2, #3, etc. are created only if an earlier archive has 50 channels.
function archiveName(index) {
  return index === 1 ? ARCHIVE_NAME : `${ARCHIVE_NAME} ${index}`;
}
function archivePermissions(guild, botId) {
  return [
    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: guild.ownerId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] },
    { id: botId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels] },
  ];
}
async function ensureArchiveCategory(guild) {
  const channels = await guild.channels.fetch();
  let chosen = null;
  let toCreate = 1;
  for (let i = 1; i <= 100; i++) {
    const name = archiveName(i);
    const category = channels.find(ch => ch?.type === ChannelType.GuildCategory && ch.name === name);
    if (!category) { toCreate = i; break; }
    const used = channels.filter(ch => ch?.parentId === category.id).size;
    if (used < 50) { chosen = category; break; }
    toCreate = i + 1;
  }
  const bot = await guild.members.fetchMe();
  if (!chosen) {
    chosen = await guild.channels.create({
      name: archiveName(toCreate),
      type: ChannelType.GuildCategory,
      permissionOverwrites: archivePermissions(guild, bot.id),
      reason: 'KRATOS: Kalıcı, özel kayıt arşivi',
    });
    const allCategories = await guild.channels.fetch();
    const last = Math.max(0, ...allCategories.filter(ch => ch?.type === ChannelType.GuildCategory).map(ch => ch.rawPosition));
    await chosen.setPosition(last + 1).catch(err => console.warn('Arşiv kategorisi en alta taşınamadı:', err));
  }
  // Re-apply privacy if existing category permissions were changed by a person.
  await chosen.permissionOverwrites.set(archivePermissions(guild, bot.id), 'KRATOS: Kayıt arşivini gizle');
  return chosen;
}
// Discord kanal adları için üyelerin kayıt sırasında seçtiği takma adı sadeleştir.
// Örn: "Hypra (orospucocuğuyum)" -> "hypra-orospucocuğuyum"
function archiveChannelSlug(nickname, ownerId) {
  const slug = String(nickname ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('tr')
    .replace(/[^\p{L}\p{N}\s_-]/gu, ' ')
    .trim()
    .replace(/[\s_]+/gu, '-')
    .replace(/-+/gu, '-')
    .slice(0, 90)
    .replace(/-+$/gu, '');
  return slug || `uye-${ownerId.slice(-6)}`;
}

async function archivedNickname(guild, details) {
  if (details.nickname) return details.nickname; // Kayıt tamamlandığı andaki isim kalıcıdır.
  // v0.4'ten kalan kanallar için kullanıcıyı Discord'dan bul.
  const member = await guild.members.fetch(details.ownerId).catch(() => null);
  if (member) return member.displayName;
  const user = await guild.client.users.fetch(details.ownerId).catch(() => null);
  return user?.globalName || user?.username || null;
}

async function uniqueArchiveChannelName(guild, channel, nickname, ownerId) {
  const base = archiveChannelSlug(nickname, ownerId);
  const channels = await guild.channels.fetch();
  const names = new Set([...channels.values()]
    .filter(ch => ch && ch.id !== channel.id && ch.parentId === channel.parentId)
    .map(ch => ch.name));
  if (!names.has(base)) return base;
  for (let index = 2; index < 1000; index++) {
    const suffix = `-${index}`;
    const proposal = `${base.slice(0, 90 - suffix.length)}${suffix}`;
    if (!names.has(proposal)) return proposal;
  }
  return `uye-${ownerId}`;
}

async function archiveTicket(guild, channelId) {
  return withCreationLock(guild.id, async () => {
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    const details = ticketDetails(channel);
    if (!details?.archiveAfter) return; // Never touch an incomplete ticket.
    if (details.archiveAfter > Date.now()) {
      scheduleArchive(guild, channelId, details.archiveAfter);
      return;
    }
    const alreadyArchived = channel.parent?.type === ChannelType.GuildCategory &&
      channel.parent.name.startsWith(ARCHIVE_NAME);
    // Eski arşivlerde hâlâ "kayıt1" gibi isimler varsa onları da düzelt.
    if (alreadyArchived && !/^kayıt\d+$/u.test(channel.name)) return;

    if (!alreadyArchived) {
      const archive = await ensureArchiveCategory(guild);
      const bot = await guild.members.fetchMe();
      // Önce erişimi gizle, sonra arşiv kategorisine taşı.
      await channel.permissionOverwrites.set(archivePermissions(guild, bot.id), 'KRATOS: Kayıt tamamlandı, sadece sunucu sahibi');
      await channel.setParent(archive, { lockPermissions: true, reason: 'KRATOS: Kayıt tamamlandı, kanalı arşive taşı' });
      await channel.send('📁 **Kayıt arşivlendi.** Bu kanal, sunucu sahibi silene kadar saklanır.')
        .catch(err => console.warn('Arşiv mesajı gönderilemedi:', err));
    }

    const nickname = await archivedNickname(guild, details);
    const newName = await uniqueArchiveChannelName(guild, channel, nickname, details.ownerId);
    if (channel.name !== newName) {
      await channel.setName(newName, 'KRATOS: Arşiv kanalının adını kayıtlı üyenin nickiyle değiştir');
    }
    console.log(`KRATOS: Kayıt kanalı arşivlendi: ${channel.name}`);
  });
}
function scheduleArchive(guild, channelId, when, retries = 0) {
  if (archiveTimers.has(channelId)) clearTimeout(archiveTimers.get(channelId));
  const delay = Math.max(0, when - Date.now());
  const timer = setTimeout(async () => {
    archiveTimers.delete(channelId);
    try {
      await archiveTicket(guild, channelId);
    } catch (err) {
      console.error(`KRATOS: ${channelId} arşive taşınamadı:`, err);
      if (retries < 3) scheduleArchive(guild, channelId, Date.now() + 60_000, retries + 1);
    }
  }, delay);
  archiveTimers.set(channelId, timer);
}
// Restart-safe: completion timestamp is stored in the channel topic. On bot
// restart, unfinished 30-second delays continue using that timestamp.
export async function resumePendingArchives(client, config) {
  const guild = await client.guilds.fetch(config.guildId);
  const channels = await guild.channels.fetch();
  for (const channel of channels.values()) {
    const details = ticketDetails(channel);
    if (details?.archiveAfter &&
      (!channel.parent?.name.startsWith(ARCHIVE_NAME) || /^kayıt\d+$/u.test(channel.name))) {
      scheduleArchive(guild, channel.id, details.archiveAfter);
    }
  }
}

async function withCreationLock(guildId, operation) {
  const before = creationQueues.get(guildId) || Promise.resolve();
  const work = before.catch(() => {}).then(operation);
  creationQueues.set(guildId, work);
  try { return await work; }
  finally { if (creationQueues.get(guildId) === work) creationQueues.delete(guildId); }
}
function nextChannelName(channels, parentId) {
  const used = new Set();
  for (const channel of channels.values()) {
    if (channel?.parentId !== parentId) continue;
    const match = /^kayıt(\d+)$/u.exec(channel.name);
    if (match) used.add(Number(match[1]));
  }
  let n = 1;
  while (used.has(n)) n++;
  return `kayıt${n}`;
}
// v2.6.1: Özel odanın gerçekten kayıt sahibine görünür olduğundan emin ol.
// Kategori izinlerini kopyalama: @everyone gizli, ilgili üye + bot erişebilir.
async function verifyPrivateTicketAccess(guild, channelId, member) {
  let ticket = await guild.channels.fetch(channelId, { force: true }).catch(() => null);
  if (!ticket || ticket.type !== ChannelType.GuildText) {
    throw new Error('Kayıt kanalı oluşturulduktan sonra bulunamadı. #server-log / Sunucu Denetim Kaydı içinde kanal silme işlemi var mı bak.');
  }
  const required = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.SendMessages,
  ];
  if (!ticket.permissionsFor(member)?.has(required)) {
    console.warn(`[KRATOS kayıt] ${member.id} kullanıcısının ${ticket.id} kanalına erişimi yok. Özel izin yeniden tanımlanıyor.`);
    await ticket.permissionOverwrites.edit(member.id, {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessages: true,
    }, { reason: 'KRATOS: Özel kayıt odası erişimini düzelt' });
    ticket = await guild.channels.fetch(channelId, { force: true }).catch(() => null);
  }
  if (!ticket || !ticket.permissionsFor(member)?.has(required)) {
    throw new Error('Özel kayıt kanalında kullanıcı erişimi doğrulanamadı. Register kategorisi ve kanal izinlerini kontrol et.');
  }
  console.log(`[KRATOS kayıt] Kanal erişimi doğrulandı: ${ticket.id}, üye: ${member.id}`);
  return ticket;
}

async function openPrivateTicket(interaction, config) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guild = interaction.guild;
  const welcome = await getWelcome(guild, config);
  if (!welcome || interaction.channelId !== welcome.id) {
    await interaction.editReply('Bu buton yalnızca Register kategorisindeki #welcome kanalında kullanılabilir.');
    return;
  }
  const member = await guild.members.fetch(interaction.user.id);
  if (member.user.bot) { await interaction.editReply('Bot hesapları kayıt olamaz.'); return; }
  if (member.roles.cache.has(config.memberRoleId) && !member.roles.cache.has(config.unverifiedRoleId)) {
    await interaction.editReply('✅ Zaten kayıtlısın, yeniden kayıt kanalı açmana gerek yok.');
    return;
  }
  const bot = await guild.members.fetchMe();
  if (!bot.permissions.has([PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles])) {
    await interaction.editReply('KRATOS botuna **Kanalları Yönet** ve **Rolleri Yönet** yetkilerini vermelisin.');
    return;
  }

  try {
    const ticket = await withCreationLock(guild.id, async () => {
      const channels = await guild.channels.fetch();
      const existing = channels.find(channel => channel?.parentId === welcome.parentId &&
        userOfTicket(channel) === interaction.user.id);
      if (existing) return verifyPrivateTicketAccess(guild, existing.id, member);
      const ticketsInCategory = channels.filter(channel => channel?.parentId === welcome.parentId);
      if (ticketsInCategory.size >= 50) {
        throw new Error('Register kategorisi dolu (en fazla 50 kanal). Eski kayıt kanallarını temizle.');
      }
      const name = nextChannelName(channels, welcome.parentId);
      const channel = await guild.channels.create({
        name, type: ChannelType.GuildText, parent: welcome.parentId,
        topic: `${REG_TOPIC}${interaction.user.id}`,
        reason: `KRATOS: ${interaction.user.tag} için özel kayıt kanalı`,
        permissionOverwrites: [
          { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
          { id: bot.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels] },
        ],
      });
      try {
        await sendPremiumPrivatePanel(channel, interaction.user.id);
      } catch (err) {
        await channel.delete('KRATOS: Kayıt mesajı gönderilemedi').catch(() => {});
        throw err;
      }
      await channel.setPosition(welcome.rawPosition + 1).catch(err => console.warn('Kanal sırası ayarlanamadı:', err.message));
      return verifyPrivateTicketAccess(guild, channel.id, member);
    });
    await interaction.editReply(`✅ Özel kayıt odan hazır: **#${ticket.name}**\n🔗 ${ticket.url}\nBağlantıya tıkla ve **Kayıt Ol** butonuna bas. Kanal görünmüyorsa Discord'u **Ctrl + R** ile yenile.`);
  } catch (error) {
    console.error('Kayıt kanalı açma hatası:', error);
    const details = String(error?.message ?? 'Bilinmeyen hata');
    await interaction.editReply(`❌ Kayıt odasına erişim doğrulanamadı. ${details.includes('Missing Permissions') ? 'KRATOS botunun Kanalları Yönet ve Rolleri Yönet izinlerini kontrol et.' : details.slice(0, 300)}\nYetkiliysen Cursor terminalindeki [KRATOS kayıt] satırlarına bak.`);
  }
}

export async function handleRegistrationInteraction(interaction, config) {
  if (interaction.guildId !== config.guildId) return false;
  const id = interaction.customId;
  if (!id || ![IDS.open, IDS.help, IDS.welcomeMenu, IDS.form, IDS.modal, IDS.select, IDS.rankButton, IDS.questionButton, IDS.questionModal, IDS.welcomeQuestionModal].some(prefix => id === prefix || id.startsWith(`${prefix}:`))) return false;

  // Menü yalnızca welcome kanalındaki yeni panelde çalışır.
  if (interaction.isStringSelectMenu() && id === IDS.welcomeMenu) {
    const selected = interaction.values[0];
    if (selected === 'register') {
      await openPrivateTicket(interaction, config);
      return true;
    }
    if (selected === 'rules') {
      await interaction.reply(privateReply(`📜 **KRATOS | Sunucu Kuralları**\n\n${rulesText()}\n\nKurallara uyarak keyifli bir ortam oluşturmamıza yardımcı olabilirsin.`));
      return true;
    }
    if (selected === 'question') {
      // Modal gösterme ilk yanıt olmalı; arada deferReply yapılmamalı.
      await interaction.showModal(questionModalFor(interaction.user.id, 'welcome'));
      return true;
    }
    await interaction.reply(privateReply('Bu işlem tanınmadı. Menüden tekrar seçim yap.'));
    return true;
  }
  if (interaction.isButton() && id === IDS.help) {
    await interaction.reply(privateReply('👑 **KRATOS Kayıt Rehberi**\n\n**1.** Kayda Başla butonuna tıkla.\n**2.** Açılan özel kayıt odasında adını ve `RiotAdı#Etiket` bilgini gir.\n**3.** VALORANT rankını seç.\n**4.** Üye ve rank rollerin verilir; kayıt odan 30 saniye sonra yalnızca sunucu sahibinin görebildiği arşive taşınır.\n\n❗ Kimlik veya oyun hesabı doğrulaması yapılmaz.'));
    return true;
  }
  if (interaction.isButton() && id === IDS.open) {
    await openPrivateTicket(interaction, config);
    return true;
  }
  if (interaction.isButton() && id.startsWith(`${IDS.rankButton}:`)) {
    const ownerId = id.slice(IDS.rankButton.length + 1);
    if (!(await isValidTicket(interaction, ownerId, config))) {
      await interaction.reply(privateReply('Bu kayıt odası veya rank seçimi sana ait değil.'));
      return true;
    }
    const data = pending.get(ownerId);
    if (!data || data.channelId !== interaction.channelId || data.expiresAt < Date.now()) {
      await interaction.reply(privateReply('Önce **Kayıt Ol** butonuna basıp isim ve Riot ID bilgilerini girmelisin.'));
      return true;
    }
    await interaction.reply({
      content: `💎 **${safe(data.nickname)}** için VALORANT rankını seç:`,
      components: [rankMenu(ownerId)],
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    return true;
  }
  if (interaction.isButton() && id.startsWith(`${IDS.questionButton}:`)) {
    const ownerId = id.slice(IDS.questionButton.length + 1);
    if (!(await isValidTicket(interaction, ownerId, config))) {
      await interaction.reply(privateReply('Bu özel kayıt odası sana ait değil.'));
      return true;
    }
    await interaction.showModal(questionModalFor(ownerId));
    return true;
  }
  if (interaction.isModalSubmit() && id.startsWith(`${IDS.welcomeQuestionModal}:`)) {
    const ownerId = id.slice(IDS.welcomeQuestionModal.length + 1);
    const welcome = await getWelcome(interaction.guild, config);
    if (ownerId !== interaction.user.id || !welcome || interaction.channelId !== welcome.id) {
      await interaction.reply(privateReply('Bu form yalnızca #welcome kanalından açılabilir.'));
      return true;
    }
    await createPermanentQuestion(interaction);
    return true;
  }
  if (interaction.isModalSubmit() && id.startsWith(`${IDS.questionModal}:`)) {
    const ownerId = id.slice(IDS.questionModal.length + 1);
    if (ownerId !== interaction.user.id || !(await isValidTicket(interaction, ownerId, config))) {
      await interaction.reply(privateReply('Bu soru formu sana ait değil veya kayıt odası geçersiz.'));
      return true;
    }
    // Kayıt odası arşivlenince soruya erişim kaybolmasın: ayrı SORULAR kanalına yaz.
    await createPermanentQuestion(interaction);
    return true;
  }
  if (interaction.isButton() && id.startsWith(`${IDS.form}:`)) {
    const ownerId = id.slice(IDS.form.length + 1);
    if (!(await isValidTicket(interaction, ownerId, config))) {
      await interaction.reply(privateReply('Bu kayıt kanalı sana ait değil ya da geçersiz.'));
      return true;
    }
    if (processing.has(ownerId)) {
      await interaction.reply(privateReply('Kaydın işleniyor.'));
      return true;
    }
    // Modal must be the first response to this button interaction.
    await interaction.showModal(modalFor(ownerId));
    return true;
  }
  if (interaction.isModalSubmit() && id.startsWith(`${IDS.modal}:`)) {
    const ownerId = id.slice(IDS.modal.length + 1);
    if (!(await isValidTicket(interaction, ownerId, config))) {
      await interaction.reply(privateReply('Kayıt bilgilerin yalnızca kendi özel kayıt kanalında geçerli.'));
      return true;
    }
    const realName = cleanInput(interaction.fields.getTextInputValue(IDS.realName));
    const gameName = cleanInput(interaction.fields.getTextInputValue(IDS.gameName));
    const nickname = `${realName} (${gameName})`;
    if (!/^[\p{L}][\p{L}\s.'’-]*$/u.test(realName)) {
      await interaction.reply(privateReply('Gerçek adında yalnızca harf ve temel noktalama kullan. Kayıt butonuna tekrar bas.'));
      return true;
    }
    if (gameName.includes('@everyone') || gameName.includes('@here') || /[<>\n\r]/u.test(gameName)) {
      await interaction.reply(privateReply('Oyun içi adında geçersiz karakterler var. Tekrar dene.'));
      return true;
    }
    if (nickname.length > 32) {
      await interaction.reply(privateReply(`Takma adın ${nickname.length} karakter. Discord sınırı 32; daha kısa yaz.`));
      return true;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    pending.set(ownerId, { nickname, channelId: interaction.channelId, expiresAt: Date.now() + PENDING_MS });
    try {
      await interaction.editReply('✅ İsim ve Riot ID bilgilerin alındı. Şimdi yukarıdaki **Rankını Seç** butonuna basıp seviyeni belirle.');
    } catch (err) {
      pending.delete(ownerId);
      console.error('Rank menüsü gönderme hatası:', err);
      await interaction.editReply('❌ İşlem tamamlanamadı. Bir kez daha dene.');
    }
    return true;
  }
  if (interaction.isStringSelectMenu() && id.startsWith(`${IDS.select}:`)) {
    const ownerId = id.slice(IDS.select.length + 1);
    if (!(await isValidTicket(interaction, ownerId, config))) {
      await interaction.reply(privateReply('Bu rank seçimi sana ait değil.'));
      return true;
    }
    await interaction.deferUpdate();
    const data = pending.get(ownerId);
    if (!data || data.channelId !== interaction.channelId || data.expiresAt < Date.now()) {
      pending.delete(ownerId);
      await interaction.editReply({ content: '⌛ Süren doldu veya bot yeniden başladı. Yukarıdaki **Kayıt Bilgilerini Gir** butonuna yeniden bas.', components: [] });
      return true;
    }
    const rank = RANKS.find(item => item.key === interaction.values[0]);
    if (!rank) {
      await interaction.editReply({ content: 'Geçersiz rank.', components: [] });
      return true;
    }
    if (processing.has(ownerId)) return true;
    processing.add(ownerId);
    try {
      const guild = interaction.guild;
      const [member, bot, allRanks, memberRole, unverifiedRole] = await Promise.all([
        guild.members.fetch(ownerId), guild.members.fetchMe(), findRanks(guild),
        guild.roles.fetch(config.memberRoleId), guild.roles.fetch(config.unverifiedRoleId),
      ]);
      const rankRole = allRanks.get(rank.key);
      if (unsafeMemberRole(memberRole) || !rankRole || rankRole.permissions.bitfield !== 0n) {
        await interaction.editReply({ content: '❌ Güvenlik kontrolü: Üye veya rank rolünün izinleri uygunsuz. Yetkiliye bildir.', components: [] });
        return true;
      }
      if (![memberRole, unverifiedRole, rankRole].every(role => manageableRole(role, bot, guild))) {
        await interaction.editReply({ content: '❌ KRATOS bot rolü, Üye/Kayıtsız/rank rollerinin üstünde olmalı.', components: [] });
        return true;
      }
      if (!member.roles.cache.has(memberRole.id)) await member.roles.add(memberRole, 'KRATOS kayıt: Üye');
      if (!member.roles.cache.has(rankRole.id)) await member.roles.add(rankRole, `KRATOS kayıt: ${rank.name}`);
      for (const [key, role] of allRanks) {
        if (key !== rank.key && role && member.roles.cache.has(role.id) && manageableRole(role, bot, guild)) {
          await member.roles.remove(role, 'KRATOS: Önceki rank kaldırıldı');
        }
      }
      if (member.roles.cache.has(unverifiedRole.id)) await member.roles.remove(unverifiedRole, 'KRATOS kayıt tamamlandı');
      let nicknameNote = '';
      if (!bot.permissions.has(PermissionFlagsBits.ManageNicknames) || !member.manageable) {
        nicknameNote = '\n⚠️ Takma adını değiştiremedim; bot rol sırasını/yetkilerini kontrol et.';
      } else {
        try { await member.setNickname(data.nickname, 'KRATOS: Kayıt takma adı'); }
        catch (err) { console.error('Takma ad ayarlama hatası:', err); nicknameNote = '\n⚠️ Takma ad değiştirilemedi.'; }
      }
      pending.delete(ownerId);
      const archiveAfter = Date.now() + 30_000;
      let archiveStatus = '\n\n📁 Kanalın **30 saniye sonra** özel **KAYIT ARŞİVİ** kategorisine taşınacak.';
      try {
        // Durable marker ensures scheduled archiving survives a bot restart.
        await interaction.channel.setTopic(
          `${REG_TOPIC}${ownerId}${ARCHIVE_MARKER}${archiveAfter}${ARCHIVE_NICK_MARKER}${encodeURIComponent(data.nickname)}`,
          'KRATOS: Kayıt tamamlandı; 30 saniye sonra nick ismiyle arşiv',
        );
      } catch (err) {
        console.error('Kayıt arşiv tarihi kaydedilemedi:', err);
        archiveStatus += '\n⚠️ Arşiv zamanını kaydedemedim; botu yeniden başlatmadan önce Kanalları Yönet iznini kontrol et.';
      }
      scheduleArchive(guild, interaction.channelId, archiveAfter);
      await interaction.editReply({
        content: '',
        embeds: [new EmbedBuilder()
          .setColor(0x27C39F)
          .setTitle('✅  KAYIT TAMAMLANDI')
          .setDescription(`**Takma ad:** ${safe(data.nickname)}\n**Rank:** ${rank.emoji} ${rank.name}\n\n**Üye** rolün verildi, **Kayıtsız** rolün kaldırıldı.${nicknameNote}${archiveStatus}`)
          .setFooter({ text: 'KRATOS • Aramıza hoş geldin!' })],
        components: [], allowedMentions: { parse: [] },
      });
    } catch (err) {
      console.error('Özel kanalda kayıt hatası:', err);
      await interaction.editReply({ content: '❌ Kayıt tamamlanamadı. Botun rol/yetki ayarlarını kontrol ettir. Kanal açık kalacak.', components: [] }).catch(console.error);
    } finally {
      processing.delete(ownerId);
    }
    return true;
  }
  return false;
}
