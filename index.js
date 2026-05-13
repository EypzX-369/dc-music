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
    AudioPlayerStatus 
} = require('@discordjs/voice');
const axios = require('axios');
const dotenv = require('dotenv/config');
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

// Queue Management System
const queues = new Map();

// Slash Command Cleanup Logic
client.once('ready', async () => {
    try {
        console.log('Bot is online');
        
        // Remove all global slash commands
        await client.application.commands.set([]);
        console.log('Successfully removed all global slash commands');

        // Optional: Remove guild-specific commands if any exist
        client.guilds.cache.forEach(async (guild) => {
            await guild.commands.set([]);
        });
        
        console.log('Command cleanup complete. Bot is operating via messages and buttons only');
    } catch (error) {
        console.error('Error during command cleanup:', error);
    }
});

client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.content) return;

    const query = message.content.trim();
    if (query.startsWith('http') || query.length > 2) {
        handlePlayRequest(message, query);
    }
});

async function handlePlayRequest(message, query) {
    const voiceChannel = message.member?.voice.channel;
    if (!voiceChannel) return message.reply('You must be in a voice channel');

    let queue = queues.get(message.guild.id);

    if (!queue) {
        queue = {
            textChannel: message.channel,
            voiceChannel: voiceChannel,
            connection: null,
            player: createAudioPlayer(),
            songs: [],
            volume: 0.5,
            playing: true,
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
            message.channel.send({ embeds: [new EmbedBuilder().setDescription(`Added ${tracks.length} tracks from playlist`).setColor('#00FF00')] });
        } else {
            queue.songs.push({ title: query, url: query });
            if (queue.songs.length > 1) {
                message.channel.send({ embeds: [new EmbedBuilder().setDescription(`Added to queue: ${query}`).setColor('#00FF00')] });
            }
        }

        if (!queue.connection) {
            queue.connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: message.guild.id,
    adapterCreator: message.guild.voiceAdapterCreator,
    selfDeaf: false,   // ← add this
    selfMute: false,   // ← and this
});
            queue.connection.subscribe(queue.player);
            playNext(message.guild.id);
        }
    } catch (error) {
        console.error(error);
        message.channel.send({ embeds: [new EmbedBuilder().setDescription('Error processing request').setColor('#FF0000')] });
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

    const resource = createAudioResource(trackData.url, { inlineVolume: true });
    resource.volume.setVolume(queue.volume);
    queue.player.play(resource);
    queue.currentResource = resource;

    const embed = new EmbedBuilder()
        .setTitle('Now Playing')
        .setDescription(trackData.title)
        .setThumbnail(trackData.thumbnail)
        .setColor('#0099FF')
        .addFields({ name: 'Duration', value: `${Math.floor(trackData.duration)} seconds`, inline: true });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('pause').setLabel('Pause').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('skip').setLabel('Skip').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('stop').setLabel('Stop').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('vol_up').setLabel('Volume Up').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('vol_down').setLabel('Volume Down').setStyle(ButtonStyle.Success)
    );

    const msg = await queue.textChannel.send({ embeds: [embed], components: [row] });

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
        console.error(`Error: ${error.message}`);
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
            await i.reply({ content: 'Skipped track', ephemeral: true });
        } else if (i.customId === 'stop') {
            queue.songs = [];
            queue.player.stop();
            queue.connection.destroy();
            queues.delete(guildId);
            await i.reply({ content: 'Stopped and cleared queue', ephemeral: true });
        } else if (i.customId === 'vol_up') {
            queue.volume = Math.min(queue.volume + 0.1, 1);
            queue.currentResource?.volume.setVolume(queue.volume);
            await i.reply({ content: `Volume set to ${Math.round(queue.volume * 100)}%`, ephemeral: true });
        } else if (i.customId === 'vol_down') {
            queue.volume = Math.max(queue.volume - 0.1, 0);
            queue.currentResource?.volume.setVolume(queue.volume);
            await i.reply({ content: `Volume set to ${Math.round(queue.volume * 100)}%`, ephemeral: true });
        }
    });
}

client.login(TOKEN);
