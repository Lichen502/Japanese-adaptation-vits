// src/index.ts
// 主入口文件
import { Schema, h } from 'koishi';
import { AudioCacheManager } from './cache';
import { MinimaxVitsService } from './service';
import { generateSpeech } from './api';
import { isWeixinLikePlatform, makeAudioElement, makeWeixinAudioElement, removeTempFile, writeTempAudioFile, } from './utils';
import { selectSpeechSentenceByAI } from './tool';
export const name = 'japanese-adaptation-vits';
// ==========================================
// 模块 A: 文本清洗 (过滤非对话内容)
// ==========================================
const ALLOWED_AUDIO_TAGS = new Set([
    'laughs', 'chuckle', 'coughs', 'clear-throat', 'groans',
    'breath', 'pant', 'inhale', 'exhale', 'gasps', 'sniffs',
    'sighs', 'snorts', 'burps', 'lip-smacking', 'humming',
    'hissing', 'emm', 'whistles', 'sneezes', 'crying', 'applause'
]);
function cleanModelOutput(text, allowInterjections = false) {
    if (!text)
        return { ttsText: '', displayText: '' };
    // 0. 共同预处理：去除思维链
    let base = text.replace(/<\|im_start\|>[\s\S]*?<\|im_end\|>/g, '');
    base = base.replace(/<think>[\s\S]*?<\/think>/gi, '');
    // ========================================
    // 路线 1: 构建 TTS 专用文本 (传给语音大模型)
    // ========================================
    let ttsText = base.replace(/<[\s\S]*?>/g, ''); // 移除所有 XML (包括 at 标签，防止读出代码)
    if (allowInterjections) {
        ttsText = ttsText.replace(/[(（\[［【]\s*([a-zA-Z-]+)\s*[)）\]］】]/g, (match, tag) => {
            if (ALLOWED_AUDIO_TAGS.has(tag.toLowerCase()))
                return `__TAG_${tag.toLowerCase()}__`;
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
        ttsText = ttsText.replace(/([。！？.!?、，,；;:]+)\s*(__TAG_[a-zA-Z-]+__)/g, '$2$1');
        ttsText = ttsText.replace(/__TAG_([a-zA-Z-]+)__/g, '($1)');
    }
    ttsText = ttsText.replace(/\s+/g, ' ').trim();
    // ========================================
    // 路线 2: 构建 Display 显示文本 (发送到 QQ)
    // ========================================
    let displayText = base;
    if (allowInterjections) {
        displayText = displayText.replace(/[(（\[［【]\s*([a-zA-Z-]+)\s*[)）\]］】]/g, (match, tag) => {
            if (ALLOWED_AUDIO_TAGS.has(tag.toLowerCase()))
                return '';
            return match;
        });
    }
    displayText = displayText.replace(/[~～]{2,}/g, '~').replace(/(\.{2,}|…+|。{2,})/g, '…');
    displayText = displayText.replace(/\s+/g, ' ').trim();
    displayText = displayText.replace(/\s+([。！？.!?、，,；;:]+)/g, '$1');
    return { ttsText, displayText };
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
    // 新增：自动转语音相关配置
    autoSpeech: Schema.object({
        enabled: Schema.boolean().default(false).description('启用 ChatLuna 对话自动转语音'),
        // === 新增：白名单配置 ===
        whitelist: Schema.object({
            groupEnabled: Schema.boolean().default(false).description('启用群聊白名单（开启后仅白名单内群聊触发自动转语音）'),
            groupList: Schema.array(String).role('table').default([]).description('群聊白名单列表 (填写群号)'),
            privateEnabled: Schema.boolean().default(false).description('启用私聊白名单（开启后仅白名单内用户触发自动转语音）'),
            privateList: Schema.array(String).role('table').default([]).description('私聊白名单列表 (填写用户Id)'),
        }).description('黑白名单机制（关闭则对所有人生效）'),
        // ========================
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
    cacheDir: Schema.string().default('./data/japanese-adaptation-vits/cache').description('缓存路径'),
    cacheMaxAge: Schema.number().default(3600000).min(60000).description('缓存有效期(ms)'),
    cacheMaxSize: Schema.number().default(104857600).min(1048576).max(1073741824).description('缓存最大体积(bytes)'),
}).description('MiniMax VITS 配置');
export const Config = schema;
export function apply(ctx, config) {
    var _a, _b, _c, _d, _e;
    const state = ctx.state;
    const logger = ctx.logger(name);
    // ======================================================
    // 1. 缓存管理器初始化
    // ======================================================
    let cacheManager;
    if (config.cacheEnabled) {
        if (!state.cacheManager) {
            state.cacheManager = new AudioCacheManager((_a = config.cacheDir) !== null && _a !== void 0 ? _a : './data/japanese-adaptation-vits/cache', logger, { enabled: true, maxAge: (_b = config.cacheMaxAge) !== null && _b !== void 0 ? _b : 3600000, maxSize: (_c = config.cacheMaxSize) !== null && _c !== void 0 ? _c : 104857600 });
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
    // 2. 核心逻辑：ChatLuna 对话后自动语音转换
    // ======================================================
    const autoSpeechEnabled = (_e = config.autoSpeech) === null || _e === void 0 ? void 0 : _e.enabled;
    if (autoSpeechEnabled) {
        ctx.on('ready', () => {
            logger.info('全局语音拦截已启动 (监听 before send 事件)');
        });
        ctx.before('send', async (session) => {
            var _a, _b, _c, _d, _e, _f;
            try {
                if (!session.content)
                    return;
                // 1. 防止死循环：如果已经是语音/音频消息，直接放行
                if (session.content.includes('<audio') || session.content.includes('[CQ:record')) {
                    return;
                }
                // 2. 过滤条件：如果配置了只拦截特定机器人 (使用 as any 防止未在 Schema 中定义时报错)
                const autoSpeechConf = config.autoSpeech;
                if (autoSpeechConf.onlyChatLuna && autoSpeechConf.chatLunaBotId) {
                    if (session.bot.selfId !== autoSpeechConf.chatLunaBotId)
                        return;
                }
                // === 3. 白名单拦截逻辑 ===
                if ((_a = config.autoSpeech) === null || _a === void 0 ? void 0 : _a.whitelist) {
                    const whitelistConfig = config.autoSpeech.whitelist;
                    const isDirect = session.isDirect || !session.guildId; // 判断是否私聊
                    const targetUserId = session.userId || session.channelId || '';
                    const targetGroupId = session.guildId || session.channelId || '';
                    //  logger.info(`[白名单检查] 模式: ${isDirect ? '私聊' : '群聊'}, 获取到的目标ID: ${isDirect ? targetUserId : targetGroupId}`);
                    //   logger.info(`[白名单配置] 私聊启用: ${whitelistConfig.privateEnabled}, 允许的列表: [${whitelistConfig.privateList?.join(', ') || ''}]`);
                    //   logger.info(`[白名单配置] 群聊启用: ${whitelistConfig.groupEnabled}, 允许的列表: [${whitelistConfig.groupList?.join(', ') || ''}]`);
                    //   logger.info('信息:', session)
                    if (isDirect) {
                        // 私聊拦截检查
                        // 使用 .some 和 .includes 是为了兼容某些平台 channelId 为 'private:123456' 的情况
                        const isUserInWhitelist = whitelistConfig.privateList.some(id => targetUserId.includes(id));
                        if (whitelistConfig.privateEnabled && !isUserInWhitelist) {
                            if (config.debug)
                                logger.info(`[私聊拦截] 目标用户ID (${targetUserId}) 不在白名单中，跳过语音生成`);
                            return;
                        }
                    }
                    else {
                        // 群聊拦截检查
                        const isGroupInWhitelist = whitelistConfig.groupList.some(id => targetGroupId.includes(id));
                        if (whitelistConfig.groupEnabled && !isGroupInWhitelist) {
                            if (config.debug)
                                logger.info(`[群聊拦截] 目标群组ID (${targetGroupId}) 不在白名单中，跳过语音生成`);
                            return;
                        }
                    }
                }
                // ============================
                // 4. 解析消息为元素数组
                const elements = session.elements || h.parse(session.content);
                // 5. 提取纯文本给 TTS (只取 text 节点，忽略图片等)
                const rawTextForTTS = elements
                    .map(el => el.type === 'text' ? el.attrs.content : '')
                    .join(' ');
                // 使用清理函数提取 TTS 文本
                const cleanedTextObj = cleanModelOutput(rawTextForTTS, config.interjections);
                const aiText = cleanedTextObj.ttsText;
                // 如果清洗后没东西了，就不转语音
                if (!aiText || aiText.length < ((_b = config.autoSpeech.minLength) !== null && _b !== void 0 ? _b : 2)) {
                    return;
                }
                if (config.debug)
                    logger.info(`准备转换对话文本: ${aiText.slice(0, 30)}...`);
                // ==================================
                // AI 筛选句子逻辑 (根据 selectorMode 决定内容)
                // ==================================
                let targetText = aiText;
                if (config.autoSpeech.selectorMode === 'ai_sentence') {
                    try {
                        const aiSelected = await selectSpeechSentenceByAI(ctx, config, aiText, logger);
                        if (aiSelected && aiSelected.length >= ((_c = config.autoSpeech.minLength) !== null && _c !== void 0 ? _c : 2))
                            targetText = aiSelected;
                    }
                    catch (error) {
                        logger.warn('AI 筛选句子失败:', error);
                    }
                }
                else if (config.autoSpeech.selectorMode === 'openai_filter') {
                    try {
                        const selected = await selectSpeechTextByOpenAI(ctx, config, aiText, logger);
                        if (!selected || selected.trim().length < ((_d = config.autoSpeech.minLength) !== null && _d !== void 0 ? _d : 2))
                            return;
                        targetText = selected.trim();
                    }
                    catch (error) {
                        logger.warn('OpenAI 筛选失败:', error);
                    }
                }
                const segments = splitTextIntoSegments(targetText);
                if (segments.length === 0)
                    return;
                // 生成音频
                const audioBuffers = await Promise.all(segments.map(seg => generateSpeech(ctx, config, seg, config.defaultVoice, cacheManager)));
                const validBuffers = audioBuffers.filter((b) => b !== null);
                if (validBuffers.length === 0)
                    return;
                const finalBuffer = Buffer.concat(validBuffers);
                // ===============================
                // 兼容微信及生成语音元素
                // ===============================
                const isWeixin = isWeixinLikePlatform(session === null || session === void 0 ? void 0 : session.platform);
                let audioElem;
                let tempAudioPath = '';
                if (isWeixin) {
                    tempAudioPath = await writeTempAudioFile(finalBuffer, (_e = config.audioFormat) !== null && _e !== void 0 ? _e : 'mp3');
                    audioElem = makeWeixinAudioElement(tempAudioPath);
                }
                else {
                    audioElem = makeAudioElement(finalBuffer, (_f = config.audioFormat) !== null && _f !== void 0 ? _f : 'mp3');
                }
                // ===============================
                // 处理用户可见的消息内容 (保护图片，移除语气词)
                // ===============================
                const audioTagsRegex = /[(（]\s*(laughs|chuckle|coughs|clear-throat|groans|breath|pant|inhale|exhale|gasps|sniffs|sighs|snorts|burps|lip-smacking|humming|hissing|emm|whistles|sneezes|crying|applause)\s*[)）]/gi;
                // 转换元素：移除语气词，同时清理文本节点边缘的空白
                const userVisibleElements = h.transform(elements, {
                    text: (attrs) => {
                        const cleaned = attrs.content.replace(audioTagsRegex, '');
                        return h.text(cleaned);
                    },
                });
                // ===============================
                // 核心发送逻辑修改 (根据 sendMode 更新 session)
                // ===============================
                switch (config.autoSpeech.sendMode) {
                    case 'voice_only':
                        session.elements = [audioElem];
                        session.content = audioElem.toString();
                        break;
                    case 'mixed':
                        // 混合模式：[文字/图片] + [语音]
                        const mixedElements = [...userVisibleElements, audioElem];
                        session.elements = mixedElements;
                        session.content = mixedElements.join('');
                        break;
                    case 'text_and_voice':
                    default:
                        // 分离模式：先单独发送语音
                        if (session.channelId) {
                            await session.bot.sendMessage(session.channelId, audioElem, session.guildId);
                        }
                        // 然后让 session 携带原来的 文本+图片 继续发送本条消息
                        session.elements = userVisibleElements;
                        session.content = userVisibleElements.join('');
                        break;
                }
                // 微信临时文件清理逻辑
                if (isWeixin && tempAudioPath) {
                    setTimeout(() => { void removeTempFile(tempAudioPath); }, 60000);
                }
                if (config.debug)
                    logger.info('语音合成成功，已保护图片元素并修改消息');
            }
            catch (err) {
                logger.error('全局语音转换出错:', err);
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
                state.minimaxVitsService.updateConfig(config).catch((err) => { logger.warn('更新服务配置失败:', err); });
            }
            else {
                state.minimaxVitsService = new MinimaxVitsService(ctxWithConsole, config);
                // state.minimaxVitsService = new MinimaxVitsService(ctxWithConsole, config);
                // if (ctxWithConsole.console) {
                //   if (typeof ctxWithConsole.console.addService === 'function') {
                //     ctxWithConsole.console.addService(name, state.minimaxVitsService);
                //   } else {
                //     ctxWithConsole.console.services = ctxWithConsole.console.services || {};
                //     ctxWithConsole.console.services[name] = state.minimaxVitsService;
                //   }
                // }
            }
        }
        catch (error) {
            logger.warn('注册控制台服务失败:', error);
        }
    });
    // ======================================================
    // 4. 生命周期管理
    // ======================================================
    ctx.on('ready', async () => { await (cacheManager === null || cacheManager === void 0 ? void 0 : cacheManager.initialize()); });
    ctx.on('dispose', () => {
        var _a;
        (_a = state.cacheManager) === null || _a === void 0 ? void 0 : _a.dispose();
        delete state.cacheManager;
        delete state.minimaxVitsService;
    });
    // ======================================================
    // 5. 指令注册 (手动调用不受白名单限制)
    // ======================================================
    ctx.command('minivits.test <text:text>', '测试 TTS')
        .option('voice', '-v <voice>')
        .option('speed', '-s <speed>', { type: 'number' })
        .action(async ({ session, options }, text) => {
        var _a, _b, _c, _d, _e;
        if (!session || !text)
            return '请输入文本';
        const { ttsText, displayText } = cleanModelOutput(text, config.interjections);
        if (!ttsText)
            return '清洗后文本为空，无需生成语音';
        await session.send('语音生成中，请稍候...');
        const buffer = await generateSpeech(ctx, { ...config, speed: (_a = options === null || options === void 0 ? void 0 : options.speed) !== null && _a !== void 0 ? _a : config.speed }, ttsText, (options === null || options === void 0 ? void 0 : options.voice) || config.defaultVoice || 'Chinese_female_gentle', cacheManager);
        if (!buffer)
            return '语音生成失败';
        const sendMode = (_c = (_b = config.autoSpeech) === null || _b === void 0 ? void 0 : _b.sendMode) !== null && _c !== void 0 ? _c : 'text_and_voice';
        const isWeixin = isWeixinLikePlatform(session.platform);
        let audioElem = null;
        let tempAudioPath = '';
        if (isWeixin) {
            tempAudioPath = await writeTempAudioFile(buffer, (_d = config.audioFormat) !== null && _d !== void 0 ? _d : 'mp3');
            audioElem = makeWeixinAudioElement(tempAudioPath);
        }
        else {
            audioElem = makeAudioElement(buffer, (_e = config.audioFormat) !== null && _e !== void 0 ? _e : 'mp3');
        }
        try {
            if (isWeixin) {
                if (sendMode === 'voice_only')
                    await session.send(audioElem);
                else if (sendMode === 'mixed') {
                    await session.send(displayText);
                    await session.send(audioElem);
                }
                else {
                    await session.send(audioElem);
                    await session.send(displayText);
                }
            }
            else {
                if (sendMode === 'voice_only')
                    await session.send(audioElem);
                else if (sendMode === 'mixed')
                    await session.send(displayText + audioElem);
                else {
                    await session.send(audioElem);
                    await session.send(displayText);
                }
            }
        }
        finally {
            if (isWeixin && tempAudioPath)
                setTimeout(() => { void removeTempFile(tempAudioPath); }, 60000);
        }
    });
}
export default {
    name,
    schema,
    Config,
    apply
};
