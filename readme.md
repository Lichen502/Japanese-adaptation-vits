# koishi-plugin-Japanese-adaptation-vits
自用插件，基于@唐晓啡老师的minimax-vits 语音合成插件，添加了日语适配、语气词保护、群聊私聊白名单功能


- **群聊私聊白名单**：开启后会只在指定的用户/群组内发送语音


## 配置

在 Koishi 控制台插件配置页面填写：

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| ttsApiKey | MiniMax TTS API Key | - |
| groupId | MiniMax Group ID | - |
| apiBase | API 基础地址 | `https://api.minimax.io/v1` |
| defaultVoice | 默认语音 ID | `Chinese_female_gentle` |
| speechModel | TTS 模型 | `speech-01-turbo` |
| speed | 语速 | 1.0 |
| pitch | 音调 | 0 |
| audioFormat | 音频格式 | mp3 |
| sampleRate | 采样率 | 32000 |
| interjections | 是否传语气词给模型(仅限支持语气词的模型) | false |

### 自动语音转换

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| enabled | 启用 ChatLuna 对话自动转语音 | false |
| groupEnabled | 启用群聊白名单（开启后仅白名单内群聊触发自动转语音） | false |
| groupList | 群聊白名单列表 | string[] |
| privateEnabled | 启用私聊白名单 | false |
| privateList | 私聊白名单列表 | string[] |
| sendMode | 发送模式：voice_only / text_and_voice / mixed | text_and_voice |
| minLength | 触发转换的最短字符数 | 2 |
| selectorMode | 语音内容选择策略 | full |

#### 语音内容选择策略

- **full**：整条文本直接转语音
- **ai_sentence**：交给 ChatLuna 从中挑选一句朗读
- **openai_filter**：通过 OpenAI 兼容接口，让小模型决定具体朗读内容（需配置 OpenAI 兼容接口）

## 使用

1. 安装并配置 MiniMax API Key
2. 在控制台开启 **启用 ChatLuna 对话自动转语音**
3. 与 ChatLuna 对话时，AI 回复将自动转换为语音发送

### 发送模式说明

- **voice_only**：只发送语音
- **text_and_voice**：先发语音，再发原文（分两条）
- **mixed**：语音+文本混合（同一条消息）

## 指令

- `/minivits.test <text>` - 测试 TTS 语音生成

## 许可证

MIT
