const { 
    Client, 
    GatewayIntentBits, 
    EmbedBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    ComponentType 
} = require('discord.js');
const { 
    joinVoiceChannel, 
    createAudioPlayer, 
    createAudioResource, 
    AudioPlayerStatus,
    StreamType
} = require('@discordjs/voice');
const axios = require('axios');
const http = require('http');
require('dotenv').config();

// --- KEEP-ALIVE ---
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
    res.writeHead(200);
    res.end('Bot is Online');
}).listen(PORT, () => console.log(`Keep-alive on port ${PORT}`));

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates
    ]
});

const TOKEN = process.env.BOT_TOKEN;
const DOWNLOAD_API = 'https://eypz.koyeb.app/api/dl?q=';
const PLAYLIST_API  = 'https://eypz.koyeb.app/api/playlist?url=';

const queues = new Map();

client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    try {
        await client.application.commands.set([]);
        client.guilds.cache.forEach(async (guild) => await guild.commands.set([]));
        console.log('Slash commands cleared');
    } catch (err) {
        console.error('Cleanup error:', err);
    }
});

client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.content) return;

    const query = message.content.trim();

    // Ignore mentions, commands, very short messages
    if (query.startsWith('<@') || query.startsWith('/') || query.startsWith('!')) return;
    if (!query.startsWith('http') && query.length <= 3) return;

    handlePlayRequest(message, query);
});

async function handlePlayRequest(message, query) {
    const voiceChannel = message.member?.voice?.channel;
    if (!voiceChannel) return message.reply('❌ Join a voice channel first.');

    let queue = queues.get(message.guild.id);

    if (!queue) {
        queue = {
            textChannel: message.channel,
            voiceChannel,
            connection: null,
            player: createAudioPlayer(),
            songs: [],
            volume: 0.5,
            nowPlayingMsg: null
        };
        queues.set(message.guild.id, queue);
        setupPlayerListeners(queue, message.guild.id);
    }

    try {
        if (query.includes('spotify.com/playlist/')) {
            const loadingMsg = await message.channel.send('⏳ Loading playlist...');
            const res = await axios.get(`${PLAYLIST_API}${encodeURIComponent(query)}`, { timeout: 20000 });
            const tracks = res.data?.result?.tracks;
            if (!tracks || tracks.length === 0) return loadingMsg.edit('❌ Could not load playlist.');
            for (const t of tracks) {
                // Store search title — we fetch fresh URL right before playing
                queue.songs.push({ title: `${t.name} ${t.artist}` });
            }
            await loadingMsg.edit({
                content: null,
                embeds: [new EmbedBuilder().setDescription(`✅ Added **${tracks.length} tracks** to the queue.`).setColor('#1DB954')]
            });
        } else {
            // Store query as title — fresh URL fetched at play time
            queue.songs.push({ title: query });
            if (queue.connection && queue.songs.length > 1) {
                await message.channel.send({
                    embeds: [new EmbedBuilder().setDescription(`🎵 Added to queue: \`${query}\``).setColor('#0099FF')]
                });
            }
        }

        if (!queue.connection) {
            queue.connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: message.guild.id,
                adapterCreator: message.guild.voiceAdapterCreator,
                selfDeaf: false,
                selfMute: false
            });
            queue.connection.subscribe(queue.player);
            playNext(message.guild.id);
        }

    } catch (err) {
        console.error('handlePlayRequest error:', err);
        message.channel.send('❌ Something went wrong.');
    }
}

// Always fetch a fresh track URL right before playing — download links expire
async function fetchTrackData(title) {
    try {
        console.log('Fetching track:', title);
        const res = await axios.get(`${DOWNLOAD_API}${encodeURIComponent(title)}`, { timeout: 20000 });
        if (!res.data?.status || !res.data?.result?.url) {
            console.warn('No result for:', title);
            return null;
        }
        console.log('Got URL:', res.data.result.url);
        return res.data.result;
    } catch (err) {
        console.error('fetchTrackData error:', err.message);
        return null;
    }
}

async function fetchAudioStream(url) {
    const res = await axios.get(url, {
        responseType: 'stream',
        timeout: 30000,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Range': 'bytes=0-'
        }
    });
    return res.data;
}

async function playNext(guildId) {
    const queue = queues.get(guildId);
    if (!queue || queue.songs.length === 0) {
        if (queue?.connection) queue.connection.destroy();
        queues.delete(guildId);
        return;
    }

    const song = queue.songs[0];

    // Always fetch a fresh URL right now — never cache audio URLs since they expire
    const trackData = await fetchTrackData(song.title);

    if (!trackData) {
        console.warn('Skipping, no track data:', song.title);
        queue.songs.shift();
        return playNext(guildId);
    }

    let resource;
    try {
        const audioStream = await fetchAudioStream(trackData.url);
        resource = createAudioResource(audioStream, {
            inputType: StreamType.Arbitrary,
            inlineVolume: true
        });
        resource.volume.setVolume(queue.volume);
    } catch (err) {
        console.error('Stream error for', song.title, ':', err.message);
        queue.songs.shift();
        return playNext(guildId);
    }

    queue.player.play(resource);

    // Delete old embed (prevents playlist spam)
    if (queue.nowPlayingMsg) {
        try { await queue.nowPlayingMsg.delete(); } catch (_) {}
        queue.nowPlayingMsg = null;
    }

    const durationSec = Math.floor(trackData.duration || 0);
    const durationStr = durationSec > 0
        ? `${Math.floor(durationSec / 60)}:${String(durationSec % 60).padStart(2, '0')}`
        : 'Unknown';

    const remaining = queue.songs.length - 1;
    const queueStr = remaining > 0 ? `${remaining} song(s) remaining` : 'Last song';

    const embed = new EmbedBuilder()
        .setTitle('🎵 Now Playing')
        .setDescription(`**${trackData.title || song.title}**`)
        .setColor('#0099FF')
        .addFields(
            { name: '⏱ Duration', value: durationStr, inline: true },
            { name: '📋 Queue',    value: queueStr,    inline: true }
        );

    if (trackData.thumbnail) embed.setThumbnail(trackData.thumbnail);

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('pause').setLabel('⏸ Pause').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('skip').setLabel('⏭ Skip').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('stop').setLabel('⏹ Stop').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('vol_up').setLabel('🔊+').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('vol_down').setLabel('🔉-').setStyle(ButtonStyle.Success)
    );

    try {
        const msg = await queue.textChannel.send({ embeds: [embed], components: [row] });
        queue.nowPlayingMsg = msg;
        setupCollector(msg, queue, guildId);
    } catch (err) {
        console.error('Failed to send embed:', err);
    }
}

function setupPlayerListeners(queue, guildId) {
    queue.player.on(AudioPlayerStatus.Idle, () => {
        queue.songs.shift();
        playNext(guildId);
    });

    queue.player.on('error', (error) => {
        console.error('Player error:', error.message);
        queue.songs.shift();
        playNext(guildId);
    });
}

function setupCollector(message, queue, guildId) {
    const collector = message.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: 600_000
    });

    collector.on('collect', async (i) => {
        switch (i.customId) {
            case 'pause':
                if (queue.player.state.status === AudioPlayerStatus.Playing) {
                    queue.player.pause();
                    await i.reply({ content: '⏸ Paused.', flags: 64 });
                } else {
                    queue.player.unpause();
                    await i.reply({ content: '▶️ Resumed.', flags: 64 });
                }
                break;

            case 'skip':
                queue.player.stop();
                await i.reply({ content: '⏭ Skipped.', flags: 64 });
                break;

            case 'stop':
                queue.songs = [];
                queue.player.stop();
                queue.connection?.destroy();
                queues.delete(guildId);
                await i.reply({ content: '⏹ Stopped and disconnected.', flags: 64 });
                collector.stop();
                break;

            case 'vol_up':
                queue.volume = Math.min(queue.volume + 0.1, 1);
                queue.player.state.resource?.volume?.setVolume(queue.volume);
                await i.reply({ content: `🔊 Volume: **${Math.round(queue.volume * 100)}%**`, flags: 64 });
                break;

            case 'vol_down':
                queue.volume = Math.max(queue.volume - 0.1, 0);
                queue.player.state.resource?.volume?.setVolume(queue.volume);
                await i.reply({ content: `🔉 Volume: **${Math.round(queue.volume * 100)}%**`, flags: 64 });
                break;
        }
    });

    collector.on('end', () => {
        message.edit({ components: [] }).catch(() => {});
    });
}

client.login(TOKEN);
