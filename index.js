require('dotenv').config();

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
    entersState,
    VoiceConnectionStatus
} = require('@discordjs/voice');

const prism = require('prism-media');
const ffmpeg = require('ffmpeg-static');
const axios = require('axios');
const { spawn } = require('child_process');

const PREFIX = '.';

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates
    ]
});

const queues = new Map();

client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
});

async function createStream(url) {
    const ffmpegProcess = spawn(ffmpeg, [
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
        '-i', url,
        '-analyzeduration', '0',
        '-loglevel', '0',
        '-f', 's16le',
        '-ar', '48000',
        '-ac', '2',
        'pipe:1'
    ], {
        stdio: ['ignore', 'pipe', 'ignore']
    });

    const opusStream = new prism.opus.Encoder({
        rate: 48000,
        channels: 2,
        frameSize: 960
    });

    return createAudioResource(
        ffmpegProcess.stdout.pipe(opusStream),
        {
            inputType: StreamType.Opus
        }
    );
}

async function playNext(guildId) {
    const queue = queues.get(guildId);

    if (!queue) return;

    if (queue.songs.length === 0) {
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
        console.error(err);
        playNext(guildId);
    }
}

client.on('messageCreate', async (message) => {
    try {
        if (message.author.bot) return;
        if (!message.content.startsWith(PREFIX)) return;

        const args = message.content.slice(PREFIX.length).trim().split(/ +/);
        const command = args.shift()?.toLowerCase();

        if (command === 'play') {
            const query = args.join(' ');

            if (!query) {
                return message.reply('Provide a song name');
            }

            const voiceChannel = message.member.voice.channel;

            if (!voiceChannel) {
                return message.reply('Join a voice channel first');
            }

            const msg = await message.reply('Searching...');

            const api = `https://song-dl-0q80.onrender.com/api/dl?q=${encodeURIComponent(query)}`;

            const { data } = await axios.get(api);

            if (!data?.status || !data?.result?.url) {
                return msg.edit('Song not found');
            }

            const song = data.result;

            let queue = queues.get(message.guild.id);

            if (!queue) {
                const connection = joinVoiceChannel({
                    channelId: voiceChannel.id,
                    guildId: voiceChannel.guild.id,
                    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
                    selfDeaf: false
                });

                await entersState(
                    connection,
                    VoiceConnectionStatus.Ready,
                    30000
                );

                const player = createAudioPlayer();

                connection.subscribe(player);

                queue = {
                    textChannel: message.channel,
                    voiceChannel,
                    connection,
                    player,
                    songs: []
                };

                queues.set(message.guild.id, queue);

                player.on(AudioPlayerStatus.Idle, () => {
                    playNext(message.guild.id);
                });

                player.on('error', (err) => {
                    console.error(err);
                    playNext(message.guild.id);
                });
            }

            queue.songs.push({
                title: song.title,
                url: song.url,
                thumbnail: song.thumbnail
            });

            msg.edit(`Added to queue: ${song.title}`);

            if (queue.player.state.status !== AudioPlayerStatus.Playing) {
                playNext(message.guild.id);
            }
        }

        else if (command === 'playlist') {
            const url = args[0];

            if (!url) {
                return message.reply('Provide Spotify playlist URL');
            }

            const voiceChannel = message.member.voice.channel;

            if (!voiceChannel) {
                return message.reply('Join a voice channel first');
            }

            const msg = await message.reply('Fetching playlist...');

            const api = `https://song-dl-0q80.onrender.com/api/playlist?url=${encodeURIComponent(url)}`;

            const { data } = await axios.get(api);

            if (!data?.status || !data?.result?.tracks?.length) {
                return msg.edit('Playlist not found');
            }

            const playlist = data.result;

            let queue = queues.get(message.guild.id);

            if (!queue) {
                const connection = joinVoiceChannel({
                    channelId: voiceChannel.id,
                    guildId: voiceChannel.guild.id,
                    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
                    selfDeaf: false
                });

                await entersState(
                    connection,
                    VoiceConnectionStatus.Ready,
                    30000
                );

                const player = createAudioPlayer();

                connection.subscribe(player);

                queue = {
                    textChannel: message.channel,
                    voiceChannel,
                    connection,
                    player,
                    songs: []
                };

                queues.set(message.guild.id, queue);

                player.on(AudioPlayerStatus.Idle, () => {
                    playNext(message.guild.id);
                });

                player.on('error', (err) => {
                    console.error(err);
                    playNext(message.guild.id);
                });
            }

            msg.edit(`Adding ${playlist.tracks.length} songs...`);

            for (const track of playlist.tracks) {
                try {
                    const search = `${track.name} ${track.artist}`;

                    const dl = await axios.get(
                        `https://eypz.koyeb.app/api/dl?q=${encodeURIComponent(search)}`
                    );

                    if (
                        dl.data?.status &&
                        dl.data?.result?.url
                    ) {
                        queue.songs.push({
                            title: dl.data.result.title,
                            url: dl.data.result.url,
                            thumbnail: dl.data.result.thumbnail
                        });
                    }

                } catch (e) {
                    console.log(e);
                }
            }

            msg.edit(
                `Playlist Added\nName: ${playlist.info.name}\nTracks: ${playlist.tracks.length}`
            );

            if (queue.player.state.status !== AudioPlayerStatus.Playing) {
                playNext(message.guild.id);
            }
        }

        else if (command === 'skip') {
            const queue = queues.get(message.guild.id);

            if (!queue) {
                return message.reply('No queue');
            }

            queue.player.stop();

            message.reply('Skipped');
        }

        else if (command === 'queue') {
            const queue = queues.get(message.guild.id);

            if (!queue || queue.songs.length === 0) {
                return message.reply('Queue empty');
            }

            const songs = queue.songs
                .slice(0, 10)
                .map((s, i) => `${i + 1}. ${s.title}`)
                .join('\n');

            message.reply(songs);
        }

        else if (command === 'stop') {
            const queue = queues.get(message.guild.id);

            if (!queue) {
                return message.reply('Nothing playing');
            }

            queue.songs = [];

            queue.player.stop();

            queue.connection.destroy();

            queues.delete(message.guild.id);

            message.reply('Stopped');
        }

    } catch (err) {
        console.error(err);

        try {
            message.reply('Error occurred');
        } catch {}
    }
});

client.login(process.env.BOT_TOKEN);
