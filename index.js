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
    VoiceConnectionStatus,
    entersState,
    StreamType
} = require('@discordjs/voice');
const axios = require('axios');
const http = require('http');
require('dotenv').config();

// --- RENDER KEEP-ALIVE ---
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
    res.writeHead(200);
    res.end('Music Bot is Online');
}).listen(PORT);

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates
    ]
});

// Settings
const TOKEN = process.env.BOT_TOKEN;
const DOWNLOAD_API = 'https://eypz.koyeb.app/api/dl?q=';
const PLAYLIST_API = 'https://eypz.koyeb.app/api/playlist?url=';

const queues = new Map();

// --- STARTUP LOGIC ---
client.once('ready', async () => {
    console.log('Bot logged in');
    try {
        // Clean up all slash commands
        await client.application.commands.set([]);
        client.guilds.cache.forEach(async (guild) => {
            await guild.commands.set([]);
        });
        console.log('Global and Guild commands cleared');
    } catch (error) {
        console.error('Cleanup error:', error);
    }
});

// --- MESSAGE HANDLER ---
client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.content) return;

    const query = message.content.trim();
    if (query.startsWith('http') || query.length > 2) {
        handlePlayRequest(message, query);
    }
});

async function handlePlayRequest(message, query) {
    const voiceChannel = message.member?.voice.channel;
    if (!voiceChannel) return message.reply('Join a voice channel first');

    let queue = queues.get(message.guild.id);

    if (!queue) {
        queue = {
            textChannel: message.channel,
            voiceChannel: voiceChannel,
            connection: null,
            player: createAudioPlayer(),
            songs: [],
            volume: 0.5,
            prefetchedNext: null
        };
        queues.set(message.guild.id, queue);
        setupPlayerListeners(queue, message.guild.id);
    }

    try {
        if (query.includes('spotify.com/playlist/')) {
            const res = await axios.get(`${PLAYLIST_API}${encodeURIComponent(query)}`);
            const tracks = res.data.result.tracks;
            tracks.forEach(t => queue.songs.push({ title: `${t.name} ${t.artist}`, url: t.share_url }));
            message.channel.send({ embeds: [new EmbedBuilder().setDescription(`Loaded ${tracks.length} tracks`).setColor('#00FF00')] });
        } else {
            queue.songs.push({ title: query, url: query });
        }

        if (!queue.connection) {
            queue.connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: message.guild.id,
                adapterCreator: message.guild.voiceAdapterCreator,
                selfDeaf: true,
                selfMute: false
            });

            try {
                await entersState(queue.connection, VoiceConnectionStatus.Ready, 20_000);
                queue.connection.subscribe(queue.player);
                playNext(message.guild.id);
            } catch (err) {
                queue.connection.destroy();
                queues.delete(message.guild.id);
            }
        }
    } catch (error) {
        console.error('Play error:', error);
    }
}

async function fetchTrackData(query) {
    try {
        const res = await axios.get(`${DOWNLOAD_API}${encodeURIComponent(query)}`);
        return res.data.status ? res.data.result : null;
    } catch {
        return null;
    }
}

async function playNext(guildId) {
    const queue = queues.get(guildId);
    if (!queue || queue.songs.length === 0) {
        queue?.connection?.destroy();
        queues.delete(guildId);
        return;
    }

    let trackData = queue.prefetchedNext || await fetchTrackData(queue.songs[0].url || queue.songs[0].title);
    queue.prefetchedNext = null;

    if (!trackData) {
        queue.songs.shift();
        return playNext(guildId);
    }

    // Direct Download URL Fix: Using StreamType.Arbitrary to force FFmpeg processing
    const resource = createAudioResource(trackData.url, { 
        inlineVolume: true,
        inputType: StreamType.Arbitrary 
    });
    
    resource.volume.setVolume(queue.volume);
    queue.player.play(resource);

    const embed = new EmbedBuilder()
        .setTitle('Now Playing')
        .setDescription(trackData.title)
        .setThumbnail(trackData.thumbnail)
        .setColor('#0099FF')
        .addFields({ name: 'Duration', value: `${Math.floor(trackData.duration)}s`, inline: true });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('pause').setLabel('Pause').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('skip').setLabel('Skip').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('stop').setLabel('Stop').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('vol_up').setLabel('Vol +').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('vol_down').setLabel('Vol -').setStyle(ButtonStyle.Success)
    );

    const msg = await queue.textChannel.send({ embeds: [embed], components: [row] });

    // Gapless pre-fetch: 30 seconds before track ends
    const preFetchDelay = (trackData.duration - 30) * 1000;
    if (preFetchDelay > 0) {
        setTimeout(async () => {
            if (queue.songs.length > 1) {
                queue.prefetchedNext = await fetchTrackData(queue.songs[1].url || queue.songs[1].title);
            }
        }, preFetchDelay);
    }

    setupCollector(msg, queue, guildId);
}

function setupPlayerListeners(queue, guildId) {
    queue.player.on(AudioPlayerStatus.Idle, () => {
        queue.songs.shift();
        playNext(guildId);
    });

    queue.player.on('error', error => {
        console.error('Player error:', error.message);
        queue.songs.shift();
        playNext(guildId);
    });
}

function setupCollector(message, queue, guildId) {
    const collector = message.createMessageComponentCollector({ componentType: ComponentType.Button, time: 600000 });

    collector.on('collect', async (i) => {
        if (i.customId === 'pause') {
            if (queue.player.state.status === AudioPlayerStatus.Playing) {
                queue.player.pause();
                await i.reply({ content: 'Playback paused', ephemeral: true });
            } else {
                queue.player.unpause();
                await i.reply({ content: 'Playback resumed', ephemeral: true });
            }
        } else if (i.customId === 'skip') {
            queue.player.stop();
            await i.reply({ content: 'Skipping track', ephemeral: true });
        } else if (i.customId === 'stop') {
            queue.songs = [];
            queue.player.stop();
            queue.connection.destroy();
            queues.delete(guildId);
            await i.reply({ content: 'Stopped and disconnected', ephemeral: true });
        } else if (i.customId === 'vol_up') {
            queue.volume = Math.min(queue.volume + 0.1, 1);
            queue.player.state.resource?.volume?.setVolume(queue.volume);
            await i.reply({ content: `Volume: ${Math.round(queue.volume * 100)}%`, ephemeral: true });
        } else if (i.customId === 'vol_down') {
            queue.volume = Math.max(queue.volume - 0.1, 0);
            queue.player.state.resource?.volume?.setVolume(queue.volume);
            await i.reply({ content: `Volume: ${Math.round(queue.volume * 100)}%`, ephemeral: true });
        }
    });
}

client.login(TOKEN);
