/**
 * CommentatorAnalyzer — Generates viral commentary scripts for videos using Gemini Multimodal Vision API.
 *
 * Workflow:
 * 1. Analyzes video visual content (frames/actions).
 * 2. Crafts an aggressive 1–3s hook targeting US/UK audience.
 * 3. Builds a timed narrative script strictly fitted to video duration.
 */

import { createLogger } from '../utils/logger';
import fs from 'fs';
import https from 'https';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

const log = createLogger('CommentatorAnalyzer');

export interface CommentatorScriptSegment {
  text: string;
  startMs: number;
  endMs: number;
}

export interface GeneratedCommentaryScript {
  hookText: string;
  scriptText: string;
  middleInterjectionText?: string;
  interruptionTimestampSec?: number;
  takeawayText?: string;
  targetWpm: number;
  estimatedDurationMs: number;
  segments: CommentatorScriptSegment[];
}

export interface CommentatorAnalyzerOptions {
  videoPath: string;
  durationMs: number;
  targetAudience?: 'US' | 'UK' | 'ID';
  serviceAccountPath?: string;
}

export class CommentatorAnalyzer {
  /**
   * Main entry point to generate a commentary script from video visual analysis.
   */
  async generateScript(opts: CommentatorAnalyzerOptions): Promise<GeneratedCommentaryScript> {
    const { videoPath, durationMs, targetAudience = 'US', serviceAccountPath } = opts;

    const durationSec = Math.max(5, Math.round(durationMs / 1000));
    // Conversational pacing ~115 words/min => ~1.9 words per second
    // Leaving 3s safety buffer at the end so the narration never gets truncated.
    const maxWords = Math.floor(Math.max(5, durationSec - 3) * 1.9);

    log.info({ videoPath, durationSec, maxWords, targetAudience }, 'Starting visual video analysis for commentary');

    const prompt = this._buildPrompt(durationSec, maxWords, targetAudience);

    if (!serviceAccountPath || !fs.existsSync(serviceAccountPath)) {
      throw new Error('Google Cloud Service Account JSON Key (Vertex AI) is required for Video Commentator AI. Please configure it in Settings.');
    }

    const rawResponse = await this._callVertexGemini(videoPath, prompt, serviceAccountPath);

    return this._parseScriptResponse(rawResponse, durationMs);
  }

  private _buildPrompt(durationSec: number, maxWords: number, targetAudience: 'US' | 'UK' | 'ID'): string {
    // Randomize tone per generation to prevent repetitive/formulaic outputs (anti-reused-content)
    const usUkTones = [
      'film breakdown & scene deconstructor — analyze comedic timing, writing techniques, and director choices with sharp wit',
      'sharp trivia expert — uncover insider trivia, voice acting easter eggs, and pop-culture context',
      'deadpan comedy critic — react with hilarious deadpan analysis of the character absurdities',
      'investigative commentator — break down the comedic setup and punchline anatomy like a pro',
    ];
    const idTones = [
      'bedah adegan & komedi — kupas teknik timing komedi dan kejeniusan penulis naskahnya secara seru',
      'trivia & fakta unik — ungkap trivia tersembunyi dan konteks adegan yang bikin videonya 10x lebih menarik',
      'analis santai — kupas kenapa adegan ini viral dan bikin ngakak dengan gaya bahasa gaul dan berbobot',
    ];

    const tones = targetAudience === 'ID' ? idTones : usUkTones;
    const selectedTone = tones[Math.floor(Math.random() * tones.length)];

    const audienceDesc = targetAudience === 'UK'
      ? 'British English (UK) Shorts/Reels audience — witty, sharp, dry humor, film/comedy breakdown'
      : targetAudience === 'ID'
        ? 'Indonesian Gen-Z/Millennial viral Shorts audience — bahasa gaul, cerdas, bedah komedi/adegan'
        : 'American English (US) YouTube Shorts / TikTok audience — high energy, authoritative scene breakdown & trivia';

    return `You are an elite viral video essayist and scene deconstructor (like Nerdwriter, Film Theorist, or CineFix) creating DEEP, CRITICAL, and TRANSFORMATIVE COMMENTARY (fully compliant with YouTube Fair Use / YPP monetization policies) for ${audienceDesc}.

YOUR VOICE/TONE FOR THIS VIDEO: ${selectedTone}.

═══════════════════════════════════════
CRITICAL RETENTION & YPP RULES (STRICT):
═══════════════════════════════════════
❌ NEVER describe obvious visual actions ("Peter walks in", "He punches the guy", "She is on the phone"). The viewer HAS EYES—they can see what is happening! Describing visible actions is boring and causes instant swipes!
❌ NEVER praise the joke with lazy clichés (DO NOT SAY: "the comedic timing is genius", "masterfully uses comedic juxtaposition", "this scene portrays", "brilliant writing choice").
❌ NEVER output generic life advice, moral lectures, or filler (e.g. DO NOT say "some days are just like that", "life is unpredictable").

✅ WHAT YOU MUST PROVIDE (DEEP DECONSTRUCTION & THE "INVISIBLE" CONTEXT):
1. **UNCOVER WHAT IS NOT OBVIOUS**: Reveal broadcast controversies, real-world parodies, voice acting lore, animation subversions, or hidden Easter eggs the casual viewer would NEVER know!
2. **CRITICAL CHARACTER PSYCHOLOGY**: Deconstruct the character's unhinged behavior, lack of moral compass, or absurd escalation like a sharp film critic.
3. **PUNCHY, HIGH-VELOCITY SCRIPT**: Dense, fast-moving sentences with zero filler.

═══════════════════════════════════════
HARD CONSTRAINTS:
═══════════════════════════════════════
1. VIDEO DURATION: ${durationSec} seconds.
2. WORD LIMIT: MAXIMUM ${maxWords} words for on-screen commentary.
3. SHORT SENTENCES: Max 12 words per sentence. Punchy, sharp delivery.
4. NATURAL SPEECH: Use contractions ("he's", "that's", "gonna"), opinionated first-person words ("I", "look", "honestly"), no stiff essay phrasing.

═══════════════════════════════════════
1. HOOK (hookText) — EXACTLY 8-12 WORDS (2.5-3.5 SECONDS):
═══════════════════════════════════════
Must instantly hook curiosity with controversy, mystery, or an unhinged fact:
✓ "Fox actually received hundreds of complaints for this 10-second joke."
✓ "Peter Griffin literally committed three felonies in this one store visit."
✓ "Almost nobody noticed the insane hidden detail in this scene."
✓ "She really pulled off the darkest revenge on a live phone call."
✓ (ID): "Adegan 10 detik ini beneran dapet ratusan komplain pas pertama tayang."

═══════════════════════════════════════
2. FULL SCENE BREAKDOWN (scriptText) — FOR FULL COMMENTARY MODE:
═══════════════════════════════════════
This is the complete narrative script used for Full Commentary mode. It MUST NOT narrate visible movements. Instead, it must break down the scene across 4 critical layers:
1. [Hook Context]: Open with the controversy, mystery, or hidden premise.
2. [The Invisible Fact]: Explain the real-world parody, censorship struggle, or writer's backstory behind this joke.
3. [Psychological Deconstruction]: Break down why the character's reaction is completely unhinged or subverts standard sitcom rules.
4. [Critical Verdict]: Deliver a final witty, sharp punchline on the impact of this scene.

EXAMPLES OF ELITE FULL COMMENTARY:
✓ (US/UK): "Fox actually received hundreds of complaints for this 10-second joke. What most people miss is that the writers were directly parodying a real 1998 broadcast scandal. Look at how Peter doesn't even flinch—the animation deliberately removes all micro-expressions to make his psychopathy feel completely unhinged. The original script had an even darker punchline that network censors completely banned from TV."
✓ (ID): "Adegan 10 detik ini beneran dapet ratusan komplain pas pertama tayang di TV. Yang jarang orang tahu, lelucon ini sebenarnya nyindir kejadian nyata tahun 98. Penulis naskahnya sengaja bikin ekspresi karakternya datar abis biar kelakuan gilanya kerasa makin absurd. Naskah aslinya bahkan jauh lebih gelap sampai harus dipotong sama sensor TV."

═══════════════════════════════════════
3. MID-SCENE INTERJECTION (middleInterjectionText) — 5-8 WORDS (1.5-2.0 SECONDS):
═══════════════════════════════════════
A sharp pattern-interrupt of sheer disbelief right at the punchline timestamp:
✓ "Wait, she said that with zero hesitation?!"
✓ "Hold on, did he actually just do that?!"
✓ "Bro didn't even hesitate for a second!"
✓ (ID): "Bentar, dia beneran ngomong gitu tanpa mikir?!"

═══════════════════════════════════════
4. TAKEAWAY / OUTRO TRIVIA (takeawayText) — 1-2 SHORT SENTENCES (10-15 WORDS, 3.5-4.5 SECONDS MAX):
═══════════════════════════════════════
A quick, satisfying behind-the-scenes trivia punchline to close the video:
✓ "The writers originally cut this scene because it was deemed too dark for broadcast."
✓ "This scene actually set the record for the quickest escalation in the entire series."
✓ (ID): "Fakta gilanya, lelucon gelap ini terinspirasi dari kejadian nyata salah satu penulisnya."

Return ONLY a JSON object (no markdown, no backticks outside JSON):
{
  "hookText": "8-12 words controversy/trivia hook",
  "scriptText": "Full deep critical scene breakdown (not visual narration)",
  "middleInterjectionText": "5-8 words sharp disbelief reaction",
  "interruptionTimestampSec": 28,
  "takeawayText": "1-2 short sentences (10-15 words) behind-the-scenes trivia punchline",
  "segments": [
    {
      "text": "Segment sentence",
      "startMs": 0,
      "endMs": 3000
    }
  ]
}`;
  }

  private _runProcess(command: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      proc.stderr?.on('data', (c: Buffer) => { stderr += c.toString(); });
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`${command} failed with code ${code}: ${stderr}`));
      });
      proc.on('error', reject);
    });
  }

  private async _extractKeyframesAsParts(videoPath: string, prompt: string): Promise<any[]> {
    const tmpDir = path.join(os.tmpdir(), `gemini_frames_${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
      const outPattern = path.join(tmpDir, 'frame_%03d.jpg');
      await this._runProcess('ffmpeg', [
        '-y',
        '-i', videoPath,
        '-vf', 'fps=1/2,scale=480:-1',
        '-q:v', '3',
        outPattern,
      ]);

      const files = fs.readdirSync(tmpDir)
        .filter((f) => f.endsWith('.jpg'))
        .sort();

      if (files.length === 0) throw new Error('No keyframe images were extracted by FFmpeg');

      const parts: any[] = [];
      const maxFrames = Math.min(files.length, 15);
      const step = files.length > 15 ? Math.ceil(files.length / 15) : 1;

      let frameCount = 0;
      for (let i = 0; i < files.length && frameCount < maxFrames; i += step) {
        const file = files[i];
        const framePath = path.join(tmpDir, file);
        const timestampSec = i * 2;
        const imgBuf = fs.readFileSync(framePath);

        parts.push({ text: `[Video Frame at ${timestampSec} seconds]:` });
        parts.push({
          inlineData: {
            mimeType: 'image/jpeg',
            data: imgBuf.toString('base64'),
          },
        });
        frameCount++;
      }

      parts.push({ text: prompt });
      return parts;
    } catch (err) {
      log.warn({ err }, 'Failed to extract keyframe images via FFmpeg, falling back to direct video read');
      const videoBuffer = fs.readFileSync(videoPath);
      const mimeType = videoPath.endsWith('.mov') ? 'video/quicktime' : 'video/mp4';
      return [
        { inlineData: { mimeType, data: videoBuffer.toString('base64') } },
        { text: prompt },
      ];
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch { }
    }
  }


  private async _callVertexGemini(videoPath: string, prompt: string, serviceAccountPath: string): Promise<string> {
    log.info({ serviceAccountPath }, 'Using Vertex AI Multimodal API (Keyframe Optimized)');
    const { accessToken, projectId } = await this._getVertexAccessToken(serviceAccountPath);
    const parts = await this._extractKeyframesAsParts(videoPath, prompt);

    const models = [
      'gemini-3.7-flash',
      'gemini-3.6-flash',
      'gemini-3.0-flash',
      'gemini-2.5-flash',
      'gemini-2.0-flash',
      'gemini-2.0-flash-exp',
      'gemini-1.5-flash-002',
      'gemini-1.5-flash-001',
      'gemini-1.5-flash',
    ];
    let lastError: Error | null = null;

    // IMPORTANT: assemble the endpoint from parts. Do NOT inline the full URL as a
    // single literal string — doing so previously caused stray "{{ }}" braces to be
    // injected into the source, producing `TypeError: Invalid URL` at runtime.
    const scheme = 'https';
    const apiHost = 'us-central1-aiplatform.googleapis.com';
    const location = 'us-central1';
    const apiBase = `${scheme}://${apiHost}/v1/projects/${projectId}/locations/${location}/publishers/google/models`;

    for (const model of models) {
      const url = `${apiBase}/${model}:generateContent`;

      const payload = {
        contents: [
          {
            role: 'user',
            parts,
          },
        ],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.9,
        },
      };

      try {
        log.info({ model, projectId }, 'Trying Vertex AI model candidate');
        return await this._httpPost(url, payload, { Authorization: `Bearer ${accessToken}` });
      } catch (err: any) {
        lastError = err;
        if (err?.message?.includes('404') || err?.message?.includes('NOT_FOUND') || err?.message?.includes('was not found')) {
          log.warn({ model }, 'Model 404 on Vertex AI, trying next model candidate');
          continue;
        }
        throw err;
      }
    }
    throw lastError || new Error('All Vertex AI Gemini model candidates failed');
  }

  private _httpPost(urlStr: string, payload: any, extraHeaders: Record<string, string> = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      const url = new URL(urlStr);
      const data = JSON.stringify(payload);

      const req = https.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          ...extraHeaders,
        },
        timeout: 120_000,
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const parsed = JSON.parse(body);
              const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
              resolve(text);
            } catch (err) {
              reject(new Error(`Failed to parse Gemini response: ${err}`));
            }
          } else {
            reject(new Error(`Gemini HTTP ${res.statusCode}: ${body}`));
          }
        });
      });

      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  private async _getVertexAccessToken(saPath: string): Promise<{ accessToken: string; projectId: string }> {
    const raw = fs.readFileSync(saPath, 'utf-8');
    const sa = JSON.parse(raw);
    const { GoogleAuth } = await import('google-auth-library');
    const auth = new GoogleAuth({
      keyFile: saPath,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    const client = await auth.getClient();
    const tokenResponse = await client.getAccessToken();
    return {
      accessToken: tokenResponse.token ?? '',
      projectId: sa.project_id ?? '',
    };
  }

  private _parseScriptResponse(raw: string, durationMs: number): GeneratedCommentaryScript {
    try {
      let cleaned = raw.trim();
      const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (fenceMatch) cleaned = fenceMatch[1].trim();

      const parsed = JSON.parse(cleaned);
      const hookText = parsed.hookText || 'Okay, you need to see this part.';
      const scriptText = parsed.scriptText || parsed.segments?.map((s: any) => s.text).join(' ') || hookText;
      const middleInterjectionText = parsed.middleInterjectionText?.trim() || '';
      const takeawayText = parsed.takeawayText || "The brilliance here comes down to the comedic subversion of expectations. The show sets up a completely serious scenario, then hits you with deadpan anti-humor. How do you feel about this style of comedy writing? Let's discuss below.";

      const durationSec = Math.max(5, Math.round(durationMs / 1000));
      let interruptionTimestampSec: number | undefined = undefined;
      if (typeof parsed.interruptionTimestampSec === 'number' && parsed.interruptionTimestampSec > 3 && parsed.interruptionTimestampSec < durationSec - 2) {
        interruptionTimestampSec = Math.round(parsed.interruptionTimestampSec);
      } else if (durationSec >= 15) {
        interruptionTimestampSec = Math.round(durationSec * 0.60);
      }

      let segments: CommentatorScriptSegment[] = parsed.segments || [];
      if (segments.length === 0) {
        segments = [{
          text: scriptText,
          startMs: 0,
          endMs: durationMs,
        }];
      }

      return {
        hookText,
        scriptText,
        middleInterjectionText,
        interruptionTimestampSec,
        takeawayText,
        targetWpm: 155,
        estimatedDurationMs: durationMs,
        segments,
      };
    } catch (err) {
      log.warn({ err, raw }, 'Failed to parse JSON script from Gemini response, using raw text fallback');
      return {
        hookText: 'Okay, watch this.',
        scriptText: raw,
        targetWpm: 155,
        estimatedDurationMs: durationMs,
        segments: [{ text: raw, startMs: 0, endMs: durationMs }],
      };
    }
  }
}
