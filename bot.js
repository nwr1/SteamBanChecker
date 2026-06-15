const { Client, GatewayIntentBits, Partials, EmbedBuilder, AttachmentBuilder, REST, Routes } = require('discord.js');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const fs = require('fs');
const puppeteer = require('puppeteer');
const config = require('./config.json');

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel],
});

const trackedFile = './tracked.json';
let tracked = fs.existsSync(trackedFile) ? JSON.parse(fs.readFileSync(trackedFile)) : {};

function saveTracked() {
  fs.writeFileSync(trackedFile, JSON.stringify(tracked, null, 2));
}

function updateWatchingStatus() {
  const count = Object.keys(tracked).length;
  client.user.setActivity(`Watching ${count} cheaters`, { type: 3 });
}

async function getSteamData(steamid) {
  try {
    const res = await fetch(`https://api.steampowered.com/ISteamUser/GetPlayerBans/v1/?key=${config.steamApiKey}&steamids=${steamid}`);
    const json = await res.json();
    return json.players?.[0] || null;
  } catch (e) {
    console.error('Błąd pobierania danych Steam (bans):', e);
    return null;
  }
}

async function getSteamProfile(steamid) {
  try {
    const res = await fetch(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${config.steamApiKey}&steamids=${steamid}`);
    const json = await res.json();
    return json.response?.players?.[0] || null;
  } catch (e) {
    console.error('Data Download Error Steam (profile):', e);
    return null;
  }
}

async function screenshotProfile(steamid) {
  const url = `https://steamcommunity.com/profiles/${steamid}`;
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'networkidle2' });
  await page.setViewport({ width: 1200, height: 800 });
  const buffer = await page.screenshot({ type: 'png', fullPage: true });
  await browser.close();
  return buffer;
}

function getBanTypes(data) {
  const bans = [];
  if (data.VACBanned) bans.push('VAC Ban');
  if (data.CommunityBanned) bans.push('Community Ban');
  if (data.NumberOfGameBans > 0) bans.push('Game Ban');
  return bans.length > 0 ? bans.join(', ') : 'no bans';
}

async function sendBanAlert(steamid, data) {
  const channel = client.channels.cache.get(config.channelId);
  if (!channel) return console.log('Could not find channel from config.channelId');

  const profile = await getSteamProfile(steamid);
  const nickname = profile?.personaname || 'Unknown';
  const steamLink = steamid ? `https://steamcommunity.com/profiles/${steamid}` : '';

  const screenshotBuffer = await screenshotProfile(steamid);
  const file = new AttachmentBuilder(screenshotBuffer, { name: 'profile.png' });

const embed = new EmbedBuilder()
    .setTitle(`🚨 cheater get banned - ${nickname}`)
    .setURL(`https://steamcommunity.com/profiles/${steamid}`)
    .setDescription(`   `)
    .setColor(0xff0000)
    .addFields(
      { name: 'SteamID64:', value: steamid, inline: false },
      { name: 'Type of ban:', value: getBanTypes(data), inline: false }
    )
    .setImage('attachment://profile.png')
	  .setFooter({
  text: 'made by cheerry.cc' })
    .setTimestamp();

  await channel.send({ embeds: [embed], files: [file] });
}

async function checkAllTracked() {
  for (const steamid of Object.keys(tracked)) {
    try {
      const data = await getSteamData(steamid);
      if (!data) continue;

      const wasBanned = tracked[steamid].banned;
      const isBanned = data.VACBanned || data.CommunityBanned || data.NumberOfGameBans > 0;

      if (isBanned && !wasBanned) {
        await sendBanAlert(steamid, data);
        delete tracked[steamid];
        saveTracked();
        updateWatchingStatus();
        console.log(`Account ban detected ${steamid} and removed from the list.`);
      } else {
        tracked[steamid].banned = isBanned;
        saveTracked();
      }
    } catch (e) {
      console.error(`Error while checking account ${steamid}:`, e);
    }
  }
}

client.once('ready', async () => {
  console.log(`logged on ${client.user.tag}`);
  await checkAllTracked();
  updateWatchingStatus();
  setInterval(checkAllTracked, 24 * 60 * 60 * 1000); // codziennie
});

const commands = [
  {
    name: 'track',
    description: 'adds an account to tracking',
    options: [{ name: 'steamid', description: 'SteamID64', type: 3, required: true }]
  },
  {
    name: 'untrack',
    description: 'removes the account from tracking',
    options: [{ name: 'steamid', description: 'SteamID64', type: 3, required: true }]
  },
  {
    name: 'checknow',
    description: 'checks if the account is already banned',
    options: [{ name: 'steamid', description: 'SteamID64', type: 3, required: true }]
  }
];

const rest = new REST({ version: '10' }).setToken(config.token);
(async () => {
  try {
    await rest.put(
      Routes.applicationGuildCommands(config.clientId, config.guildId),
      { body: commands }
    );
    console.log('Slash commands registered.');
  } catch (error) {
    console.error(error);
  }
})();

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, options } = interaction;

  if (commandName === 'track') {
    const steamid = options.getString('steamid');
    if (tracked[steamid]) {
      await interaction.reply({ content: 'This account is already being tracked.', flags: 1 << 6 });
      return;
    }

    tracked[steamid] = { banned: false };
    saveTracked();
    updateWatchingStatus();
    await interaction.reply({ content: `Added account ${steamid} to track.`, flags: 1 << 6 });
  }

  else if (commandName === 'untrack') {
    const steamid = options.getString('steamid');
    if (!tracked[steamid]) {
      await interaction.reply({ content: 'This account is not tracked.', flags: 1 << 6 });
      return;
    }

    delete tracked[steamid];
    saveTracked();
    updateWatchingStatus();
    await interaction.reply({ content: `Removed account ${steamid} from list.`, flags: 1 << 6 });
  }

  else if (commandName === 'checknow') {
    const steamid = options.getString('steamid');
    await interaction.deferReply({ flags: 1 << 6 });

    try {
      const data = await getSteamData(steamid);
      if (!data) {
        await interaction.editReply('Failed to download data from Steam.');
        return;
      }

      const isBanned = data.VACBanned || data.CommunityBanned || data.NumberOfGameBans > 0;

      if (isBanned) {
        await sendBanAlert(steamid, data);
        if (tracked[steamid]) {
          delete tracked[steamid];
          saveTracked();
          updateWatchingStatus();
        }
        await interaction.editReply('A ban was detected and an alert was sent. The account has been removed from the list.');
      } else {
        await interaction.editReply('This account has no ban.');
      }
    } catch (err) {
      console.error(err);
      await interaction.editReply('An error occurred while checking  account.');
    }
  }
});

client.login(config.token);
ne w
