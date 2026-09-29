# koishi-plugin-Japanese-adaptation-vits
自用插件，基于@唐晓啡老师的minimax-vits 语音合成插件，添加了日语适配、语气词保护、群聊私聊白名单功能。感谢妖祀老师帮忙添加mp3转silk功能！


- **群聊私聊白名单**：开启后会只在指定的用户/群组内发送语音


#### 服务商选择
| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `provider` | Union | `minimax` | 选择使用的 TTS 服务商：`minimax` 或 `elevenlabs` |

---

#### MiniMax 设置（当选择 `minimax` 时显示）
| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `ttsApiKey` | string | `""` | MiniMax TTS API Key（密钥模式） |
| `groupId` | string | `""` | MiniMax Group ID |
| `apiBase` | string | `https://api.minimax.io/v1` | API 基础地址 |
| `defaultVoice` | string | `Chinese_female_gentle` | 默认音色 ID |
| `speechModel` | string | `speech-01-turbo` | TTS 模型 |
| `speed` | number | `1.0` | 语速 (0.5 ~ 2.0) |
| `vol` | number | `1.0` | 音量 (0.0 ~ 2.0) |
| `pitch` | number | `0` | 音调 (-12 ~ 12) |
| `audioFormat` | Union | `mp3` | 音频格式 (`mp3` / `wav`) |
| `sampleRate` | Union | `32000` | 采样率 (16000 / 24000 / 32000 / 44100 / 48000) |
| `bitrate` | Union | `128000` | 比特率 (64000 ~ 256000) |
| `outputFormat` | const | `hex` | API 输出编码 (必须为 `hex`) |
| `languageBoost` | Union | `auto` | 语言增强 (`auto` / `zh` / `en` / `ja`) |
| `interjections` | boolean | `false` | 是否传递语气词给模型（仅限支持语气词的模型） |

---

#### ElevenLabs 设置（当选择 `elevenlabs` 时显示）
| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `elevenlabsApiKey` | string | `""` | ElevenLabs API Key（密钥模式） |
| `elevenlabsApiBase` | string | `https://api.elevenlabs.io/v1` | ElevenLabs API 基础地址 |
| `elevenlabsVoiceId` | string | `21m00Tcm4TlvDq8ikWAM` | 默认 Voice ID（例如 Rachel） |
| `elevenlabsModelId` | string | `eleven_multilingual_v2` | TTS 模型 ID（推荐 `eleven_v3` 或 `eleven_flash_v2_5`） |
| `elevenlabsStability` | number | `0.5` | 稳定性 (0.0 ~ 1.0，较低时情感更丰富，较高时更平稳) |
| `elevenlabsSimilarityBoost` | number | `0.75` | 相似度提升 (0.0 ~ 1.0) |
| `elevenlabsStyle` | number | `0.0` | 风格夸张度 (0.0 ~ 1.0，设为 0 时较沉稳) |
| `elevenlabsUseSpeakerBoost` | boolean | `true` | 启用说话人增强（Speaker Boost） |
| `elevenlabsAudioFormat` | Union | `mp3` | 输出格式 (`mp3` / `pcm`) |

---

### 2. 自动语音转换配置（`autoSpeech`）

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `enabled` | boolean | `false` | 是否启用对话自动转语音（拦截 Bot 发送的消息） |
| `sendMode` | Union | `text_and_voice` | 发送模式：<br>• `voice_only`: 仅发送语音<br>• `text_and_voice`: 发送语音 + 文本 (分两条)<br>• `mixed`: 文本 + 语音混合 (同一条消息) |
| `minLength` | number | `2` | 触发转换的最短字符数 |
| `selectorMode` | Union | `full` | 语音内容选择策略：<br>• `full`: 整条文本直接转语音<br>• `ai_sentence`: 从中挑选适合朗读的一句<br>• `openai_filter`: 通过 OpenAI 接口小模型精选 |
| **白名单机制** | object | - | - |
| ├ `whitelist.groupEnabled` | boolean | `false` | 启用群聊白名单（开启后仅白名单内群聊触发） |
| ├ `whitelist.groupList` | array | `[]` | 群聊白名单群号列表 |
| ├ `whitelist.privateEnabled` | boolean | `false` | 启用私聊白名单（开启后仅白名单内用户触发） |
| └ `whitelist.privateList` | array | `[]` | 私聊白名单用户 ID 列表 |
| **OpenAI 兼容小模型筛选** | object | - | 当 `selectorMode` 为 `openai_filter` 时生效 |
| ├ `openaiLikeBaseUrl` | string | `""` | API Base URL（如 `https://api.openai.com`） |
| ├ `openaiLikeApiKey` | string | `""` | API Key |
| ├ `openaiLikeModel` | string | `""` | 模型名称（如 `gpt-4o-mini`, `qwen-turbo`） |
| └ `customPrompt` | string | 预置 Prompt | 自定义内容筛选 System Prompt |

---

### 3. 通用与缓存设置

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `debug` | boolean | `false` | 是否开启调试控制台日志 |
| `cacheEnabled` | boolean | `true` | 是否启用本地文件缓存 |
| `cacheDir` | string | `./data/tts-adaptation-service/cache` | 缓存存储目录 |
| `cacheMaxAge` | number | `3600000` | 缓存有效期（毫秒，默认 1 小时） |
| `cacheMaxSize` | number | `104857600` | 最大缓存占用空间（字节，默认 100MB） |

---
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
