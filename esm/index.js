// src/index.ts
import { Schema, h } from 'koishi';
import { AudioCacheManager } from './cache';
import { MinimaxVitsService } from './service';
import { generateSpeech } from './api';
import { isWeixinLikePlatform, makeAudioElement, makeSilkAudioElementSafe, makeWeixinAudioElement, removeTempFile, writeTempAudioFile } from './utils';
import { generateSpeechElevenLabs } from './api';
import { selectSpeechSentenceByAI } from './tool';
export const name = 'tts-adaptation-service';
// SILK/ffmpeg 为可选服务；缺失时自动回退原始音频，不影响纯文字发送
export const inject = {
    optional: ['console', 'chatluna', 'chatluna_mind', 'silk', 'ffmpeg']
};
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
function cleanElevenLabsOutput(base, allowInterjections = true) {
    let ttsText = base.replace(/<[\s\S]*?>/g, ''); // 移除 HTML / XML
    if (allowInterjections) {
        // 先将所有合法的 [audio tag] 暂时保护替换为标记
        ttsText = ttsText.replace(ELEVENLABS_TAG_REGEX, (match, tag) => {
            return `__EL_TAG_${tag.trim().toLowerCase()}__`;
        });
    }
    // 剔除所有普通括号及内容（如 (旁白)、【说明】、未匹配的中文方括号等）
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
            if (MINIMAX_ALLOWED_AUDIO_TAGS.has(tag.toLowerCase()))
                return '';
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
function cleanModelOutput(text, allowInterjections = false, engine = 'minimax') {
    if (!text)
        return { ttsText: '', displayText: '' };
    // 通用预处理：去除思维链
    let base = text.replace(/<\|im_start\|>[\s\S]*?<\|im_end\|>/g, '');
    base = base.replace(/<think>[\s\S]*?<\/think>/gi, '');
    const result = engine === 'elevenlabs'
        ? cleanElevenLabsOutput(base, allowInterjections)
        : cleanMinimaxOutput(base, allowInterjections);
    // 尾音保护第一层：只给 TTS 文本补终止标点，展示文本保持聊天原貌。
    // 聊天风格消息常无句尾信号，TTS 缺句号时最后一个音节容易被截断。
    if (result.ttsText && !/[。！？!?…～~]$/.test(result.ttsText)) {
        result.ttsText = result.ttsText.replace(/[、，,]+$/, '') + '。';
    }
    return result;
}
// ==========================================
// 模块 B: 文本分段
// ==========================================
function splitTextIntoSegments(text) {
    if (!text)
        return [];
    const matches = text.match(/[^。！？.!?\n]+[。！？.!?\n]*/g);
    if (!matches)
        return [text.trim()];
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
    if (sentences.length <= 1)
        return false;
    if (text.length > 500)
        return true;
    if (sentences.length >= 3)
        return true;
    return false;
}
async function selectSpeechTextByOpenAI(ctx, config, text, logger) {
    var _a, _b, _c, _d, _e, _f;
    const oa = config.autoSpeech;
    const minLen = (_b = (_a = config.autoSpeech) === null || _a === void 0 ? void 0 : _a.minLength) !== null && _b !== void 0 ? _b : 2;
    if (!(oa === null || oa === void 0 ? void 0 : oa.openaiLikeBaseUrl) || !(oa === null || oa === void 0 ? void 0 : oa.openaiLikeApiKey) || !(oa === null || oa === void 0 ? void 0 : oa.openaiLikeModel)) {
        if (config.debug)
            logger === null || logger === void 0 ? void 0 : logger.warn('未配置完整的 OpenAI 类小模型参数，跳过小模型筛选');
        return null;
    }
    if (!shouldUseOpenAIFilter(text, minLen)) {
        if (config.debug)
            logger === null || logger === void 0 ? void 0 : logger.info('文本较短或只有一句，跳过 OpenAI 小模型筛选');
        return null;
    }
    let baseUrl = String(oa.openaiLikeBaseUrl).replace(/\/$/, '');
    if (baseUrl.endsWith('/v1'))
        baseUrl = baseUrl.slice(0, -3);
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
            const content = (_f = (_e = (_d = (_c = resp === null || resp === void 0 ? void 0 : resp.choices) === null || _c === void 0 ? void 0 : _c[0]) === null || _d === void 0 ? void 0 : _d.message) === null || _e === void 0 ? void 0 : _e.content) === null || _f === void 0 ? void 0 : _f.trim();
            if (!content)
                return null;
            const upperContent = content.toUpperCase();
            if (upperContent === 'EMPTY' || upperContent === 'NONE' || upperContent === 'NULL') {
                return null;
            }
            const cleanedContent = content.replace(/^["'，。！？、:：]+|["'，。！？、:：]+$/g, '').trim();
            if (cleanedContent.length < minLen)
                return null;
            return cleanedContent;
        }
        catch (error) {
            if (attempt < OPENAI_MAX_RETRIES) {
                await openaiSleep(OPENAI_RETRY_DELAY);
                continue;
            }
            logger === null || logger === void 0 ? void 0 : logger.warn('OpenAI 筛选内容失败:', (error === null || error === void 0 ? void 0 : error.message) || error);
            return null;
        }
    }
    return null;
}
export const schema = Schema.intersect([
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
            apiBase: Schema.string().default('https://api.minimax.com/v1').description('API 基础地址'),
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
            elevenlabsModelId: Schema.string().default('eleven_v3').description('TTS 模型 ID (如: eleven_v3, eleven_multilingual_v2, eleven_flash_v2_5 等)'),
            // 核心声音属性调节 (voice_settings)
            elevenlabsSpeed: Schema.number().default(1.0).min(0.7).max(1.2).step(0.05).description('语速 (0.7 慢速 ~ 1.2 快速，默认 1.0)'),
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
            // 本地 SILK 链路选项（与 API 的 voice_settings.speed 独立）
            elevenlabsLocalSpeed: Schema.number().default(1.0).min(0.5).max(2.0).step(0.05)
                .description('本地语速 (atempo，0.5~2.0；不经 API，对缓存音频也即时生效，需 ffmpeg/silk 服务)'),
            elevenlabsTailPadMs: Schema.number().default(300).min(0).max(2000).step(50)
                .description('尾部静音垫最小值 ms (自动补齐到跨过下一整秒再加 50ms，0=关闭；需 ffmpeg/silk 服务)'),
            elevenlabsContextStitching: Schema.boolean().default(true)
                .description('previous_text 上下文缝合 (按频道取最近三条；eleven_v3 自动跳过，模型不支持时自动禁用)'),
            elevenlabsContextMaxChars: Schema.number().default(300).min(0).max(2000)
                .description('previous_text 最大字符数'),
        }).description('ElevenLabs 设置')
    ]),
    // 3. 通用配置（不论选哪个服务商都会显示）
    Schema.object({
        autoSpeech: Schema.intersect([
            Schema.object({
                enabled: Schema.boolean().default(false).description('启用 ChatLuna 对话自动转语音'),
                minLength: Schema.number().default(2).description('触发转换的最短字符数'),
            }).description('基础'),
            Schema.object({
                whitelist: Schema.object({
                    groupEnabled: Schema.boolean().default(false).description('启用群聊白名单（开启后仅白名单内群聊触发自动转语音）'),
                    groupList: Schema.array(String).role('table').default([]).description('群聊白名单列表 (填写群号)'),
                    privateEnabled: Schema.boolean().default(false).description('启用私聊白名单（开启后仅白名单内用户触发自动转语音）'),
                    privateList: Schema.array(String).role('table').default([]).description('私聊白名单列表 (填写用户Id)'),
                }).description('黑白名单机制（关闭则对所有人生效）'),
                skipPrivateUsers: Schema.array(String).role('table').default([])
                    .description('私聊中跳过语音的对象 (如其他 bot 的 ID；仅私聊生效，文字照常发送，不受白名单开关影响)'),
                mindSpeakingOnly: Schema.boolean().default(false)
                    .description('仅在 chatluna_mind 服务判定当前频道正在发言时才合成语音 (未装该服务时行为不变)'),
            }).description('触发范围'),
            Schema.object({
                userProviders: Schema.array(Schema.object({
                    userId: Schema.string().description('用户 ID (私聊填用户 ID，群聊填发送者 ID；与白名单一致支持部分匹配)'),
                    provider: Schema.union([
                        Schema.const('minimax').description('MiniMax'),
                        Schema.const('elevenlabs').description('ElevenLabs')
                    ]).default('minimax').description('该用户使用的服务商'),
                })).role('table').default([])
                    .description('按用户指定 TTS 服务商（命中即覆盖顶部选择；留空或未命中则跟随顶部 provider）'),
                sendMode: Schema.union([
                    Schema.const('voice_only').description('仅发送语音'),
                    Schema.const('text_and_voice').description('发送语音+文本(分两条)'),
                    Schema.const('mixed').description('文本+语音混合(同条消息)')
                ]).default('text_and_voice').description('发送模式'),
            }).description('服务商与发送'),
            Schema.object({
                selectorMode: Schema.union([
                    Schema.const('full').description('整条文本直接转语音（默认逻辑）'),
                    Schema.const('ai_sentence').description('交给 ChatLuna / 小模型从中挑选一句朗读'),
                    Schema.const('openai_filter').description('通过 OpenAI 兼容接口，让小模型决定具体朗读内容'),
                ]).default('full').description('语音内容选择策略'),
                openaiLikeBaseUrl: Schema.string().description('OpenAI 兼容接口 Base URL'),
                openaiLikeApiKey: Schema.string().role('secret').description('OpenAI 兼容接口 API Key'),
                // 复用 ChatLuna 注册的全局 model 动态下拉（与 chatluna-character 同款），
                // 列出所有已配置模型供选择；未装 ChatLuna 时 dynamic 退化为 any，可手填任意模型名。
                openaiLikeModel: Schema.dynamic('model').description('用于筛选朗读内容的小模型（从 ChatLuna 已配置模型中选择；也可手填任意兼容模型名）'),
                customPrompt: Schema.string().role('textarea')
                    .default('你是一个专业的"语音内容筛选助手"。你的任务是从给定的聊天文本中挑选出最适合朗读的一段。\n\n筛选规则：\n1. 选择自然流畅、口语化的内容（对话、回答、叙述），偏向于情感表达的句子，比如"你好"、"我很喜欢你"等类似句子。\n2. 排除以下内容：\n   - 思维链、推理过程（如"让我想想..."、"因为...所以..."）\n   - 代码块、技术术语\n   - 系统提示、指令、引导语\n   - 重复的客套话\n3. 如果整段都不适合朗读，返回"EMPTY"\n\n输出要求：\n- 只返回选中的内容，不要添加任何解释、标点或引号\n- 如果不适合朗读，返回"EMPTY"\n- 返回内容长度控制在 20-100 字之间效果最佳')
                    .description('自定义 System Prompt'),
            }).description('朗读内容'),
        ]).description('自动语音转换设置'),
        silkEnabled: Schema.boolean().default(true)
            .description('非微信平台发送前转 SILK (需 ffmpeg/silk 服务，如 koishi-plugin-ffmpeg-path 开启 enableSilk；失败自动回退原始音频)'),
        debug: Schema.boolean().default(false).description('启用调试日志'),
        cacheEnabled: Schema.boolean().default(true).description('启用本地文件缓存'),
        cacheDir: Schema.string().default('./data/tts-adaptation-service/cache').description('缓存路径'),
        cacheMaxAge: Schema.number().default(3600000).min(60000).description('缓存有效期(ms)'),
        cacheMaxSize: Schema.number().default(104857600).min(1048576).max(1073741824).description('缓存最大体积(bytes)'),
    }).description('通用/其他设置')
]);
export const Config = schema;
/** 计算某条消息实际使用的服务商：用户指定优先，未命中跟随顶部 provider */
function resolveSessionProvider(config, session) {
    var _a, _b;
    const overrides = ((_a = config.autoSpeech) === null || _a === void 0 ? void 0 : _a.userProviders) || [];
    const ids = [session === null || session === void 0 ? void 0 : session.userId, session === null || session === void 0 ? void 0 : session.channelId]
        .filter(Boolean)
        .map((id) => String(id));
    for (const item of overrides) {
        const target = String((_b = item === null || item === void 0 ? void 0 : item.userId) !== null && _b !== void 0 ? _b : '').trim();
        if (!target)
            continue;
        if (ids.some(id => id === target || id.includes(target))) {
            return item.provider === 'elevenlabs' ? 'elevenlabs' : 'minimax';
        }
    }
    return config.provider;
}
/**
 * 运行时参数适配辅助函数：将分别保存的配置映射为 TTS API 标准入参
 * providerOverride 用于按用户覆盖顶部服务商选择，其余配置仍共用同一份 schema。
 */
function resolveTTSRuntimeParams(config, providerOverride) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j;
    const provider = providerOverride !== null && providerOverride !== void 0 ? providerOverride : config.provider;
    const isEL = provider === 'elevenlabs';
    const apiKey = isEL ? config.elevenlabsApiKey : config.ttsApiKey;
    const apiBase = isEL ? (config.elevenlabsApiBase || 'https://api.elevenlabs.io/v1') : (config.apiBase || 'https://api.minimax.io/v1');
    const defaultVoice = isEL ? (config.elevenlabsVoiceId || '21m00Tcm4TlvDq8ikWAM') : (config.defaultVoice || 'Chinese_female_gentle');
    const speechModel = isEL ? (config.elevenlabsModelId || 'eleven_v3') : (config.speechModel || 'speech-01-turbo');
    // 音频格式适配
    const isPcmOutput = (_a = config.elevenlabsOutputFormat) === null || _a === void 0 ? void 0 : _a.startsWith('pcm');
    const audioFormat = isEL ? (isPcmOutput ? 'wav' : (config.elevenlabsAudioFormat || 'mp3')) : (config.audioFormat || 'mp3');
    const allowInterjections = isEL ? true : Boolean(config.interjections);
    const speed = isEL ? ((_b = config.elevenlabsSpeed) !== null && _b !== void 0 ? _b : 1.0) : ((_c = config.speed) !== null && _c !== void 0 ? _c : 1.0);
    return {
        ...config,
        engine: provider,
        provider,
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
        stability: (_d = config.elevenlabsStability) !== null && _d !== void 0 ? _d : 0.5,
        similarityBoost: (_e = config.elevenlabsSimilarityBoost) !== null && _e !== void 0 ? _e : 0.75,
        style: (_f = config.elevenlabsStyle) !== null && _f !== void 0 ? _f : 0.0,
        useSpeakerBoost: (_g = config.elevenlabsUseSpeakerBoost) !== null && _g !== void 0 ? _g : true,
        // ElevenLabs 高级生成参数与格式
        outputFormat: isEL ? (config.elevenlabsOutputFormat || 'mp3_44100_128') : config.outputFormat,
        languageCode: (isEL && config.elevenlabsLanguageCode !== 'auto') ? config.elevenlabsLanguageCode : undefined,
        applyTextNormalization: isEL ? config.elevenlabsApplyTextNormalization : undefined,
        seed: (isEL && config.elevenlabsSeed !== undefined && config.elevenlabsSeed >= 0) ? config.elevenlabsSeed : undefined,
        optimizeStreamingLatency: isEL ? config.elevenlabsOptimizeStreamingLatency : undefined,
        // 通用 / MiniMax 专属
        vol: (_h = config.vol) !== null && _h !== void 0 ? _h : 1.0,
        pitch: (_j = config.pitch) !== null && _j !== void 0 ? _j : 0,
    };
}
export function apply(ctx, config) {
    var _a, _b, _c, _d, _e;
    const state = ctx.state;
    const logger = ctx.logger(name);
    // ======================================================
    // 1. 缓存初始化
    // ======================================================
    let cacheManager;
    if (config.cacheEnabled) {
        if (!state.cacheManager) {
            state.cacheManager = new AudioCacheManager((_a = config.cacheDir) !== null && _a !== void 0 ? _a : './data/tts-adaptation-service/cache', logger, { enabled: true, maxAge: (_b = config.cacheMaxAge) !== null && _b !== void 0 ? _b : 3600000, maxSize: (_c = config.cacheMaxSize) !== null && _c !== void 0 ? _c : 104857600 });
            state.cacheManager.initialize().catch((err) => { logger.warn('缓存初始化失败:', err); });
        }
        cacheManager = state.cacheManager;
    }
    else {
        (_d = state.cacheManager) === null || _d === void 0 ? void 0 : _d.dispose();
        delete state.cacheManager;
        cacheManager = undefined;
    }
    // ======================================================
    // 2. 核心拦截：对话后自动语音转换
    // ======================================================
    // ElevenLabs previous_text 上下文：按频道记录最近已合成文本
    const recentTtsByChannel = new Map();
    if ((_e = config.autoSpeech) === null || _e === void 0 ? void 0 : _e.enabled) {
        ctx.on('ready', () => {
            logger.info(`全局语音拦截已启动 (当前服务商: ${config.provider})`);
        });
        ctx.before('send', async (session) => {
            var _a, _b, _c, _d, _e, _f, _g;
            try {
                if (!session.content)
                    return;
                // 防死循环：跳过音频元素
                if (session.content.includes('<audio') || session.content.includes('[CQ:record')) {
                    return;
                }
                // 可选 mind 门控：只给脑插件正在发言的频道配音；
                // 没有 chatluna_mind 服务或该方法时保持原路径，不引入硬依赖。
                if ((_a = config.autoSpeech) === null || _a === void 0 ? void 0 : _a.mindSpeakingOnly) {
                    let mindSvc;
                    try {
                        mindSvc = typeof ctx.get === 'function' ? ctx.get('chatluna_mind') : undefined;
                    }
                    catch {
                        mindSvc = undefined;
                    }
                    if (mindSvc && typeof mindSvc.isSpeaking === 'function' && !mindSvc.isSpeaking(session.channelId)) {
                        if (config.debug)
                            logger.info(`[脑挡] ${session.channelId} 这条不是脑在说，不合成语音`);
                        return;
                    }
                }
                // 按用户覆盖服务商：命中 userProviders 用指定引擎，否则跟随顶部 provider
                const effectiveProvider = resolveSessionProvider(config, session);
                const runtimeParams = resolveTTSRuntimeParams(config, effectiveProvider);
                const elements = session.elements || h.parse(session.content);
                // 根据本次实际使用的引擎清洗展示文本：
                // ElevenLabs 剔除所有 [xxx] 标签，MiniMax 剔除名单内的 (xxx)
                const userVisibleElements = h.transform(elements, {
                    text: (attrs) => {
                        let cleaned = attrs.content;
                        if (effectiveProvider === 'elevenlabs') {
                            cleaned = cleaned.replace(ELEVENLABS_TAG_REGEX, '');
                        }
                        else {
                            cleaned = cleaned.replace(MINIMAX_TAG_REGEX, (m, tag) => {
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
                // 私聊排除（如其他 bot 之间的自动交流）：与白名单用途不同，命中即跳过语音，文字照常发送
                const skipPrivateUsers = (((_b = config.autoSpeech) === null || _b === void 0 ? void 0 : _b.skipPrivateUsers) || [])
                    .map(id => String(id).trim()).filter(Boolean);
                if (skipPrivateUsers.length && (session.isDirect || !session.guildId)) {
                    const target = `${session.userId || ''} ${session.channelId || ''}`;
                    if (skipPrivateUsers.some(id => target.includes(id))) {
                        if (config.debug)
                            logger.info(`[私聊跳过] ${session.channelId || session.userId} 在 skipPrivateUsers 中，不合成语音`);
                        return;
                    }
                }
                // 检查白名单
                if ((_c = config.autoSpeech) === null || _c === void 0 ? void 0 : _c.whitelist) {
                    const wl = config.autoSpeech.whitelist;
                    const isDirect = session.isDirect || !session.guildId;
                    const targetUserId = session.userId || session.channelId || '';
                    const targetGroupId = session.guildId || session.channelId || '';
                    if (isDirect) {
                        const inWhitelist = (wl.privateList || []).some((id) => targetUserId.includes(id));
                        if (wl.privateEnabled && !inWhitelist)
                            return;
                    }
                    else {
                        const inWhitelist = (wl.groupList || []).some((id) => targetGroupId.includes(id));
                        if (wl.groupEnabled && !inWhitelist)
                            return;
                    }
                }
                // 清洗出供语音模型读的文本 (保留对应语气词标签)
                const { ttsText } = cleanModelOutput(rawTextForTTS, runtimeParams.allowInterjections, effectiveProvider);
                if (!ttsText || ttsText.length < ((_d = config.autoSpeech.minLength) !== null && _d !== void 0 ? _d : 2)) {
                    return;
                }
                let targetText = ttsText;
                if (config.autoSpeech.selectorMode === 'ai_sentence') {
                    try {
                        const aiSelected = await selectSpeechSentenceByAI(ctx, runtimeParams, ttsText, logger);
                        if (aiSelected && aiSelected.length >= ((_e = config.autoSpeech.minLength) !== null && _e !== void 0 ? _e : 2)) {
                            targetText = aiSelected;
                        }
                    }
                    catch (e) {
                        logger.warn('AI 挑选句子失败:', e);
                    }
                }
                else if (config.autoSpeech.selectorMode === 'openai_filter') {
                    try {
                        const selected = await selectSpeechTextByOpenAI(ctx, config, ttsText, logger);
                        if (!selected || selected.trim().length < ((_f = config.autoSpeech.minLength) !== null && _f !== void 0 ? _f : 2))
                            return;
                        targetText = selected.trim();
                    }
                    catch (e) {
                        logger.warn('OpenAI 筛选失败:', e);
                    }
                }
                // 生成音频：ElevenLabs 整条一次合成以保留同消息内的标签与上下文；
                // MiniMax 仍按原逻辑分句合成。
                let audioBuffers;
                if (effectiveProvider === 'elevenlabs') {
                    const chKey = `${session.platform || 'qq'}:${session.channelId || session.userId || 'unknown'}`;
                    let prevText = '';
                    if (config.elevenlabsContextStitching !== false) {
                        const hist = recentTtsByChannel.get(chKey) || [];
                        prevText = hist.join(' ');
                        const maxChars = (_g = config.elevenlabsContextMaxChars) !== null && _g !== void 0 ? _g : 300;
                        if (prevText.length > maxChars)
                            prevText = prevText.slice(-maxChars);
                    }
                    const buf = await generateSpeechElevenLabs(ctx, runtimeParams, targetText, runtimeParams.defaultVoice, cacheManager, prevText || undefined);
                    if (buf) {
                        const hist = recentTtsByChannel.get(chKey) || [];
                        hist.push(targetText);
                        while (hist.length > 3)
                            hist.shift();
                        recentTtsByChannel.set(chKey, hist);
                    }
                    audioBuffers = [buf];
                }
                else {
                    const segments = splitTextIntoSegments(targetText);
                    if (segments.length === 0)
                        return;
                    audioBuffers = await Promise.all(segments.map(seg => generateSpeech(ctx, runtimeParams, seg, runtimeParams.defaultVoice, cacheManager)));
                }
                const validBuffers = audioBuffers.filter((b) => b !== null);
                if (validBuffers.length === 0)
                    return;
                const finalBuffer = Buffer.concat(validBuffers);
                const isWeixin = isWeixinLikePlatform(session === null || session === void 0 ? void 0 : session.platform);
                let audioElem;
                let tempAudioPath = '';
                if (isWeixin) {
                    tempAudioPath = await writeTempAudioFile(finalBuffer, runtimeParams.audioFormat);
                    audioElem = makeWeixinAudioElement(tempAudioPath);
                }
                else if (config.silkEnabled !== false) {
                    // 发送前转 SILK：解决部分 NapCat/Exec 环境无法把 MP3 转 SILK 导致语音发不出去的问题
                    audioElem = await makeSilkAudioElementSafe(ctx, finalBuffer, runtimeParams.audioFormat, effectiveProvider === 'elevenlabs' ? config.elevenlabsLocalSpeed : undefined, effectiveProvider === 'elevenlabs' ? config.elevenlabsTailPadMs : undefined);
                }
                else {
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
            }
            catch (err) {
                logger.error('自动语音转换异常:', err);
            }
        });
    }
    // ======================================================
    // 3. 服务与生命周期
    // ======================================================
    ctx.inject(['console'], (injectedCtx) => {
        try {
            const runtimeParams = resolveTTSRuntimeParams(config);
            if (state.minimaxVitsService) {
                state.minimaxVitsService.updateConfig(runtimeParams).catch((err) => { logger.warn('更新配置失败:', err); });
            }
            else {
                state.minimaxVitsService = new MinimaxVitsService(injectedCtx, runtimeParams);
            }
        }
        catch (error) {
            logger.warn('注册控制台服务异常:', error);
        }
    });
    ctx.on('ready', async () => { await (cacheManager === null || cacheManager === void 0 ? void 0 : cacheManager.initialize()); });
    ctx.on('dispose', () => {
        var _a;
        (_a = state.cacheManager) === null || _a === void 0 ? void 0 : _a.dispose();
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
        var _a;
        if (!session || !text)
            return '请输入要合成的文本';
        const effectiveProvider = resolveSessionProvider(config, session);
        const runtimeParams = resolveTTSRuntimeParams(config, effectiveProvider);
        const { ttsText, displayText } = cleanModelOutput(text, runtimeParams.allowInterjections, effectiveProvider);
        if (!ttsText)
            return '清洗后文本为空，无需生成语音';
        await session.send('语音生成中，请稍候...');
        const callParams = { ...runtimeParams, speed: (_a = options === null || options === void 0 ? void 0 : options.speed) !== null && _a !== void 0 ? _a : runtimeParams.speed };
        const buffer = effectiveProvider === 'elevenlabs'
            ? await generateSpeechElevenLabs(ctx, callParams, ttsText, (options === null || options === void 0 ? void 0 : options.voice) || runtimeParams.defaultVoice, cacheManager)
            : await generateSpeech(ctx, callParams, ttsText, (options === null || options === void 0 ? void 0 : options.voice) || runtimeParams.defaultVoice, cacheManager);
        if (!buffer)
            return '语音生成失败，请检查控制台日志';
        // 测试指令与自动语音走同一条 SILK 发送链路，便于现场验证转码效果
        const audioElem = config.silkEnabled !== false && !isWeixinLikePlatform(session.platform)
            ? await makeSilkAudioElementSafe(ctx, buffer, runtimeParams.audioFormat, effectiveProvider === 'elevenlabs' ? config.elevenlabsLocalSpeed : undefined, effectiveProvider === 'elevenlabs' ? config.elevenlabsTailPadMs : undefined)
            : makeAudioElement(buffer, runtimeParams.audioFormat);
        await session.send(audioElem);
        if (displayText)
            await session.send(displayText);
    });
}
export default {
    name,
    schema,
    Config,
    apply
};
