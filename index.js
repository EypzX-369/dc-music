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

const TOKEN = process.env.BOT_TOKEN;
const DOWNLOAD_API = 'https://eypz.koyeb.app/api/dl?q=';
const PLAYLIST_API  = 'https://eypz.koyeb.app/api/playlist?url=';

const queues = new Map();

// --- STARTUP ---
client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    try {
        await client.application.commands.set([]);
        for (const guild of client.guilds.cache.values()) {
            await guild.commands.set([]);
        }
        console.log('Slash commands cleared');
    } catch (err) {
        console.error('Cleanup error:', err);
    }
});

// --- MESSAGE HANDLER ---
client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.content) return;

    const query = message.content.trim();

    // Ignore very short messages that aren't URLs (avoid reacting to every chat message)
    if (!query.startsWith('http') && query.length <= 3) return;

    handlePlayRequest(message, query);
});

// --- PLAY REQUEST ---
async function handlePlayRequest(message, query) {
    const voiceChannel = message.member?.voice?.channel;
    if (!voiceChannel) {
        return message.reply('❌ Please join a voice channel first.');
    }

    let queue = queues.get(message.guild.id);

    if (!queue) {
        const player = createAudioPlayer();
        queue = {
            textChannel: message.channel,
            voiceChannel,
            connection: null,
            player,
            songs: [],
            volume: 0.5,
            prefetchedNext: null,
            nowPlayingMsg: null
        };
        queues.set(message.guild.id, queue);
        setupPlayerListeners(queue, message.guild.id);
    }

    try {
        // --- Spotify playlist ---
        if (query.includes('spotify.com/playlist/')) {
            const loadingMsg = await message.channel.send('⏳ Loading playlist...');
            const res = await axios.get(`${PLAYLIST_API}${encodeURIComponent(query)}`);
            const tracks = res.data?.result?.tracks;
            if (!tracks || tracks.length === 0) {
                return loadingMsg.edit('❌ Could not load playlist.');
            }
            for (const t of tracks) {
                queue.songs.push({ title: `${t.name} ${t.artist}`, url: t.share_url || `${t.name} ${t.artist}` });
            }
            await loadingMsg.edit({
                content: null,
                embeds: [
                    new EmbedBuilder()
                        .setDescription(`✅ Added **${tracks.length} tracks** to the queue.`)
                        .setColor('#1DB954')
                ]
            });

        } else {
            // Single track — just push, don't send embed here (playNext will)
            queue.songs.push({ title: query, url: query });
            if (queue.connection && queue.songs.length > 1) {
                // Already playing something — confirm queued
                await message.channel.send({
                    embeds: [
                        new EmbedBuilder()
                            .setDescription(`🎵 Added to queue: \`${query}\``)
                            .setColor('#0099FF')
                    ]
                });
            }
        }

        // --- Connect if not already connected ---
        if (!queue.connection) {
            queue.connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: message.guild.id,
                adapterCreator: message.guild.voiceAdapterCreator,
                selfDeaf: false,   // FIX: was true — caused deafen issue
                selfMute: false
            });

            try {
                await entersState(queue.connection, VoiceConnectionStatus.Ready, 20_000);
                queue.connection.subscribe(queue.player);
                await playNext(message.guild.id);
            } catch (err) {
                console.error('Voice connection error:', err);
                queue.connection.destroy();
                queues.delete(message.guild.id);
                message.channel.send('❌ Failed to join voice channel.');
            }
        }

    } catch (error) {
        console.error('handlePlayRequest error:', error);
        message.channel.send('❌ Something went wrong.');
    }
}

// --- FETCH TRACK ---
async function fetchTrackData(query) {
    try {
        const res = await axios.get(`${DOWNLOAD_API}${encodeURIComponent(query)}`, { timeout: 15000 });
        return res.data?.status ? res.data.result : null;
    } catch (err) {
        console.error('fetchTrackData error:', err.message);
        return null;
    }
}

// --- PLAY NEXT ---
async function playNext(guildId) {
    const queue = queues.get(guildId);
    if (!queue || queue.songs.length === 0) {
        if (queue?.connection) {
            queue.connection.destroy();
        }
        queues.delete(guildId);
        return;
    }

    const song = queue.songs[0];

    // Use prefetched data if available, otherwise fetch now
    let trackData = queue.prefetchedNext || await fetchTrackData(song.url || song.title);
    queue.prefetchedNext = null;

    if (!trackData) {
        console.warn('No track data for:', song.title);
        queue.songs.shift();
        return playNext(guildId);
    }

    // FIX: Use StreamType.Arbitrary with ffmpeg OR let discord.js auto-handle
    // Removed explicit StreamType to let the library probe and decode automatically
    let resource;
    try {
        resource = createAudioResource(trackData.url, {
            inlineVolume: true,
            // No inputType — let @discordjs/voice auto-detect (works with most direct URLs)
        });
        resource.volume.setVolume(queue.volume);
    } catch (err) {
        console.error('createAudioResource error:', err);
        queue.songs.shift();
        return playNext(guildId);
    }

    queue.player.play(resource);

    // --- Delete old now-playing message to avoid embed spam ---
    if (queue.nowPlayingMsg) {
        try { await queue.nowPlayingMsg.delete(); } catch (_) {}
        queue.nowPlayingMsg = null;
    }

    // --- Build embed ---
    const durationSec = Math.floor(trackData.duration || 0);
    const durationStr = durationSec > 0
        ? `${Math.floor(durationSec / 60)}:${String(durationSec % 60).padStart(2, '0')}`
        : 'Unknown';

    const embed = new EmbedBuilder()
        .setTitle('🎵 Now Playing')
        .setDescription(`**${trackData.title || song.title}**`)
        .setColor('#0099FF')
        .addFields(
            { name: '⏱ Duration', value: durationStr, inline: true },
            { name: '📋 Queue', value: `${queue.songs.length} track(s)`, inline: true }
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
        console.error('Failed to send now-playing embed:', err);
    }

    // --- Gapless pre-fetch: 30s before end ---
    if (durationSec > 35 && queue.songs.length > 1) {
        const delay = (durationSec - 30) * 1000;
        setTimeout(async () => {
            const currentQueue = queues.get(guildId);
            if (currentQueue && currentQueue.songs.length > 1) {
                currentQueue.prefetchedNext = await fetchTrackData(
                    currentQueue.songs[1].url || currentQueue.songs[1].title
                );
            }
        }, delay);
    }
}

// --- PLAYER EVENTS ---
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

// --- BUTTON COLLECTOR ---
function setupCollector(message, queue, guildId) {
    const collector = message.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: 600_000 // 10 minutes
    });

    collector.on('collect', async (i) => {
        await i.deferReply({ ephemeral: true });

        switch (i.customId) {
            case 'pause':
                if (queue.player.state.status === AudioPlayerStatus.Playing) {
                    queue.player.pause();
                    await i.editReply('⏸ Paused.');
                } else {
                    queue.player.unpause();
                    await i.editReply('▶️ Resumed.');
                }
                break;

            case 'skip':
                queue.player.stop(); // triggers Idle → playNext
                await i.editReply('⏭ Skipped.');
                break;

            case 'stop':
                queue.songs = [];
                queue.player.stop();
                queue.connection?.destroy();
                queues.delete(guildId);
                await i.editReply('⏹ Stopped and disconnected.');
                collector.stop();
                break;

            case 'vol_up':
                queue.volume = Math.min(queue.volume + 0.1, 1);
                queue.player.state.resource?.volume?.setVolume(queue.volume);
                await i.editReply(`🔊 Volume: **${Math.round(queue.volume * 100)}%**`);
                break;

            case 'vol_down':
                queue.volume = Math.max(queue.volume - 0.1, 0);
                queue.player.state.resource?.volume?.setVolume(queue.volume);
                await i.editReply(`🔉 Volume: **${Math.round(queue.volume * 100)}%**`);
                break;
        }
    });

    collector.on('end', () => {
        // Disable buttons when collector expires
        message.edit({ components: [] }).catch(() => {});
    });
}

client.login(TOKEN);
