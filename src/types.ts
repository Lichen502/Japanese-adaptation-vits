// src/types.ts

export interface Config {
  // === 基础服务商 ===
  provider?: 'minimax' | 'elevenlabs';
  engine?: 'minimax' | 'elevenlabs'; // 运行时兼容字段

  // === MiniMax ===
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
  outputFormat?: string; // 👈 必须改为 string，彻底解决 'hex' 冲突！
  languageBoost?: 'auto' | 'zh' | 'en' | 'ja';
  interjections?: boolean;

  // === ElevenLabs 原生完整参数 ===
  elevenlabsApiKey?: string;
  elevenlabsApiBase?: string;
  elevenlabsVoiceId?: string;
  elevenlabsModelId?: string;
  elevenlabsSpeed?: number; // 语速 (0.7 ~ 1.2)
  elevenlabsStability?: number; // 稳定性 (0.0 ~ 1.0)
  elevenlabsSimilarityBoost?: number; // 相似度 (0.0 ~ 1.0)
  elevenlabsStyle?: number; // 风格夸张度 (0.0 ~ 1.0)
  elevenlabsUseSpeakerBoost?: boolean; // 说话人增强
  elevenlabsOutputFormat?: string; // API 原生输出规格 (如 mp3_44100_128, pcm_16000)
  elevenlabsAudioFormat?: 'mp3' | 'wav' | 'pcm'; // 封装格式
  elevenlabsLanguageCode?: string; // 强制语言代码 (ja, zh, en 等)
  elevenlabsApplyTextNormalization?: 'auto' | 'on' | 'off'; // 文本归一化
  elevenlabsSeed?: number; // 随机种子 (-1 或具体数值)
  elevenlabsOptimizeStreamingLatency?: number; // 流式延迟优化等级 (0 ~ 4)

  // === 运行时兼容映射字段（供 api.ts 统一读取）===
  apiKey?: string;
  voiceId?: string;
  modelId?: string;
  stability?: number;
  similarityBoost?: number;
  style?: number;
  useSpeakerBoost?: boolean;
  languageCode?: string;
  applyTextNormalization?: 'auto' | 'on' | 'off';
  seed?: number;
  optimizeStreamingLatency?: number;
  allowInterjections?: boolean;

  // === 自动语音配置 ===
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

  // === 功能开关与缓存 ===
  debug?: boolean;
  cacheEnabled?: boolean;
  cacheDir?: string;
  cacheMaxAge?: number;
  cacheMaxSize?: number;
}