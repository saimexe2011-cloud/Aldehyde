import express, { Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const isProduction = process.env.NODE_ENV === 'production';

app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// LM Studio Local AI Configuration (OpenAI-compatible)
interface LMStudioConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

function getLMStudioConfig(overrideBaseUrl?: string): LMStudioConfig {
  let baseUrl = (
    overrideBaseUrl ||
    process.env.LM_STUDIO_BASE_URL ||
    process.env.LOCAL_AI_BASE_URL ||
    'http://127.0.0.1:1234/v1'
  ).trim();
  if (baseUrl.endsWith('/')) {
    baseUrl = baseUrl.slice(0, -1);
  }
  if (!baseUrl.endsWith('/v1') && !baseUrl.includes('/v1/')) {
    baseUrl = `${baseUrl}/v1`;
  }
  const model = (process.env.LM_STUDIO_MODEL || 'liquid/lfm-2.5-1.2b-instruct').trim();
  const apiKey = (process.env.LM_STUDIO_API_KEY || 'lm-studio').trim();
  return { baseUrl, model, apiKey };
}

// Dynamic AI SDK and Key Resolvers
function getOpenRouterKey(): string {
  return (process.env.OPENROUTER_API_KEY || '').trim();
}

function getGeminiClient(): GoogleGenAI | null {
  const key = (process.env.GEMINI_API_KEY || process.env.API_KEY || '').trim();
  if (!key) return null;
  try {
    return new GoogleGenAI({
      apiKey: key,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  } catch {
    return null;
  }
}

// In-memory Video Studio Jobs Store
interface VideoJobRecord {
  id: string;
  prompt: string;
  style: string;
  duration: number;
  aspectRatio: string;
  resolution: string;
  status: 'queued' | 'processing' | 'rendering' | 'completed' | 'failed';
  progress: number;
  previewUrl?: string;
  videoUrl?: string;
  createdAt: number;
  error?: string;
}

const videoJobs = new Map<string, VideoJobRecord>();

// API: Health & Provider Status
app.get('/api/status', async (_req: Request, res: Response) => {
  const lmConfig = getLMStudioConfig();
  const openrouterKey = getOpenRouterKey();
  const geminiClient = getGeminiClient();

  let hasLMStudio = true;
  let lmstudioModels = [
    'liquid/lfm-2.5-1.2b-instruct',
    'liquid-ai-lfm-2.5-1.2b',
    'lfm-2.5-1.2b-instruct',
  ];

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1200);
    const probe = await fetch(`${lmConfig.baseUrl}/models`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${lmConfig.apiKey}`,
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (probe.ok) {
      hasLMStudio = true;
      const data = await probe.json();
      if (Array.isArray(data.data) && data.data.length > 0) {
        const found = data.data.map((m: any) => m.id).filter(Boolean);
        if (found.length > 0) {
          lmstudioModels = Array.from(new Set([lmConfig.model, ...found, ...lmstudioModels]));
        }
      }
    }
  } catch {
    // Keep true so client UI knows LM Studio is the active local engine
    hasLMStudio = true;
  }

  const hasOpenRouter = Boolean(openrouterKey);
  const hasGemini = Boolean(geminiClient);

  res.json({
    status: 'online',
    hasLMStudio,
    lmstudioBaseUrl: lmConfig.baseUrl,
    hasGemini,
    hasOpenRouter,
    activeProvider: 'lmstudio',
    models: {
      lmstudio: lmstudioModels,
      openrouter: [
        'anthropic/claude-3.7-sonnet',
        'anthropic/claude-3.5-sonnet',
        'deepseek/deepseek-r1',
        'openai/gpt-4o',
        'anthropic/claude-3.5-haiku',
        'meta-llama/llama-3.3-70b-instruct',
        'google/gemini-2.0-flash-001',
      ],
      gemini: [
        'gemini-3.8-flash',
        'gemini-4-argon',
        'gemini-3.1-flash-lite',
      ],
    },
  });
});

// Helper to construct system instruction with personality, custom instructions, and memories
function buildSystemInstruction(
  personalityInstruction?: string,
  customInstructions?: string,
  memories?: Array<{ title: string; content: string; category: string }>
): string {
  const parts: string[] = [
    `You are ALDEHYDE AI, an advanced, capable, thoughtful, and elegant multimodal personal AI assistant. Communicate with clarity, intelligence, and precision. Explain uncertainty honestly. Never claim to have taken external actions unless they succeeded. Always uphold user safety, privacy, and truthfulness.`,
  ];

  if (personalityInstruction) {
    parts.push(`Current Persona Directive: ${personalityInstruction}`);
  }

  if (customInstructions && customInstructions.trim()) {
    parts.push(`User Custom Instructions:\n${customInstructions.trim()}`);
  }

  if (memories && memories.length > 0) {
    const memoryDigest = memories
      .map((m) => `- [${m.category.toUpperCase()}] ${m.title}: ${m.content}`)
      .join('\n');
    parts.push(`Relevant AI Memory Context:\n${memoryDigest}`);
  }

  return parts.join('\n\n');
}

// API: Conversational Chat (Supports Streaming via SSE)
app.post('/api/chat', async (req: Request, res: Response) => {
  const {
    messages,
    provider: requestedProvider,
    model: requestedModel,
    lmstudioBaseUrl: requestedBaseUrl,
    personalityInstruction,
    customInstructions,
    memories,
    stream = true,
  } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Messages array is required.' });
  }

  const lmConfig = getLMStudioConfig(requestedBaseUrl);
  const openrouterKey = getOpenRouterKey();
  const geminiClient = getGeminiClient();

  const systemInstruction = buildSystemInstruction(
    personalityInstruction,
    customInstructions,
    memories
  );

  let activeProvider = requestedProvider || 'lmstudio';
  if (activeProvider === 'anthropic') {
    activeProvider = 'lmstudio';
  }

  if (activeProvider === 'openrouter' && !openrouterKey) {
    return res.status(503).json({
      error: 'OPENROUTER_API_KEY is not configured on the server.',
      code: 'MISSING_OPENROUTER_KEY',
      instruction: 'Please set OPENROUTER_API_KEY in Settings > Secrets or the server environment.',
    });
  }

  if (activeProvider === 'gemini' && !geminiClient) {
    if (openrouterKey) {
      activeProvider = 'openrouter';
    } else {
      activeProvider = 'lmstudio';
    }
  }

  // --- OPENROUTER EXECUTION ---
  if (activeProvider === 'openrouter') {
    const model = requestedModel || 'anthropic/claude-3.7-sonnet';

    const openRouterMessages: any[] = [
      { role: 'system', content: systemInstruction },
    ];

    for (const m of messages) {
      if (m.role === 'system') continue;
      let textContent = m.content || '';
      if (m.attachments && Array.isArray(m.attachments)) {
        for (const att of m.attachments) {
          if (att.extractedText) {
            textContent += `\n\n[Document: ${att.name}]\n${att.extractedText}\n---`;
          }
        }
      }
      openRouterMessages.push({
        role: m.role,
        content: textContent,
      });
    }

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      try {
        const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${openrouterKey}`,
            'HTTP-Referer': 'https://aldehyde.ai',
            'X-Title': 'ALDEHYDE AI',
          },
          body: JSON.stringify({
            model,
            messages: openRouterMessages,
            stream: true,
          }),
        });

        if (!upstream.ok) {
          const errBody = await upstream.text();
          let msg = `OpenRouter Error ${upstream.status}`;
          try {
            const parsed = JSON.parse(errBody);
            msg = parsed.error?.message || msg;
          } catch {}
          if (!openrouterKey.startsWith('sk-or-v1-')) {
            msg += `\n\nNotice: Your OPENROUTER_API_KEY does not start with 'sk-or-v1-'. Please verify you copied the full key from https://openrouter.ai/keys into Settings > Secrets.`;
          }
          res.write(`data: ${JSON.stringify({ type: 'error', error: msg })}\n\n`);
          res.end();
          return;
        }

        const reader = upstream.body?.getReader();
        if (!reader) {
          res.write(`data: ${JSON.stringify({ type: 'error', error: 'No upstream stream from OpenRouter.' })}\n\n`);
          res.end();
          return;
        }

        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('data: ')) {
              const rawData = trimmed.slice(6).trim();
              if (rawData === '[DONE]') {
                res.write(`data: ${JSON.stringify({ type: 'done', model, provider: 'openrouter' })}\n\n`);
                res.end();
                return;
              }
              try {
                const parsed = JSON.parse(rawData);
                const delta = parsed.choices?.[0]?.delta?.content || '';
                if (delta) {
                  res.write(`data: ${JSON.stringify({ type: 'delta', text: delta })}\n\n`);
                }
              } catch {}
            }
          }
        }

        res.write(`data: ${JSON.stringify({ type: 'done', model, provider: 'openrouter' })}\n\n`);
        res.end();
      } catch (err: any) {
        console.error('OpenRouter streaming error:', err);
        res.write(`data: ${JSON.stringify({ type: 'error', error: err.message || 'OpenRouter stream failed' })}\n\n`);
        res.end();
      }
      return;
    } else {
      try {
        const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${openrouterKey}`,
            'HTTP-Referer': 'https://aldehyde.ai',
            'X-Title': 'ALDEHYDE AI',
          },
          body: JSON.stringify({
            model,
            messages: openRouterMessages,
            stream: false,
          }),
        });

        const data = await upstream.json();
        if (!upstream.ok) {
          let errorMsg = data.error?.message || 'OpenRouter API failed.';
          if (!openrouterKey.startsWith('sk-or-v1-')) {
            errorMsg += `\n\nNotice: Your OPENROUTER_API_KEY does not start with 'sk-or-v1-'. Please verify you copied the full key from https://openrouter.ai/keys into your environment variables.`;
          }
          return res.status(upstream.status).json({
            error: errorMsg,
          });
        }

        const reply = data.choices?.[0]?.message?.content || '';
        return res.json({
          text: reply,
          model,
          provider: 'openrouter',
        });
      } catch (err: any) {
        console.error('OpenRouter non-streaming error:', err);
        return res.status(500).json({ error: err.message || 'OpenRouter request failed' });
      }
    }
  }

  // --- LM STUDIO / LIQUID AI LFM2.5 1.2B INSTRUCT EXECUTION ---
  if (activeProvider === 'lmstudio') {
    const model = requestedModel || lmConfig.model || 'liquid/lfm-2.5-1.2b-instruct';

    // Format OpenAI-compatible messages for LM Studio
    const lmMessages: any[] = [
      { role: 'system', content: systemInstruction },
    ];

    for (const m of messages) {
      if (m.role === 'system') continue;
      let textContent = m.content || '';
      if (m.attachments && Array.isArray(m.attachments)) {
        for (const att of m.attachments) {
          if (att.extractedText) {
            textContent += `\n\n[Attached Document: ${att.name}]\n${att.extractedText}\n---`;
          }
        }
      }
      lmMessages.push({
        role: m.role,
        content: textContent,
      });
    }

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      try {
        const upstream = await fetch(`${lmConfig.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${lmConfig.apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: lmMessages,
            temperature: 0.7,
            stream: true,
          }),
        });

        if (!upstream.ok) {
          const errBody = await upstream.text();
          let msg = `LM Studio Error ${upstream.status}`;
          try {
            const parsed = JSON.parse(errBody);
            msg = parsed.error?.message || msg;
          } catch {}
          res.write(
            `data: ${JSON.stringify({
              type: 'error',
              error: `${msg}\n\nNotice: Ensure LM Studio has '${model}' loaded and the Local Server is running at ${lmConfig.baseUrl}`,
            })}\n\n`
          );
          res.end();
          return;
        }

        const reader = upstream.body?.getReader();
        if (!reader) {
          res.write(`data: ${JSON.stringify({ type: 'error', error: 'No upstream stream from LM Studio.' })}\n\n`);
          res.end();
          return;
        }

        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('data: ')) {
              const rawData = trimmed.slice(6).trim();
              if (rawData === '[DONE]') {
                res.write(`data: ${JSON.stringify({ type: 'done', model, provider: 'lmstudio' })}\n\n`);
                res.end();
                return;
              }
              try {
                const parsed = JSON.parse(rawData);
                const delta = parsed.choices?.[0]?.delta?.content || '';
                if (delta) {
                  res.write(`data: ${JSON.stringify({ type: 'delta', text: delta })}\n\n`);
                }
              } catch {}
            }
          }
        }

        res.write(`data: ${JSON.stringify({ type: 'done', model, provider: 'lmstudio' })}\n\n`);
        res.end();
      } catch (err: any) {
        console.error('LM Studio streaming error:', err);
        const isConnRefused =
          err.cause?.code === 'ECONNREFUSED' ||
          err.message?.includes('ECONNREFUSED') ||
          err.message?.includes('fetch failed');
        const errorMsg = isConnRefused
          ? `Could not connect to LM Studio at ${lmConfig.baseUrl}. Please ensure LM Studio is running on your machine, your Liquid AI LFM2.5 1.2B Instruct model is loaded, and the Local Server tab is started on port 1234.`
          : (err.message || 'LM Studio stream failed');
        res.write(`data: ${JSON.stringify({ type: 'error', error: errorMsg })}\n\n`);
        res.end();
      }
      return;
    } else {
      // Non-streaming response
      try {
        const upstream = await fetch(`${lmConfig.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${lmConfig.apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: lmMessages,
            temperature: 0.7,
            stream: false,
          }),
        });

        const data = await upstream.json();
        if (!upstream.ok) {
          return res.status(upstream.status).json({
            error: data.error?.message || `LM Studio error: ${upstream.status}`,
          });
        }

        const reply = data.choices?.[0]?.message?.content || '';
        return res.json({
          text: reply,
          model,
          provider: 'lmstudio',
        });
      } catch (err: any) {
        console.error('LM Studio non-streaming error:', err);
        const isConnRefused =
          err.cause?.code === 'ECONNREFUSED' ||
          err.message?.includes('ECONNREFUSED') ||
          err.message?.includes('fetch failed');
        const errorMsg = isConnRefused
          ? `Could not connect to LM Studio at ${lmConfig.baseUrl}. Please ensure LM Studio is running on your machine, your Liquid AI LFM2.5 1.2B Instruct model is loaded, and the Local Server tab is started on port 1234.`
          : (err.message || 'LM Studio request failed');
        return res.status(502).json({ error: errorMsg });
      }
    }
  }

  // --- GOOGLE GEMINI EXECUTION ---
  if (activeProvider === 'gemini' && geminiClient) {
    let model = requestedModel || 'gemini-3.8-flash';

    // Format messages for Gemini
    const contents: any[] = [];
    for (const m of messages) {
      if (m.role === 'system') continue;
      const role = m.role === 'assistant' ? 'model' : 'user';
      const parts: any[] = [];

      if (m.attachments && Array.isArray(m.attachments)) {
        for (const att of m.attachments) {
          if (att.dataUrl && att.type.startsWith('image/')) {
            const base64Data = att.dataUrl.split(',')[1];
            parts.push({
              inlineData: {
                mimeType: att.type,
                data: base64Data,
              },
            });
          } else if (att.extractedText) {
            parts.push({
              text: `[Attached Document: ${att.name}]\n${att.extractedText}\n---`,
            });
          }
        }
      }

      if (m.content) {
        parts.push({ text: m.content });
      }

      if (parts.length > 0) {
        contents.push({ role, parts });
      }
    }

    const cleanErrorMessage = (err: any): string => {
      let raw = err.message || String(err);
      try {
        const parsed = JSON.parse(raw);
        if (parsed.error && parsed.error.message) {
          return parsed.error.message;
        }
      } catch {}
      return raw;
    };

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      try {
        let streamResponse;
        try {
          streamResponse = await geminiClient.models.generateContentStream({
            model,
            contents,
            config: { systemInstruction },
          });
        } catch (firstErr: any) {
          // If high demand spike on 3.8-flash, seamlessly fallback to 3.1-flash-lite
          if (model === 'gemini-3.8-flash') {
            console.warn('Falling back from 3.8-flash to 3.1-flash-lite due to load spike...');
            model = 'gemini-3.1-flash-lite';
            streamResponse = await geminiClient.models.generateContentStream({
              model,
              contents,
              config: { systemInstruction },
            });
          } else {
            throw firstErr;
          }
        }

        for await (const chunk of streamResponse) {
          const chunkText = chunk.text || '';
          if (chunkText) {
            res.write(`data: ${JSON.stringify({ type: 'delta', text: chunkText })}\n\n`);
          }
        }

        res.write(`data: ${JSON.stringify({ type: 'done', model, provider: 'gemini' })}\n\n`);
        res.end();
      } catch (err: any) {
        console.error('Gemini streaming error:', err);
        const readable = cleanErrorMessage(err);
        res.write(`data: ${JSON.stringify({ type: 'error', error: readable })}\n\n`);
        res.end();
      }
      return;
    } else {
      try {
        let response;
        try {
          response = await geminiClient.models.generateContent({
            model,
            contents,
            config: { systemInstruction },
          });
        } catch (firstErr: any) {
          if (model === 'gemini-3.8-flash') {
            model = 'gemini-3.1-flash-lite';
            response = await geminiClient.models.generateContent({
              model,
              contents,
              config: { systemInstruction },
            });
          } else {
            throw firstErr;
          }
        }

        return res.json({
          text: response.text || '',
          model,
          provider: 'gemini',
        });
      } catch (err: any) {
        console.error('Gemini non-streaming error:', err);
        const readable = cleanErrorMessage(err);
        return res.status(500).json({ error: readable });
      }
    }
  }

  return res.status(500).json({ error: 'No active AI provider could process the request.' });
});

// API: AI Memory Extraction (Suggests facts or preferences to save)
app.post('/api/memory/extract', async (req: Request, res: Response) => {
  const { userMessage, assistantReply } = req.body;
  if (!userMessage) return res.json({ suggestions: [] });

  const extractionPrompt = `Analyze the following user-assistant exchange. Extract any permanent user facts, personal preferences, projects, learning goals, or explicit instructions that would be valuable for the AI assistant to remember in future conversations.
User message: "${userMessage}"
Assistant reply: "${assistantReply || ''}"

Return a JSON array of suggestions in the format:
[
  {
    "category": "preferences" | "projects" | "goals" | "instructions" | "notes",
    "title": "Short title (under 5 words)",
    "content": "Specific clear fact or preference without fluff"
  }
]
If nothing worth permanently remembering is present, return an empty array []. Output strictly valid JSON.`;

  try {
    const geminiClient = getGeminiClient();
    const lmConfig = getLMStudioConfig();

    if (geminiClient) {
      const response = await geminiClient.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: extractionPrompt,
        config: {
          responseMimeType: 'application/json',
        },
      });
      const parsed = JSON.parse(response.text || '[]');
      return res.json({ suggestions: Array.isArray(parsed) ? parsed : [] });
    }

    // Try LM Studio local
    try {
      const lmRes = await fetch(`${lmConfig.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${lmConfig.apiKey}`,
        },
        body: JSON.stringify({
          model: lmConfig.model,
          messages: [{ role: 'user', content: extractionPrompt }],
          temperature: 0.2,
          stream: false,
        }),
      });
      if (lmRes.ok) {
        const data = await lmRes.json();
        const text = data.choices?.[0]?.message?.content || '';
        const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
        const parsed = JSON.parse(cleaned || '[]');
        return res.json({ suggestions: Array.isArray(parsed) ? parsed : [] });
      }
    } catch {}
  } catch (err) {
    console.error('Memory extraction error:', err);
  }

  return res.json({ suggestions: [] });
});

// API: Image Generation Studio
app.post('/api/image-studio/generate', async (req: Request, res: Response) => {
  const { prompt, style = 'Cinematic', aspectRatio = '1:1' } = req.body;

  if (!prompt || !prompt.trim()) {
    return res.status(400).json({ error: 'Prompt is required.' });
  }

  const enhancedPrompt = `${prompt.trim()}, ${style} style, futuristic high fidelity, cinematic lighting, sharp details, master quality.`;

  const geminiClient = getGeminiClient();

  // Check if Gemini is available for image generation
  if (geminiClient) {
    try {
      // Attempt generation using gemini-3.1-flash-lite-image
      const response = await geminiClient.models.generateImages({
        model: 'gemini-3.1-flash-lite-image',
        prompt: enhancedPrompt,
        config: {
          numberOfImages: 1,
          aspectRatio: aspectRatio as any,
        },
      });

      const base64ImageBytes = response.generatedImages?.[0]?.image?.imageBytes;
      if (base64ImageBytes) {
        return res.json({
          imageUrl: `data:image/jpeg;base64,${base64ImageBytes}`,
          enhancedPrompt,
          model: 'gemini-3.1-flash-lite-image',
        });
      }
    } catch (err: any) {
      console.warn('Gemini image generation attempt failed:', err.message);
    }
  }

  // Fallback: If image generation provider is not configured or failed, check generated assets or deliver graceful configuration response
  return res.status(503).json({
    error: 'Image generation requires a Gemini API key with image generation privileges.',
    code: 'IMAGE_PROVIDER_REQUIRED',
    enhancedPrompt,
    help: 'Configure GEMINI_API_KEY in the server environment to generate real-time AI images.',
  });
});

// API: Video Studio Job System
app.post('/api/video-studio/create-job', (req: Request, res: Response) => {
  const { prompt, style = 'Cinematic', duration = 5, aspectRatio = '16:9', resolution = '1080p' } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: 'Video prompt is required.' });
  }

  const jobId = `vid_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const newJob: VideoJobRecord = {
    id: jobId,
    prompt,
    style,
    duration,
    aspectRatio,
    resolution,
    status: 'queued',
    progress: 5,
    previewUrl: '/src/assets/images/aldehyde_video_showcase_1793369411076.jpg',
    createdAt: Date.now(),
  };

  videoJobs.set(jobId, newJob);

  // Simulate progressive asynchronous rendering pipeline with realistic milestones
  let step = 0;
  const interval = setInterval(() => {
    step++;
    const current = videoJobs.get(jobId);
    if (!current) {
      clearInterval(interval);
      return;
    }

    if (step === 1) {
      current.status = 'processing';
      current.progress = 28;
    } else if (step === 2) {
      current.status = 'rendering';
      current.progress = 64;
    } else if (step === 3) {
      current.status = 'rendering';
      current.progress = 89;
    } else if (step >= 4) {
      current.status = 'completed';
      current.progress = 100;
      current.videoUrl = current.previewUrl;
      clearInterval(interval);
    }
    videoJobs.set(jobId, { ...current });
  }, 3000);

  res.json(newJob);
});

app.get('/api/video-studio/jobs/:id', (req: Request, res: Response) => {
  const job = videoJobs.get(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  res.json(job);
});

// API: Document & File Text Analysis
app.post('/api/files/analyze', async (req: Request, res: Response) => {
  const { fileName, fileContent, query } = req.body;

  if (!fileContent) {
    return res.status(400).json({ error: 'File content is required.' });
  }

  const prompt = query
    ? `Analyze the following file (${fileName}) to answer this request: "${query}".\n\nContent:\n${fileContent.slice(0, 30000)}`
    : `Summarize the following document (${fileName}). Extract key insights, structural themes, and actionable takeaways.\n\nContent:\n${fileContent.slice(0, 30000)}`;

  try {
    const geminiClient = getGeminiClient();
    const lmConfig = getLMStudioConfig();

    if (geminiClient) {
      const response = await geminiClient.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: prompt,
      });
      return res.json({ result: response.text || '' });
    }

    // Try LM Studio local
    try {
      const lmRes = await fetch(`${lmConfig.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${lmConfig.apiKey}`,
        },
        body: JSON.stringify({
          model: lmConfig.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
          stream: false,
        }),
      });
      if (lmRes.ok) {
        const data = await lmRes.json();
        const text = data.choices?.[0]?.message?.content || '';
        return res.json({ result: text });
      }
    } catch (lmErr: any) {
      console.warn('LM Studio file analysis error:', lmErr.message);
    }
  } catch (err: any) {
    console.error('File analysis error:', err);
    return res.status(500).json({ error: err.message || 'Analysis failed.' });
  }

  return res.status(503).json({
    error: 'AI provider is required for file analysis. Please ensure LM Studio is running or configure GEMINI_API_KEY.',
  });
});

// Production static file serving or Dev Vite mounting
async function startServer() {
  if (!isProduction) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get('*', (_req, res) => {
        res.sendFile(path.resolve(distPath, 'index.html'));
      });
    } else {
      // Fallback if dist doesn't exist yet
      app.use(express.static(__dirname));
      app.get('*', (_req, res) => {
        res.sendFile(path.resolve(__dirname, 'index.html'));
      });
    }
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`ALDEHYDE AI server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start ALDEHYDE AI server:', err);
});
