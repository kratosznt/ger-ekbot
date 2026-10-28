// KRATOS v2.2 — butonlu duyuru / etkinlik katilim sistemi.
// Mevcut muzik, kayit, log ve moderasyon modullerinden bagimsizdir.
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const PREFIX = 'kduy';
const STORE_FILE = path.join(process.cwd(), 'data', 'kratos-events.json');
const ME = MessageFlags.Ephemeral;
const RANKS = ['Radyant', 'Ölümsüzlük', 'Yücelik', 'Elmas', 'Platin', 'Altın', 'Gümüş', 'Bronz', 'Demir'];
let storePromise;
let operationChain = Promise.resolve();

function serial(work) {
  const next = operationChain.then(work);
  operationChain = next.catch(() => {});
  return next;
}
async function loadStore() {
  if (!storePromise) {
    storePromise = readFile(STORE_FILE, 'utf8')
      .then(raw => {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || !parsed.events || typeof parsed.events !== 'object') {
          throw new Error('Etkinlik verisi beklenen bicimde degil.');
        }
        return parsed;
      })
      .catch(err => {
        if (err.code === 'ENOENT') return { version: 1, events: {} };
        throw err;
      });
  }
  return storePromise;
}
async function saveStore(next) {
  await mkdir(path.dirname(STORE_FILE), { recursive: true });
  const temporary = `${STORE_FILE}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', 'utf8');
  await rename(temporary, STORE_FILE);
  storePromise = Promise.resolve(next);
}
function memberRank(member) {
  if (!member) return null;
  const roles = [...member.roles.cache.values()];
  return RANKS.find(rank => roles.some(role => role.name.toLocaleLowerCase('tr-TR') === rank.toLocaleLowerCase('tr-TR'))) ?? null;
}
async function participantLines(event, guild) {
  const ids = event.participants;
  const members = await Promise.all(ids.map(id => guild.members.fetch(id).catch(() => null)));
  return ids.map((id, index) => {
    const rank = memberRank(members[index]);
    return `${index + 1}. <@${id}>${rank ? ` · ${rank}` : ''}`;
  });
}
function button(id, action, label, emoji, style, disabled = false) {
  return new ButtonBuilder()
    .setCustomId(`${PREFIX}:${action}:${id}`)
    .setLabel(label)
    .setEmoji(emoji)
    .setStyle(style)
    .setDisabled(disabled);
}
async function renderEvent(event, guild) {
  const amount = event.participants.length;
  const full = amount >= event.capacity;
  const closed = !!event.closed;
  const lines = await participantLines(event, guild);
  const blocks = 12;
  const completed = Math.round((amount / event.capacity) * blocks);
  const progress = '▰'.repeat(completed) + '▱'.repeat(blocks - completed);
  const embed = new EmbedBuilder()
    .setColor(closed ? 0x616B7B : full ? 0x27AE80 : 0x3B91F5)
    .setTitle('👑 KRATOS | ETKİNLİK KATILIMI')
    .setDescription(`**${event.message}**\n\n**Durum:** ${closed ? '🔒 Kapatıldı' : full ? '✅ Kontenjan doldu' : '🟢 Katılım açık'}\n**Düzenleyen:** <@${event.ownerId}>\n**Katılımcı:** **${amount}/${event.capacity}**\n${progress}`)
    .addFields({ name: '👥 Katılımcılar', value: lines.length ? lines.join('\n').slice(0, 1024) : '*Henüz kimse katılmadı.*' })
    .setFooter({ text: 'Katıl veya Ayrıl butonlarını kullan. Aynı kişi yalnızca bir kez katılabilir.' })
    .setTimestamp(new Date(event.createdAt));
  if (event.teams && event.teams.length === 2) {
    embed.addFields(
      { name: '🔵 Mavi Takım', value: event.teams[0].map(id => `<@${id}>`).join('\n'), inline: true },
      { name: '🔴 Kırmızı Takım', value: event.teams[1].map(id => `<@${id}>`).join('\n'), inline: true },
    );
  }
  const row = new ActionRowBuilder().addComponents(
    button(event.id, 'join', 'Katıl', '✅', ButtonStyle.Success, closed || full),
    button(event.id, 'leave', 'Ayrıl', '🚪', ButtonStyle.Secondary, closed),
    button(event.id, 'teams', '5v5 Ayır', '⚔️', ButtonStyle.Primary, closed || event.capacity !== 10 || amount !== 10),
    button(event.id, 'close', closed ? 'Kapalı' : 'Kapat', '🔒', ButtonStyle.Danger, closed),
  );
  return { embeds: [embed], components: [row], allowedMentions: { parse: [] } };
}
function canManage(interaction, ownerId) {
  return interaction.user.id === ownerId ||
    interaction.user.id === interaction.guild.ownerId ||
    !!interaction.memberPermissions?.has(PermissionFlagsBits.ManageEvents);
}
async function safeReply(interaction, text) {
  const payload = { content: text, allowedMentions: { parse: [] } };
  if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
  return interaction.reply({ ...payload, flags: ME });
}
async function createEvent(interaction) {
  if (!interaction.inGuild()) return safeReply(interaction, 'Bu komut yalnızca sunucuda çalışır.');
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageEvents)) {
    return safeReply(interaction, 'Etkinlik başlatmak için **Etkinlikleri Yönet** yetkisi gerekir.');
  }
  await interaction.deferReply({ flags: ME });
  const message = interaction.options.getString('mesaj', true).trim();
  const capacity = interaction.options.getInteger('kapasite') ?? 10;
  if (!message || capacity < 2 || capacity > 20) return safeReply(interaction, 'Mesaj ve kapasiteyi kontrol et (2–20 kişi).');
  const channel = interaction.channel;
  if (!channel?.isTextBased() || !('send' in channel)) return safeReply(interaction, 'Bunu bir metin kanalında kullan.');
  const me = await interaction.guild.members.fetchMe();
  const permissions = channel.permissionsFor(me);
  if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
    return safeReply(interaction, 'Botun bu kanalda **Kanalı Görüntüle, Mesaj Gönder, Bağlantı Yerleştir** izinleri eksik.');
  }
  const event = {
    id: randomUUID(), guildId: interaction.guildId, channelId: channel.id, messageId: null,
    ownerId: interaction.user.id, message, capacity, participants: [], teams: null,
    closed: false, createdAt: new Date().toISOString(),
  };
  const sent = await channel.send(await renderEvent(event, interaction.guild));
  event.messageId = sent.id;
  try {
    await serial(async () => {
      const state = await loadStore();
      await saveStore({ ...state, events: { ...state.events, [event.id]: event } });
    });
  } catch (error) {
    await sent.delete().catch(() => {});
    throw error;
  }
  await safeReply(interaction, `✅ Etkinlik oluşturuldu: ${sent.url}\nÜyeler **Katıl** ve **Ayrıl** butonlarıyla listeyi yönetebilir.`);
}
function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
async function useButton(interaction) {
  await interaction.deferReply({ flags: ME });
  const [, action, id] = interaction.customId.split(':');
  if (!['join', 'leave', 'teams', 'close'].includes(action) || !id) return safeReply(interaction, 'Geçersiz etkinlik işlemi.');
  const response = await serial(async () => {
    const state = await loadStore();
    const original = state.events[id];
    if (!original || original.guildId !== interaction.guildId || original.channelId !== interaction.channelId || original.messageId !== interaction.message.id) {
      return 'Bu etkinlik artık kayıtlı değil veya panelin kimliği değişmiş.';
    }
    if (original.closed) return 'Bu etkinlik kapatıldı.';
    const event = { ...original, participants: [...original.participants], teams: original.teams ? original.teams.map(a => [...a]) : null };
    const alreadyIn = event.participants.includes(interaction.user.id);
    let reply;
    if (action === 'join') {
      if (alreadyIn) return 'Zaten katılımcı listesindesin.';
      if (event.participants.length >= event.capacity) return 'Kontenjan dolu. Birisi ayrılırsa tekrar deneyebilirsin.';
      event.participants.push(interaction.user.id);
      event.teams = null;
      reply = `✅ Katıldın! (${event.participants.length}/${event.capacity})`;
    } else if (action === 'leave') {
      if (!alreadyIn) return 'Zaten listede değilsin.';
      event.participants = event.participants.filter(id => id !== interaction.user.id);
      event.teams = null;
      reply = '🚪 Etkinlik listesinden ayrıldın.';
    } else if (action === 'teams') {
      if (!canManage(interaction, event.ownerId)) return 'Takımları yalnızca etkinliği oluşturan kişi veya yetkililer ayırabilir.';
      if (event.capacity !== 10 || event.participants.length !== 10) return '5v5 takımları ayırmak için kapasite **10** ve katılımcı sayısı **10** olmalı.';
      const mixed = shuffle(event.participants);
      event.teams = [mixed.slice(0, 5), mixed.slice(5)];
      reply = '⚔️ Katılımcılar rastgele 5v5 iki takıma ayrıldı.';
    } else if (action === 'close') {
      if (!canManage(interaction, event.ownerId)) return 'Etkinliği yalnızca oluşturan kişi veya yetkililer kapatabilir.';
      event.closed = true;
      reply = '🔒 Etkinlik kapatıldı. Katılımcı listesi kalıcı olarak panelde görünecek.';
    }
    // Gorsel degisikligini once Discord'a gonder, basariliysa kalici veri olarak yaz.
    await interaction.message.edit(await renderEvent(event, interaction.guild));
    await saveStore({ ...state, events: { ...state.events, [id]: event } });
    return reply;
  });
  await safeReply(interaction, response);
}

// Geriye true donerse bu etkilesim islenmistir ve diger modullere gitmemelidir.
export async function handleAnnouncementInteraction(interaction) {
  const isCommand = interaction.isChatInputCommand() && interaction.commandName === 'duyuru';
  const isButton = interaction.isButton() && interaction.customId.startsWith(`${PREFIX}:`);
  if (!isCommand && !isButton) return false;
  try {
    if (isCommand) await createEvent(interaction);
    else await useButton(interaction);
  } catch (error) {
    console.error('[KRATOS Duyuru] Islem hatasi:', error);
    await safeReply(interaction, '⚠️ İşlem sırasında hata oluştu. Bot izinlerini veya Cursor terminalini kontrol et.').catch(console.error);
  }
  return true;
}
