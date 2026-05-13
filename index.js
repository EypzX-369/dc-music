require('dotenv').config();

const express = require('express');
const app = express();

app.get('/', (req, res) => {
    res.send('Bot Running');
});

app.listen(process.env.PORT || 3000, () => {
    console.log('Web server started');
});

const {
    Client,
    GatewayIntentBits,
    EmbedBuilder
} = require('discord.js');

const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    StreamType,
    VoiceConnectionStatus,
    entersState
} = require('@discordjs/voice');

const prism = require('prism-media');
const ffmpeg = require('ffmpeg-static');
const axios = require('axios');
const { spawn } = require('child_process');

const PREFIX = '/';

const API_BASE = 'https://song-dl-0q80.onrender.com';

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates
    ]
});

const queues = new Map();

client.once('clientReady', () => {
    console.log(`Logged in as ${client.user.tag}`);
    console.log('Menu');
});

async function createStream(url) {

    const ffmpegProcess = spawn(ffmpeg, [
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
        '-nostdin',
        '-i', url,
        '-analyzeduration', '0',
        '-loglevel', '0',
        '-f', 's16le',
        '-ar', '48000',
        '-ac', '2',
        'pipe:1'
    ], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
    });

    const opusEncoder = new prism.opus.Encoder({
        rate: 48000,
        channels: 2,
        frameSize: 960
    });

    return createAudioResource(
        ffmpegProcess.stdout.pipe(opusEncoder),
        {
            inputType: StreamType.Opus
        }
    );
}

async function playNext(guildId) {

    const queue = queues.get(guildId);

    if (!queue) return;

    if (queue.songs.length === 0) {

        queue.player.stop();

        queue.connection.destroy();

        queues.delete(guildId);

        return;
    }

    const song = queue.songs.shift();

    try {

        const resource = await createStream(song.url);

        queue.player.play(resource);

        const embed = new EmbedBuilder()
            .setTitle('Now Playing')
            .setDescription(`**${song.title}**`)
            .setThumbnail(song.thumbnail || null);

        queue.textChannel.send({
            embeds: [embed]
        });

    } catch (err) {

        console.log(err);

        playNext(guildId);
    }
}

async function createQueue(message, voiceChannel) {

    const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: voiceChannel.guild.id,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        selfDeaf: true
    });

    connection.on(
        VoiceConnectionStatus.Disconnected,
        async () => {

            try {

                await Promise.race([
                    entersState(
                        connection,
                        VoiceConnectionStatus.Signalling,
                        5000
                    ),

                    entersState(
                        connection,
                        VoiceConnectionStatus.Connecting,
                        5000
                    )
                ]);

            } catch {

                connection.destroy();
            }
        }
    );

    connection.on('stateChange', (oldState, newState) => {

        console.log(
            `Voice State: ${oldState.status} -> ${newState.status}`
        );
    });

    const player = createAudioPlayer();

    connection.subscribe(player);

    const queue = {
        textChannel: message.channel,
        voiceChannel,
        connection,
        player,
        songs: []
    };

    player.on(AudioPlayerStatus.Idle, () => {

        playNext(message.guild.id);
    });

    player.on('error', (err) => {

        console.log(err);

        playNext(message.guild.id);
    });

    queues.set(message.guild.id, queue);

    return queue;
}

client.on('messageCreate', async (message) => {

    try {

        if (message.author.bot) return;

        if (!message.content.startsWith(PREFIX)) return;

        const args = message.content
            .slice(PREFIX.length)
            .trim()
            .split(/ +/);

        const command = args.shift()?.toLowerCase();

        if (command === 'play') {

            const query = args.join(' ');

            if (!query) {
                return message.reply(
                    'Provide song name'
                );
            }

            const voiceChannel =
                message.member.voice.channel;

            if (!voiceChannel) {
                return message.reply(
                    'Join voice channel first'
                );
            }

            const searching =
                await message.reply(
                    'Searching song...'
                );

            const api =
                `${API_BASE}/api/dl?q=${encodeURIComponent(query)}`;

            const { data } =
                await axios.get(api);

            if (
                !data?.status ||
                !data?.result?.url
            ) {
                return searching.edit(
                    'Song not found'
                );
            }

            const song = data.result;

            let queue =
                queues.get(message.guild.id);

            if (!queue) {

                queue =
                    await createQueue(
                        message,
                        voiceChannel
                    );

                if (!queue) return;
            }

            queue.songs.push({
                title: song.title,
                url: song.url,
                thumbnail: song.thumbnail
            });

            await searching.edit(
                `Added to queue: ${song.title}`
            );

            if (
                queue.player.state.status !==
                AudioPlayerStatus.Playing
            ) {

                playNext(message.guild.id);
            }
        }

        else if (command === 'playlist') {

            const url = args[0];

            if (!url) {

                return message.reply(
                    'Provide Spotify playlist URL'
                );
            }

            const voiceChannel =
                message.member.voice.channel;

            if (!voiceChannel) {

                return message.reply(
                    'Join voice channel first'
                );
            }

            const msg =
                await message.reply(
                    'Fetching playlist...'
                );

            const api =
                `${API_BASE}/api/playlist?url=${encodeURIComponent(url)}`;

            const { data } =
                await axios.get(api);

            if (
                !data?.status ||
                !data?.result?.tracks?.length
            ) {

                return msg.edit(
                    'Playlist not found'
                );
            }

            const playlist =
                data.result;

            let queue =
                queues.get(message.guild.id);

            if (!queue) {

                queue =
                    await createQueue(
                        message,
                        voiceChannel
                    );

                if (!queue) return;
            }

            await msg.edit(
                `Adding ${playlist.tracks.length} songs...`
            );

            for (const track of playlist.tracks) {

                try {

                    const search =
                        `${track.name} ${track.artist}`;

                    const dl =
                        await axios.get(
                            `${API_BASE}/api/dl?q=${encodeURIComponent(search)}`
                        );

                    if (
                        dl.data?.status &&
                        dl.data?.result?.url
                    ) {

                        queue.songs.push({
                            title:
                                dl.data.result.title,

                            url:
                                dl.data.result.url,

                            thumbnail:
                                dl.data.result.thumbnail
                        });
                    }

                } catch (err) {

                    console.log(err);
                }
            }

            await msg.edit(
                `Playlist Added\nName: ${playlist.info.name}\nTracks: ${playlist.tracks.length}`
            );

            if (
                queue.player.state.status !==
                AudioPlayerStatus.Playing
            ) {

                playNext(message.guild.id);
            }
        }

        else if (command === 'skip') {

            const queue =
                queues.get(message.guild.id);

            if (!queue) {

                return message.reply(
                    'No queue'
                );
            }

            queue.player.stop();

            message.reply('Skipped');
        }

        else if (command === 'queue') {

            const queue =
                queues.get(message.guild.id);

            if (
                !queue ||
                queue.songs.length === 0
            ) {

                return message.reply(
                    'Queue empty'
                );
            }

            const songs =
                queue.songs
                    .slice(0, 15)
                    .map((s, i) =>
                        `${i + 1}. ${s.title}`
                    )
                    .join('\n');

            const embed =
                new EmbedBuilder()
                    .setTitle('Queue')
                    .setDescription(songs);

            message.reply({
                embeds: [embed]
            });
        }

        else if (command === 'stop') {

            const queue =
                queues.get(message.guild.id);

            if (!queue) {

                return message.reply(
                    'Nothing playing'
                );
            }

            queue.songs = [];

            queue.player.stop();

            queue.connection.destroy();

            queues.delete(message.guild.id);

            message.reply('Stopped');
        }

        else if (command === 'ping') {

            message.reply('Pong');
        }
    }

    catch (err) {

        console.log(err);

        try {

            message.reply(
                'Error occurred'
            );

        } catch {}
    }
});

client.login(process.env.BOT_TOKEN);
