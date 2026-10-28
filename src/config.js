import 'dotenv/config';

const required = [
  'DISCORD_TOKEN',
  'CLIENT_ID',
  'GUILD_ID',
  'UNVERIFIED_ROLE_ID',
  'MEMBER_ROLE_ID',
];

for (const name of required) {
  const value = process.env[name];
  if (!value || value.startsWith('BURAYA_')) {
    throw new Error(`.env dosyasinda ${name} alanini doldurmalisin.`);
  }
}

export const config = Object.freeze({
  token: process.env.DISCORD_TOKEN,
  clientId: process.env.CLIENT_ID,
  guildId: process.env.GUILD_ID,
  unverifiedRoleId: process.env.UNVERIFIED_ROLE_ID,
  memberRoleId: process.env.MEMBER_ROLE_ID,
  welcomeChannelId: process.env.WELCOME_CHANNEL_ID || null,
  musicChannelId: process.env.MUSIC_CHANNEL_ID || null,
});
