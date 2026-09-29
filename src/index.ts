// src/index.ts
import { Schema, h, Context } from 'koishi';
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

// 2. ElevenLabs 开放式标签匹配正则：只要是方括号包含英文/连字符/空格（如 [laughs], [deep voice]）均视为语气词
const ELEVENLABS_TAG_REGEX = /[\[［]\s*([a-zA-Z][a-zA-Z\s'-]*?)\s*[\]］]/g;
// MiniMax 圆括号匹配正则
const MINIMAX_TAG_REGEX = /[(（]\s*([a-zA-Z-]+)\s*[)）]/gi;

/**
 * ElevenLabs 专用清洗器 (开放式方括号语气词)
 */
function cleanElevenLabsOutput(base: string, allowInterjections = true) {
    let ttsText = base.replace(/<[\s\S]*?>/g, ''); // 移除 HTML / XML

    if (allowInterjections) {
        // 先将所有合法的 [audio tag] 暂时保护替换为标记
        ttsText = ttsText.replace(ELEVENLABS_TAG_REGEX, (match, tag) => {
            return `__EL_TAG_${tag.trim().toLowerCase()}__`;
        });
    }

    // 剔除所有普通括号及内容（如 (旁白)、【说明】、未匹配的中文方括号等）
    let prev: string;
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

    // 还原语气词标签为 ElevenLabs 识别的标准格式 [tag]
    if (allowInterjections) {
        ttsText = ttsText.replace(/__EL_TAG_([a-zA-Z\s'-]+)__/g, '[$1]');
    }
    ttsText = ttsText.replace(/\s+/g, ' ').trim();

    // 构建 QQ / 平台可见文本：彻底删除方括号语气词
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
function cleanMinimaxOutput(base: string, allowInterjections = false) {
    let ttsText = base.replace(/<[\s\S]*?>/g, '');
    if (allowInterjections) {
        ttsText = ttsText.replace(/[(（\[［【]\s*([a-zA-Z-]+)\s*[)）\]］】]/g, (match, tag) => {
            if (MINIMAX_ALLOWED_AUDIO_TAGS.has(tag.toLowerCase())) {
                return `__MM_TAG_${tag.toLowerCase()}__`;
            }
            return match;
        });
    }

    let prev: string;
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
function cleanModelOutput(text: string, allowInterjections = false, engine: 'elevenlabs' | 'minimax' = 'minimax') {
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
function splitTextIntoSegments(text: string): string[] {
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

async function openaiSleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function shouldUseOpenAIFilter(text: string, minLength: number): boolean {
    const sentences = text.split(/[。！？.!?\n]+/).filter(s => s.trim().length > 0);
    if (sentences.length <= 1) return false;
    if (text.length > 500) return true;
    if (sentences.length >= 3) return true;
    return false;
}

async function selectSpeechTextByOpenAI(ctx: Context, config: any, text: string, logger: any): Promise<string | null> {
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
            const resp: any = await ctx.http.post(url, {
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
        } catch (error: any) {
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
export type ConfigType = {
    provider: 'minimax' | 'elevenlabs';
    // MiniMax
    ttsApiKey?: string;
    groupId?: string;
    apiBase?: string;
    defaultVoice?: string;
    speechModel?: string;
    speed?: number;
    vol?: number;
    pitch?: number;
    audioFormat?: 'mp3' | 'wav';
    sampleRate?: number;
    bitrate?: number;
    outputFormat?: string;
    languageBoost?: string;
    interjections?: boolean;

    // ElevenLabs
    elevenlabsApiKey?: string;
    elevenlabsApiBase?: string;
    elevenlabsVoiceId?: string;
    elevenlabsModelId?: string;
    // 官方原生 voice_settings
    elevenlabsSpeed?: number;
    elevenlabsStability?: number;
    elevenlabsSimilarityBoost?: number;
    elevenlabsStyle?: number;
    elevenlabsUseSpeakerBoost?: boolean;
    // 官方高级控制与格式
    elevenlabsOutputFormat?: string;
    elevenlabsAudioFormat?: 'mp3' | 'wav';
    elevenlabsLanguageCode?: string;
    elevenlabsApplyTextNormalization?: 'auto' | 'on' | 'off';
    elevenlabsSeed?: number;
    elevenlabsOptimizeStreamingLatency?: number;

    // Common
    autoSpeech?: {
        enabled?: boolean;
        whitelist?: {
            groupEnabled?: boolean;
            groupList?: string[];
            privateEnabled?: boolean;
            privateList?: string[];
        };
        sendMode?: 'voice_only' | 'text_and_voice' | 'mixed';
        minLength?: number;
        selectorMode?: 'full' | 'ai_sentence' | 'openai_filter';
        openaiLikeBaseUrl?: string;
        openaiLikeApiKey?: string;
        openaiLikeModel?: string;
        customPrompt?: string;
    };
    debug?: boolean;
    cacheEnabled?: boolean;
    cacheDir?: string;
    cacheMaxAge?: number;
    cacheMaxSize?: number;
};

export const schema: Schema<ConfigType> = Schema.intersect([
    // 1. 服务商选择器
    Schema.object({
        provider: Schema.union([
            Schema.const('minimax').description('MiniMax 语音合成'),
            Schema.const('elevenlabs').description('ElevenLabs 语音合成')
        ]).default('minimax').description('选择 TTS 服务商'),
    }),

    // 2. 动态显示对应服务商的配置
    Schema.union([
        // --- MiniMax 配置项 ---
        Schema.object({
            provider: Schema.const('minimax'),
            ttsApiKey: Schema.string().default('').description('MiniMax TTS API Key').role('secret'),
            groupId: Schema.string().default('').description('MiniMax Group ID'),
            apiBase: Schema.string().default('https://api.minimax.io/v1').description('API 基础地址'),
            defaultVoice: Schema.string().default('Chinese_female_gentle').description('默认语音 ID'),
            speechModel: Schema.string().default('speech-01-turbo').description('TTS 模型 (推荐 speech-01-turbo)'),
            speed: Schema.number().default(1.0).min(0.5).max(2.0).description('语速'),
            vol: Schema.number().default(1.0).min(0.0).max(2.0).description('音量'),
            pitch: Schema.number().default(0).min(-12).max(12).description('音调'),
            audioFormat: Schema.union([
                Schema.const('mp3').description('MP3 格式'),
                Schema.const('wav').description('WAV 格式')
            ]).default('mp3').description('音频封装格式'),
            sampleRate: Schema.union([
                Schema.const(16000), Schema.const(24000), Schema.const(32000), Schema.const(44100), Schema.const(48000)
            ]).default(32000).description('采样率'),
            bitrate: Schema.union([
                Schema.const(64000), Schema.const(96000), Schema.const(128000), Schema.const(192000), Schema.const(256000)
            ]).default(128000).description('比特率'),
            outputFormat: Schema.const('hex').description('API输出编码 (必须是 hex)'),
            languageBoost: Schema.union([
                Schema.const('auto').description('自动'), Schema.const('zh').description('中文'),
                Schema.const('en').description('英文'), Schema.const('ja').description('日文')
            ]).default('auto').description('语言增强'),
            interjections: Schema.boolean().default(false).description('是否传语气词给模型(仅限支持语气词的模型)'),
        }).description('MiniMax 设置'),

        // --- ElevenLabs 配置项 (原生完整支持) ---
        Schema.object({
            provider: Schema.const('elevenlabs'),
            elevenlabsApiKey: Schema.string().default('').description('ElevenLabs API Key').role('secret'),
            elevenlabsApiBase: Schema.string().default('https://api.elevenlabs.io/v1').description('ElevenLabs API 基础地址'),
            elevenlabsVoiceId: Schema.string().default('21m00Tcm4TlvDq8ikWAM').description('默认 Voice ID (例如 Rachel)'),
            elevenlabsModelId: Schema.union([
                Schema.const('eleven_v3').description('eleven_v3 (最新旗舰，语气词与情感最佳)'),
                Schema.const('eleven_multilingual_v2').description('eleven_multilingual_v2 (经典稳定多语言)'),
                Schema.const('eleven_flash_v2_5').description('eleven_flash_v2_5 (极速多语言，超低延迟)'),
                Schema.const('eleven_turbo_v2_5').description('eleven_turbo_v2_5 (质量与速度平衡)'),
                Schema.string().description('自定义其他模型 ID')
            ]).default('eleven_v3').description('TTS 模型 ID'),

            // 核心声音属性调节 (voice_settings)
            elevenlabsSpeed: Schema.number().default(1.0).min(0).max(1.2).step(0.05).description('语速 (0.7 慢速 ~ 1.2 快速，默认 1.0)'),
            elevenlabsStability: Schema.number().default(0.5).min(0.0).max(1.0).step(0.05).description('稳定性 (较低=更有情绪波动与随机性；较高=冷静沉稳)'),
            elevenlabsSimilarityBoost: Schema.number().default(0.75).min(0.0).max(1.0).step(0.05).description('相似度提升 (越高越贴近原音色，过高可能引入底噪)'),
            elevenlabsStyle: Schema.number().default(0.0).min(0.0).max(1.0).step(0.05).description('风格夸张度 (放大说话人的说话风格与情绪，设为 0 较平稳)'),
            elevenlabsUseSpeakerBoost: Schema.boolean().default(true).description('启用说话人增强 (提高清晰度并强化原声音色相似度)'),

            // 输出格式与质量
            elevenlabsOutputFormat: Schema.union([
                Schema.const('mp3_44100_128').description('MP3 44.1kHz 128kbps (标准推荐)'),
                Schema.const('mp3_44100_192').description('MP3 44.1kHz 192kbps (高清，需付费账号)'),
                Schema.const('pcm_16000').description('PCM 16kHz (WAV/低采样率)'),
                Schema.const('pcm_24000').description('PCM 24kHz (WAV/中采样率)'),
                Schema.const('pcm_44100').description('PCM 44.1kHz (CD无损级 WAV)'),
                Schema.const('ulaw_8000').description('u-law 8kHz (电话音质)')
            ]).default('mp3_44100_128').description('API 音频输出编码规格 (output_format)'),

            elevenlabsAudioFormat: Schema.union([
                Schema.const('mp3').description('MP3 封装'),
                Schema.const('wav').description('WAV 封装')
            ]).default('mp3').description('本地保存/发送时的封装格式 (若 output_format 为 pcm 请选 wav)'),

            // 高级控制
            elevenlabsLanguageCode: Schema.union([
                Schema.const('auto').description('自动识别'),
                Schema.const('ja').description('日语 (ja)'),
                Schema.const('zh').description('中文 (zh)'),
                Schema.const('en').description('英语 (en)'),
                Schema.const('ko').description('韩语 (ko)'),
                Schema.string().description('其他 ISO 639-1 语言代码')
            ]).default('auto').description('强制语言代码 (显式指明发音语言，可减少多语言跑偏)'),

            elevenlabsApplyTextNormalization: Schema.union([
                Schema.const('auto').description('自动 (auto)'),
                Schema.const('on').description('开启 (on - 自动将数字、日期与符号转换为读音)'),
                Schema.const('off').description('关闭 (off - 原样字面读出)')
            ]).default('auto').description('文本归一化模式 (apply_text_normalization)'),

            elevenlabsSeed: Schema.number().min(-1).max(4294967295).step(1).default(-1).description('随机种子 Seed (-1 为完全随机；指定数字可固定相同的音调起伏)'),
            elevenlabsOptimizeStreamingLatency: Schema.union([
                Schema.const(0).description('0 - 关闭延迟优化 (完整音质)'),
                Schema.const(1).description('1 - 基础低延迟优化'),
                Schema.const(2).description('2 - 中级低延迟优化'),
                Schema.const(3).description('3 - 高级低延迟优化'),
                Schema.const(4).description('4 - 极致首字延迟 (可能稍微影响自然度)')
            ]).default(0).description('流式延迟优化等级 (optimize_streaming_latency)'),
        }).description('ElevenLabs 设置')
    ]),

    // 3. 通用配置（不论选哪个服务商都会显示）
    Schema.object({
        autoSpeech: Schema.object({
            enabled: Schema.boolean().default(false).description('启用 ChatLuna 对话自动转语音'),

            whitelist: Schema.object({
                groupEnabled: Schema.boolean().default(false).description('启用群聊白名单（开启后仅白名单内群聊触发自动转语音）'),
                groupList: Schema.array(String).role('table').default([]).description('群聊白名单列表 (填写群号)'),
                privateEnabled: Schema.boolean().default(false).description('启用私聊白名单（开启后仅白名单内用户触发自动转语音）'),
                privateList: Schema.array(String).role('table').default([]).description('私聊白名单列表 (填写用户Id)'),
            }).description('黑白名单机制（关闭则对所有人生效）'),

            sendMode: Schema.union([
                Schema.const('voice_only').description('仅发送语音'),
                Schema.const('text_and_voice').description('发送语音+文本(分两条)'),
                Schema.const('mixed').description('文本+语音混合(同条消息)')
            ]).default('text_and_voice').description('发送模式'),
            minLength: Schema.number().default(2).description('触发转换的最短字符数'),

            selectorMode: Schema.union([
                Schema.const('full').description('整条文本直接转语音（默认逻辑）'),
                Schema.const('ai_sentence').description('交给 ChatLuna / 小模型从中挑选一句朗读'),
                Schema.const('openai_filter').description('通过 OpenAI 兼容接口，让小模型决定具体朗读内容'),
            ]).default('full').description('语音内容选择策略'),

            openaiLikeBaseUrl: Schema.string().description('OpenAI 兼容接口 Base URL'),
            openaiLikeApiKey: Schema.string().role('secret').description('OpenAI 兼容接口 API Key'),
            openaiLikeModel: Schema.string().description('用于筛选朗读内容的小模型名称'),
            customPrompt: Schema.string().role('textarea')
                .default('你是一个专业的"语音内容筛选助手"。你的任务是从给定的聊天文本中挑选出最适合朗读的一段。\n\n筛选规则：\n1. 选择自然流畅、口语化的内容（对话、回答、叙述），偏向于情感表达的句子，比如"你好"、"我很喜欢你"等类似句子。\n2. 排除以下内容：\n   - 思维链、推理过程（如"让我想想..."、"因为...所以..."）\n   - 代码块、技术术语\n   - 系统提示、指令、引导语\n   - 重复的客套话\n3. 如果整段都不适合朗读，返回"EMPTY"\n\n输出要求：\n- 只返回选中的内容，不要添加任何解释、标点或引号\n- 如果不适合朗读，返回"EMPTY"\n- 返回内容长度控制在 20-100 字之间效果最佳')
                .description('自定义 System Prompt'),
        }).description('自动语音转换设置'),

        debug: Schema.boolean().default(false).description('启用调试日志'),
        cacheEnabled: Schema.boolean().default(true).description('启用本地文件缓存'),
        cacheDir: Schema.string().default('./data/tts-adaptation-service/cache').description('缓存路径'),
        cacheMaxAge: Schema.number().default(3600000).min(60000).description('缓存有效期(ms)'),
        cacheMaxSize: Schema.number().default(104857600).min(1048576).max(1073741824).description('缓存最大体积(bytes)'),
    }).description('通用/其他设置')
]);

export const Config = schema;

/**
 * 运行时参数适配辅助函数：将分别保存的配置映射为 TTS API 标准入参
 */
function resolveTTSRuntimeParams(config: ConfigType) {
    const isEL = config.provider === 'elevenlabs';
    const apiKey = isEL ? config.elevenlabsApiKey : config.ttsApiKey;
    const apiBase = isEL ? (config.elevenlabsApiBase || 'https://api.elevenlabs.io/v1') : (config.apiBase || 'https://api.minimax.io/v1');
    const defaultVoice = isEL ? (config.elevenlabsVoiceId || '21m00Tcm4TlvDq8ikWAM') : (config.defaultVoice || 'Chinese_female_gentle');
    const speechModel = isEL ? (config.elevenlabsModelId || 'eleven_v3') : (config.speechModel || 'speech-01-turbo');

    // 音频格式适配
    const isPcmOutput = config.elevenlabsOutputFormat?.startsWith('pcm');
    const audioFormat = isEL ? (isPcmOutput ? 'wav' : (config.elevenlabsAudioFormat || 'mp3')) : (config.audioFormat || 'mp3');
    const allowInterjections = isEL ? true : Boolean(config.interjections);
    const speed = isEL ? (config.elevenlabsSpeed ?? 1.0) : (config.speed ?? 1.0);

    return {
        ...config,
        engine: config.provider,
        provider: config.provider,
        ttsApiKey: apiKey,
        apiKey: apiKey,
        apiBase,
        defaultVoice,
        voiceId: defaultVoice,
        speechModel,
        modelId: speechModel,
        audioFormat,
        allowInterjections,
        speed,

        // ElevenLabs 专用 voice_settings
        stability: config.elevenlabsStability ?? 0.5,
        similarityBoost: config.elevenlabsSimilarityBoost ?? 0.75,
        style: config.elevenlabsStyle ?? 0.0,
        useSpeakerBoost: config.elevenlabsUseSpeakerBoost ?? true,

        // ElevenLabs 高级生成参数与格式
        outputFormat: isEL ? (config.elevenlabsOutputFormat || 'mp3_44100_128') : config.outputFormat,
        languageCode: (isEL && config.elevenlabsLanguageCode !== 'auto') ? config.elevenlabsLanguageCode : undefined,
        applyTextNormalization: isEL ? config.elevenlabsApplyTextNormalization : undefined,
        seed: (isEL && config.elevenlabsSeed !== undefined && config.elevenlabsSeed >= 0) ? config.elevenlabsSeed : undefined,
        optimizeStreamingLatency: isEL ? config.elevenlabsOptimizeStreamingLatency : undefined,

        // 通用 / MiniMax 专属
        vol: config.vol ?? 1.0,
        pitch: config.pitch ?? 0,
    };
}

export function apply(ctx: Context, config: ConfigType) {
    const state = ctx.state as any;
    const logger = ctx.logger(name);

    // ======================================================
    // 1. 缓存初始化
    // ======================================================
    let cacheManager: AudioCacheManager | undefined;
    if (config.cacheEnabled) {
        if (!state.cacheManager) {
            state.cacheManager = new AudioCacheManager(
                config.cacheDir ?? './data/tts-adaptation-service/cache',
                logger,
                { enabled: true, maxAge: config.cacheMaxAge ?? 3600000, maxSize: config.cacheMaxSize ?? 104857600 }
            );
            state.cacheManager.initialize().catch((err: any) => { logger.warn('缓存初始化失败:', err); });
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
            logger.info(`全局语音拦截已启动 (当前服务商: ${config.provider})`);
        });

        ctx.before('send', async (session) => {
            try {
                if (!session.content) return;
                // 防死循环：跳过音频元素
                if (session.content.includes('<audio') || session.content.includes('[CQ:record')) {
                    return;
                }

                const runtimeParams = resolveTTSRuntimeParams(config);
                const elements = session.elements || h.parse(session.content);

                // 根据当前引擎清洗展示文本：
                // ElevenLabs 剔除所有 [xxx] 标签，MiniMax 剔除名单内的 (xxx)
                const userVisibleElements = h.transform(elements, {
                    text: (attrs) => {
                        let cleaned = attrs.content;
                        if (config.provider === 'elevenlabs') {
                            cleaned = cleaned.replace(ELEVENLABS_TAG_REGEX, '');
                        } else {
                            cleaned = cleaned.replace(MINIMAX_TAG_REGEX, (m: string, tag: string) => {
                                return MINIMAX_ALLOWED_AUDIO_TAGS.has(tag.toLowerCase()) ? '' : m;
                            });
                        }
                        return h.text(cleaned);
                    },
                });

                // 更新即将发给用户的 session 文本（不展示 tag）
                if (runtimeParams.allowInterjections) {
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
                        const inWhitelist = (wl.privateList || []).some((id: string) => targetUserId.includes(id));
                        if (wl.privateEnabled && !inWhitelist) return;
                    } else {
                        const inWhitelist = (wl.groupList || []).some((id: string) => targetGroupId.includes(id));
                        if (wl.groupEnabled && !inWhitelist) return;
                    }
                }

                // 清洗出供语音模型读的文本 (保留对应语气词标签)
                const { ttsText } = cleanModelOutput(rawTextForTTS, runtimeParams.allowInterjections, config.provider);
                if (!ttsText || ttsText.length < (config.autoSpeech.minLength ?? 2)) {
                    return;
                }

                let targetText = ttsText;
                if (config.autoSpeech.selectorMode === 'ai_sentence') {
                    try {
                        const aiSelected = await selectSpeechSentenceByAI(ctx, runtimeParams, ttsText, logger);
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
                    segments.map(seg => generateSpeech(ctx, runtimeParams, seg, runtimeParams.defaultVoice, cacheManager))
                );
                const validBuffers = audioBuffers.filter((b): b is Buffer => b !== null);
                if (validBuffers.length === 0) return;

                const finalBuffer = Buffer.concat(validBuffers);
                const isWeixin = isWeixinLikePlatform(session?.platform);
                let audioElem: any;
                let tempAudioPath = '';

                if (isWeixin) {
                    tempAudioPath = await writeTempAudioFile(finalBuffer, runtimeParams.audioFormat);
                    audioElem = makeWeixinAudioElement(tempAudioPath);
                } else {
                    audioElem = makeAudioElement(finalBuffer, runtimeParams.audioFormat);
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
    ctx.inject(['console'], (injectedCtx: any) => {
        try {
            const runtimeParams = resolveTTSRuntimeParams(config);
            if (state.minimaxVitsService) {
                state.minimaxVitsService.updateConfig(runtimeParams).catch((err: any) => { logger.warn('更新配置失败:', err); });
            } else {
                state.minimaxVitsService = new MinimaxVitsService(injectedCtx, runtimeParams);
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

            const runtimeParams = resolveTTSRuntimeParams(config);
            const { ttsText, displayText } = cleanModelOutput(text, runtimeParams.allowInterjections, config.provider);
            if (!ttsText) return '清洗后文本为空，无需生成语音';

            await session.send('语音生成中，请稍候...');
            const buffer = await generateSpeech(
                ctx,
                { ...runtimeParams, speed: options?.speed ?? runtimeParams.speed },
                ttsText,
                options?.voice || runtimeParams.defaultVoice,
                cacheManager
            );
            if (!buffer) return '语音生成失败，请检查控制台日志';

            const audioElem = makeAudioElement(buffer, runtimeParams.audioFormat);
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