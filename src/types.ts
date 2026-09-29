// src/types.ts
export interface Config {
   provider?: 'minimax' | 'elevenlabs';
  
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
  outputFormat?: 'hex';
  languageBoost?: 'auto' | 'zh' | 'en' | 'ja';
  interjections?: boolean;

  // === ElevenLabs ===
  elevenlabsApiKey?: string;
  elevenlabsApiBase?: string;
  elevenlabsVoiceId?: string;
  elevenlabsModelId?: string;
  elevenlabsStability?: number;
  elevenlabsSimilarityBoost?: number;
  elevenlabsStyle?: number;
  elevenlabsUseSpeakerBoost?: boolean;
  elevenlabsAudioFormat?: 'mp3' | 'pcm';


  // 新增：自动语音配置
  autoSpeech: {
    enabled: boolean
    whitelist?: {
      groupEnabled: boolean
      groupList: string[]
      privateEnabled: boolean
      privateList: string[]
    }
    sendMode: 'voice_only' | 'text_and_voice' | 'mixed'
    minLength: number
    selectorMode: 'full' | 'ai_sentence' | 'openai_filter'
    openaiLikeBaseUrl?: string
    openaiLikeApiKey?: string
    openaiLikeModel?: string
    customPrompt?: string
  }

  // 功能开关
  debug: boolean
  
  // 缓存配置
  cacheEnabled: boolean
  cacheDir: string
  cacheMaxAge: number
  cacheMaxSize: number
}
