"use strict";

/*
 * GMA RADIO CORE
 *
 * Shared:
 *   - Web Audio master engine
 *   - GMA1 packet parser
 *   - PCM16 conversion
 *   - WAV decoding
 *   - WebCodecs helpers
 *   - Receiver class
 *
 * Each receiver instance owns:
 *   - WebSocket
 *   - decoder
 *   - jitter buffer
 *   - playback timeline
 *   - station gain
 *   - codec state
 */

const GMA_MAGIC = "GMA1";
const GMA_VERSION = 1;
const GMA_HEADER_SIZE = 20;

const CODEC_IDS = {
    1: "PCM16",
    2: "Opus",
    3: "AAC",
    4: "MP3",
    6: "WAV"
};

const BYTES_PER_SAMPLE = 2;

const JITTER_START_SEC = 1.00;
const JITTER_TARGET_SEC = 1.50;
const JITTER_MAX_SEC = 3.00;
const JITTER_PUMP_MS = 50;

export const CROSSFADE_SEC = 0.18;


/* ============================================================
   SHARED AUDIO ENGINE
   ============================================================ */

let sharedAudioContext = null;
let sharedMasterGain = null;
let sharedAnalyser = null;

let meterAnimation = null;
let meterCallback = null;


export function createAudioEngine() {

    if (sharedAudioContext) {
        return {
            context: sharedAudioContext,
            masterGain: sharedMasterGain,
            analyser: sharedAnalyser
        };
    }

    const AudioContextClass =
        window.AudioContext ||
        window.webkitAudioContext;

    if (!AudioContextClass) {
        throw new Error(
            "Web Audio API is not supported."
        );
    }

    sharedAudioContext = new AudioContextClass();

    sharedMasterGain =
        sharedAudioContext.createGain();

    sharedAnalyser =
        sharedAudioContext.createAnalyser();

    sharedAnalyser.fftSize = 2048;
    sharedAnalyser.smoothingTimeConstant = 0.75;

    sharedMasterGain.gain.value = 1;

    sharedMasterGain.connect(
        sharedAnalyser
    );

    sharedAnalyser.connect(
        sharedAudioContext.destination
    );

    return {
        context: sharedAudioContext,
        masterGain: sharedMasterGain,
        analyser: sharedAnalyser
    };
}


export async function resumeAudioEngine() {

    const engine = createAudioEngine();

    if (
        engine.context.state === "suspended"
    ) {
        await engine.context.resume();
    }

    return engine;
}


export function getAudioEngine() {

    if (!sharedAudioContext) {
        return null;
    }

    return {
        context: sharedAudioContext,
        masterGain: sharedMasterGain,
        analyser: sharedAnalyser
    };
}


export function setMasterVolume(value) {

    if (!sharedMasterGain) {
        return;
    }

    sharedMasterGain.gain.value =
        Math.max(
            0,
            Math.min(1, Number(value))
        );
}


export function startMeter(callback) {

    meterCallback = callback;

    if (meterAnimation) {
        return;
    }

    function draw() {

        if (!sharedAnalyser) {
            meterAnimation = null;
            return;
        }

        const data =
            new Float32Array(
                sharedAnalyser.fftSize
            );

        sharedAnalyser.getFloatTimeDomainData(
            data
        );

        let sum = 0;

        for (let i = 0; i < data.length; i++) {
            sum += data[i] * data[i];
        }

        const rms =
            Math.sqrt(
                sum / data.length
            );

        let db = -60;

        if (rms > 0.00001) {
            db = 20 * Math.log10(rms);
        }

        db = Math.max(
            -60,
            Math.min(0, db)
        );

        const level =
            (db + 60) / 60;

        if (meterCallback) {
            meterCallback(level, db);
        }

        meterAnimation =
            requestAnimationFrame(draw);
    }

    meterAnimation =
        requestAnimationFrame(draw);
}


export function getAudioContext() {
    return sharedAudioContext;
}


/* ============================================================
   GMA1 PACKET PARSER
   ============================================================ */

export function parseGMA1Packet(arrayBuffer) {

    if (
        !(arrayBuffer instanceof ArrayBuffer) ||
        arrayBuffer.byteLength < GMA_HEADER_SIZE
    ) {
        return null;
    }

    const bytes =
        new Uint8Array(arrayBuffer);

    const magic =
        String.fromCharCode(
            bytes[0],
            bytes[1],
            bytes[2],
            bytes[3]
        );

    if (magic !== GMA_MAGIC) {
        return null;
    }

    const view =
        new DataView(arrayBuffer);

    const version =
        view.getUint8(4);

    const codecId =
        view.getUint8(5);

    const flags =
        view.getUint8(6);

    const channels =
        view.getUint8(7);

    const sequence =
        view.getUint32(8, false);

    const sampleRate =
        view.getUint32(12, false);

    const payloadLength =
        view.getUint32(16, false);

    if (version !== GMA_VERSION) {
        throw new Error(
            `Unsupported GMA1 version: ${version}`
        );
    }

    const codec =
        CODEC_IDS[codecId];

    if (!codec) {
        throw new Error(
            `Unknown codec ID: ${codecId}`
        );
    }

    if (
        channels < 1 ||
        channels > 8
    ) {
        throw new Error(
            `Invalid channel count: ${channels}`
        );
    }

    if (
        sampleRate < 8000 ||
        sampleRate > 192000
    ) {
        throw new Error(
            `Invalid sample rate: ${sampleRate}`
        );
    }

    const expectedSize =
        GMA_HEADER_SIZE +
        payloadLength;

    if (
        arrayBuffer.byteLength <
        expectedSize
    ) {
        throw new Error(
            `Incomplete GMA1 packet`
        );
    }

    const payload =
        new Uint8Array(
            arrayBuffer,
            GMA_HEADER_SIZE,
            payloadLength
        );

    return {
        magic,
        version,
        codecId,
        codec,
        flags,
        channels,
        sequence,
        sampleRate,
        payloadLength,
        payload
    };
}


/* ============================================================
   RECEIVER
   ============================================================ */

export class RadioReceiver {

    constructor(options) {

        this.name =
            options.name || "";

        this.url =
            options.url || "";

        this.onStatus =
            options.onStatus || (() => {});

        this.onFormat =
            options.onFormat || (() => {});

        this.onError =
            options.onError || (() => {});

        this.onPacket =
            options.onPacket || (() => {});

        this.socket = null;

        this.audioContext = null;

        this.gainNode = null;

        this.pipelineStarted = false;
        this.prepared = false;

        this.connected = false;

        this.destroyed = false;

        // Persistent WebSocket reconnect state.
        this.shouldReconnect = false;
        this.reconnectTimer = null;
        this.reconnectAttempt = 0;
        this.reconnectDelays = [1000, 2000, 4000, 8000, 15000];

        // Wake/network recovery hooks for mobile browsers.
        this.handleVisibilityChange = () => {
            if (
                document.visibilityState === "visible" &&
                this.shouldReconnect &&
                !this.destroyed
            ) {
                if (!this.connected) {
                    this.reconnectAttempt = 0;
                    this.scheduleReconnect();
                }

                if (this.audioContext) {
                    this.audioContext.resume().catch(() => {});
                }
            }
        };

        this.handleOnline = () => {
            if (
                this.shouldReconnect &&
                !this.destroyed &&
                !this.connected
            ) {
                this.reconnectAttempt = 0;
                this.scheduleReconnect();
            }
        };

        if (typeof document !== "undefined") {
            document.addEventListener(
                "visibilitychange",
                this.handleVisibilityChange
            );
        }

        if (typeof window !== "undefined") {
            window.addEventListener(
                "online",
                this.handleOnline
            );
        }

        this.currentCodec = null;

        this.codecId = null;

        this.sampleRate = 44100;

        this.channels = 2;

        this.decoder = null;

        this.decoderCodec = null;

        this.decoderSampleRate = 0;

        this.decoderChannels = 0;

        this.decoderBaseSequence = null;

        this.decoderPacketDurationUs = 20000;

        this.decoderNeedsKeyFrame = true;

        this.packetProcessingChain =
            Promise.resolve();

        this.decodedQueue = [];

        this.decodedQueueDuration = 0;

        this.playbackPrimed = false;

        this.nextAudioTime = 0;

        this.jitterTimer = null;

        this.activeSources = new Set();

        this.packetCount = 0;

        this.byteCount = 0;

        this.lastSequence = null;
    }


    /* ========================================================
       AUDIO
       ======================================================== */

    async prepareAudio() {

        const engine =
            await resumeAudioEngine();

        this.audioContext =
            engine.context;

        if (!this.gainNode) {

            this.gainNode =
                this.audioContext.createGain();

            this.gainNode.gain.value = 0;

            this.gainNode.connect(
                engine.masterGain
            );
        }

        this.pipelineStarted = true;
        this.prepared = true;

        // Idempotent: never reset the playback timeline here.
        this.startJitterPump();
        this.pumpJitter();
    }


    async stopAudio() {

        // Compatibility pause. Keep decoder, socket and buffered audio.
        this.pipelineStarted = false;
    }


    setVolume(value, fade = false) {

        if (!this.gainNode) {
            return;
        }

        const target =
            Math.max(
                0,
                Math.min(1, Number(value))
            );

        const now =
            this.audioContext
                ? this.audioContext.currentTime
                : 0;

        if (fade) {

            this.gainNode.gain.cancelScheduledValues(
                now
            );

            this.gainNode.gain.linearRampToValueAtTime(
                target,
                now + CROSSFADE_SEC
            );

        } else {

            this.gainNode.gain.value =
                target;
        }
    }


    getVolume() {

        if (!this.gainNode) {
            return 0;
        }

        return this.gainNode.gain.value;
    }


    /* ========================================================
       SOCKET
       ======================================================== */

    connect() {

        if (this.destroyed) {
            return;
        }

        // A call to connect() means the receiver should stay connected.
        // Automatic reconnect remains enabled until disconnect() or destroy().
        this.shouldReconnect = true;

        if (
            this.socket &&
            (
                this.socket.readyState ===
                    WebSocket.OPEN ||
                this.socket.readyState ===
                    WebSocket.CONNECTING
            )
        ) {
            return;
        }

        if (!this.url) {
            return;
        }

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        this.onStatus(
            this.reconnectAttempt > 0
                ? "reconnecting"
                : "connecting"
        );

        let socket;

        try {

            socket =
                new WebSocket(
                    this.url
                );

            socket.binaryType =
                "arraybuffer";

        } catch (error) {

            this.onError(error);

            this.onStatus(
                "error"
            );

            return;
        }

        this.socket = socket;

        socket.onopen = () => {

            if (this.socket !== socket) {
                return;
            }

            this.connected = true;
            this.reconnectAttempt = 0;

            if (this.reconnectTimer) {
                clearTimeout(this.reconnectTimer);
                this.reconnectTimer = null;
            }

            this.onStatus(
                "connected"
            );

            try {

                socket.send(
                    JSON.stringify({
                        type:
                            "register-receiver"
                    })
                );

            } catch (error) {
                this.onError(error);
            }
        };


        socket.onmessage = event => {

            if (this.socket !== socket) {
                return;
            }

            this.handleMessage(
                event
            );
        };


        socket.onerror = () => {

            if (this.socket !== socket) {
                return;
            }

            this.onStatus(
                "error"
            );
        };


        socket.onclose = () => {

            if (this.socket !== socket) {
                return;
            }

            this.connected = false;

            this.socket = null;

            if (this.shouldReconnect && !this.destroyed) {
                this.scheduleReconnect();
            } else {
                this.onStatus(
                    "disconnected"
                );
            }
        };
    }


    scheduleReconnect() {
        if (
            !this.shouldReconnect ||
            this.destroyed ||
            !this.url ||
            this.reconnectTimer
        ) {
            return;
        }

        const index = Math.min(
            this.reconnectAttempt,
            this.reconnectDelays.length - 1
        );
        const delay =
            this.reconnectDelays[index];

        this.reconnectAttempt++;

        this.onStatus(
            "reconnecting"
        );

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;

            if (
                !this.shouldReconnect ||
                this.destroyed
            ) {
                return;
            }

            this.connect();
        }, delay);
    }


    disconnect() {

        // Explicit disconnect means: do NOT reconnect.
        this.shouldReconnect = false;

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        this.reconnectAttempt = 0;

        const socket =
            this.socket;

        this.socket = null;

        this.connected = false;

        if (socket) {

            try {
                socket.close();
            } catch (_) {}
        }

        this.onStatus(
            "disconnected"
        );
    }


    /* ========================================================
       SOCKET MESSAGE
       ======================================================== */

    async handleMessage(event) {

        if (
            typeof event.data ===
            "string"
        ) {

            this.handleServerMessage(
                event.data
            );

            return;
        }

        let arrayBuffer;

        try {

            arrayBuffer =
                event.data instanceof
                ArrayBuffer
                    ? event.data
                    : await event.data.arrayBuffer();

        } catch (error) {

            this.onError(error);

            return;
        }

        this.packetCount++;

        this.byteCount +=
            arrayBuffer.byteLength;

        this.onPacket(
            this.packetCount,
            this.byteCount
        );

        this.packetProcessingChain =
            this.packetProcessingChain
                .then(
                    () =>
                        this.handleAudioPacket(
                            arrayBuffer
                        )
                )
                .catch(
                    error =>
                        this.onError(error)
                );
    }


    handleServerMessage(text) {

        try {

            const message =
                JSON.parse(text);

            const codec =
                message.codec ||
                message.format ||
                null;

            const codecId =
                message.codecId != null
                    ? Number(
                        message.codecId
                    )
                    : null;

            const sampleRate =
                message.sampleRate
                    ? Number(
                        message.sampleRate
                    )
                    : null;

            const channels =
                message.channels
                    ? Number(
                        message.channels
                    )
                    : null;

            if (
                codec ||
                codecId != null ||
                sampleRate ||
                channels
            ) {

                if (sampleRate) {
                    this.sampleRate =
                        sampleRate;
                }

                if (channels) {
                    this.channels =
                        channels;
                }

                if (codec) {
                    this.currentCodec =
                        this.normalizeCodecName(
                            String(codec)
                        );
                }

                this.codecId =
                    codecId;

                this.emitFormat();
            }

        } catch (_) {

            /*
             * Non-JSON text is ignored.
             */
        }
    }


    /* ========================================================
       FORMAT
       ======================================================== */

    normalizeCodecName(codec) {

        return codec === "PCM"
            ? "PCM16"
            : codec;
    }


    async adoptServerFormat(
        codec,
        codecId,
        sampleRate,
        channels
    ) {

        codec =
            this.normalizeCodecName(
                codec
            );

        const changed =
            this.currentCodec !== codec ||
            this.codecId !== codecId ||
            this.sampleRate !== sampleRate ||
            this.channels !== channels;

        if (!changed) {
            this.emitFormat();
            return;
        }

        this.currentCodec = codec;

        this.codecId = codecId;

        this.sampleRate =
            Number(sampleRate);

        this.channels =
            Number(channels);

        await this.destroyDecoder();

        this.resetPlayback();

        this.emitFormat();
    }


    emitFormat() {

        this.onFormat({
            codec:
                this.currentCodec,
            codecId:
                this.codecId,
            sampleRate:
                this.sampleRate,
            channels:
                this.channels
        });
    }


    /* ========================================================
       PACKET PROCESSING
       ======================================================== */

    async handleAudioPacket(
        arrayBuffer
    ) {

        let packet = null;

        try {

            packet =
                parseGMA1Packet(
                    arrayBuffer
                );

        } catch (error) {

            this.onError(error);

            return;
        }


        if (packet) {

            await this.handleGMA1Packet(
                packet
            );

            return;
        }


        /*
         * Legacy raw PCM16.
         */

        if (
            arrayBuffer.byteLength > 0 &&
            arrayBuffer.byteLength %
                (
                    this.channels *
                    BYTES_PER_SAMPLE
                ) === 0
        ) {

            if (!this.pipelineStarted) {
                return;
            }

            const buffer =
                this.convertPCMToAudioBuffer(
                    arrayBuffer,
                    this.sampleRate,
                    this.channels
                );

            if (buffer) {
                this.enqueueAudio(
                    buffer
                );
            }
        }
    }


    async handleGMA1Packet(packet) {

        await this.adoptServerFormat(
            packet.codec,
            packet.codecId,
            packet.sampleRate,
            packet.channels
        );


        if (!this.pipelineStarted) {
            return;
        }


        if (
            packet.codec ===
            "PCM16"
        ) {

            const buffer =
                this.convertPCMToAudioBuffer(
                    packet.payload
                        .slice()
                        .buffer,
                    packet.sampleRate,
                    packet.channels
                );

            if (buffer) {
                this.enqueueAudio(
                    buffer
                );
            }

            return;
        }


        if (
            packet.codec ===
            "WAV"
        ) {

            this.playWAV(
                packet.payload
                    .slice()
                    .buffer
            );

            return;
        }


        if (
            packet.codec === "Opus" ||
            packet.codec === "AAC" ||
            packet.codec === "MP3"
        ) {

            await this.playCompressed(
                packet.payload,
                packet.codec,
                packet.sampleRate,
                packet.channels,
                packet.sequence
            );
        }
    }


    /* ========================================================
       PCM
       ======================================================== */

    convertPCMToAudioBuffer(
        arrayBuffer,
        sampleRate,
        channels
    ) {

        if (
            !this.audioContext ||
            !(arrayBuffer instanceof ArrayBuffer)
        ) {
            return null;
        }

        const bytesPerFrame =
            channels *
            BYTES_PER_SAMPLE;

        if (
            !arrayBuffer.byteLength ||
            arrayBuffer.byteLength %
                bytesPerFrame !== 0
        ) {
            return null;
        }

        const frameCount =
            arrayBuffer.byteLength /
            bytesPerFrame;

        const buffer =
            this.audioContext.createBuffer(
                channels,
                frameCount,
                sampleRate
            );

        const view =
            new DataView(
                arrayBuffer
            );

        for (
            let channel = 0;
            channel < channels;
            channel++
        ) {

            const data =
                buffer.getChannelData(
                    channel
                );

            for (
                let frame = 0;
                frame < frameCount;
                frame++
            ) {

                const offset =
                    (
                        frame *
                        channels +
                        channel
                    ) * 2;

                data[frame] =
                    view.getInt16(
                        offset,
                        true
                    ) / 32768;
            }
        }

        return buffer;
    }


    /* ========================================================
       WAV
       ======================================================== */

    playWAV(arrayBuffer) {

        if (
            !this.audioContext ||
            arrayBuffer.byteLength < 44
        ) {
            return;
        }

        this.audioContext
            .decodeAudioData(
                arrayBuffer.slice(0)
            )
            .then(buffer => {

                if (!this.pipelineStarted) {
                    return;
                }

                this.sampleRate =
                    buffer.sampleRate;

                this.channels =
                    buffer.numberOfChannels;

                this.currentCodec =
                    "WAV";

                this.emitFormat();

                this.enqueueAudio(
                    buffer
                );

            })
            .catch(error => {

                this.onError(error);
            });
    }


    /* ========================================================
       WEBCODECS
       ======================================================== */

    getAACCodecString(payload) {

        if (
            payload &&
            payload.length >= 2 &&
            payload[0] === 0xFF &&
            (payload[1] & 0xF6) === 0xF0
        ) {
            return "mp4a.40.2";
        }

        return "mp4a.40.2";
    }


    async createDecoder(
        codec,
        sampleRate,
        channels,
        firstPayload
    ) {

        if (
            !("AudioDecoder" in window)
        ) {
            throw new Error(
                "WebCodecs AudioDecoder is not supported."
            );
        }

        let codecString;

        if (codec === "Opus") {

            codecString = "opus";

        } else if (codec === "MP3") {

            codecString = "mp3";

        } else if (codec === "AAC") {

            codecString =
                this.getAACCodecString(
                    firstPayload
                );

        } else {

            throw new Error(
                `Unsupported codec: ${codec}`
            );
        }


        if (
            this.decoder &&
            this.decoderCodec === codecString &&
            this.decoderSampleRate === sampleRate &&
            this.decoderChannels === channels &&
            this.decoder.state ===
                "configured"
        ) {
            return;
        }


        await this.destroyDecoder();


        const support =
            await AudioDecoder.isConfigSupported({
                codec: codecString,
                sampleRate,
                numberOfChannels:
                    channels
            });


        if (!support.supported) {

            throw new Error(
                `Unsupported ${codec} format`
            );
        }


        this.decoder =
            new AudioDecoder({

                output: audioData => {

                    this.handleDecodedAudio(
                        audioData
                    );
                },

                error: error => {

                    this.onError(error);
                }
            });


        this.decoder.configure({
            codec: codecString,
            sampleRate,
            numberOfChannels:
                channels
        });


        this.decoderCodec =
            codecString;

        this.decoderSampleRate =
            sampleRate;

        this.decoderChannels =
            channels;

        this.decoderNeedsKeyFrame =
            true;
    }


    async playCompressed(
        payload,
        codec,
        sampleRate,
        channels,
        sequence
    ) {

        try {

            const codecString =
                codec === "Opus"
                    ? "opus"
                    : codec === "MP3"
                        ? "mp3"
                        : codec === "AAC"
                            ? this.getAACCodecString(
                                payload
                            )
                            : codec;


            const formatChanged =
                this.decoderCodec !== null &&
                (
                    this.decoderCodec !==
                        codecString ||
                    this.decoderSampleRate !==
                        sampleRate ||
                    this.decoderChannels !==
                        channels
                );


            await this.createDecoder(
                codec,
                sampleRate,
                channels,
                payload
            );


            if (
                formatChanged ||
                this.decoderBaseSequence === null
            ) {

                this.decoderBaseSequence =
                    sequence;

                this.decoderPacketDurationUs =
                    codec === "AAC"
                        ? (
                            1024 /
                            sampleRate
                        ) * 1000000
                        : codec === "MP3"
                            ? (
                                1152 /
                                sampleRate
                            ) * 1000000
                            : 20000;
            }


            const packetOffset =
                (
                    sequence -
                    this.decoderBaseSequence
                ) >>> 0;


            const timestamp =
                packetOffset *
                this.decoderPacketDurationUs;


            const chunk =
                new EncodedAudioChunk({
                    type:
                        this.decoderNeedsKeyFrame
                            ? "key"
                            : "delta",

                    timestamp:
                        Math.max(
                            0,
                            Math.round(
                                timestamp
                            )
                        ),

                    duration:
                        Math.max(
                            1,
                            Math.round(
                                this.decoderPacketDurationUs
                            )
                        ),

                    data: payload
                });


            this.decoder.decode(
                chunk
            );

            this.decoderNeedsKeyFrame =
                false;

        } catch (error) {

            this.onError(error);
        }
    }


    handleDecodedAudio(
        audioData
    ) {

        try {

            if (!this.pipelineStarted) {

                audioData.close();

                return;
            }


            const buffer =
                this.audioDataToAudioBuffer(
                    audioData
                );

            audioData.close();


            if (buffer) {

                this.enqueueAudio(
                    buffer
                );
            }

        } catch (error) {

            try {
                audioData.close();
            } catch (_) {}

            this.onError(error);
        }
    }


    audioDataToAudioBuffer(
        audioData
    ) {

        if (
            !this.audioContext ||
            !audioData
        ) {
            return null;
        }

        const channels =
            audioData.numberOfChannels;

        const frames =
            audioData.numberOfFrames;

        const sampleRate =
            audioData.sampleRate;

        if (
            !channels ||
            !frames ||
            !sampleRate
        ) {
            return null;
        }


        const buffer =
            this.audioContext.createBuffer(
                channels,
                frames,
                sampleRate
            );


        try {

            for (
                let channel = 0;
                channel < channels;
                channel++
            ) {

                audioData.copyTo(
                    buffer.getChannelData(
                        channel
                    ),
                    {
                        planeIndex:
                            channel,
                        format:
                            "f32-planar"
                    }
                );
            }

            return buffer;

        } catch (_) {}


        try {

            const format =
                audioData.format || "";

            const bytesPerSample =
                format.includes("s16")
                    ? 2
                    : format.includes("s32")
                        ? 4
                        : 4;

            const planar =
                format.includes(
                    "planar"
                );


            if (planar) {

                for (
                    let channel = 0;
                    channel < channels;
                    channel++
                ) {

                    const destination =
                        buffer.getChannelData(
                            channel
                        );

                    const raw =
                        new ArrayBuffer(
                            frames *
                            bytesPerSample
                        );

                    audioData.copyTo(
                        new Uint8Array(
                            raw
                        ),
                        {
                            planeIndex:
                                channel
                        }
                    );

                    const view =
                        new DataView(
                            raw
                        );

                    for (
                        let i = 0;
                        i < frames;
                        i++
                    ) {

                        if (
                            format.includes(
                                "s16"
                            )
                        ) {

                            destination[i] =
                                view.getInt16(
                                    i * 2,
                                    true
                                ) / 32768;

                        } else if (
                            format.includes(
                                "s32"
                            )
                        ) {

                            destination[i] =
                                view.getInt32(
                                    i * 4,
                                    true
                                ) /
                                2147483648;

                        } else {

                            destination[i] =
                                view.getFloat32(
                                    i * 4,
                                    true
                                );
                        }
                    }
                }

                return buffer;
            }


            const raw =
                new ArrayBuffer(
                    frames *
                    channels *
                    bytesPerSample
                );

            audioData.copyTo(
                new Uint8Array(raw),
                {
                    planeIndex: 0
                }
            );

            const view =
                new DataView(raw);


            for (
                let frame = 0;
                frame < frames;
                frame++
            ) {

                for (
                    let channel = 0;
                    channel < channels;
                    channel++
                ) {

                    const index =
                        frame *
                        channels +
                        channel;

                    const destination =
                        buffer.getChannelData(
                            channel
                        );


                    if (
                        format.includes(
                            "s16"
                        )
                    ) {

                        destination[frame] =
                            view.getInt16(
                                index * 2,
                                true
                            ) / 32768;

                    } else if (
                        format.includes(
                            "s32"
                        )
                    ) {

                        destination[frame] =
                            view.getInt32(
                                index * 4,
                                true
                            ) /
                            2147483648;

                    } else {

                        destination[frame] =
                            view.getFloat32(
                                index * 4,
                                true
                            );
                    }
                }
            }

            return buffer;

        } catch (error) {

            this.onError(error);

            return null;
        }
    }


    /* ========================================================
       JITTER BUFFER
       ======================================================== */

    enqueueAudio(
        audioBuffer
    ) {

        if (
            !this.pipelineStarted ||
            !audioBuffer
        ) {
            return;
        }

        this.decodedQueue.push(
            audioBuffer
        );

        this.decodedQueueDuration +=
            audioBuffer.duration;

        this.pumpJitter();
    }


    startJitterPump() {

        if (this.jitterTimer) {
            return;
        }

        this.jitterTimer =
            setInterval(
                () => this.pumpJitter(),
                JITTER_PUMP_MS
            );
    }


    pumpJitter() {

        if (
            !this.pipelineStarted ||
            !this.audioContext ||
            this.audioContext.state !== "running"
        ) {
            return;
        }


        const now =
            this.audioContext.currentTime;


        if (
            this.playbackPrimed &&
            this.nextAudioTime <=
                now + 0.01
        ) {

            this.playbackPrimed =
                false;

            this.nextAudioTime =
                now + 0.08;
        }


        if (!this.playbackPrimed) {

            if (
                this.decodedQueueDuration <
                JITTER_START_SEC
            ) {
                return;
            }

            this.nextAudioTime =
                now + 0.10;

            this.playbackPrimed =
                true;
        }


        const scheduleUntil =
            now +
            JITTER_TARGET_SEC;


        while (
            this.decodedQueue.length &&
            this.nextAudioTime <
                scheduleUntil
        ) {

            const buffer =
                this.decodedQueue.shift();

            this.decodedQueueDuration =
                Math.max(
                    0,
                    this.decodedQueueDuration -
                        buffer.duration
                );

            this.scheduleBuffer(
                buffer
            );
        }


        while (
            this.decodedQueueDuration >
                JITTER_MAX_SEC &&
            this.decodedQueue.length > 1
        ) {

            const dropped =
                this.decodedQueue.shift();

            this.decodedQueueDuration =
                Math.max(
                    0,
                    this.decodedQueueDuration -
                        dropped.duration
                );
        }
    }


    scheduleBuffer(
        audioBuffer
    ) {

        if (
            !this.pipelineStarted ||
            !this.audioContext ||
            !audioBuffer
        ) {
            return;
        }


        const source =
            this.audioContext
                .createBufferSource();

        source.buffer =
            audioBuffer;

        source.connect(
            this.gainNode
        );

        this.activeSources.add(
            source
        );

        source.onended = () => {

            this.activeSources.delete(
                source
            );
        };


        const now =
            this.audioContext.currentTime;


        if (
            this.nextAudioTime < now
        ) {

            this.playbackPrimed =
                false;

            this.nextAudioTime =
                now + 0.08;
        }


        source.start(
            this.nextAudioTime
        );

        this.nextAudioTime +=
            audioBuffer.duration;
    }


    resetPlayback() {

        for (
            const source of
            this.activeSources
        ) {

            try {
                source.stop();
            } catch (_) {}
        }

        this.activeSources.clear();

        this.decodedQueue.length = 0;

        this.decodedQueueDuration = 0;

        this.playbackPrimed = false;

        this.nextAudioTime = 0;
    }


    /* ========================================================
       DECODER CLEANUP
       ======================================================== */

    async destroyDecoder() {

        const decoder =
            this.decoder;

        this.decoder = null;

        this.decoderCodec = null;

        this.decoderSampleRate = 0;

        this.decoderChannels = 0;

        this.decoderBaseSequence = null;

        this.decoderPacketDurationUs =
            20000;

        this.decoderNeedsKeyFrame =
            true;


        if (!decoder) {
            return;
        }


        try {

            if (
                decoder.state !==
                "closed"
            ) {
                await decoder.flush();
            }

        } catch (_) {}


        try {

            if (
                decoder.state !==
                "closed"
            ) {
                decoder.close();
            }

        } catch (_) {}
    }


    /* ========================================================
       COMPLETE DESTROY
       ======================================================== */

    async destroy() {

        this.destroyed = true;
        this.shouldReconnect = false;

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (typeof document !== "undefined") {
            document.removeEventListener(
                "visibilitychange",
                this.handleVisibilityChange
            );
        }

        if (typeof window !== "undefined") {
            window.removeEventListener(
                "online",
                this.handleOnline
            );
        }

        this.pipelineStarted = false;
        this.prepared = false;

        if (this.jitterTimer) {

            clearInterval(
                this.jitterTimer
            );

            this.jitterTimer = null;
        }

        this.resetPlayback();

        this.packetProcessingChain =
            Promise.resolve();

        await this.destroyDecoder();

        this.disconnect();

        if (this.gainNode) {

            try {
                this.gainNode.disconnect();
            } catch (_) {}

            this.gainNode = null;
        }
    }
}