import express from "express";
import http from "http";
import path from "path";
import dotenv from "dotenv";
import { GoogleGenAI, Modality, GenerateVideosOperation } from "@google/genai";
import { WebSocketServer, WebSocket } from "ws";
import { createServer as createViteServer } from "vite";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Body parsers with generous limits for audio and images
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Lazy initializer for Gemini client
let genAIInstance: GoogleGenAI | null = null;
function getGenAI(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured in the workspace secrets. Please set your Gemini API key in Settings > Secrets.");
  }
  if (!genAIInstance) {
    genAIInstance = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  }
  return genAIInstance;
}

// 1. Health check
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    hasApiKey: Boolean(process.env.GEMINI_API_KEY),
    timestamp: new Date().toISOString(),
  });
});

// 2. Multi-turn Chat with Grounding & Role-based System Instructions
app.post("/api/gemini/chat", async (req, res) => {
  try {
    const {
      message,
      history = [],
      model = "gemini-3.5-flash",
      useSearch = false,
      useMaps = false,
      userLocation = null,
      telemetryContext = "",
    } = req.body;

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "A non-empty 'message' string is required." });
    }

    const ai = getGenAI();

    // Map model selector
    let selectedModel = "gemini-3.5-flash";
    if (model === "gemini-3.1-pro-preview") selectedModel = "gemini-3.1-pro-preview";
    else if (model === "gemini-3.1-flash-lite") selectedModel = "gemini-3.1-flash-lite";

    // Build system instruction
    let systemInstruction =
      "You are the Autonomous Mobile Robot (AMR) Fleet Operations Copilot in a high-tech automated fulfillment warehouse. " +
      "You understand distributed peer-to-peer trajectory deconfliction, time-space corridor reservations, A* kinematic pathfinding, " +
      "battery management, and throughput optimization. Answer questions accurately and concisely. " +
      "Format key metrics, warnings, or action recommendations clearly with bullet points or markdown.";

    if (telemetryContext) {
      systemInstruction += `\n\n[LIVE WAREHOUSE TELEMETRY SNAPSHOT]:\n${telemetryContext}`;
    }

    // Configure tools
    const tools: any[] = [];
    let toolConfig: any = undefined;

    if (useSearch) {
      tools.push({ googleSearch: {} });
    } else if (useMaps) {
      tools.push({ googleMaps: {} });
      if (userLocation && typeof userLocation.latitude === "number" && typeof userLocation.longitude === "number") {
        toolConfig = {
          retrievalConfig: {
            latLng: {
              latitude: userLocation.latitude,
              longitude: userLocation.longitude,
            },
          },
        };
      }
    }

    // Convert previous chat history
    const contents: any[] = [];
    if (Array.isArray(history) && history.length > 0) {
      for (const h of history) {
        if (h.role === "user" || h.role === "model") {
          contents.push({
            role: h.role,
            parts: [{ text: String(h.text || "") }],
          });
        }
      }
    }
    // Add current user message
    contents.push({
      role: "user",
      parts: [{ text: message }],
    });

    const config: any = {
      systemInstruction,
    };
    if (tools.length > 0) {
      config.tools = tools;
      if (toolConfig) config.toolConfig = toolConfig;
    }

    const response = await ai.models.generateContent({
      model: selectedModel,
      contents,
      config,
    });

    const text = response.text || "No response generated.";
    const groundingChunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];

    res.json({
      text,
      model: selectedModel,
      groundingChunks,
    });
  } catch (err: any) {
    console.error("Chat error:", err);
    res.status(500).json({
      error: err.message || "Failed to process chat request.",
    });
  }
});

// 3. Audio Transcription with gemini-3.5-transcribe
app.post("/api/gemini/transcribe", async (req, res) => {
  try {
    const { audioData, mimeType = "audio/webm" } = req.body;
    if (!audioData) {
      return res.status(400).json({ error: "Missing audioData payload (base64 string)." });
    }

    const ai = getGenAI();
    const cleanBase64 = audioData.replace(/^data:[^;]+;base64,/, "");

    const response = await ai.models.generateContent({
      model: "gemini-3.5-transcribe",
      contents: {
        parts: [
          {
            inlineData: {
              mimeType,
              data: cleanBase64,
            },
          },
          {
            text: "Transcribe the warehouse operator's spoken audio accurately. Output only the transcribed text.",
          },
        ],
      },
    });

    res.json({
      transcription: response.text?.trim() || "",
    });
  } catch (err: any) {
    console.error("Transcription error:", err);
    res.status(500).json({ error: err.message || "Audio transcription failed." });
  }
});

// 4. Image Generation & Editing with gemini-3.1-flash-image
app.post("/api/gemini/generate-image", async (req, res) => {
  try {
    const { prompt, aspectRatio = "1:1", imageSize = "1K" } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: "Prompt is required." });
    }

    const ai = getGenAI();
    const response = await ai.models.generateContent({
      model: "gemini-3.1-flash-image",
      contents: {
        parts: [{ text: prompt }],
      },
      config: {
        imageConfig: {
          aspectRatio,
          imageSize,
        },
      },
    });

    let imageUrl = "";
    let caption = "";

    const parts = response.candidates?.[0]?.content?.parts || [];
    for (const part of parts) {
      if (part.inlineData && part.inlineData.data) {
        const mime = part.inlineData.mimeType || "image/png";
        imageUrl = `data:${mime};base64,${part.inlineData.data}`;
      } else if (part.text) {
        caption += part.text;
      }
    }

    if (!imageUrl) {
      return res.status(500).json({ error: "No image was returned by the model.", details: caption });
    }

    res.json({ imageUrl, caption });
  } catch (err: any) {
    console.error("Image generation error:", err);
    res.status(500).json({ error: err.message || "Failed to generate image." });
  }
});

app.post("/api/gemini/edit-image", async (req, res) => {
  try {
    const { prompt, base64ImageData, mimeType = "image/png" } = req.body;
    if (!prompt || !base64ImageData) {
      return res.status(400).json({ error: "Both prompt and base64ImageData are required." });
    }

    const cleanBase64 = base64ImageData.replace(/^data:[^;]+;base64,/, "");
    const ai = getGenAI();

    const response = await ai.models.generateContent({
      model: "gemini-3.1-flash-image",
      contents: {
        parts: [
          {
            inlineData: {
              data: cleanBase64,
              mimeType,
            },
          },
          {
            text: prompt,
          },
        ],
      },
    });

    let imageUrl = "";
    let caption = "";

    const parts = response.candidates?.[0]?.content?.parts || [];
    for (const part of parts) {
      if (part.inlineData && part.inlineData.data) {
        const mime = part.inlineData.mimeType || "image/png";
        imageUrl = `data:${mime};base64,${part.inlineData.data}`;
      } else if (part.text) {
        caption += part.text;
      }
    }

    if (!imageUrl) {
      return res.status(500).json({ error: "Model did not output an edited image.", details: caption });
    }

    res.json({ imageUrl, caption });
  } catch (err: any) {
    console.error("Image edit error:", err);
    res.status(500).json({ error: err.message || "Failed to edit image." });
  }
});

// 5. Veo 3 Video Generation: veo-3.1-fast-generate-preview
app.post("/api/gemini/generate-video", async (req, res) => {
  try {
    const {
      prompt,
      startingImageBase64 = null,
      mimeType = "image/png",
      aspectRatio = "16:9",
      resolution = "720p",
    } = req.body;

    const ai = getGenAI();
    const payload: any = {
      model: "veo-3.1-fast-generate-preview",
      config: {
        numberOfVideos: 1,
        aspectRatio: aspectRatio === "9:16" ? "9:16" : "16:9",
        resolution: resolution === "1080p" ? "1080p" : "720p",
      },
    };

    if (prompt) {
      payload.prompt = prompt;
    }

    if (startingImageBase64) {
      const cleanBase64 = startingImageBase64.replace(/^data:[^;]+;base64,/, "");
      payload.image = {
        imageBytes: cleanBase64,
        mimeType,
      };
    }

    if (!payload.prompt && !payload.image) {
      return res.status(400).json({ error: "Must supply either a text prompt or an image to animate." });
    }

    const operation = await ai.models.generateVideos(payload);
    res.json({
      operationName: operation.name,
      status: "started",
    });
  } catch (err: any) {
    console.error("Veo video generation error:", err);
    res.status(500).json({ error: err.message || "Failed to initiate video generation." });
  }
});

app.post("/api/gemini/video-status", async (req, res) => {
  try {
    const { operationName } = req.body;
    if (!operationName) {
      return res.status(400).json({ error: "operationName is required." });
    }

    const ai = getGenAI();
    const op = new GenerateVideosOperation();
    op.name = operationName;
    const updated = await ai.operations.getVideosOperation({ operation: op });

    res.json({
      done: Boolean(updated.done),
      error: updated.error || null,
      hasVideo: Boolean(updated.response?.generatedVideos?.[0]?.video?.uri),
    });
  } catch (err: any) {
    console.error("Video status polling error:", err);
    res.status(500).json({ error: err.message || "Failed to check video status." });
  }
});

app.post("/api/gemini/video-download", async (req, res) => {
  try {
    const { operationName } = req.body;
    if (!operationName) {
      return res.status(400).json({ error: "operationName is required." });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY missing");

    const ai = getGenAI();
    const op = new GenerateVideosOperation();
    op.name = operationName;
    const updated = await ai.operations.getVideosOperation({ operation: op });

    const uri = updated.response?.generatedVideos?.[0]?.video?.uri;
    if (!uri) {
      return res.status(404).json({ error: "Video URI not found or video generation not yet completed." });
    }

    const videoRes = await fetch(uri, {
      headers: { "x-goog-api-key": apiKey },
    });

    if (!videoRes.ok) {
      return res.status(videoRes.status).json({ error: `Downstream video fetch failed with HTTP ${videoRes.status}` });
    }

    res.setHeader("Content-Type", "video/mp4");
    if (videoRes.body) {
      // @ts-ignore
      const reader = videoRes.body.getReader();
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
        res.end();
      };
      await pump();
    } else {
      res.end();
    }
  } catch (err: any) {
    console.error("Video download error:", err);
    res.status(500).json({ error: err.message || "Video download failed." });
  }
});

// 6. Music Generation with Lyria: lyria-3-clip-preview & lyria-3-pro-preview
app.post("/api/gemini/generate-music", async (req, res) => {
  try {
    const {
      prompt = "Futuristic warehouse ambient soundscape with rhythmic mechanical pulses and calm melodic synth pads",
      model = "lyria-3-clip-preview",
      imageBase64 = null,
      mimeType = "image/jpeg",
    } = req.body;

    const selectedModel = model === "lyria-3-pro-preview" ? "lyria-3-pro-preview" : "lyria-3-clip-preview";
    const ai = getGenAI();

    let contents: any = prompt;
    if (imageBase64) {
      const cleanBase64 = imageBase64.replace(/^data:[^;]+;base64,/, "");
      contents = {
        parts: [
          { text: prompt },
          { inlineData: { data: cleanBase64, mimeType } },
        ],
      };
    }

    const responseStream = await ai.models.generateContentStream({
      model: selectedModel,
      contents,
    });

    let audioBase64 = "";
    let lyrics = "";
    let audioMimeType = "audio/wav";

    for await (const chunk of responseStream) {
      const parts = chunk.candidates?.[0]?.content?.parts;
      if (!parts) continue;
      for (const part of parts) {
        if (part.inlineData?.data) {
          if (!audioBase64 && part.inlineData.mimeType) {
            audioMimeType = part.inlineData.mimeType;
          }
          audioBase64 += part.inlineData.data;
        }
        if (part.text && !lyrics) {
          lyrics = part.text;
        }
      }
    }

    if (!audioBase64) {
      return res.status(500).json({ error: "No audio generated by Lyria model." });
    }

    res.json({
      audioBase64,
      mimeType: audioMimeType,
      lyrics,
      model: selectedModel,
    });
  } catch (err: any) {
    console.error("Lyria music generation error:", err);
    res.status(500).json({ error: err.message || "Music generation failed." });
  }
});

// Create HTTP server to mount both Express and WebSocket
const server = http.createServer(app);

// WebSocket for gemini-3.8-live
const wss = new WebSocketServer({ server, path: "/live" });

wss.on("connection", async (clientWs: WebSocket) => {
  console.log("Client connected to /live WebSocket");
  let liveSession: any = null;

  try {
    const ai = getGenAI();
    liveSession = await ai.live.connect({
      model: "gemini-3.8-live",
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } },
        },
        systemInstruction:
          "You are an edge warehouse dispatcher communicating verbally via radio with the autonomous mobile robot fleet. " +
          "Keep vocal responses brief, military-clear, and professional.",
      },
      callbacks: {
        onmessage: (message: any) => {
          const audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
          if (audio && clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({ audio }));
          }
          if (message.serverContent?.interrupted && clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({ interrupted: true }));
          }
        },
      },
    });

    clientWs.on("message", (raw: any) => {
      try {
        const parsed = JSON.parse(raw.toString());
        if (parsed.audio && liveSession) {
          liveSession.sendRealtimeInput({
            audio: { data: parsed.audio, mimeType: "audio/pcm;rate=16000" },
          });
        }
      } catch (err) {
        console.error("Live input parse error:", err);
      }
    });

    clientWs.on("close", () => {
      try {
        if (liveSession) liveSession.close();
      } catch (_) {}
    });
  } catch (err: any) {
    console.error("Failed to connect to Live API:", err);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({ error: err.message || "Live API connection failed." }));
    }
  }
});

// Setup Vite middleware for development or static serving for production
async function start() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      appType: "spa",
      server: { middlewareMode: true, hmr: false },
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Autonomous Mobile Robot Server running on port ${PORT}`);
  });
}

start();
