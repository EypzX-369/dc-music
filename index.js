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
            prefetchedNext: null,
            nowPlayingMsg: null
        };
        queues.set(message.guild.id, queue);
        setupPlayerListeners(queue, message.guild.id);
    }

    try {
        if (query.includes('spotify.com/playlist/')) {
            const loadingMsg = await message.channel.send('⏳ Loading playlist...');
            const res = await axios.get(`${PLAYLIST_API}${encodeURIComponent(query)}`);
            const tracks = res.data?.result?.tracks;
            if (!tracks || tracks.length === 0) return loadingMsg.edit('❌ Could not load playlist.');
            for (const t of tracks) {
                queue.songs.push({ title: `${t.name} ${t.artist}`, url: t.share_url || `${t.name} ${t.artist}` });
            }
            await loadingMsg.edit({
                content: null,
                embeds: [new EmbedBuilder().setDescription(`✅ Added **${tracks.length} tracks** to the queue.`).setColor('#1DB954')]
            });
        } else {
            queue.songs.push({ title: query, url: query });
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

async function fetchTrackData(query) {
    try {
        const res = await axios.get(`${DOWNLOAD_API}${encodeURIComponent(query)}`, { timeout: 15000 });
        return res.data?.status ? res.data.result : null;
    } catch (err) {
        console.error('fetchTrackData error:', err.message);
        return null;
    }
}

// Download the audio URL as a readable stream and pipe into discord
async function fetchAudioStream(url) {
    const res = await axios.get(url, {
        responseType: 'stream',
        timeout: 30000,
        headers: {
            'User-Agent': 'Mozilla/5.0',
            'Range': 'bytes=0-'
        }
    });
    return res.data; // this is a Node.js Readable stream
}

async function playNext(guildId) {
    const queue = queues.get(guildId);
    if (!queue || queue.songs.length === 0) {
        if (queue?.connection) queue.connection.destroy();
        queues.delete(guildId);
        return;
    }

    const song = queue.songs[0];
    let trackData = queue.prefetchedNext || await fetchTrackData(song.url || song.title);
    queue.prefetchedNext = null;

    if (!trackData) {
        console.warn('No track data for:', song.title);
        queue.songs.shift();
        return playNext(guildId);
    }

    // Log the URL so you can verify what's being fetched
    console.log('Playing URL:', trackData.url);

    let resource;
    try {
        // Pipe the download stream directly — works even without ffmpeg installed globally
        const audioStream = await fetchAudioStream(trackData.url);
        resource = createAudioResource(audioStream, {
            inputType: StreamType.Arbitrary,
            inlineVolume: true
        });
        resource.volume.setVolume(queue.volume);
    } catch (err) {
        console.error('Audio stream error:', err.message);
        queue.songs.shift();
        return playNext(guildId);
    }

    queue.player.play(resource);

    // Delete old embed (no playlist spam)
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

    // Pre-fetch next track 30s before end
    if (durationSec > 35 && queue.songs.length > 1) {
        setTimeout(async () => {
            const q = queues.get(guildId);
            if (q && q.songs.length > 1) {
                q.prefetchedNext = await fetchTrackData(q.songs[1].url || q.songs[1].title);
            }
        }, (durationSec - 30) * 1000);
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
