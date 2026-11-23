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
| `elevenlabsOutputFormat` | Union | `mp3_44100_128` | API 原生输出规格；`apply_text_normalization` / `language_code` / `seed` / `optimize_streaming_latency` 已接入实际请求 |
| `elevenlabsLocalSpeed` | number | `1.0` | 本地语速 (0.5 ~ 2.0，atempo 变速不变调；与 API 语速独立，对缓存音频也生效，需 ffmpeg/silk 服务) |
| `elevenlabsTailPadMs` | number | `300` | 尾部静音垫最小值 ms (自动补到跨过下一整秒再加 50ms，防末音节截断；`0` 关闭，需 ffmpeg/silk 服务) |
| `elevenlabsContextStitching` | boolean | `true` | 按频道缝合最近三条朗读文本作为 `previous_text`；`eleven_v3` 自动跳过，模型不支持时自动禁用重试 |
| `elevenlabsContextMaxChars` | number | `300` | `previous_text` 最大字符数 |

> ElevenLabs 会把一条消息整条合成一次，保留消息内 `[tag]` 的上下文；MiniMax 仍按句合成。TTS 文本缺少终止标点时自动补「。」，显示文本不变。

---

### 2. 自动语音转换配置（`autoSpeech`）

**基础**

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `enabled` | boolean | `false` | 是否启用对话自动转语音（拦截 Bot 发送的消息） |
| `minLength` | number | `2` | 触发转换的最短字符数 |

**触发范围：谁能触发、何时触发**

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| **黑白名单机制** `whitelist` | object | - | 关闭则对所有人生效 |
| ├ `whitelist.groupEnabled` | boolean | `false` | 启用群聊白名单（开启后仅白名单内群聊触发） |
| ├ `whitelist.groupList` | array | `[]` | 群聊白名单群号列表 |
| ├ `whitelist.privateEnabled` | boolean | `false` | 启用私聊白名单（开启后仅白名单内用户触发） |
| └ `whitelist.privateList` | array | `[]` | 私聊白名单用户 ID 列表 |
| `skipPrivateUsers` | array | `[]` | 私聊中跳过语音的对象 (如其他 bot 的 ID)；仅私聊生效，文字照常发送 |
| `mindSpeakingOnly` | boolean | `false` | 仅在 `chatluna_mind` 判定该频道正在发言时配音；未装该服务时行为不变 |

**服务商与发送方式**

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `userProviders` | array | `[]` | 按用户指定服务商：`[{ "userId": "用户ID", "provider": "elevenlabs" }]`。命中即覆盖顶部 `provider`；留空或未命中则跟随顶部选择。群聊按发送者 ID 匹配，与白名单一致支持部分匹配 |
| `sendMode` | Union | `text_and_voice` | 发送模式：<br>• `voice_only`: 仅发送语音<br>• `text_and_voice`: 发送语音 + 文本 (分两条)<br>• `mixed`: 文本 + 语音混合 (同一条消息) |

**朗读内容：选什么读**

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `selectorMode` | Union | `full` | 语音内容选择策略，见下方「语音内容选择策略」 |
| `openaiLikeBaseUrl` | string | `""` | OpenAI 兼容接口 Base URL（如 `https://api.openai.com`），仅 `openai_filter` 时生效 |
| `openaiLikeApiKey` | string | `""` | API Key，仅 `openai_filter` 时生效 |
| `openaiLikeModel` | dynamic | `""` | 小模型名称，仅 `openai_filter` 时生效。**复用 ChatLuna 全局模型列表做下拉**（与 chatluna-character 同款），可直接选已配置的模型（值形如 `openai/gpt-4o-mini`）；未装 ChatLuna 时也可在配置文件里手填任意兼容模型名（如 `gpt-4o-mini`, `qwen-turbo`） |
| `customPrompt` | string | 预置 Prompt | 自定义内容筛选 System Prompt，仅 `openai_filter` 时生效 |

> 下拉项来自 ChatLuna 已配置的对话模型，名称带 `平台/` 前缀。若你填的是独立的 OpenAI 兼容端点且不接受带前缀的模型名，可直接在 `koishi.yml` 里写裸模型名（该字段不锁定取值）。

> **语音内容选择策略**：`full` 整条文本直接转语音（默认）；`ai_sentence` 交给 ChatLuna 从中挑选一句朗读；`openai_filter` 通过 OpenAI 兼容接口，让小模型决定具体朗读内容（需配置上方 OpenAI 兼容接口）。

---

### 3. 通用与缓存设置

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `silkEnabled` | boolean | `true` | 非微信平台发送前转 SILK（需 `ffmpeg` / `silk` 服务，如 koishi-plugin-ffmpeg-path 开启 `enableSilk`；失败自动回退原始音频） |
| `debug` | boolean | `false` | 是否开启调试控制台日志 |
| `cacheEnabled` | boolean | `true` | 是否启用本地文件缓存 |
| `cacheDir` | string | `./data/tts-adaptation-service/cache` | 缓存存储目录 |
| `cacheMaxAge` | number | `3600000` | 缓存有效期（毫秒，默认 1 小时） |
| `cacheMaxSize` | number | `104857600` | 最大缓存占用空间（字节，默认 100MB） |

---

## 使用

1. 安装并配置 MiniMax API Key
2. 在控制台开启 **启用 ChatLuna 对话自动转语音**
3. 与 ChatLuna 对话时，AI 回复将自动转换为语音发送

### 发送模式说明

- **voice_only**：只发送语音
- **text_and_voice**：先发语音，再发原文（分两条）
- **mixed**：语音+文本混合（同一条消息）

## 指令

- `/tts.test <text>` - 测试 TTS 语音生成（同样走 SILK 链路）

## 许可证

MIT
