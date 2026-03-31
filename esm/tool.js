const CHATLUNA_TIMEOUT = 10000;
const MAX_RETRIES = 2;
const RETRY_DELAY = 1000;
export class MinimaxVitsTool {
    constructor(ctx, config) {
        this.ctx = ctx;
        this.config = config;
    }
    async call(input, toolConfig) {
        return '';
    }
}
async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
export async function selectSpeechSentenceByAI(ctx, config, text, logger) {
    var _a, _b, _c, _d, _e, _f, _g;
    const sentences = text.split(/[。！？.!?\n]+/).filter(s => s.trim().length > 0);
    if (sentences.length <= 1) {
        if (config.debug)
            logger === null || logger === void 0 ? void 0 : logger.info('文本只有一个句子，跳过 AI 筛选');
        return null;
    }
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const chatluna = ctx.chatluna;
            if (!chatluna) {
                if (config.debug)
                    logger === null || logger === void 0 ? void 0 : logger.info('ChatLuna 服务未找到');
                return null;
            }
            const prompt = `从以下文本中选出一句最适合语音朗读的内容。只返回选中的句子，不要添加任何解释、标点和空格：

${text}

选出的句子：`;
            const chatOptions = {
                timeout: CHATLUNA_TIMEOUT
            };
            let response;
            if (typeof chatluna.chat === 'function') {
                response = await chatluna.chat(prompt, chatOptions);
            }
            else if (typeof chatluna.complete === 'function') {
                response = await chatluna.complete(prompt, chatOptions);
            }
            else if (typeof chatluna.generate === 'function') {
                response = await chatluna.generate(prompt, chatOptions);
            }
            else {
                if (config.debug)
                    logger === null || logger === void 0 ? void 0 : logger.warn('ChatLuna 未找到可用的调用方法');
                return null;
            }
            let selected = '';
            if (typeof response === 'string') {
                selected = response.trim();
            }
            else if (response === null || response === void 0 ? void 0 : response.content) {
                selected = response.content.trim();
            }
            else if (response === null || response === void 0 ? void 0 : response.text) {
                selected = response.text.trim();
            }
            else if ((_c = (_b = (_a = response === null || response === void 0 ? void 0 : response.choices) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.message) === null || _c === void 0 ? void 0 : _c.content) {
                selected = response.choices[0].message.content.trim();
            }
            if (!selected || selected.length < ((_e = (_d = config.autoSpeech) === null || _d === void 0 ? void 0 : _d.minLength) !== null && _e !== void 0 ? _e : 2)) {
                return null;
            }
            const cleanedSelected = selected.replace(/^[。！？.!?\s]+|[。！？.!?\s]+$/g, '').trim();
            if (cleanedSelected.length >= ((_g = (_f = config.autoSpeech) === null || _f === void 0 ? void 0 : _f.minLength) !== null && _g !== void 0 ? _g : 2)) {
                if (config.debug)
                    logger === null || logger === void 0 ? void 0 : logger.info(`ChatLuna 选择的句子: ${cleanedSelected.slice(0, 30)}...`);
                return cleanedSelected;
            }
            return null;
        }
        catch (error) {
            if (config.debug)
                logger === null || logger === void 0 ? void 0 : logger.warn(`ChatLuna 调用失败 (尝试 ${attempt + 1}/${MAX_RETRIES + 1}):`, (error === null || error === void 0 ? void 0 : error.message) || error);
            if (attempt < MAX_RETRIES) {
                await sleep(RETRY_DELAY);
                continue;
            }
            logger === null || logger === void 0 ? void 0 : logger.warn('ChatLuna 模型选择语音句子失败，已达最大重试次数');
            return null;
        }
    }
    return null;
}
