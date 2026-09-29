/**
 * 构造缓存查询参数（区分引擎）
 */
function getCacheParams(config) {
    var _a, _b, _c, _d, _e, _f;
    if (config.engine === 'elevenlabs') {
        return {
            engine: 'elevenlabs',
            model: config.speechModel,
            stability: (_a = config.stability) !== null && _a !== void 0 ? _a : 0.5,
            similarityBoost: (_b = config.similarityBoost) !== null && _b !== void 0 ? _b : 0.75,
            style: (_c = config.style) !== null && _c !== void 0 ? _c : 0.0,
            speed: (_d = config.speed) !== null && _d !== void 0 ? _d : 1.0,
            format: (_e = config.outputFormat) !== null && _e !== void 0 ? _e : 'mp3_44100_128',
        };
    }
    else {
        return {
            engine: 'minimax',
            model: config.speechModel,
            speed: config.speed,
            vol: config.vol,
            pitch: config.pitch,
            format: (_f = config.audioFormat) !== null && _f !== void 0 ? _f : 'mp3'
        };
    }
}
/**
 * 核心语音生成函数
 */
export async function generateSpeech(ctx, config, text, voiceId, cacheManager) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o;
    const logger = ctx.logger('tts-service');
    const engine = config.engine || 'elevenlabs';
    try {
        logger.info(`generateSpeech 触发 [${engine}] — 文本字数: ${(_a = text === null || text === void 0 ? void 0 : text.length) !== null && _a !== void 0 ? _a : 0}, voiceId: ${voiceId}`);
    }
    catch (e) {
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
            if (config.debug)
                logger.info('命中本地音频缓存');
            return cached;
        }
    }
    // 2. 调用对应服务商 API
    try {
        let audioBuffer = null;
        if (engine === 'elevenlabs') {
            // ==========================================
            // 分支 1: ElevenLabs 请求逻辑
            // ==========================================
            const outputFormat = config.outputFormat || 'mp3_44100_128';
            let baseUrl = String(config.apiBase || 'https://api.elevenlabs.io/v1').replace(/\/$/, '');
            const url = `${baseUrl}/text-to-speech/${voiceId}?output_format=${outputFormat}`;
            const payload = {
                text: text, // 已经保留了开放式 [tag]
                model_id: config.speechModel || 'eleven_multilingual_v2',
                voice_settings: {
                    stability: (_b = config.stability) !== null && _b !== void 0 ? _b : 0.5,
                    similarity_boost: (_c = config.similarityBoost) !== null && _c !== void 0 ? _c : 0.75,
                    style: (_d = config.style) !== null && _d !== void 0 ? _d : 0.0,
                    use_speaker_boost: (_e = config.useSpeakerBoost) !== null && _e !== void 0 ? _e : true,
                    speed: (_f = config.speed) !== null && _f !== void 0 ? _f : 1.0,
                }
            };
            if (config.debug) {
                logger.info(`[ElevenLabs] 请求 URL: ${url}`);
                logger.info('[ElevenLabs] 请求 payload:', JSON.stringify(payload));
            }
            const response = await ctx.http.post(url, payload, {
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
                }
                catch (e) {
                    // 不是合法 json，继续当成音频处理
                }
            }
            audioBuffer = resBuffer;
        }
        else {
            // ==========================================
            // 分支 2: MiniMax 请求逻辑 (保留原逻辑)
            // ==========================================
            let baseUrl = String(config.apiBase || 'https://api.minimax.io/v1').replace(/\/$/, '');
            const url = `${baseUrl}/t2a_v2`;
            const payload = {
                model: config.speechModel || 'speech-01-turbo',
                text: text,
                stream: false,
                output_format: 'hex',
                voice_setting: {
                    voice_id: voiceId,
                    speed: (_g = config.speed) !== null && _g !== void 0 ? _g : 1.0,
                    vol: (_h = config.vol) !== null && _h !== void 0 ? _h : 1.0,
                    pitch: (_j = config.pitch) !== null && _j !== void 0 ? _j : 0
                },
                audio_setting: {
                    sample_rate: (_k = config.sampleRate) !== null && _k !== void 0 ? _k : 32000,
                    bitrate: (_l = config.bitrate) !== null && _l !== void 0 ? _l : 128000,
                    format: (_m = config.audioFormat) !== null && _m !== void 0 ? _m : 'mp3',
                    channel: 1
                }
            };
            if (config.languageBoost && config.languageBoost !== 'auto') {
                payload.language_boost = config.languageBoost;
            }
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
            }
            else {
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
    }
    catch (error) {
        logger.error(`[${engine}] TTS 请求失败:`, ((_o = error === null || error === void 0 ? void 0 : error.response) === null || _o === void 0 ? void 0 : _o.data) ? Buffer.from(error.response.data).toString() : (error === null || error === void 0 ? void 0 : error.message) || error);
        return null;
    }
}
export async function uploadFile(ctx, config, filePath, purpose) {
    return null;
}
export async function cloneVoice(ctx, config, fileId, voiceId, promptAudioId, promptText, text) {
    return null;
}
