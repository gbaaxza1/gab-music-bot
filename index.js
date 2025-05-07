// index.js
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  getVoiceConnection
} = require('@discordjs/voice');
const ytdl = require('ytdl-core');
const ytSearch = require('yt-search');
const SpotifyWebApi = require('spotify-web-api-node');
const config = require('./config.json');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

// Per-guild song queues
const queue = new Map();

// Set up Spotify API client
const spotifyApi = new SpotifyWebApi({
  clientId: config.spotify.clientId,
  clientSecret: config.spotify.clientSecret
});

// Refresh Spotify token every hour
async function refreshSpotifyToken() {
  const data = await spotifyApi.clientCredentialsGrant();
  spotifyApi.setAccessToken(data.body.access_token);
}
refreshSpotifyToken();
setInterval(refreshSpotifyToken, 1000 * 60 * 60);

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('messageCreate', async msg => {
  if (!msg.guild || msg.author.bot) return;
  if (!msg.content.startsWith(config.prefix)) return;

  const args = msg.content.slice(config.prefix.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  // Helper to get or create server queue
  let serverQueue = queue.get(msg.guild.id);

  if (command === 'play') {
    const query = args.join(' ');
    if (!query) return msg.reply('❌ You need to give me something to play.');

    let url;
    // 1) Spotify track URL?
    if (query.match(/https?:\/\/(open\.)?spotify\.com\/track\/([A-Za-z0-9]+)/)) {
      const id = query.split('/track/')[1].split('?')[0];
      await refreshSpotifyToken();
      const track = await spotifyApi.getTrack(id);
      url = await ytSearch(`${track.body.name} ${track.body.artists[0].name}`)
        .then(r => r.videos[0]?.url);
    }
    // 2) YouTube URL?
    else if (ytdl.validateURL(query)) {
      url = query;
    }
    // 3) Just search YouTube
    else {
      url = await ytSearch(query).then(r => r.videos[0]?.url);
    }

    if (!url) return msg.reply('❌ Couldn’t find any results.');

    const songInfo = await ytdl.getInfo(url);
    const song = {
      title: songInfo.videoDetails.title,
      url
    };

    if (!serverQueue) {
      // Create queue object
      const qContruct = {
        voiceChannel: msg.member.voice.channel,
        textChannel: msg.channel,
        player: createAudioPlayer(),
        songs: []
      };
      queue.set(msg.guild.id, qContruct);
      qContruct.songs.push(song);

      try {
        const conn = joinVoiceChannel({
          channelId: qContruct.voiceChannel.id,
          guildId: msg.guild.id,
          adapterCreator: msg.guild.voiceAdapterCreator
        });
        conn.subscribe(qContruct.player);
        playSong(msg.guild.id);
      } catch (err) {
        console.error(err);
        queue.delete(msg.guild.id);
        return msg.reply('❌ Could not join your voice channel.');
      }
    } else {
      serverQueue.songs.push(song);
      return msg.reply(`➕ **Added to queue:** ${song.title}`);
    }
  }

  else if (command === 'skip') {
    if (!serverQueue) return msg.reply('❌ Nothing to skip.');
    serverQueue.player.stop();
    msg.reply('⏭ Skipping song...');
  }

  else if (command === 'stop') {
    if (!serverQueue) return msg.reply('❌ Nothing playing.');
    serverQueue.songs = [];
    serverQueue.player.stop();
    getVoiceConnection(msg.guild.id)?.destroy();
    queue.delete(msg.guild.id);
    msg.reply('⏹ Stopped and cleared queue.');
  }

  else if (command === 'queue') {
    if (!serverQueue || !serverQueue.songs.length) return msg.reply('❌ Queue is empty.');
    const list = serverQueue.songs
      .map((s, i) => `\`${i+1}.\` ${s.title}`)
      .join('\n');
    msg.reply(`🎶 **Queue:**\n${list}`);
  }

  else if (command === 'np') {
    if (!serverQueue || !serverQueue.songs.length) return msg.reply('❌ Nothing playing.');
    msg.reply(`▶️ **Now playing:** ${serverQueue.songs[0].title}`);
  }
});

// Plays the first song in the queue, then shifts & recurses
function playSong(guildId) {
  const serverQueue = queue.get(guildId);
  if (!serverQueue) return;

  const song = serverQueue.songs[0];
  if (!song) {
    // queue empty: leave
    getVoiceConnection(guildId)?.destroy();
    queue.delete(guildId);
    return;
  }

  const resource = createAudioResource(
    ytdl(song.url, { filter: 'audioonly', highWaterMark: 1<<25 })
  );
  serverQueue.player.play(resource);

  serverQueue.player.once(AudioPlayerStatus.Idle, () => {
    serverQueue.songs.shift();
    playSong(guildId);
  });
}

client.login(config.token);
