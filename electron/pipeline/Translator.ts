/**
 * Translator — translates transcript words using DeepL (preferred) or Ollama (fallback).
 *
 * DeepL: high-quality neural translation, free tier 500K chars/month.
 * Ollama: local fallback, lower quality but no API key needed.
 */

import { createLogger } from '../utils/logger';
import { ensureOllamaRunning } from '../utils/ollamaHealth';
import type { TranscriptWord } from '../../shared/types';

const log = createLogger('Translator');

const BATCH_SIZE_DEEPL  = 100;  // words per DeepL request (larger = fewer requests)
const BATCH_SIZE_OLLAMA = 60;   // words per Ollama request

// DeepL language codes (differ slightly from ISO)
const DEEPL_LANG_MAP: Record<string, string> = {
  id: 'ID',   // Indonesian
  en: 'EN-US',
  es: 'ES',
  fr: 'FR',
  de: 'DE',
  ja: 'JA',
  ko: 'KO',
  zh: 'ZH',
  pt: 'PT-BR',
  ar: 'AR',
  it: 'IT',
  nl: 'NL',
  pl: 'PL',
  ru: 'RU',
  tr: 'TR',
  ms: 'MS',   // Malay (DeepL supports since 2024)
};

const LANG_NAMES: Record<string, string> = {
  id: 'Indonesian (Bahasa Indonesia)',
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese (Simplified)',
  pt: 'Portuguese',
  ms: 'Malay',
};

function getLangName(code: string): string {
  return LANG_NAMES[code.toLowerCase()] ?? code;
}

export class Translator {
  /**
   * Translate transcript words to target language.
   * Uses Google Translate (primary), falls back to DeepL, then Ollama.
   */
  async translate(
    words: TranscriptWord[],
    targetLang: string,
    ollamaModel: string,
    deeplApiKey?: string,
    onProgress?: (pct: number) => void,
  ): Promise<TranscriptWord[]> {
    if (!words.length) return words;

    log.info({ wordCount: words.length, targetLang }, 'Translating with Google Translate');
    try {
      const result = await this._translateGoogle(words, targetLang, onProgress);
      log.info({ wordCount: result.length, targetLang }, 'Google Translate complete');
      return result;
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Google Translate failed, falling back to DeepL/Ollama');
    }

    if (deeplApiKey && deeplApiKey.trim()) {
      log.info({ wordCount: words.length, targetLang }, 'Translating with DeepL');
      try {
        const result = await this._translateDeepL(words, targetLang, deeplApiKey, onProgress);
        log.info({ wordCount: result.length, targetLang }, 'DeepL translation complete');
        return result;
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : String(err) }, 'DeepL failed, falling back to Ollama');
      }
    } else {
      log.info({ targetLang }, 'No DeepL API key — using Ollama');
    }

    log.info({ wordCount: words.length, targetLang }, 'Translating with Ollama');
    await ensureOllamaRunning();
    return await this._translateOllama(words, targetLang, ollamaModel, onProgress);
  }

  private async _translateGoogle(
    words: TranscriptWord[],
    targetLang: string,
    onProgress?: (pct: number) => void,
  ): Promise<TranscriptWord[]> {
    const sentences = this._groupIntoSentences(words);
    const result: TranscriptWord[] = [...words];

    const totalSentences = sentences.length;
    let done = 0;

    const batchSize = 50;
    for (let i = 0; i < sentences.length; i += batchSize) {
      const batch = sentences.slice(i, i + batchSize);
      const texts = batch.map((s) => s.text);

      const translated = await this._googleRequest(texts, targetLang);

      for (let j = 0; j < batch.length; j++) {
        const sentence = batch[j];
        const translatedText = translated[j] ?? sentence.text;
        const translatedWords = translatedText.trim().split(/\s+/);

        for (let k = 0; k < sentence.wordIndices.length; k++) {
          const wordIdx = sentence.wordIndices[k];
          result[wordIdx] = {
            ...words[wordIdx],
            word: translatedWords[k] ?? translatedWords[translatedWords.length - 1] ?? words[wordIdx].word,
          };
        }
      }

      done += batch.length;
      onProgress?.(Math.round((done / totalSentences) * 100));
    }

    return result;
  }

  private async _googleRequest(texts: string[], targetLang: string): Promise<string[]> {
    log.info({ targetLang, textCount: texts.length }, 'Google Translate API request');
    const joined = texts.join('\n');
    const params = new URLSearchParams({
      client: 'gtx',
      sl: 'auto',
      tl: targetLang,
      dt: 't',
      q: joined,
    });

    const response = await fetch('https://translate.googleapis.com/translate_a/single', {
      method: 'POST',
      body: params,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    if (!response.ok) {
      const err = await response.text();
      log.error({ status: response.status, body: err.slice(0, 300) }, 'Google Translate API error');
      throw new Error(`Google Translate API error ${response.status}: ${err.slice(0, 200)}`);
    }

    const data = await response.json() as any[];
    if (!data || !Array.isArray(data[0])) {
      throw new Error('Invalid response structure from Google Translate');
    }

    const segments = data[0];
    return texts.map((orig, idx) => {
      const segment = segments[idx];
      if (!segment) return orig;
      let trans = segment[0];
      if (trans.endsWith('\n') && !orig.endsWith('\n')) {
        trans = trans.slice(0, -1);
      }
      return trans;
    });
  }

  // ---------------------------------------------------------------------------
  // DeepL
  // ---------------------------------------------------------------------------

  private async _translateDeepL(
    words: TranscriptWord[],
    targetLang: string,
    apiKey: string,
    onProgress?: (pct: number) => void,
  ): Promise<TranscriptWord[]> {
    const deeplTarget = DEEPL_LANG_MAP[targetLang.toLowerCase()] ?? targetLang.toUpperCase();

    // DeepL translates full sentences better than word-by-word.
    // Group words into sentences (split at long pauses or punctuation).
    const sentences = this._groupIntoSentences(words);
    const result: TranscriptWord[] = [...words]; // copy, will replace word text

    const totalSentences = sentences.length;
    let done = 0;

    // Batch sentences to reduce API calls
    const batchSize = BATCH_SIZE_DEEPL;
    for (let i = 0; i < sentences.length; i += batchSize) {
      const batch = sentences.slice(i, i + batchSize);
      const texts = batch.map((s) => s.text);

      const translated = await this._deeplRequest(texts, deeplTarget, apiKey);

      // Map translated sentences back to individual words
      for (let j = 0; j < batch.length; j++) {
        const sentence = batch[j];
        const translatedText = translated[j] ?? sentence.text;
        const translatedWords = translatedText.trim().split(/\s+/);

        // Distribute translated words across original word slots
        for (let k = 0; k < sentence.wordIndices.length; k++) {
          const wordIdx = sentence.wordIndices[k];
          result[wordIdx] = {
            ...words[wordIdx],
            word: translatedWords[k] ?? translatedWords[translatedWords.length - 1] ?? words[wordIdx].word,
          };
        }
      }

      done += batch.length;
      onProgress?.(Math.round((done / totalSentences) * 100));
    }

    return result;
  }

  private async _deeplRequest(texts: string[], targetLang: string, apiKey: string): Promise<string[]> {
    // Detect if free tier key (ends with :fx) or pro key
    const baseUrl = apiKey.endsWith(':fx')
      ? 'https://api-free.deepl.com/v2/translate'
      : 'https://api.deepl.com/v2/translate';

    log.info({ targetLang, textCount: texts.length, endpoint: baseUrl.includes('free') ? 'free' : 'pro' }, 'DeepL API request');

    const body = JSON.stringify({
      text: texts,
      target_lang: targetLang,
      preserve_formatting: true,
    });

    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Authorization': `DeepL-Auth-Key ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body,
    });

    if (!response.ok) {
      const err = await response.text();
      log.error({ status: response.status, body: err.slice(0, 300) }, 'DeepL API error');
      throw new Error(`DeepL API error ${response.status}: ${err.slice(0, 200)}`);
    }

    const data = await response.json() as { translations: Array<{ text: string }> };
    return data.translations.map((t) => t.text);
  }

  private _groupIntoSentences(words: TranscriptWord[]): Array<{ text: string; wordIndices: number[] }> {
    const sentences: Array<{ text: string; wordIndices: number[] }> = [];
    let current: number[] = [];
    const MAX_GAP_MS = 600;
    const MAX_WORDS = 20;

    for (let i = 0; i < words.length; i++) {
      current.push(i);
      const isLast = i === words.length - 1;
      const nextGap = isLast ? Infinity : words[i + 1].startMs - words[i].endMs;
      const endsWithPunct = /[.!?,;]$/.test(words[i].word.trim());

      if (isLast || nextGap > MAX_GAP_MS || endsWithPunct || current.length >= MAX_WORDS) {
        sentences.push({
          text: current.map((idx) => words[idx].word).join(' '),
          wordIndices: [...current],
        });
        current = [];
      }
    }

    return sentences;
  }

  // ---------------------------------------------------------------------------
  // Ollama fallback
  // ---------------------------------------------------------------------------

  private async _translateOllama(
    words: TranscriptWord[],
    targetLang: string,
    model: string,
    onProgress?: (pct: number) => void,
  ): Promise<TranscriptWord[]> {
    const targetName = getLangName(targetLang);
    const result: TranscriptWord[] = [];
    const totalBatches = Math.ceil(words.length / BATCH_SIZE_OLLAMA);

    for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
      const batch = words.slice(batchIdx * BATCH_SIZE_OLLAMA, (batchIdx + 1) * BATCH_SIZE_OLLAMA);
      const translated = await this._ollamaBatch(batch, targetName, model);
      result.push(...translated);
      onProgress?.(Math.round(((batchIdx + 1) / totalBatches) * 100));
    }

    return result;
  }

  private async _ollamaBatch(words: TranscriptWord[], targetName: string, model: string): Promise<TranscriptWord[]> {
    const numbered = words.map((w, i) => `${i + 1}. ${w.word.trim()}`).join('\n');
    const prompt = `Translate to ${targetName}. Keep numbering. Output ONLY numbered translations.\n\n${numbered}`;

    const MAX_RETRIES = 3;
    const RETRY_DELAY = 3000;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          log.warn({ attempt }, `Retrying Ollama translation in ${RETRY_DELAY}ms...`);
          await new Promise((r) => setTimeout(r, RETRY_DELAY));
          await ensureOllamaRunning();
        }

        const response = await fetch('http://127.0.0.1:11434/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, prompt, stream: false, keep_alive: '10m', options: { temperature: 0.1, num_predict: words.length * 8 } }),
        });

        if (!response.ok) {
          throw new Error(`Ollama HTTP ${response.status}`);
        }

        const data = await response.json() as { response: string };
        const lines = data.response.trim().split('\n').filter((l) => l.trim());

        const translatedMap = new Map<number, string>();
        for (const line of lines) {
          const match = line.match(/^(\d+)\.\s+(.+)$/);
          if (match) translatedMap.set(parseInt(match[1], 10), match[2].trim());
        }

        return words.map((w, i) => ({ ...w, word: translatedMap.get(i + 1) ?? w.word }));
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const isRetriable = errMsg.includes('ECONNRESET') || errMsg.includes('ECONNREFUSED')
          || errMsg.includes('EPIPE') || errMsg.includes('fetch failed')
          || errMsg.includes('network') || errMsg.includes('ETIMEDOUT');

        if (isRetriable && attempt < MAX_RETRIES) {
          log.warn({ attempt, err: errMsg }, 'Ollama translation batch failed (retriable)');
          continue;
        }

        log.warn({ err }, 'Ollama batch failed, keeping originals');
        return words;
      }
    }

    return words;
  }
}
