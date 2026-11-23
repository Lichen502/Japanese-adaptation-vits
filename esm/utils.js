// 工具函数
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { h } from 'koishi';
export const inject = { optional: ['silk', 'ffmpeg'] };
/**
 * 模糊查询关键词
 */
export function fuzzyQuery(text, keywords) {
    const lowerText = text.toLowerCase();
    return keywords.some(keyword => lowerText.includes(keyword.toLowerCase()));
}
/**
 * 从消息内容中提取文本
 */
export function getMessageContent(content) {
    if (typeof content === 'string')
        return content;
    if (content && typeof content === 'object') {
        const obj = content;
        return (obj.text || obj.content || JSON.stringify(content));
    }
    return String(content);
}
/**
 * 提取对话内容（过滤动作描述等）
 */
export function extractDialogueContent(text) {
    const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    let dialogueContent = '';
    let inDialogue = false;
    for (const line of lines) {
        const isDialogueLine = line.startsWith('"') ||
            line.startsWith("'") ||
            line.includes('说：') ||
            /^[A-Za-z\u4e00-\u9fff]+[：:]/.test(line);
        const isNonDialogue = (line.includes('（') && line.includes('）')) ||
            (line.includes('(') && line.includes(')')) ||
            /^\s*[\[\{【（(]/.test(line);
        if (isDialogueLine && !isNonDialogue) {
            let cleanLine = line
                .replace(/^["\'"']/, '')
                .replace(/["\'"']$/, '')
                .replace(/^[A-Za-z\u4e00-\u9fff]+[：:]\s*/, '')
                .replace(/说：|说道：/g, '')
                .trim();
            if (cleanLine.length > 0) {
                dialogueContent += cleanLine + '。';
                inDialogue = true;
            }
        }
        else if (inDialogue && line.length > 0 && !isNonDialogue) {
            dialogueContent += line + '。';
        }
    }
    if (dialogueContent.length > 0) {
        return dialogueContent.replace(/。+/g, '。').trim();
    }
    if (text.length <= 150 && !/[[{【（(]/.test(text)) {
        return text;
    }
    return null;
}
/**
 * 判断是否为 weixin/openclaw 平台
 */
export function isWeixinLikePlatform(platform) {
    if (!platform)
        return false;
    const lower = String(platform).toLowerCase();
    return lower.includes('weixin') || lower.includes('openclaw');
}
/**
 * 把音频(mp3/wav 等)先转成 SILK 再生成 audio 元素。
 * 解决部分环境(如 macOS 的 NapCat)客户端无法将 mp3 转 silk 导致语音发送失败的问题。
 * 依赖提供 `silk`(silk-wasm 接口)与 `ffmpeg` 服务的插件,例如 koishi-plugin-ffmpeg-path(enableSilk: true)。
 * 任一步失败都会回退到原始音频,保证不比现状更糟。
 */
export async function makeSilkAudioElement(ctx, buffer, fallbackFormat) {
    // 保留原导出签名；实际转换走统一的 safe 实现（含本地变速与尾音垫的可选参数）
    return makeSilkAudioElementSafe(ctx, buffer, fallbackFormat);
}
/**
 * 音频 → PCM(s16le / 24000Hz / 单声道)。
 * speed 为本地变速不变调（atempo），折进同一次 ffmpeg 解码，不额外转码；
 * 对已缓存的音频同样即时生效。依赖 ffmpeg 服务（如 koishi-plugin-ffmpeg-path）。
 */
export async function decodeToPcm24k(ctx, buffer, speed) {
    const ffmpeg = (ctx && typeof ctx.get === 'function')
        ? ctx.get('ffmpeg')
        : ctx === null || ctx === void 0 ? void 0 : ctx.ffmpeg;
    if (!ffmpeg)
        throw new Error('ffmpeg service unavailable');
    const spd = (typeof speed === 'number' && isFinite(speed))
        ? Math.max(0.5, Math.min(2.0, speed))
        : 1.0;
    const builder = ffmpeg.builder().input(buffer);
    if (Math.abs(spd - 1.0) > 0.001) {
        builder.outputOption('-filter:a', `atempo=${spd}`);
    }
    const pcm = await builder
        .outputOption('-f', 's16le', '-ar', '24000', '-ac', '1')
        .run('buffer');
    return Buffer.from(pcm);
}
/**
 * PCM 尾部补静音：至少补 minPadMs，且总时长跨过语音结束后的下一整秒再加 50ms。
 * 防 QQ/NapCat 播放端把时长按整秒下取整时吃掉最后一个音节；minPadMs=0 表示不补。
 */
export function padPcmTail(pcm, minPadMs) {
    const bytesPerSec = 24000 * 2;
    const durMs = pcm.length / bytesPerSec * 1000;
    const targetMs = Math.max(durMs + minPadMs, (Math.floor(durMs / 1000) + 1) * 1000 + 50);
    const padBytes = Math.max(0, Math.ceil((targetMs - durMs) / 1000 * bytesPerSec / 2) * 2);
    return Buffer.concat([Buffer.from(pcm), Buffer.alloc(padBytes)]);
}
/** PCM → SILK 消息元素。依赖 silk 服务（enableSilk: true）。 */
export async function silkElementFromPcm(ctx, pcm) {
    var _a;
    const silk = (ctx && typeof ctx.get === 'function')
        ? ctx.get('silk')
        : ctx === null || ctx === void 0 ? void 0 : ctx.silk;
    if (!silk)
        throw new Error('silk service unavailable');
    const encoded = await silk.encode(pcm, 24000);
    const silkBuf = Buffer.from((_a = encoded === null || encoded === void 0 ? void 0 : encoded.data) !== null && _a !== void 0 ? _a : encoded);
    return h('audio', { src: `data:audio/silk;base64,${silkBuf.toString('base64')}` });
}
/**
 * 发送前的完整 SILK 转换入口：已是 silk 直接透传；否则解码 → 可选变速/尾音垫 → 编码。
 * 任一步失败都回退到原始音频元素，保证不比不使用该链路更差。
 */
export async function makeSilkAudioElementSafe(ctx, buffer, fallbackFormat, speed, tailPadMs) {
    var _a;
    try {
        const silk = (ctx && typeof ctx.get === 'function')
            ? ctx.get('silk')
            : ctx === null || ctx === void 0 ? void 0 : ctx.silk;
        if (silk && typeof silk.isSilk === 'function' && silk.isSilk(buffer)) {
            return h('audio', { src: `data:audio/silk;base64,${Buffer.from(buffer).toString('base64')}` });
        }
        let pcm = await decodeToPcm24k(ctx, buffer, speed);
        const pad = (typeof tailPadMs === 'number' && isFinite(tailPadMs))
            ? Math.max(0, Math.min(2000, tailPadMs))
            : 0;
        if (pad > 0 && pcm.length > 0) {
            const durMs = pcm.length / (24000 * 2) * 1000;
            pcm = padPcmTail(pcm, pad);
            const totalMs = pcm.length / (24000 * 2) * 1000;
            try {
                ctx.logger('tts-adaptation-service').info(`silk: 语音 ${(durMs / 1000).toFixed(2)}s → 总长 ${(totalMs / 1000).toFixed(2)}s (垫 ${Math.round(totalMs - durMs)}ms)`);
            }
            catch { /* 日志不可用时忽略 */ }
        }
        return await silkElementFromPcm(ctx, pcm);
    }
    catch (e) {
        try {
            ctx.logger('tts-adaptation-service').warn('SILK 转换失败,回退原始音频:%s', (_a = e === null || e === void 0 ? void 0 : e.message) !== null && _a !== void 0 ? _a : e);
        }
        catch { /* 日志不可用时忽略 */ }
        return makeAudioElement(buffer, fallbackFormat);
    }
}
/**
 * 构建音频消息元素（data-uri）
 */
export function makeAudioElement(buffer, format) {
    const mimeType = format === 'wav' ? 'audio/wav' : 'audio/mpeg';
    const src = `data:${mimeType};base64,${buffer.toString('base64')}`;
    return h('audio', { src });
}
/**
 * 将音频写入临时文件，返回绝对路径
 */
export async function writeTempAudioFile(buffer, format) {
    const ext = format === 'wav' ? 'wav' : 'mp3';
    const dir = path.resolve('./data/minimax-vits/outbound');
    await fs.mkdir(dir, { recursive: true });
    const fileName = `tts-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
    const filePath = path.join(dir, fileName);
    await fs.writeFile(filePath, buffer);
    return filePath;
}
/**
 * 构建 weixin 兼容文件消息元素（走 file:// URL）
 */
export function makeWeixinFileElement(filePath) {
    const fileUrl = pathToFileURL(path.resolve(filePath)).href;
    return h.file(fileUrl);
}
/**
 * 构建 weixin 兼容语音消息元素（走 file:// URL）
 */
export function makeWeixinAudioElement(filePath) {
    const fileUrl = pathToFileURL(path.resolve(filePath)).href;
    return h('audio', { src: fileUrl });
}
/**
 * 删除临时文件（忽略异常）
 */
export async function removeTempFile(filePath) {
    if (!filePath)
        return;
    try {
        await fs.unlink(filePath);
    }
    catch {
        // ignore
    }
}
