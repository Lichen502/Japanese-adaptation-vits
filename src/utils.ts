// 工具函数
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { h } from 'koishi'

/**
 * 模糊查询关键词
 */
export function fuzzyQuery(text: string, keywords: string[]): boolean {
  const lowerText = text.toLowerCase()
  return keywords.some(keyword => lowerText.includes(keyword.toLowerCase()))
}

/**
 * 从消息内容中提取文本
 */
export function getMessageContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (content && typeof content === 'object') {
    const obj = content as Record<string, unknown>
    return (obj.text || obj.content || JSON.stringify(content)) as string
  }
  return String(content)
}

/**
 * 提取对话内容（过滤动作描述等）
 */
export function extractDialogueContent(text: string): string | null {
  const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0)
  let dialogueContent = ''
  let inDialogue = false

  for (const line of lines) {
    const isDialogueLine =
      line.startsWith('"') ||
      line.startsWith("'") ||
      line.includes('说：') ||
      /^[A-Za-z\u4e00-\u9fff]+[：:]/.test(line)

    const isNonDialogue =
      (line.includes('（') && line.includes('）')) ||
      (line.includes('(') && line.includes(')')) ||
      /^\s*[\[\{【（(]/.test(line)

    if (isDialogueLine && !isNonDialogue) {
      let cleanLine = line
        .replace(/^["\'"']/, '')
        .replace(/["\'"']$/, '')
        .replace(/^[A-Za-z\u4e00-\u9fff]+[：:]\s*/, '')
        .replace(/说：|说道：/g, '')
        .trim()

      if (cleanLine.length > 0) {
        dialogueContent += cleanLine + '。'
        inDialogue = true
      }
    } else if (inDialogue && line.length > 0 && !isNonDialogue) {
      dialogueContent += line + '。'
    }
  }

  if (dialogueContent.length > 0) {
    return dialogueContent.replace(/。+/g, '。').trim()
  }
  if (text.length <= 150 && !/[[{【（(]/.test(text)) {
    return text
  }
  return null
}

/**
 * 判断是否为 weixin/openclaw 平台
 */
export function isWeixinLikePlatform(platform?: string): boolean {
  if (!platform) return false
  const lower = String(platform).toLowerCase()
  return lower.includes('weixin') || lower.includes('openclaw')
}

/**
 * 构建音频消息元素（data-uri）
 */
export function makeAudioElement(buffer: Buffer, format: string) {
  const mimeType = format === 'wav' ? 'audio/wav' : 'audio/mpeg'
  const src = `data:${mimeType};base64,${buffer.toString('base64')}`
  return h('audio', { src })
}

/**
 * 将音频写入临时文件，返回绝对路径
 */
export async function writeTempAudioFile(buffer: Buffer, format: string): Promise<string> {
  const ext = format === 'wav' ? 'wav' : 'mp3'
  const dir = path.resolve('./data/minimax-vits/outbound')
  await fs.mkdir(dir, { recursive: true })
  const fileName = `tts-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`
  const filePath = path.join(dir, fileName)
  await fs.writeFile(filePath, buffer)
  return filePath
}

/**
 * 构建 weixin 兼容文件消息元素（走 file:// URL）
 */
export function makeWeixinFileElement(filePath: string) {
  const fileUrl = pathToFileURL(path.resolve(filePath)).href
  return h.file(fileUrl)
}

/**
 * 构建 weixin 兼容语音消息元素（走 file:// URL）
 */
export function makeWeixinAudioElement(filePath: string) {
  const fileUrl = pathToFileURL(path.resolve(filePath)).href
  return h('audio', { src: fileUrl })
}

/**
 * 删除临时文件（忽略异常）
 */
export async function removeTempFile(filePath?: string): Promise<void> {
  if (!filePath) return
  try {
    await fs.unlink(filePath)
  } catch {
    // ignore
  }
}
