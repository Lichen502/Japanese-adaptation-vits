// src/index.js (纯 JS 版，无任何 TS 类型注释)
import { Schema, h } from 'koishi';
import { AudioCacheManager } from './cache';
import { MinimaxVitsService } from './service';
import { generateSpeech } from './api';
import { 
    isWeixinLikePlatform, 
    makeAudioElement, 
    makeWeixinAudioElement, 
    removeTempFile, 
    writeTempAudioFile 
} from './utils';
import { selectSpeechSentenceByAI } from './tool';

export const name = 'tts-adaptation-service';

// ==========================================
// 模块 A: 语气词与文本清洗系统
// ==========================================

// 1. MiniMax 专用固定白名单（封闭集合）
const MINIMAX_ALLOWED_AUDIO_TAGS = new Set([
    'laughs', 'chuckle', 'coughs', 'clear-throat', 'groans',
    'breath', 'pant', 'inhale', 'exhale', 'gasps', 'sniffs',
    'sighs', 'snorts', 'burps', 'lip-smacking', 'humming',
    'hissing', 'emm', 'whistles', 'sneezes', 'crying', 'applause'
]);

// 2. ElevenLabs 开放式标签匹配正则：方括号包含英文/连字符/空格均视为语气词
const ELEVENLABS_TAG_REGEX = /[\[［]\s*([a-zA-Z][a-zA-Z\s'-]*?)\s*[\]］]/g;
// MiniMax 圆括号匹配正则
const MINIMAX_TAG_REGEX = /[(（]\s*([a-zA-Z-]+)\s*[)）]/gi;

/**
 * ElevenLabs 专用清洗器 (开放式方括号语气词)
 */
function cleanElevenLabsOutput(base, allowInterjections = true) {
    let ttsText = base.replace(/<[\s\S]*?>/g, ''); // 移除 HTML / XML

    if (allowInterjections) {
        // 将所有合法的 [audio tag] 暂时保护替换为标记
        ttsText = ttsText.replace(ELEVENLABS_TAG_REGEX, (match, tag) => {
            return `__EL_TAG_${tag.trim().toLowerCase()}__`;
        });
    }

    // 剔除所有普通括号及内容（如 (旁白)、【说明】等）
    let prev;
    do {
        prev = ttsText;
        ttsText = ttsText.replace(/[(（\[［【][^()（）\[\]［］【】]*[)）\]］】]/g, '');
    } while (ttsText !== prev);

    // 剔除动作星号内容 (*动作*)
    do {
        prev = ttsText;
        ttsText = ttsText.replace(/\*[^*]*\*/g, '');
    } while (ttsText !== prev);

    ttsText = ttsText.replace(/\*\*/g, '').replace(/[~～]{2,}/g, '~').replace(/(\.{2,}|…+|。{2,})/g, '…');

    // 还原语气词标签为 ElevenLabs 标准格式 [tag]
    if (allowInterjections) {
        ttsText = ttsText.replace(/__EL_TAG_([a-zA-Z\s'-]+)__/g, '[$1]');
    }
    ttsText = ttsText.replace(/\s+/g, ' ').trim();

    // 构建展示文本：彻底删除方括号语气词
    let displayText = base;
    displayText = displayText.replace(ELEVENLABS_TAG_REGEX, '');
    displayText = displayText.replace(/[~～]{2,}/g, '~').replace(/(\.{2,}|…+|。{2,})/g, '…');
    displayText = displayText.replace(/\s+/g, ' ').trim();
    displayText = displayText.replace(/\s+([。！？.!?、，,；;:]+)/g, '$1');

    return { ttsText, displayText };
}

/**
 * MiniMax 专用清洗器 (白名单圆括号语气词)
 */
function cleanMinimaxOutput(base, allowInterjections = false) {
    let ttsText = base.replace(/<[\s\S]*?>/g, '');
    if (allowInterjections) {
        ttsText = ttsText.replace(/[(（\[［【]\s*([a-zA-Z-]+)\s*[)）\]］】]/g, (match, tag) => {
            if (MINIMAX_ALLOWED_AUDIO_TAGS.has(tag.toLowerCase())) {
                return `__MM_TAG_${tag.toLowerCase()}__`;
            }
            return match;
        });
    }

    let prev;
    do {
        prev = ttsText;
        ttsText = ttsText.replace(/[(（\[［【][^()（）\[\]［］【】]*[)）\]］】]/g, '');
    } while (ttsText !== prev);

    do {
        prev = ttsText;
        ttsText = ttsText.replace(/\*[^*]*\*/g, '');
    } while (ttsText !== prev);

    ttsText = ttsText.replace(/\*\*/g, '').replace(/[~～]{2,}/g, '~').replace(/(\.{2,}|…+|。{2,})/g, '…');

    if (allowInterjections) {
        ttsText = ttsText.replace(/([。！？.!?、，,；;:]+)\s*(__MM_TAG_[a-zA-Z-]+__)/g, '$2$1');
        ttsText = ttsText.replace(/__MM_TAG_([a-zA-Z-]+)__/g, '($1)');
    }
    ttsText = ttsText.replace(/\s+/g, ' ').trim();

    let displayText = base;
    if (allowInterjections) {
        displayText = displayText.replace(/[(（\[［【]\s*([a-zA-Z-]+)\s*[)）\]］】]/g, (match, tag) => {
            if (MINIMAX_ALLOWED_AUDIO_TAGS.has(tag.toLowerCase())) return '';
            return match;
        });
    }
    displayText = displayText.replace(/[~～]{2,}/g, '~').replace(/(\.{2,}|…+|。{2,})/g, '…');
    displayText = displayText.replace(/\s+/g, ' ').trim();
    displayText = displayText.replace(/\s+([。！？.!?、，,；;:]+)/g, '$1');

    return { ttsText, displayText };
}

/**
 * 统一清洗入口
 */
function cleanModelOutput(text, allowInterjections = false, engine = 'elevenlabs') {
    if (!text) return { ttsText: '', displayText: '' };

    // 通用预处理：去除思维链
    let base = text.replace(/<\|im_start\|>[\s\S]*?<\|im_end\|>/g, '');
    base = base.replace(/<think>[\s\S]*?<\/think>/gi, '');

    if (engine === 'elevenlabs') {
        return cleanElevenLabsOutput(base, allowInterjections);
    } else {
        return cleanMinimaxOutput(base, allowInterjections);
    }
}

// ==========================================
// 模块 B: 文本分段
// ==========================================
function splitTextIntoSegments(text) {
    if (!text) return [];
    const matches = text.match(/[^。！？.!?\n]+[。！？.!?\n]*/g);
    if (!matches) return [text.trim()];
    return matches.map(s => s.trim()).filter(s => s.length > 0);
}

// ==========================================
// 模块 C: 小模型决策过滤
// ==========================================
const OPENAI_TIMEOUT = 15000;
const OPENAI_MAX_RETRIES = 2;
const OPENAI_RETRY_DELAY = 1000;

async function openaiSleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function shouldUseOpenAIFilter(text, minLength) {
    const sentences = text.split(/[。！？.!?\n]+/).filter(s => s.trim().length > 0);
    if (sentences.length <= 1) return false;
    if (text.length > 500) return true;
    if (sentences.length >= 3) return true;
    return false;
}

async function selectSpeechTextByOpenAI(ctx, config, text, logger) {
    const oa = config.autoSpeech;
    const minLen = config.autoSpeech?.minLength ?? 2;

    if (!oa?.openaiLikeBaseUrl || !oa?.openaiLikeApiKey || !oa?.openaiLikeModel) {
        if (config.debug) logger?.warn('未配置完整的 OpenAI 类小模型参数，跳过小模型筛选');
        return null;
    }

    if (!shouldUseOpenAIFilter(text, minLen)) {
        if (config.debug) logger?.info('文本较短或只有一句，跳过 OpenAI 小模型筛选');
        return null;
    }

    let baseUrl = String(oa.openaiLikeBaseUrl).replace(/\/$/, '');
    if (baseUrl.endsWith('/v1')) baseUrl = baseUrl.slice(0, -3);
    const url = `${baseUrl}/v1/chat/completions`;
    const systemPrompt = oa.customPrompt.trim();

    for (let attempt = 0; attempt <= OPENAI_MAX_RETRIES; attempt++) {
        try {
            const resp = await ctx.http.post(url, {
                model: oa.openaiLikeModel,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: text }
                ],
                temperature: 0.3,
                max_tokens: 200,
            }, {
                headers: { Authorization: `Bearer ${oa.openaiLikeApiKey}` },
                timeout: OPENAI_TIMEOUT,
            });

            const content = resp?.choices?.[0]?.message?.content?.trim();
            if (!content) return null;

            const upperContent = content.toUpperCase();
            if (upperContent === 'EMPTY' || upperContent === 'NONE' || upperContent === 'NULL') {
                return null;
            }

            const cleanedContent = content.replace(/^["'，。！？、:：]+|["'，。！？、:：]+$/g, '').trim();
            if (cleanedContent.length < minLen) return null;
            return cleanedContent;
        } catch (error) {
            if (attempt < OPENAI_MAX_RETRIES) {
                await openaiSleep(OPENAI_RETRY_DELAY);
                continue;
            }
            logger?.warn('OpenAI 筛选内容失败:', error?.message || error);
            return null;
        }
    }
    return null;
}

// ==========================================
// 配置 Schema
// ==========================================
export const schema = Schema.object({
    engine: Schema.union([
        Schema.const('elevenlabs').description('ElevenLabs 引擎'),
        Schema.const('minimax').description('MiniMax 引擎'),
    ]).default('elevenlabs').description('选择使用的语音合成引擎'),

    // --- 通用 / ElevenLabs 专属配置 ---
    ttsApiKey: Schema.string().default('').description('TTS API Key (ElevenLabs / MiniMax)').role('secret'),
    apiBase: Schema.string().default('https://api.elevenlabs.io/v1').description('API Base URL'),
    defaultVoice: Schema.string().default('21m00Tcm4TlvDq8ikWAM').description('默认 Voice ID'),
    speechModel: Schema.string().default('eleven_multilingual_v2').description('模型 ID (如 eleven_multilingual_v2, eleven_flash_v2_5)'),
    
    // ElevenLabs 核心微调
    stability: Schema.number().default(0.5).min(0.0).max(1.0).step(0.05).description('稳定性 (较低=更有情绪起伏；较高=冷静沉稳)'),
    similarityBoost: Schema.number().default(0.75).min(0.0).max(1.0).step(0.05).description('原声相似度 (越高越贴近原声音色)'),
    style: Schema.number().default(0.0).min(0.0).max(1.0).step(0.05).description('风格夸张度 (设为 0 较平稳)'),
    speed: Schema.number().default(1.0).min(0.7).max(1.2).step(0.05).description('语速 (0.7 ~ 1.2)'),
    useSpeakerBoost: Schema.boolean().default(true).description('开启说话人增强'),

    // MiniMax 专属参数保留
    groupId: Schema.string().default('').description('MiniMax Group ID (仅 MiniMax 需要)'),
    pitch: Schema.number().default(0).min(-12).max(12).description('音调 (仅 MiniMax 支持物理调 pitch)'),

    // 输出格式
    outputFormat: Schema.string().default('mp3_44100_128').description('输出格式 (ElevenLabs 如 mp3_44100_128, pcm_16000)'),
    audioFormat: Schema.union([
        Schema.const('mp3').description('MP3'),
        Schema.const('wav').description('WAV')
    ]).default('mp3').description('本地保存/发送时的音频格式'),

    interjections: Schema.boolean().default(true).description('是否启用语气词 Tags (ElevenLabs 开放识别 [...]，MiniMax 识别指定清单)'),

    autoSpeech: Schema.object({
        enabled: Schema.boolean().default(false).description('启用对话自动转语音'),
        whitelist: Schema.object({
            groupEnabled: Schema.boolean().default(false).description('启用群聊白名单'),
            groupList: Schema.array(String).role('table').default([]).description('群聊白名单群号'),
            privateEnabled: Schema.boolean().default(false).description('启用私聊白名单'),
            privateList: Schema.array(String).role('table').default([]).description('私聊白名单用户ID'),
        }).description('黑白名单机制'),
        sendMode: Schema.union([
            Schema.const('voice_only').description('仅发送语音'),
            Schema.const('text_and_voice').description('发送语音+文本(分两条)'),
            Schema.const('mixed').description('文本+语音混合(同条消息)')
        ]).default('text_and_voice').description('发送模式'),
        minLength: Schema.number().default(2).description('触发转换的最短字符数'),
        selectorMode: Schema.union([
            Schema.const('full').description('整条文本直接朗读'),
            Schema.const('ai_sentence').description('智能挑选一句朗读'),
            Schema.const('openai_filter').description('通过 OpenAI 接口精选朗读内容'),
        ]).default('full').description('语音内容选择策略'),
        openaiLikeBaseUrl: Schema.string().description('OpenAI 兼容接口 Base URL'),
        openaiLikeApiKey: Schema.string().role('secret').description('OpenAI 兼容接口 API Key'),
        openaiLikeModel: Schema.string().description('小模型名称'),
        customPrompt: Schema.string().role('textarea')
            .default('挑选适合口语朗读的一段内容，剔除思维链、代码与提示词，若无合适内容返回 EMPTY。')
            .description('筛选 System Prompt'),
    }).description('自动语音转换设置'),

    debug: Schema.boolean().default(false).description('启用调试日志'),
    cacheEnabled: Schema.boolean().default(true).description('启用本地文件缓存'),
    cacheDir: Schema.string().default('./data/tts-adaptation-service/cache').description('缓存路径'),
    cacheMaxAge: Schema.number().default(3600000).min(60000).description('缓存有效期(ms)'),
    cacheMaxSize: Schema.number().default(104857600).description('缓存最大体积(bytes)'),
}).description('TTS 服务配置');

export const Config = schema;

export function apply(ctx, config) {
    const state = ctx.state;
    const logger = ctx.logger(name);

    // ======================================================
    // 1. 缓存初始化
    // ======================================================
    let cacheManager;
    if (config.cacheEnabled) {
        if (!state.cacheManager) {
            state.cacheManager = new AudioCacheManager(
                config.cacheDir ?? './data/tts-adaptation-service/cache',
                logger,
                { enabled: true, maxAge: config.cacheMaxAge ?? 3600000, maxSize: config.cacheMaxSize ?? 104857600 }
            );
            state.cacheManager.initialize().catch((err) => { logger.warn('缓存初始化失败:', err); });
        }
        cacheManager = state.cacheManager;
    } else {
        state.cacheManager?.dispose();
        delete state.cacheManager;
        cacheManager = undefined;
    }

    // ======================================================
    // 2. 核心拦截：对话后自动语音转换
    // ======================================================
    if (config.autoSpeech?.enabled) {
        ctx.on('ready', () => {
            logger.info(`全局语音拦截已启动 (当前引擎: ${config.engine})`);
        });

        ctx.before('send', async (session) => {
            try {
                if (!session.content) return;
                // 防死循环：跳过音频元素
                if (session.content.includes('<audio') || session.content.includes('[CQ:record')) {
                    return;
                }

                const elements = session.elements || h.parse(session.content);

                // 根据当前引擎清洗展示文本：
                // ElevenLabs 剔除所有 [xxx]，MiniMax 剔除名单内的 (xxx)
                const userVisibleElements = h.transform(elements, {
                    text: (attrs) => {
                        let cleaned = attrs.content;
                        if (config.engine === 'elevenlabs') {
                            cleaned = cleaned.replace(ELEVENLABS_TAG_REGEX, '');
                        } else {
                            cleaned = cleaned.replace(MINIMAX_TAG_REGEX, (m, tag) => {
                                return MINIMAX_ALLOWED_AUDIO_TAGS.has(tag.toLowerCase()) ? '' : m;
                            });
                        }
                        return h.text(cleaned);
                    },
                });

                // 如果开启了语气词过滤，更新即将发给用户的 session 文本
                if (config.interjections) {
                    session.elements = userVisibleElements;
                    session.content = userVisibleElements.join('');
                }

                // 提取包含标签的完整原始内容供 TTS 使用
                const rawTextForTTS = elements
                    .map(el => el.type === 'text' ? el.attrs.content : '')
                    .join(' ');

                // 检查白名单
                if (config.autoSpeech?.whitelist) {
                    const wl = config.autoSpeech.whitelist;
                    const isDirect = session.isDirect || !session.guildId;
                    const targetUserId = session.userId || session.channelId || '';
                    const targetGroupId = session.guildId || session.channelId || '';

                    if (isDirect) {
                        const inWhitelist = wl.privateList.some((id) => targetUserId.includes(id));
                        if (wl.privateEnabled && !inWhitelist) return;
                    } else {
                        const inWhitelist = wl.groupList.some((id) => targetGroupId.includes(id));
                        if (wl.groupEnabled && !inWhitelist) return;
                    }
                }

                // 清洗出供语音模型读的文本 (保留标签)
                const { ttsText } = cleanModelOutput(rawTextForTTS, config.interjections, config.engine);
                if (!ttsText || ttsText.length < (config.autoSpeech.minLength ?? 2)) {
                    return;
                }

                let targetText = ttsText;
                if (config.autoSpeech.selectorMode === 'ai_sentence') {
                    try {
                        const aiSelected = await selectSpeechSentenceByAI(ctx, config, ttsText, logger);
                        if (aiSelected && aiSelected.length >= (config.autoSpeech.minLength ?? 2)) {
                            targetText = aiSelected;
                        }
                    } catch (e) {
                        logger.warn('AI 挑选句子失败:', e);
                    }
                } else if (config.autoSpeech.selectorMode === 'openai_filter') {
                    try {
                        const selected = await selectSpeechTextByOpenAI(ctx, config, ttsText, logger);
                        if (!selected || selected.trim().length < (config.autoSpeech.minLength ?? 2)) return;
                        targetText = selected.trim();
                    } catch (e) {
                        logger.warn('OpenAI 筛选失败:', e);
                    }
                }

                const segments = splitTextIntoSegments(targetText);
                if (segments.length === 0) return;

                // 生成音频
                const audioBuffers = await Promise.all(
                    segments.map(seg => generateSpeech(ctx, config, seg, config.defaultVoice, cacheManager))
                );
                const validBuffers = audioBuffers.filter((b) => b !== null);
                if (validBuffers.length === 0) return;

                const finalBuffer = Buffer.concat(validBuffers);
                const isWeixin = isWeixinLikePlatform(session?.platform);
                let audioElem;
                let tempAudioPath = '';

                if (isWeixin) {
                    tempAudioPath = await writeTempAudioFile(finalBuffer, config.audioFormat ?? 'mp3');
                    audioElem = makeWeixinAudioElement(tempAudioPath);
                } else {
                    audioElem = makeAudioElement(finalBuffer, config.audioFormat ?? 'mp3');
                }

                // 消息发送派发
                switch (config.autoSpeech.sendMode) {
                    case 'voice_only':
                        session.elements = [audioElem];
                        session.content = audioElem.toString();
                        break;
                    case 'mixed':
                        const mixed = [...userVisibleElements, audioElem];
                        session.elements = mixed;
                        session.content = mixed.join('');
                        break;
                    case 'text_and_voice':
                    default:
                        if (session.channelId) {
                            await session.bot.sendMessage(session.channelId, audioElem, session.guildId);
                        }
                        session.elements = userVisibleElements;
                        session.content = userVisibleElements.join('');
                        break;
                }

                if (isWeixin && tempAudioPath) {
                    setTimeout(() => { void removeTempFile(tempAudioPath); }, 60000);
                }
            } catch (err) {
                logger.error('自动语音转换异常:', err);
            }
        });
    }

    // ======================================================
    // 3. 服务与生命周期
    // ======================================================
    ctx.inject(['console'], (injectedCtx) => {
        try {
            if (state.minimaxVitsService) {
                state.minimaxVitsService.updateConfig(config).catch((err) => { logger.warn('更新配置失败:', err); });
            } else {
                state.minimaxVitsService = new MinimaxVitsService(injectedCtx, config);
            }
        } catch (error) {
            logger.warn('注册控制台服务异常:', error);
        }
    });

    ctx.on('ready', async () => { await cacheManager?.initialize(); });
    ctx.on('dispose', () => {
        state.cacheManager?.dispose();
        delete state.cacheManager;
        delete state.minimaxVitsService;
    });

    // ======================================================
    // 4. 测试指令
    // ======================================================
    ctx.command('tts.test <text:text>', '测试语音合成')
        .option('voice', '-v <voice>')
        .option('speed', '-s <speed>', { type: 'number' })
        .action(async ({ session, options }, text) => {
            if (!session || !text) return '请输入要合成的文本';

            const { ttsText, displayText } = cleanModelOutput(text, config.interjections, config.engine);
            if (!ttsText) return '清洗后文本为空，无需生成语音';

            await session.send('语音生成中，请稍候...');
            const buffer = await generateSpeech(
                ctx,
                { ...config, speed: options?.speed ?? config.speed },
                ttsText,
                options?.voice || config.defaultVoice,
                cacheManager
            );
            if (!buffer) return '语音生成失败，请检查控制台日志';

            const audioElem = makeAudioElement(buffer, config.audioFormat ?? 'mp3');
            await session.send(audioElem);
            if (displayText) await session.send(displayText);
        });
}

export default {
    name,
    schema,
    Config,
    apply
};