// src/api.ts
import { Context } from 'koishi';
import { AudioCacheManager } from './cache';

/**
 * 构造缓存查询参数（区分引擎）
 */
function getCacheParams(config: any) {
    if (config.engine === 'elevenlabs') {
        return {
            engine: 'elevenlabs',
            model: config.speechModel,
            stability: config.stability ?? 0.5,
            similarityBoost: config.similarityBoost ?? 0.75,
            style: config.style ?? 0.0,
            speed: config.speed ?? 1.0,
            format: config.outputFormat ?? 'mp3_44100_128',
        };
    } else {
        return {
            engine: 'minimax',
            model: config.speechModel,
            speed: config.speed,
            vol: config.vol,
            pitch: config.pitch,
            format: config.audioFormat ?? 'mp3'
        };
    }
}

/**
 * 核心语音生成函数
 */
export async function generateSpeech(
    ctx: Context,
    config: any,
    text: string,
    voiceId: string,
    cacheManager?: AudioCacheManager
): Promise<Buffer | null> {
    const logger = ctx.logger('tts-service');
    const engine = config.engine || 'elevenlabs';

    try {
        logger.info(`generateSpeech 触发 [${engine}] — 文本字数: ${text?.length ?? 0}, voiceId: ${voiceId}`);
    } catch (e) {
        // ignore
    }

    if (!config.ttsApiKey) {
        logger.error(`未配置 ttsApiKey，无法调用 ${engine} 接口`);
        return null;
    }

    // 1. 尝试读取本地缓存
    const cacheParams = getCacheParams(config);
    if (cacheManager) {
        const cached = await cacheManager.getAudio(text, voiceId, cacheParams);
        if (cached) {
            if (config.debug) logger.info('命中本地音频缓存');
            return cached;
        }
    }

    // 2. 调用对应服务商 API
    try {
        let audioBuffer: Buffer | null = null;

        if (engine === 'elevenlabs') {
            // ==========================================
            // 分支 1: ElevenLabs 请求逻辑
            // ==========================================
            const outputFormat = config.outputFormat || 'mp3_44100_128';
            let baseUrl = String(config.apiBase || 'https://api.elevenlabs.io/v1').replace(/\/$/, '');
            const url = `${baseUrl}/text-to-speech/${voiceId}?output_format=${outputFormat}`;

            const payload: any = {
                text: text, // 已经保留了开放式 [tag]
                model_id: config.speechModel || 'eleven_multilingual_v2',
                voice_settings: {
                    stability: config.stability ?? 0.5,
                    similarity_boost: config.similarityBoost ?? 0.75,
                    style: config.style ?? 0.0,
                    use_speaker_boost: config.useSpeakerBoost ?? true,
                    speed: config.speed ?? 1.0,
                }
            };

            if (config.debug) {
                logger.info(`[ElevenLabs] 请求 URL: ${url}`);
                logger.info('[ElevenLabs] 请求 payload:', JSON.stringify(payload));
            }

            const response: any = await ctx.http.post(url, payload, {
                headers: {
                    'xi-api-key': config.ttsApiKey,
                    'Content-Type': 'application/json',
                },
                responseType: 'arraybuffer'
            });

            const resBuffer = Buffer.isBuffer(response) ? response : Buffer.from(response);

            // 检查 ElevenLabs 报错（报错时通常返回 JSON：{"detail":{"status":"...","message":"..."}}）
            const strCheck = resBuffer.toString('utf8', 0, Math.min(resBuffer.length, 100)).trim();
            if (strCheck.startsWith('{')) {
                try {
                    const errObj = JSON.parse(resBuffer.toString('utf8'));
                    logger.error('[ElevenLabs] API 响应错误:', JSON.stringify(errObj.detail || errObj));
                    return null;
                } catch (e) {
                    // 不是合法 json，继续当成音频处理
                }
            }

            audioBuffer = resBuffer;

        } else {
            // ==========================================
            // 分支 2: MiniMax 请求逻辑 (保留原逻辑)
            // ==========================================
            let baseUrl = String(config.apiBase || 'https://api.minimax.io/v1').replace(/\/$/, '');
            const url = `${baseUrl}/t2a_v2`;

            const payload: any = {
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

            const response: any = await ctx.http.post(url, payload, {
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

        // 3. 校验音频完整性
        if (!audioBuffer || audioBuffer.length === 0) {
            logger.error(`[${engine}] 返回的音频数据为空`);
            return null;
        }

        if (config.debug) {
            logger.info(`[${engine}] 成功获得音频二进制流，大小: ${audioBuffer.length} 字节`);
        }

        // 4. 写入本地缓存
        if (cacheManager) {
            await cacheManager.saveAudio(text, voiceId, cacheParams, audioBuffer);
        }

        return audioBuffer;

    } catch (error: any) {
        logger.error(`[${engine}] TTS 请求失败:`, error?.response?.data ? Buffer.from(error.response.data).toString() : error?.message || error);
        return null;
    }
}

export async function uploadFile(ctx: Context, config: any, filePath: string, purpose: string) {
    return null;
}

export async function cloneVoice(ctx: Context, config: any, fileId: string, voiceId: string, promptAudioId: string, promptText: string, text: string) {
    return null;
}