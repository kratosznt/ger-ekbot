import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';

const mod = PermissionFlagsBits.ManageRoles;
const msg = PermissionFlagsBits.ManageMessages;
const ban = PermissionFlagsBits.BanMembers;
const kick = PermissionFlagsBits.KickMembers;
const timeout = PermissionFlagsBits.ModerateMembers;

export const commandData = [
  new SlashCommandBuilder()
    .setName('logkontrol')
    .setDescription('KRATOS log kanalları ve bot izinlerini kontrol et.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('kayitpanel')
    .setDescription('Butonlu kayit panelini bu kanala gonderir, rank rollerini hazirlar.')
    .setDefaultMemberPermissions(mod),

  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('KRATOS botunun cevap verdigini kontrol et.'),

  new SlashCommandBuilder()
    .setName('uyesay')
    .setDescription('Sunucudaki toplam uye sayisini goster.'),

  new SlashCommandBuilder()
    .setName('sil')
    .setDescription('Bu kanaldaki son mesajlardan secilen sayida sil.')
    .addIntegerOption(option => option
      .setName('sayi')
      .setDescription('1 ile 100 arasinda')
      .setMinValue(1)
      .setMaxValue(100)
      .setRequired(true))
    .setDefaultMemberPermissions(msg),

  new SlashCommandBuilder()
    .setName('rolver')
    .setDescription('Bir uyeye yonetebildigin bir rolu ver.')
    .addUserOption(option => option
      .setName('uye').setDescription('Hedef uye').setRequired(true))
    .addRoleOption(option => option
      .setName('rol').setDescription('Verilecek rol').setRequired(true))
    .setDefaultMemberPermissions(mod),

  new SlashCommandBuilder()
    .setName('rolal')
    .setDescription('Bir uyeden yonetebildigin bir rolu al.')
    .addUserOption(option => option
      .setName('uye').setDescription('Hedef uye').setRequired(true))
    .addRoleOption(option => option
      .setName('rol').setDescription('Alinacak rol').setRequired(true))
    .setDefaultMemberPermissions(mod),

  new SlashCommandBuilder()
    .setName('kayit')
    .setDescription('Bir uyeyi kaydet; Kayitsiz rolunu kaldir, Uye rolunu ver.')
    .addUserOption(option => option
      .setName('uye').setDescription('Kaydedilecek uye').setRequired(true))
    .setDefaultMemberPermissions(mod),

  new SlashCommandBuilder()
    .setName('kayitsiz')
    .setDescription('Uyeyi kayitsiz duruma geri al.')
    .addUserOption(option => option
      .setName('uye').setDescription('Kayitsiz yapilacak uye').setRequired(true))
    .setDefaultMemberPermissions(mod),
  // KRATOS v0.7 — Moderasyon, uye bilgi, istatistik, yardim
  new SlashCommandBuilder()
    .setName('ban').setDescription('Yetkinin altindaki bir uyeyi sunucudan yasakla.')
    .addUserOption(o => o.setName('uye').setDescription('Yasaklanacak uye').setRequired(true))
    .addStringOption(o => o.setName('sebep').setDescription('Yasaklama sebebi (istege bagli)').setMaxLength(250))
    .setDefaultMemberPermissions(ban),
  new SlashCommandBuilder()
    .setName('at').setDescription('Yetkinin altindaki bir uyeyi sunucudan at.')
    .addUserOption(o => o.setName('uye').setDescription('Atilacak uye').setRequired(true))
    .addStringOption(o => o.setName('sebep').setDescription('Atma sebebi (istege bagli)').setMaxLength(250))
    .setDefaultMemberPermissions(kick),
  new SlashCommandBuilder()
    .setName('sustur').setDescription('Bir uyeye gecici Discord zaman asimi uygula (dakika).')
    .addUserOption(o => o.setName('uye').setDescription('Susturulacak uye').setRequired(true))
    .addIntegerOption(o => o.setName('dakika').setDescription('1 ile 40320 dakika (en cok 28 gun)').setMinValue(1).setMaxValue(40320).setRequired(true))
    .addStringOption(o => o.setName('sebep').setDescription('Sebep (istege bagli)').setMaxLength(250))
    .setDefaultMemberPermissions(timeout),
  new SlashCommandBuilder()
    .setName('susturkaldir').setDescription('Bir uyenin zaman asimini kaldir.')
    .addUserOption(o => o.setName('uye').setDescription('Zaman asimi kaldirilacak uye').setRequired(true))
    .setDefaultMemberPermissions(timeout),
  new SlashCommandBuilder()
    .setName('uyeinfo').setDescription('Bir uyenin hesap ve sunucu bilgilerini goster.')
    .addUserOption(o => o.setName('uye').setDescription('Bilgisine bakilacak uye (bos: sen)')),
  new SlashCommandBuilder()
    .setName('istatistik').setDescription('Sunucudaki uye, kayitli ve kayitsiz sayilarini goster.'),
  new SlashCommandBuilder()
    .setName('yardim').setDescription('KRATOS komutlarini kategori halinde goster.'),
  // KRATOS v1.0: Yalnizca yoneticiler paneli ilk kez kurabilir / yenileyebilir.
  new SlashCommandBuilder().setName('muzikpanel')
    .setDescription('Tek mesajlik KRATOS muzik kontrol panelini kur / guncelle.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  // KRATOS v0.9: Butun muzik komutlari sadece #muzikcal kanalinda.
  new SlashCommandBuilder().setName('play')
    .setDescription('Ses kanalina katil ve baglantidaki parcayi cal / siraya ekle.')
    .addStringOption(o => o.setName('link').setDescription('SoundCloud, Vimeo veya dogrudan MP3/OGG linki').setRequired(true)),
  new SlashCommandBuilder().setName('stop').setDescription('Muzigi durdur, sirayi temizle ve ses kanalindan ayril.'),
  new SlashCommandBuilder().setName('skip').setDescription('Siradaki parcaya gec.'),
  new SlashCommandBuilder().setName('dongu').setDescription('Listeyi veya tek sarkiyi tekrar et; donguyu kapat.')
    .addStringOption(o => o.setName('mod').setDescription('Bos birakirsan tum liste tekrar eder.')
      .addChoices(
        { name: 'Tum liste', value: 'liste' },
        { name: 'Tek sarki', value: 'sarki' },
        { name: 'Kapali', value: 'kapali' },
      )),
  new SlashCommandBuilder().setName('kuyruk').setDescription('Calmakta olan sarki ve siradakileri goster.'),
  new SlashCommandBuilder().setName('duraklat').setDescription('Muzigi gecici duraklat.'),
  new SlashCommandBuilder().setName('devam').setDescription('Duraklatilan muzigi devam ettir.'),
  new SlashCommandBuilder().setName('calan').setDescription('Su anda calan parcayi goster.'),
  new SlashCommandBuilder().setName('karistir').setDescription('Bekleyen sarkilarin sirasini karistir.'),
  // KRATOS v2.2: Etkinlik/duyuru katilim paneli
  new SlashCommandBuilder()
    .setName('duyuru')
    .setDescription('Butonla katilabilecegin etkinlik duyurusu ac.')
    .addStringOption(o => o.setName('mesaj').setDescription('Ornek: Valorant 5v5 gelmek isteyenler').setRequired(true).setMaxLength(300))
    .addIntegerOption(o => o.setName('kapasite').setDescription('2-20 arasi; varsayilan 10').setMinValue(2).setMaxValue(20))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageEvents),
  // KRATOS v2.4: Riot ID from registered Discord nickname.
  new SlashCommandBuilder()
    .setName('tracker')
    .setDescription('Kayitli bir uyenin izin verdigi VALORANT istatistiklerini goster.')
    .addUserOption(o => o.setName('uye').setDescription('Sunucudaki oyuncu').setRequired(true)),
  new SlashCommandBuilder()
    .setName('trackerizin')
    .setDescription('VALORANT istatistiklerinin sunucuda goruntulenmesine izin ver veya iptal et.')
    .addBooleanOption(o => o.setName('ac').setDescription('Evet: izin ver / Hayir: iptal et').setRequired(true)),
];
