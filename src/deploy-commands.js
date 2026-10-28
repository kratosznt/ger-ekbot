import { REST, Routes } from 'discord.js';
import { config } from './config.js';
import { commandData } from './commands.js';

const rest = new REST({ version: '10' }).setToken(config.token);

try {
  const commands = commandData.map(command => command.toJSON());
  console.log(`${commands.length} komut sunucuya yukleniyor...`);
  await rest.put(
    Routes.applicationGuildCommands(config.clientId, config.guildId),
    { body: commands },
  );
  console.log('Komutlar yuklendi. Discord icinde /ping yazmayi dene.');
} catch (error) {
  console.error('Komutlari kaydetme hatasi:', error);
  process.exitCode = 1;
}
