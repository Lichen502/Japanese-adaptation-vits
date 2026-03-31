// src/index.ts
// 主入口文件
import { Schema } from 'koishi';
import { AudioCacheManager } from './cache';
import { MinimaxVitsService } from './service';
import { generateSpeech } from './api';
import { isWeixinLikePlatform, makeAudioElement, makeWeixinAudioElement, removeTempFile, writeTempAudioFile, } from './utils';
import { selectSpeechSentenceByAI } from './tool';
export const name = 'minimax-vits';
// ==========================================
// 模块 A: 文本清洗 (过滤非对话内容)
// ==========================================
function cleanModelOutput(text) {
    if (!text)
        return '';
    // 0. 预处理：移除 Koishi 的 XML 标签 (img, audio, video, file, at, quote 等)
    // 使用正则匹配 <xxx ...> 或 <xxx .../> 或 </xxx>
    // 注意：我们不想匹配普通的标点符号，所以要匹配标签特有的格式
    let cleaned = text.replace(/<[\s\S]*?>/g, '');
    return cleaned
        // 1. 去除 DeepSeek/R1 等模型的思维链标签 (防止漏网之鱼)
        .replace(/<\|im_start\|>[\s\S]*?<\|im_end\|>/g, '')
        // 2. 去除括号内的动作、神态等非对话描写 (支持中英文括号)
        .replace(/（[^）]*）/g, '')
        .replace(/\([^)]*\)/g, '')
        // 3. 去除星号内的动作描写
        .replace(/\*([^*]*)\*/g, '')
        // 4. 去除多余的 Markdown 符号 (如加粗的 **)
        .replace(/\*\*/g, '')
        // 5. 将连续的空白字符替换为单个空格，并去除首尾空白
        .replace(/\s+/g, ' ')
        .trim();
}
// ==========================================
// 模块 B: 文本分段 (保留，用于长文本处理)
// ==========================================
function splitTextIntoSegments(text) {
    if (!text)
        return [];
    const sentences = text.split(/[。！？.!?\n]+/).filter(s => s.trim().length > 0);
    return sentences.map(s => s.trim());
}
// ==========================================
// 模块 C: 使用类 OpenAI 接口让小模型决策朗读内容
// ==========================================
const OPENAI_TIMEOUT = 15000;
const OPENAI_MAX_RETRIES = 2;
const OPENAI_RETRY_DELAY = 1000;
async function openaiSleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
function shouldUseOpenAIFilter(text, minLength) {
    const sentences = text.split(/[。！？.!?\n]+/).filter(s => s.trim().length > 0);
    if (sentences.length <= 1) {
        return false;
    }
    if (text.length > 500) {
        return true;
    }
    if (sentences.length >= 3) {
        return true;
    }
    return false;
}
/**
 * 通过 OpenAI 兼容接口，让小模型从整段文本中挑选出需要朗读的内容。
 * - 返回 null / 空字符串：表示「不需要生成语音」
 * - 返回一小段文本：只对这段文本进行 TTS
 */
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
    if (baseUrl.endsWith('/v1')) {
        baseUrl = baseUrl.slice(0, -3);
    }
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
                headers: {
                    Authorization: `Bearer ${oa.openaiLikeApiKey}`,
                },
                timeout: OPENAI_TIMEOUT,
            });
            const content = (_f = (_e = (_d = (_c = resp === null || resp === void 0 ? void 0 : resp.choices) === null || _c === void 0 ? void 0 : _c[0]) === null || _d === void 0 ? void 0 : _d.message) === null || _e === void 0 ? void 0 : _e.content) === null || _f === void 0 ? void 0 : _f.trim();
            if (!content) {
                if (config.debug)
                    logger === null || logger === void 0 ? void 0 : logger.info('小模型返回为空，视为无需朗读');
                return null;
            }
            const upperContent = content.toUpperCase();
            if (upperContent === 'EMPTY' || upperContent === 'NONE' || upperContent === 'NULL') {
                if (config.debug)
                    logger === null || logger === void 0 ? void 0 : logger.info('小模型判断当前消息无需生成语音');
                return null;
            }
            const cleanedContent = content.replace(/^["'，。！？、:：]+|["'，。！？、:：]+$/g, '').trim();
            if (cleanedContent.length < minLen) {
                if (config.debug)
                    logger === null || logger === void 0 ? void 0 : logger.info(`小模型返回内容过短 (${cleanedContent.length} < ${minLen})，忽略`);
                return null;
            }
            if (config.debug)
                logger === null || logger === void 0 ? void 0 : logger.info(`小模型筛选结果: ${cleanedContent.slice(0, 30)}...`);
            return cleanedContent;
        }
        catch (error) {
            if (config.debug)
                logger === null || logger === void 0 ? void 0 : logger.warn(`OpenAI 小模型调用失败 (尝试 ${attempt + 1}/${OPENAI_MAX_RETRIES + 1}):`, (error === null || error === void 0 ? void 0 : error.message) || error);
            if (attempt < OPENAI_MAX_RETRIES) {
                await openaiSleep(OPENAI_RETRY_DELAY);
                continue;
            }
            logger === null || logger === void 0 ? void 0 : logger.warn('OpenAI 类小模型筛选语音内容失败，已达最大重试次数');
            return null;
        }
    }
    return null;
}
// 配置 Schema
export const schema = Schema.object({
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
    ]).default('mp3').description('音频格式'),
    sampleRate: Schema.union([
        Schema.const(16000),
        Schema.const(24000),
        Schema.const(32000),
        Schema.const(44100),
        Schema.const(48000)
    ]).default(32000).description('采样率'),
    bitrate: Schema.union([
        Schema.const(64000),
        Schema.const(96000),
        Schema.const(128000),
        Schema.const(192000),
        Schema.const(256000)
    ]).default(128000).description('比特率'),
    outputFormat: Schema.const('hex').description('API输出编码 (必须是 hex)'),
    languageBoost: Schema.union([
        Schema.const('auto').description('自动'),
        Schema.const('zh').description('中文'),
        Schema.const('en').description('英文')
    ]).default('auto').description('语言增强'),
    // 新增：自动转语音相关配置
    autoSpeech: Schema.object({
        enabled: Schema.boolean().default(false).description('启用 ChatLuna 对话自动转语音'),
        sendMode: Schema.union([
            Schema.const('voice_only').description('仅发送语音'),
            Schema.const('text_and_voice').description('发送语音+文本(分两条)'),
            Schema.const('mixed').description('文本+语音混合(同条消息)')
        ]).default('text_and_voice').description('发送模式'),
        minLength: Schema.number().default(2).description('触发转换的最短字符数'),
        // 朗读内容选择策略
        selectorMode: Schema.union([
            Schema.const('full').description('整条文本直接转语音（默认逻辑）'),
            Schema.const('ai_sentence').description('交给 ChatLuna / 小模型从中挑选一句朗读'),
            Schema.const('openai_filter').description('通过 OpenAI 兼容接口，让小模型决定具体朗读内容'),
        ]).default('full').description('语音内容选择策略'),
        // 类 OpenAI 小模型配置（用于 openai_filter 策略）
        openaiLikeBaseUrl: Schema.string()
            .description('OpenAI 兼容接口 Base URL，例如 https://api.openai.com 或自建代理地址'),
        openaiLikeApiKey: Schema.string()
            .role('secret')
            .description('OpenAI 兼容接口 API Key'),
        openaiLikeModel: Schema.string()
            .description('用于筛选朗读内容的小模型名称，例如 gpt-4o-mini / deepseek-chat 等'),
        customPrompt: Schema.string()
            .role('textarea')
            .default('你是一个专业的"语音内容筛选助手"。你的任务是从给定的聊天文本中挑选出最适合朗读的一段。\n\n筛选规则：\n1. 选择自然流畅、口语化的内容（对话、回答、叙述），偏向于情感表达的句子，比如"你好"、"我很喜欢你"等类似句子。\n2. 排除以下内容：\n   - 思维链、推理过程（如"让我想想..."、"因为...所以..."）\n   - 代码块、技术术语\n   - 系统提示、指令、引导语\n   - 重复的客套话\n3. 如果整段都不适合朗读，返回"EMPTY"\n\n输出要求：\n- 只返回选中的内容，不要添加任何解释、标点或引号\n- 如果不适合朗读，返回"EMPTY"\n- 返回内容长度控制在 20-100 字之间效果最佳')
            .description('自定义 System Prompt（填写后会覆盖默认提示词）'),
    }).description('自动语音转换设置'),
    debug: Schema.boolean().default(false).description('启用调试日志'),
    cacheEnabled: Schema.boolean().default(true).description('启用本地文件缓存'),
    cacheDir: Schema.string().default('./data/minimax-vits/cache').description('缓存路径'),
    cacheMaxAge: Schema.number().default(3600000).min(60000).description('缓存有效期(ms)'),
    cacheMaxSize: Schema.number().default(104857600).min(1048576).max(1073741824).description('缓存最大体积(bytes)'),
}).description('MiniMax VITS 配置');
// 兼容旧版本
export const Config = schema;
// --- 插件入口 ---
export function apply(ctx, config) {
    var _a, _b, _c, _d, _e;
    const state = ctx.state;
    const logger = ctx.logger('minimax-vits');
    // ======================================================
    // 1. 缓存管理器初始化
    // ======================================================
    let cacheManager;
    if (config.cacheEnabled) {
        if (!state.cacheManager) {
            state.cacheManager = new AudioCacheManager((_a = config.cacheDir) !== null && _a !== void 0 ? _a : './data/minimax-vits/cache', logger, {
                enabled: true,
                maxAge: (_b = config.cacheMaxAge) !== null && _b !== void 0 ? _b : 3600000,
                maxSize: (_c = config.cacheMaxSize) !== null && _c !== void 0 ? _c : 104857600
            });
            state.cacheManager.initialize().catch((err) => {
                logger.warn('缓存初始化失败:', err);
            });
        }
        cacheManager = state.cacheManager;
    }
    else {
        (_d = state.cacheManager) === null || _d === void 0 ? void 0 : _d.dispose();
        delete state.cacheManager;
        cacheManager = undefined;
    }
    // ======================================================
    // 2. 核心逻辑：消息拦截与自动语音转换
    // ======================================================
    // 我们不再尝试注册 ChatLuna Tool，而是直接监听所有发出的消息
    // ======================================================
    // 2. 核心逻辑：ChatLuna 对话后自动语音转换
    // ======================================================
    // 使用 ChatLuna 的 after-chat 事件精确拦截 AI 对话
    const autoSpeechEnabled = (_e = config.autoSpeech) === null || _e === void 0 ? void 0 : _e.enabled;
    if (autoSpeechEnabled) {
        ctx.on('ready', () => {
            logger.info('ChatLuna 语音拦截已启动 (监听 chatluna/after-chat 事件)');
        });
        ctx.on('chatluna/after-chat', async (...args) => {
            var _a, _b, _c, _d, _e, _f, _g;
            try {
                if (config.debug)
                    logger.info('接收到 chatluna/after-chat 事件, 参数:', args.map((a) => typeof a).join(', '));
                // 根据文档: conversationId, sourceMessage, responseMessage, promptVariables, chatInterface, session
                const conversationId = args[0];
                const sourceMessage = args[1];
                const responseMessage = args[2];
                const promptVariables = args[3];
                const chatInterface = args[4];
                const session = args[5];
                if (!(responseMessage === null || responseMessage === void 0 ? void 0 : responseMessage.content)) {
                    if (config.debug)
                        logger.info('无 responseMessage 内容');
                    return;
                }
                const aiText = cleanModelOutput(responseMessage.content);
                if (aiText.length < ((_a = config.autoSpeech.minLength) !== null && _a !== void 0 ? _a : 2)) {
                    if (config.debug)
                        logger.info(`文本过短: ${aiText.length}`);
                    return;
                }
                if (config.debug)
                    logger.info(`ChatLuna 对话: ${aiText.slice(0, 30)}...`);
                let targetText = aiText;
                if (config.autoSpeech.selectorMode === 'ai_sentence') {
                    try {
                        const aiSelected = await selectSpeechSentenceByAI(ctx, config, aiText, logger);
                        if (aiSelected && aiSelected.length >= ((_b = config.autoSpeech.minLength) !== null && _b !== void 0 ? _b : 2)) {
                            targetText = aiSelected;
                        }
                    }
                    catch (error) {
                        logger.warn('AI 筛选句子失败:', error);
                    }
                }
                else if (config.autoSpeech.selectorMode === 'openai_filter') {
                    try {
                        const selected = await selectSpeechTextByOpenAI(ctx, config, aiText, logger);
                        if (!selected || selected.trim().length < ((_c = config.autoSpeech.minLength) !== null && _c !== void 0 ? _c : 2)) {
                            return;
                        }
                        targetText = selected.trim();
                    }
                    catch (error) {
                        logger.warn('OpenAI 筛选失败:', error);
                    }
                }
                const segments = splitTextIntoSegments(targetText);
                if (segments.length === 0)
                    return;
                const audioBuffers = await Promise.all(segments.map(seg => generateSpeech(ctx, config, seg, config.defaultVoice, cacheManager)));
                const validBuffers = audioBuffers.filter((b) => b !== null);
                if (validBuffers.length === 0)
                    return;
                const finalBuffer = Buffer.concat(validBuffers);
                const sendMode = (_e = (_d = config.autoSpeech) === null || _d === void 0 ? void 0 : _d.sendMode) !== null && _e !== void 0 ? _e : 'text_and_voice';
                const isWeixin = isWeixinLikePlatform(session === null || session === void 0 ? void 0 : session.platform);
                if (isWeixin) {
                    const tempAudioPath = await writeTempAudioFile(finalBuffer, (_f = config.audioFormat) !== null && _f !== void 0 ? _f : 'mp3');
                    const audioElem = makeWeixinAudioElement(tempAudioPath);
                    try {
                        if (sendMode === 'voice_only') {
                            await session.send(audioElem);
                        }
                        else if (sendMode === 'mixed') {
                            await session.send(targetText);
                            await session.send(audioElem);
                        }
                        else {
                            // text_and_voice
                            await session.send(audioElem);
                            await session.send(targetText);
                        }
                    }
                    finally {
                        setTimeout(() => {
                            void removeTempFile(tempAudioPath);
                        }, 60000);
                    }
                }
                else {
                    const audioElem = makeAudioElement(finalBuffer, (_g = config.audioFormat) !== null && _g !== void 0 ? _g : 'mp3');
                    if (sendMode === 'voice_only') {
                        await session.send(audioElem);
                    }
                    else if (sendMode === 'mixed') {
                        await session.send(targetText + audioElem);
                    }
                    else {
                        await session.send(audioElem);
                    }
                }
                if (config.debug)
                    logger.info(`语音已发送 (platform=${(session === null || session === void 0 ? void 0 : session.platform) || 'unknown'})`);
            }
            catch (err) {
                logger.error('语音转换出错:', err);
            }
        });
    }
    // ======================================================
    // 3. 服务注册 (控制台设置)
    // ======================================================
    ctx.inject(['console'], (injectedCtx) => {
        try {
            const ctxWithConsole = injectedCtx;
            if (state.minimaxVitsService) {
                state.minimaxVitsService.updateConfig(config).catch((err) => {
                    logger.warn('更新服务配置失败:', err);
                });
            }
            else {
                state.minimaxVitsService = new MinimaxVitsService(ctxWithConsole, config);
                if (ctxWithConsole.console) {
                    if (typeof ctxWithConsole.console.addService === 'function') {
                        ctxWithConsole.console.addService('minimax-vits', state.minimaxVitsService);
                    }
                    else {
                        ctxWithConsole.console.services = ctxWithConsole.console.services || {};
                        ctxWithConsole.console.services['minimax-vits'] = state.minimaxVitsService;
                    }
                }
            }
        }
        catch (error) {
            logger.warn('注册控制台服务失败:', error);
        }
    });
    // ======================================================
    // 4. 生命周期管理
    // ======================================================
    ctx.on('ready', async () => {
        await (cacheManager === null || cacheManager === void 0 ? void 0 : cacheManager.initialize());
    });
    ctx.on('dispose', () => {
        var _a;
        (_a = state.cacheManager) === null || _a === void 0 ? void 0 : _a.dispose();
        delete state.cacheManager;
        delete state.minimaxVitsService;
    });
    // ======================================================
    // 5. 指令注册 (保持不变，用于测试)
    // ======================================================
    ctx.command('minivits.test <text:text>', '测试 TTS')
        .option('voice', '-v <voice>')
        .option('speed', '-s <speed>', { type: 'number' })
        .action(async ({ session, options }, text) => {
        var _a, _b, _c;
        if (!text)
            return '请输入文本';
        await (session === null || session === void 0 ? void 0 : session.send('生成中...'));
        const buffer = await generateSpeech(ctx, {
            ...config,
            speed: (_a = options === null || options === void 0 ? void 0 : options.speed) !== null && _a !== void 0 ? _a : config.speed
        }, text, (options === null || options === void 0 ? void 0 : options.voice) || config.defaultVoice || 'Chinese_female_gentle', cacheManager);
        if (!buffer)
            return '失败';
        const isWeixin = isWeixinLikePlatform(session === null || session === void 0 ? void 0 : session.platform);
        if (!isWeixin) {
            return makeAudioElement(buffer, (_b = config.audioFormat) !== null && _b !== void 0 ? _b : 'mp3');
        }
        const tempAudioPath = await writeTempAudioFile(buffer, (_c = config.audioFormat) !== null && _c !== void 0 ? _c : 'mp3');
        setTimeout(() => {
            void removeTempFile(tempAudioPath);
        }, 60000);
        return makeWeixinAudioElement(tempAudioPath);
    });
}
export default {
    name,
    schema,
    Config,
    apply
};
