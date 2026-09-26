// Client service interfacing with server Gemini API endpoints and Live WebSockets

export interface ChatMessage {
  role: "user" | "model";
  text: string;
  groundingChunks?: any[];
  timestamp?: string;
}

export interface ChatRequestOptions {
  message: string;
  history: ChatMessage[];
  model?: "gemini-3.5-flash" | "gemini-3.1-pro-preview" | "gemini-3.1-flash-lite";
  useSearch?: boolean;
  useMaps?: boolean;
  userLocation?: { latitude: number; longitude: number } | null;
  telemetryContext?: string;
}

export interface ChatResponse {
  text: string;
  model: string;
  groundingChunks: any[];
}

export async function sendChatMessage(options: ChatRequestOptions): Promise<ChatResponse> {
  const res = await fetch("/api/gemini/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `Chat failed with HTTP ${res.status}`);
  }
  return data;
}

export async function transcribeAudioBlob(blob: Blob): Promise<string> {
  // Convert blob to base64
  const arrayBuffer = await blob.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(arrayBuffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);

  const res = await fetch("/api/gemini/transcribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      audioData: base64,
      mimeType: blob.type || "audio/webm",
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || "Audio transcription failed.");
  }
  return data.transcription || "";
}

export async function generateWarehouseImage(prompt: string, aspectRatio: string = "1:1"): Promise<{ imageUrl: string; caption?: string }> {
  const res = await fetch("/api/gemini/generate-image", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, aspectRatio }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || "Failed to generate image.");
  }
  return data;
}

export async function editWarehouseImage(prompt: string, base64ImageData: string, mimeType: string = "image/png"): Promise<{ imageUrl: string; caption?: string }> {
  const res = await fetch("/api/gemini/edit-image", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, base64ImageData, mimeType }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || "Failed to edit image.");
  }
  return data;
}

export interface VideoGenOptions {
  prompt?: string;
  startingImageBase64?: string | null;
  mimeType?: string;
  aspectRatio?: "16:9" | "9:16";
  onProgress?: (status: string) => void;
}

export async function generateVeoVideo(options: VideoGenOptions): Promise<string> {
  const { prompt, startingImageBase64, mimeType = "image/png", aspectRatio = "16:9", onProgress } = options;

  onProgress?.("Initiating Veo 3 video generation job...");

  const initRes = await fetch("/api/gemini/generate-video", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      startingImageBase64,
      mimeType,
      aspectRatio,
    }),
  });

  const initData = await initRes.json();
  if (!initRes.ok) {
    throw new Error(initData.error || "Failed to start Veo video generation.");
  }

  const operationName = initData.operationName;
  onProgress?.("Veo video synthesizing (rendering cinematic frames)...");

  // Poll status until done
  const maxAttempts = 60; // 5 mins max
  let attempts = 0;
  while (attempts < maxAttempts) {
    await new Promise((r) => setTimeout(r, 6000));
    attempts++;

    const statusRes = await fetch("/api/gemini/video-status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operationName }),
    });

    const statusData = await statusRes.json();
    if (!statusRes.ok) {
      throw new Error(statusData.error || "Error checking video generation status.");
    }

    if (statusData.error) {
      throw new Error(statusData.error.message || "Veo generation reported an error.");
    }

    if (statusData.done) {
      onProgress?.("Finalizing video stream download...");
      break;
    } else {
      onProgress?.(`Rendering video: in progress (${attempts * 6}s elapsed)...`);
    }
  }

  // Fetch final video binary
  const downloadRes = await fetch("/api/gemini/video-download", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operationName }),
  });

  if (!downloadRes.ok) {
    throw new Error("Failed to download generated video stream.");
  }

  const videoBlob = await downloadRes.blob();
  return URL.createObjectURL(videoBlob);
}

export async function generateLyriaMusic(
  prompt: string,
  model: "lyria-3-clip-preview" | "lyria-3-pro-preview" = "lyria-3-clip-preview",
  imageBase64: string | null = null,
  mimeType: string = "image/jpeg"
): Promise<{ audioUrl: string; lyrics?: string; model: string }> {
  const res = await fetch("/api/gemini/generate-music", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, model, imageBase64, mimeType }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || "Music generation failed.");
  }

  // Decode base64 to Blob URL
  const binary = atob(data.audioBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: data.mimeType || "audio/wav" });
  const audioUrl = URL.createObjectURL(blob);

  return {
    audioUrl,
    lyrics: data.lyrics,
    model: data.model,
  };
}

// Live Voice API helper over WebSockets
export class LiveVoiceClient {
  private ws: WebSocket | null = null;
  private inputAudioCtx: AudioContext | null = null;
  private outputAudioCtx: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private isRunning: boolean = false;
  private onStateChange: (state: { active: boolean; error?: string }) => void;
  private nextPlayTime: number = 0;

  constructor(onStateChange: (state: { active: boolean; error?: string }) => void) {
    this.onStateChange = onStateChange;
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;

    try {
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      this.ws = new WebSocket(`${protocol}//${location.host}/live`);

      // 16kHz for input mic capture
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      this.inputAudioCtx = new AudioCtx({ sampleRate: 16000 });
      // 24kHz for Live API model response audio playback
      this.outputAudioCtx = new AudioCtx({ sampleRate: 24000 });
      this.nextPlayTime = this.outputAudioCtx.currentTime;

      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });

      const source = this.inputAudioCtx.createMediaStreamSource(this.mediaStream);
      this.processor = this.inputAudioCtx.createScriptProcessor(4096, 1, 1);
      source.connect(this.processor);
      this.processor.connect(this.inputAudioCtx.destination);

      this.processor.onaudioprocess = (e) => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        const channelData = e.inputBuffer.getChannelData(0);
        // Convert Float32 [-1, 1] to Int16 PCM
        const pcm16 = new Int16Array(channelData.length);
        for (let i = 0; i < channelData.length; i++) {
          const s = Math.max(-1, Math.min(1, channelData[i]));
          pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        const base64 = btoa(String.fromCharCode(...new Uint8Array(pcm16.buffer)));
        this.ws.send(JSON.stringify({ audio: base64 }));
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.error) {
            this.onStateChange({ active: false, error: msg.error });
            this.stop();
          } else if (msg.audio) {
            this.playAudioChunk(msg.audio);
          } else if (msg.interrupted) {
            if (this.outputAudioCtx) {
              this.nextPlayTime = this.outputAudioCtx.currentTime;
            }
          }
        } catch (err) {
          console.error("Live message handling error:", err);
        }
      };

      this.ws.onopen = () => {
        this.isRunning = true;
        this.onStateChange({ active: true });
      };

      this.ws.onerror = (err) => {
        console.error("Live WebSocket error:", err);
        this.onStateChange({ active: false, error: "Live audio WebSocket connection error." });
        this.stop();
      };

      this.ws.onclose = () => {
        this.isRunning = false;
        this.onStateChange({ active: false });
      };
    } catch (err: any) {
      this.stop();
      this.onStateChange({ active: false, error: err.message || "Microphone access denied or audio initialization failed." });
      throw err;
    }
  }

  private playAudioChunk(base64Pcm: string): void {
    if (!this.outputAudioCtx) return;

    try {
      const binary = atob(base64Pcm);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      const int16 = new Int16Array(bytes.buffer);
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / 32768.0;
      }

      const audioBuffer = this.outputAudioCtx.createBuffer(1, float32.length, 24000);
      audioBuffer.getChannelData(0).set(float32);

      const source = this.outputAudioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.outputAudioCtx.destination);

      const startTime = Math.max(this.outputAudioCtx.currentTime, this.nextPlayTime);
      source.start(startTime);
      this.nextPlayTime = startTime + audioBuffer.duration;
    } catch (err) {
      console.error("Error playing audio chunk:", err);
    }
  }

  public stop(): void {
    this.isRunning = false;
    if (this.processor) {
      this.processor.disconnect();
      this.processor = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }
    if (this.inputAudioCtx) {
      this.inputAudioCtx.close();
      this.inputAudioCtx = null;
    }
    if (this.outputAudioCtx) {
      this.outputAudioCtx.close();
      this.outputAudioCtx = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.onStateChange({ active: false });
  }
}
