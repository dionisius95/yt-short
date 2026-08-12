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
      'deadpan disbelief — react like you genuinely cannot believe what you just saw',
      'hype commentator — explosive energy like a sports commentator witnessing something legendary',
      'storyteller — narrate like you are telling your best friend an insane story you just witnessed',
      'dry wit — understated British-style humor, say less but make every word land',
      'investigator — break down what happened like a detective uncovering clues in real-time',
      'empathetic observer — connect emotionally with what the people in the video are feeling',
      'shocked insider — react like someone who knows the context and is stunned by the outcome',
      'philosophical narrator — observe the deeper meaning behind what is unfolding',
    ];
    const idTones = [
      'storyteller santai — ceritakan seperti ngobrol sama temen yang excited',
      'kaget abis — react seolah benar-benar tidak percaya apa yang barusan terjadi',
      'komentator seru — energi tinggi seperti komentator bola yang lihat gol spektakuler',
      'bijak santai — sampaikan pelajaran hidup tapi dengan cara yang relatable dan tidak menggurui',
    ];

    const tones = targetAudience === 'ID' ? idTones : usUkTones;
    const selectedTone = tones[Math.floor(Math.random() * tones.length)];

    const audienceDesc = targetAudience === 'UK'
      ? 'British English (UK) Shorts/Reels audience — witty, sharp, dry humor, relatable British expressions'
      : targetAudience === 'ID'
        ? 'Indonesian Gen-Z/Millennial viral Shorts audience — bahasa gaul, relatable, engaging'
        : 'American English (US) YouTube Shorts / TikTok audience — high energy, authentic, punchy';

    return `You are a top-tier viral YouTube Shorts / Reels creator producing TRANSFORMATIVE, HIGH-VALUE commentary for ${audienceDesc}.

YOUR VOICE/TONE FOR THIS VIDEO: ${selectedTone}.

Analyze the video carefully, then write a commentary script that feels like a REAL knowledgeable human creator reacting or explaining — NOT a lazy AI reading what's on screen.

═══════════════════════════════════════
CRITICAL RULE — TRANSFORMATIVE ADDED VALUE (NEVER NARRATE THE OBVIOUS):
═══════════════════════════════════════
❌ NEVER just describe what the viewer can ALREADY SEE with their own eyes (e.g. DO NOT say "He walks into the room", "The man is laughing", "Look at the dog running"). Viewers HATE generic narration of obvious actions and will comment "AI adds literally nothing to the video".
❌ DO NOT state obvious physical movements or recite dialogue.

✅ WHAT YOU MUST PROVIDE INSTEAD (PICK 1-2 STYLES FOR THIS VIDEO):
1. **EXPLAIN THE CONTEXT / JOKE / HIDDEN DETAILS**: Point out a subtle detail 95% of people missed in the background, or explain the pop-culture reference/joke.
2. **WITTY ROAST & ABSURDITY**: Comment on the sheer absurdity, bad decision making, or priceless facial expressions with sharp humor.
3. **UNSETTLING / FASCINATING FACTS & BACKSTORY**: Give a quick backstory, real-world comparison, or insider trivia that makes the clip 10x more interesting.
4. **RELATABLE REACTION & COMMENTARY**: Speak like a knowledgeable friend breaking down an insane moment ("Wait, if you look closely...", "Bro really thought...", "The worst part about this is...").

═══════════════════════════════════════
HARD CONSTRAINTS:
═══════════════════════════════════════
1. VIDEO DURATION: ${durationSec} seconds.
2. WORD LIMIT: MAXIMUM ${maxWords} words for the on-screen commentary (hookText + scriptText). The closing outro (takeawayText) is SEPARATE and is NOT counted in this limit — give it room to breathe.
3. FINISH EARLY: Commentary MUST end by second ${durationSec - 3}. Leave 3s clean gap at the end.
4. SHORT SENTENCES: Max 12 words per sentence. Punchy fragments are encouraged.

═══════════════════════════════════════
WRITE LIKE A REAL HUMAN — NOT AI (MANDATORY):
═══════════════════════════════════════
The #1 goal is that this NEVER sounds AI-generated. Write how people actually TALK, not how AI writes.
- Read every line in your head. If it sounds like an essay or a documentary narrator, REWRITE it.
- ALWAYS use contractions: "he's", "that's", "gonna", "didn't", "you're", "there's". Never stiff full forms.
- Speak in FIRST PERSON with a real opinion and reaction words: "I", "honestly", "look", "okay so", "not gonna lie", "wait".
- Vary sentence length ON PURPOSE: slam a 2-word punch next to a longer line. One casual sentence fragment is good — it feels spontaneous and human.
- It's okay to be slightly imperfect, casual, and opinionated. Real reactions are not grammatically perfect.
- NEVER use these AI-tell words/phrases: "delve", "moreover", "furthermore", "in conclusion", "ultimately", "testament", "vibrant", "bustling", "whimsical", "navigate the complexities", "little did they know", "in a world where", "one thing is certain".
- NO rigid 1-2-3 list phrasing and NO perfectly parallel sentences back-to-back — that instantly reads as AI.
- Avoid over-punctuation. Write it the way you'd actually say it out loud to a friend.

═══════════════════════════════════════
HOOK (hookText) — FIRST 1-3 SECONDS:
═══════════════════════════════════════
Must stop the scroll immediately by introducing an intriguing hook, hidden detail, or hilarious angle.

BANNED HOOK PHRASES:
× "Stop scrolling" / "Don't scroll" / "Hey guys" / "Watch this"
× "99% of people missed..." / "You won't believe..." / "Wait for it..."
× Generic statements that apply to any video

GREAT HOOK ENERGIES:
✓ "The one detail everyone missed in this clip..."
✓ "Bro really thought he was going to get away with this."
✓ "There is a reason this video went viral instantly."
✓ "Pay attention to what happens in the background right here."

═══════════════════════════════════════
FULL SCRIPT (scriptText):
═══════════════════════════════════════
- Deliver punchy, transformative commentary based on the rules above.
- Sound like a REAL human creator with personality, wit, and high energy.
- NO filler words, NO visual redundancy. Every word must add entertainment or educational value.

═══════════════════════════════════════
TAKEAWAY / OUTRO (takeawayText) — THE CLOSING PAYOFF (~9-14 SECONDS, DON'T RUSH IT):
═══════════════════════════════════════
This is the part that makes people feel something and hit the comments. A single one-liner is TOO FAST — the viewer never actually lands the point before the video ends. Give it real room.

Write 3-5 full, flowing sentences (roughly 30-55 words) in this shape:
1. LAND THE REAL TAKEAWAY clearly — the "so what" of the whole clip. Make the viewer go "ohh, THAT'S the point." Don't be vague; say what it actually means.
2. ADD ONE MORE BEAT — a sharp observation, a relatable twist, or a tiny bit of context that makes the point stick and feel earned.
3. END WITH A NATURAL QUESTION that genuinely pulls the audience in and asks for THEIR opinion — like you actually want to hear what they think. It must feel like something you'd really say to a friend, NOT a forced call-to-action.

The closing question MUST match the audience's language (write it in casual Indonesian for an ID audience, natural English for US/UK).

GREAT CLOSING ENERGIES (notice they LAND the point first, THEN invite opinions naturally):
✓ "...and honestly, that's the part nobody talks about. We all like to think we'd stay calm in that moment — but would we really? I'm genuinely curious, would YOU have done the same thing? Tell me in the comments, I need to know I'm not the only one."
✓ "...so yeah — tiny choice, massive consequences. Kinda makes you wonder how often this happens and we just don't notice. What would you have done in his shoes? Drop your take below, let's argue about it."
✓ "...jadi intinya, jangan pernah remehin orang yang udah nggak punya apa-apa buat dijaga. Tapi mungkin gue yang salah baca situasinya. Menurut lo gimana? Komen dong, gue pengin tau kalian di tim yang mana."

BANNED CLOSING PHRASES (too robotic / screams AI or spam): "comment below", "like and subscribe", "let us know in the comments", "don't forget to", "thanks for watching", "smash that like button".

Return ONLY a JSON object (no markdown, no text outside JSON):
{
  "hookText": "1-3 second hook — intriguing & specific",
  "scriptText": "Full transformative voiceover script",
  "takeawayText": "Longer ~9-14s closing outro (3-5 sentences): first land the real takeaway/message clearly, add one extra beat, then END with a natural question that asks the audience for their opinion in their own language — never robotic",
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

    const models = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash-002', 'gemini-1.5-flash-001', 'gemini-1.5-flash'];
    let lastError: Error | null = null;

    for (const model of models) {
      const url = `{{https://us-central1-aiplatform.googleapis.com/v1/projects/${projectId}}}/locations/us-central1/publishers/google/models/${model}:generateContent`;

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
      const takeawayText = parsed.takeawayText || "Yeah... I still can't fully wrap my head around this one, honestly. The more you think about it, the crazier it gets. So I gotta ask — what would YOU have done in that exact moment? Drop it in the comments, I really wanna know where you stand.";

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
