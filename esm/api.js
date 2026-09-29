// src/api.js 核心部分修改

export async function generateSpeech(ctx, config, text, voiceId, cacheManager) {
    const logger = ctx.logger('tts-service');
    const engine = config.engine || 'elevenlabs';

    // 打印当前实际读取到的配置引擎，方便确认
    logger.info(`[TTS] 当前生效引擎: 【${engine}】，文本字数: ${text?.length ?? 0}`);

    if (!config.ttsApiKey) {
        logger.error(`[TTS] 未配置 ttsApiKey，无法调用 ${engine} 接口`);
        return null;
    }

    // 1. 尝试读取本地缓存
    const cacheParams = getCacheParams(config);
    if (cacheManager) {
        const cached = await cacheManager.getAudio(text, voiceId, cacheParams);
        if (cached) {
            if (config.debug) logger.info('[TTS] 命中本地音频缓存');
            return cached;
        }
    }

    try {
        let audioBuffer = null;

        if (engine === 'elevenlabs') {
            // ==========================================
            // 分支 1: ElevenLabs 请求逻辑 (带地址自动纠错)
            // ==========================================
            let baseUrl = String(config.apiBase || '').trim();
            // 防呆纠错：如果用户配置里残留了 minimax 地址或为空，强制使用 ElevenLabs 官方地址
            if (!baseUrl || baseUrl.includes('minimax.io')) {
                baseUrl = 'https://api.elevenlabs.io/v1';
            }
            baseUrl = baseUrl.replace(/\/$/, '');

            const outputFormat = config.outputFormat || 'mp3_44100_128';
            const url = `${baseUrl}/text-to-speech/${voiceId}?output_format=${outputFormat}`;

            const payload = {
                text: text,
                model_id: config.speechModel || 'eleven_multilingual_v2',
                voice_settings: {
                    stability: config.stability ?? 0.5,
                    similarity_boost: config.similarityBoost ?? 0.75,
                    style: config.style ?? 0.0,
                    use_speaker_boost: config.useSpeakerBoost ?? true,
                    speed: config.speed ?? 1.0,
                }
            };

            logger.info(`[ElevenLabs] 正在发起请求 -> URL: ${url}`);

            const response = await ctx.http.post(url, payload, {
                headers: {
                    'xi-api-key': config.ttsApiKey,
                    'Content-Type': 'application/json',
                },
                responseType: 'arraybuffer'
            });

            const resBuffer = Buffer.isBuffer(response) ? response : Buffer.from(response);

            // 检查 ElevenLabs 是否返回了错误 JSON
            const strCheck = resBuffer.toString('utf8', 0, Math.min(resBuffer.length, 100)).trim();
            if (strCheck.startsWith('{')) {
                try {
                    const errObj = JSON.parse(resBuffer.toString('utf8'));
                    logger.error('[ElevenLabs] API 响应报错:', JSON.stringify(errObj.detail || errObj));
                    return null;
                } catch (e) {
                    // 不是 json 说明是音频正常数据
                }
            }

            audioBuffer = resBuffer;

        } else {
            // ==========================================
            // 分支 2: MiniMax 请求逻辑
            // ==========================================
            let baseUrl = String(config.apiBase || 'https://api.minimax.io/v1').replace(/\/$/, '');
            if (baseUrl.includes('elevenlabs.io')) {
                baseUrl = 'https://api.minimax.io/v1';
            }
            const url = `${baseUrl}/t2a_v2`;

            const payload = {
                model: config.speechModel || 'speech-01-turbo',
                text: text,
                stream: false,
                output_format: 'hex',
                voice_setting: {
                    voice_id: voiceId,
                    speed: config.speed ?? 1.0,
                    vol: config.vol ?? 1.0,
                    pitch: config.pitch ?? 0
                },
                audio_setting: {
                    sample_rate: config.sampleRate ?? 32000,
                    bitrate: config.bitrate ?? 128000,
                    format: config.audioFormat ?? 'mp3',
                    channel: 1
                }
            };

            if (config.languageBoost && config.languageBoost !== 'auto') {
                payload.language_boost = config.languageBoost;
            }

            logger.info(`[MiniMax] 正在发起请求 -> URL: ${url}`);

            const response = await ctx.http.post(url, payload, {
                headers: {
                    'Authorization': `Bearer ${config.ttsApiKey}`,
                    'Content-Type': 'application/json',
                    'Tts-Group-Id': config.groupId || ''
                },
                responseType: 'arraybuffer'
            });

            const resBuffer = Buffer.isBuffer(response) ? response : Buffer.from(response);
            const responseText = resBuffer.toString('utf8').trim();

            if (responseText.startsWith('{') || responseText.startsWith('[')) {
                const obj = JSON.parse(responseText);
                if (obj.base_resp && obj.base_resp.status_code && obj.base_resp.status_code !== 0) {
                    logger.error('[MiniMax] API 错误:', obj.base_resp.status_msg || obj.base_resp.status_code);
                    return null;
                }
                if (obj.data && obj.data.audio && typeof obj.data.audio === 'string') {
                    audioBuffer = Buffer.from(obj.data.audio, 'hex');
                }
            } else {
                audioBuffer = resBuffer;
            }
        }

        if (!audioBuffer || audioBuffer.length === 0) {
            logger.error(`[${engine}] 返回的音频数据为空`);
            return null;
        }

        if (cacheManager) {
            await cacheManager.saveAudio(text, voiceId, cacheParams, audioBuffer);
        }

        return audioBuffer;

    } catch (error) {
        logger.error(`[${engine}] TTS 请求失败:`, error?.response?.data ? Buffer.from(error.response.data).toString() : error?.message || error);
        return null;
    }
}