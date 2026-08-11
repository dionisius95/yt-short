import fs from 'fs';
import crypto from 'crypto';
import http from 'http';
import { createLogger } from '../utils/logger';
import { ConfigManager } from '../config/ConfigManager';
import { TrendAnalysisResult } from '../../shared/types';

const log = createLogger('TrendAnalyzer');

// ---------------------------------------------------------------------------
// Curated Heuristic Niche Templates
// ---------------------------------------------------------------------------

interface HeuristicNiche {
  keywords: string[];
  name: string;
  rpmPotential: 'very_high' | 'high' | 'medium';
  estimatedRpm: string;
  whyViral: string;
  targetAudience: string;
  hooks: Array<{ text: string; type: string; why: string }>;
  titles: string[];
}

const NICHES: HeuristicNiche[] = [
  {
    name: 'Personal Finance & Investing',
    keywords: ['money', 'invest', 'finance', 'rich', 'bitcoin', 'crypto', 'stock', 'option', 'trade', 'saas', 'dropship', 'side hustle', 'income', 'business', 'startup', 'retire', 'wealth', 'saving', 'tax', 'property', 'real estate'],
    rpmPotential: 'very_high',
    estimatedRpm: '$20 - $45',
    whyViral: 'Niche ini memiliki RPM tertinggi karena pengiklan di sektor keuangan (broker, bank, asuransi, SaaS) rela membayar mahal demi audiens US/UK dengan daya beli tinggi. Topik seperti kebebasan finansial dan investasi memiliki daya tarik emosional kuat yang memicu komentar dan share tinggi.',
    targetAudience: 'Investor ritel, profesional muda berusia 18-35 tahun di AS dan Inggris yang mencari panduan pertumbuhan aset dan pendapatan pasif.',
    hooks: [
      {
        text: 'Most people think the best way to invest $1,000 is in the stock market, but they are completely wrong...',
        type: 'Controversial (Pattern Interrupt)',
        why: 'Membantah keyakinan umum (common myth) secara instan memaksa audiens bertahan untuk mendengar alternatifnya.'
      },
      {
        text: 'This is the secret tax loophole in the US/UK that billionaires use to compound their wealth legally...',
        type: 'Authority & Mystery (Open Loop)',
        why: 'Menggunakan kata "rahasia" dan "miliarder" memicu rasa ingin tahu (curiosity gap) yang kuat sejak detik pertama.'
      },
      {
        text: 'If you have idle money sitting in your bank account right now, stop scrolling and watch this...',
        type: 'Immediate Action Callout',
        why: 'Perintah langsung dengan urgensi tinggi membuat penonton merasa bahwa video ini sangat penting dan tidak boleh dilewati.'
      }
    ],
    titles: [
      'The Secret Way To Double $1,000 Fast in 2026',
      'Stop Saving Your Money! Do This Instead',
      'The Legal Tax Loophole Billionaires Keep Secret'
    ]
  },
  {
    name: 'Artificial Intelligence & Tech Reviews',
    keywords: ['ai', 'tech', 'chatgpt', 'llm', 'coding', 'programmer', 'developer', 'python', 'javascript', 'gadget', 'iphone', 'apple', 'tesla', 'nvidia', 'software', 'code', 'computer'],
    rpmPotential: 'very_high',
    estimatedRpm: '$15 - $32',
    whyViral: 'Advertiser untuk platform cloud, tool produktivitas, dan gadget baru memiliki budget marketing yang sangat besar untuk wilayah US/UK. Ketakutan akan tertinggal teknologi baru (FOMO) dan rasa takjub terhadap AI memicu retensi penonton yang luar biasa tinggi.',
    targetAudience: 'Tech enthusiast, software developer, desainer, dan pekerja kreatif digital berusia 18-40 tahun di US/UK.',
    hooks: [
      {
        text: 'I built a fully functional app in just 30 seconds using this brand new AI coding agent...',
        type: 'Demonstration & Wonder (Pattern Interrupt)',
        why: 'Menunjukkan bukti hasil instan yang menakjubkan dalam 3 detik pertama memikat penonton untuk melihat proses lengkapnya.'
      },
      {
        text: 'This new artificial intelligence tool is officially going to replace traditional developers this year...',
        type: 'High Emotion / Threat (Controversial)',
        why: 'Memanfaatkan ketakutan karier (career anxiety) atau perubahan industri radikal menciptakan urgensi tinggi untuk terus menonton.'
      },
      {
        text: 'If you are still writing code or typing emails manually in 2026, you are making a fatal mistake...',
        type: 'Negative Framing Callout',
        why: 'Menyebutkan "kesalahan fatal" membuat penonton ingin tahu apakah mereka termasuk dalam kelompok yang melakukan kesalahan tersebut.'
      }
    ],
    titles: [
      'Is This New AI Officially Replacing Programmers?',
      'How To Build An App in 30 Seconds (No-Code AI)',
      'The Powerful AI Tools Secretly Hidden From You'
    ]
  },
  {
    name: 'Productivity & Psychology Hacks',
    keywords: ['productivity', 'habit', 'routine', 'focus', 'mindset', 'procrastinate', 'dopamine', 'sleep', 'meditate', 'read', 'success', 'psychology', 'brain'],
    rpmPotential: 'high',
    estimatedRpm: '$10 - $22',
    whyViral: 'Niche pengembangan diri didukung oleh pengiklan aplikasi edukasi, kesehatan mental (seperti BetterHelp), dan gaya hidup. Keinginan universal untuk menjadi lebih baik, dipadukan dengan tips praktis yang bisa langsung dicoba, mendorong retensi jangka panjang.',
    targetAudience: 'Mahasiswa, pekerja kantoran, dan pengusaha di US/UK yang mencari peningkatan performa harian dan efisiensi waktu.',
    hooks: [
      {
        text: 'This 60-second psychological trick will crush your procrastination habit forever...',
        type: 'Quick Transformation Promise',
        why: 'Menjanjikan solusi cepat (60 detik) untuk masalah besar (procrastination) membuat penonton merasa investasi waktunya bernilai tinggi.'
      },
      {
        text: 'Most productivity advice tells you to wake up at 5 AM, but science proves that actually ruins your focus...',
        type: 'Myth Busting (Controversial)',
        why: 'Membongkar mitos terkenal langsung menarik perhatian kelompok orang yang tidak suka bangun pagi dan ingin tahu alasannya.'
      },
      {
        text: 'This is the extreme concentration protocol used by the US Navy SEALs, and it is way easier than you think...',
        type: 'Authority Bias Intro',
        why: 'Mengaitkan taktik dengan institusi elit (Navy SEAL) meningkatkan kredibilitas video secara instan dan memicu retensi.'
      }
    ],
    titles: [
      'Destroy Procrastination in 60 Seconds With This Trick',
      'Why Waking Up at 5 AM Might Be Ruining Your Focus',
      'The Navy SEAL Protocol For Extreme Concentration'
    ]
  },
  {
    name: 'True Crime & Deep Mysteries',
    keywords: ['crime', 'murder', 'mystery', 'solve', 'police', 'detective', 'secret', 'history', 'alien', 'space', 'universe', 'nasa', 'mars', 'fbi', 'creepy', 'scary', 'unsolved'],
    rpmPotential: 'medium',
    estimatedRpm: '$6 - $15',
    whyViral: 'Meskipun RPM tidak setinggi Finance/Tech, niche misteri dan kriminal memiliki tingkat retensi (Average View Duration) tertinggi di YouTube Shorts. Elemen cerita berantai (storytelling) dan ketegangan narasi membuat penonton terus terikat hingga akhir video.',
    targetAudience: 'Penggemar dokumenter kriminal, misteri konspirasi, dan luar angkasa dari segala rentang umur di wilayah US/UK.',
    hooks: [
      {
        text: 'She thought she was going on a normal date, until police found something in her trunk that changed the case...',
        type: 'Story Loop / Narrative Tension',
        why: 'Memulai cerita di tengah aksi (in media res) dengan elemen bahaya tersembunyi memaksa otak penonton ingin tahu kelintendannya.'
      },
      {
        text: 'NASA just detected a strange signal from a planet 10 lightyears away, and it is not just space static...',
        type: 'Curiosity Loop (Mystery)',
        why: 'Membuka misteri ilmiah berskala besar memicu imajinasi penonton dan mengunci atensi mereka untuk mendengarkan detail.'
      },
      {
        text: 'The FBI spent 20 years searching for this man, until they realized he lived right next to their headquarters...',
        type: 'Irony & Suspense',
        why: 'Plot twist atau ironi di awal video memicu keterkejutan instan yang sangat efektif mempertahankan penonton.'
      }
    ],
    titles: [
      'The Ordinary Date That Ended With A Terrifying Discovery',
      'The Alien Planet Signal That Has NASA Worried',
      'Wanted By The FBI For 20 Years: Found Next Door!'
    ]
  }
];

const DEFAULT_NICHE: HeuristicNiche = {
  name: 'General Engagement',
  keywords: [],
  rpmPotential: 'medium',
  estimatedRpm: '$4 - $10',
  whyViral: 'Topik umum ini memiliki basis audiens yang sangat luas di US/UK. Tingginya penayangan didorong oleh algoritma rekomendasi YouTube yang menyasar minat massal, meskipun nilai iklan per seribu tayangan (RPM) berada di tingkat menengah.',
  targetAudience: 'Penonton umum di platform media sosial di AS dan Inggris yang mencari konten hiburan cepat atau fakta unik.',
  hooks: [
    {
      text: 'You are probably doing this everyday activity completely wrong, here is how to fix it...',
      type: 'Everyday Improvement Hack',
      why: 'Menyoroti kesalahan sehari-hari penonton memicu rasa bersalah yang sehat dan rasa ingin tahu untuk segera membenarkannya.'
    },
    {
      text: 'This is the number one mistake people make when trying to do this...',
      type: 'Negative Warning Callout',
      why: 'Konten bernada peringatan atau pencegahan kegagalan secara natural menarik perhatian karena manusia cenderung menghindari kerugian.'
    },
    {
      text: 'Watch what happens when we mix these two ordinary objects under extreme conditions...',
      type: 'Visual Curiosity Interrupt',
      why: 'Menjanjikan eksperimen atau visual yang tidak biasa memicu retensi visual instan (visual loop).'
    }
  ],
  titles: [
    'Stop Doing This Everyday Task The Wrong Way!',
    'The Number One Mistake Most People Make',
    'Viral Experiment: The Result You Did Not Expect!'
  ]
};

// ---------------------------------------------------------------------------
// Network Helpers (Gemini & Ollama)
// ---------------------------------------------------------------------------

async function callOllamaChat(
  systemPrompt: string,
  userPrompt: string,
  modelName: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: modelName,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      stream: false,
      options: {
        num_predict: 1536,
        temperature: 0.2
      }
    });

    const req = http.request({
      hostname: '127.0.0.1',
      port: 11434,
      path: '/api/chat',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Ollama returned HTTP ${res.statusCode}`));
        return;
      }
      let data = '';
      res.on('data', (chunk) => { data += chunk.toString(); });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.message?.content ?? '');
        } catch {
          reject(new Error('Failed to parse Ollama response'));
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Ollama request timed out'));
    });
    req.write(body);
    req.end();
  });
}

async function callGeminiVertexAI(
  systemPrompt: string,
  userPrompt: string,
  serviceAccountPath: string,
  images?: string[]
): Promise<string> {
  const keyData = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf-8')) as {
    client_email: string; private_key: string; project_id: string; token_uri?: string;
  };

  const tokenUri = keyData.token_uri || 'https://oauth2.googleapis.com/token';
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claimSet = { iss: keyData.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform', aud: tokenUri, iat: now, exp: now + 3600 };

  const encodeBase64Url = (obj: unknown): string =>
    Buffer.from(JSON.stringify(obj)).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const signInput = `${encodeBase64Url(header)}.${encodeBase64Url(claimSet)}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signInput);
  const signature = sign.sign(keyData.private_key, 'base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const jwt = `${signInput}.${signature}`;
  const tokenResponse = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });

  if (!tokenResponse.ok) throw new Error(`Token exchange failed: ${tokenResponse.status}`);
  const tokenData = await tokenResponse.json() as { access_token: string };

  const parts: any[] = [{ text: `${systemPrompt}\n\n${userPrompt}` }];
  if (images && images.length > 0) {
    for (const img of images) {
      let data = img;
      let mimeType = 'image/jpeg';
      if (img.startsWith('data:')) {
        const match = /^data:([^;]+);base64,(.+)$/.exec(img);
        if (match) {
          mimeType = match[1];
          data = match[2];
        }
      }
      parts.push({ inlineData: { mimeType, data } });
    }
  }

  const models = ['gemini-3.6-flash', 'gemini-3.0-flash', 'gemini-1.5-flash-002', 'gemini-1.5-flash-001', 'gemini-2.5-flash', 'gemini-2.0-flash-001', 'gemini-1.5-flash'];
  let lastErr: Error | null = null;

  for (const model of models) {
    const url = `https://us-central1-aiplatform.googleapis.com/v1/projects/${keyData.project_id}/locations/us-central1/publishers/google/models/${model}:generateContent`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${tokenData.access_token}`,
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 8192, responseMimeType: 'application/json' },
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        if (response.status === 404 || errText.includes('NOT_FOUND')) continue;
        throw new Error(`Vertex AI Gemini error ${response.status}: ${errText.slice(0, 300)}`);
      }

      const data = await response.json() as any;
      return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    } catch (e: any) {
      lastErr = e;
      if (e?.message?.includes('404') || e?.message?.includes('NOT_FOUND')) continue;
      throw e;
    }
  }
  throw lastErr || new Error('All Vertex AI Gemini model candidates failed');
}


// ---------------------------------------------------------------------------
// Main Service Implementation
// ---------------------------------------------------------------------------

export async function analyzeTrend(
  params: { topic?: string; title?: string; description?: string; regionCode?: string; userScript?: string },
  configManager: ConfigManager
): Promise<TrendAnalysisResult> {
  const topic = params.topic || params.title || 'General Video Topic';
  const region = params.regionCode || 'US';

  log.info({ topic, region, hasUserScript: !!params.userScript }, 'Running trend analysis');

  let systemPrompt = `You are a viral short-form video & SEO expert specializing in high RPM niches for English-speaking audiences (primarily United States and United Kingdom).
Predict whether this topic or video will perform well on YouTube Shorts/TikTok (high RPM & retention).
The response must be in Indonesian language for text fields (whyViral, targetAudience, whyItWorks) so the local creator can easily read it, but the hookText and suggestedTitles must be in English since they target US/UK audiences!
IMPORTANT: Your JSON must be clean and parseable. Do NOT use unescaped double quotes inside any string field (use single quotes ' instead). Do NOT include unescaped newlines in JSON strings.

Format:
{
  "topic": "string (the finalized topic name)",
  "trendStrength": number (1 to 100),
  "rpmPotential": "very_high" | "high" | "medium",
  "estimatedRpm": "string (e.g. $15 - $35)",
  "whyViral": "string (detailed explanation in Indonesian)",
  "targetAudience": "string (explanation in Indonesian)",
  "hooks": [
    {
      "hookText": "string (exact 3-second English script)",
      "hookType": "string (e.g. Controversial, Curiosity Loop, Visual Interrupt, Myth Busting)",
      "whyItWorks": "string (psychological hook analysis in Indonesian)"
    }
  ],
  "suggestedTitles": ["string (English catchy title 1)", "string (English catchy title 2)", "string (English catchy title 3)"]
}`;

  if (params.userScript) {
    systemPrompt += `

PENTING - AUDIT ALGORITMA YOUTUBE 2026 (G.I.S.T. / Conflict Radius):
Pengguna menyertakan draf naskah/ide kustom. Anda WAJIB membandingkannya dengan ide asli berdasarkan aturan:
1. YouTube menilai keunikan konten lewat G.I.S.T (Net Information Gain) pada Token 7 (Idea) dan Token 8 (Delivery).
2. Hitung "netInformationGain" (0-100) - seberapa banyak nilai baru/analisis unik yang diberikan draf naskah dibanding video asli.
3. Berikan "similarityScore" (0-100) draf naskah dibanding ide orisinal.
4. Tentukan "conflictRadiusRisk":
   - "duplicate" (views stuck di 0-1k): jika naskah meniru persis, parafrase dekat, atau strukturnya sama. (similarityScore > 75)
   - "somewhat_transformative" (limit rata-rata 30k views): jika ada sentuhan baru tetapi ide utamanya masih sama. (similarityScore 40-75)
   - "significantly_transformative" (tanpa limit tayangan): jika naskah memberi Net Information Gain tinggi dengan perspektif baru, data unik, atau Delivery/Hook yang berbeda jauh. (similarityScore < 40)
5. Jelaskan overlap Token 7 (originalIdeaOverlap) dan Token 8 (deliveryOverlap) dalam bahasa Indonesia.
6. Buat "diversityActionPlan": 3 langkah praktis dalam bahasa Indonesia untuk mengubah draf tersebut menjadi "significantly_transformative" dan keluar dari Conflict Radius.

Tambahkan objek "gistAudit" ke respons JSON dengan format:
  "gistAudit": {
    "netInformationGain": number,
    "conflictRadiusRisk": "duplicate" | "somewhat_transformative" | "significantly_transformative",
    "similarityScore": number,
    "originalIdeaOverlap": "string",
    "deliveryOverlap": "string",
    "diversityActionPlan": ["string", "string", "string"]
  }`;
  }

  const userPrompt = JSON.stringify({
    inputTopic: params.topic || '',
    inputTitle: params.title || '',
    inputDescription: params.description || '',
    targetRegion: region,
    userScript: params.userScript || ''
  });

  const serviceAccountPath = configManager.get('googleSttServiceAccountPath') || '';
  const ollamaModel = configManager.get('ollamaModel') || 'llama3';

  // 1. Try Vertex AI Gemini API (if Service Account path set)
  if (serviceAccountPath && fs.existsSync(serviceAccountPath)) {
    try {
      log.info('Attempting Vertex AI analysis...');
      const response = await callGeminiVertexAI(systemPrompt, userPrompt, serviceAccountPath);
      return parseAiResponse(response, topic);
    } catch (err) {
      log.warn({ err }, 'Vertex AI analysis failed, trying fallback to Ollama');
    }
  }

  // 3. Try Ollama (if running)
  try {
    log.info('Attempting Ollama analysis...');
    const response = await callOllamaChat(systemPrompt, userPrompt, ollamaModel);
    return parseAiResponse(response, topic);
  } catch (err) {
    log.warn({ err }, 'Ollama failed, falling back to smart Heuristic Engine');
  }

  // 4. Heuristic Fallback
  return generateHeuristicAnalysis(params);
}

// Helper to clean and parse LLM response
function parseAiResponse(raw: string, fallbackTopic: string): TrendAnalysisResult {
  let cleaned = raw.trim();
  // Strip markdown fences
  const match = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (match) {
    cleaned = match[1].trim();
  }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    cleaned = cleaned.slice(start, end + 1);
  }

  try {
    const result = JSON.parse(cleanJsonString(cleaned)) as TrendAnalysisResult;
    // Ensure basic fields are present
    return {
      topic: result.topic || fallbackTopic,
      trendStrength: result.trendStrength || 80,
      rpmPotential: result.rpmPotential || 'high',
      estimatedRpm: result.estimatedRpm || '$10 - $20',
      whyViral: result.whyViral || 'Topik ini memiliki potensi keterikatan tinggi bagi penonton luar negeri.',
      targetAudience: result.targetAudience || 'Penonton di US/UK.',
      hooks: result.hooks || [],
      suggestedTitles: result.suggestedTitles || [],
      gistAudit: result.gistAudit
    };
  } catch (err) {
    log.error({ err, raw, cleaned }, 'parseAiResponse JSON parsing failed');
    throw err;
  }
}

// Smart Heuristic Fallback Engine with G.I.S.T. Audit Sim
function generateHeuristicAnalysis(params: { topic?: string; title?: string; description?: string; regionCode?: string; userScript?: string }): TrendAnalysisResult {
  const topicText = (params.topic || '').toLowerCase();
  const titleText = (params.title || '').toLowerCase();
  const descText = (params.description || '').toLowerCase();
  const fullText = `${topicText} ${titleText} ${descText}`;

  const topicName = params.topic || params.title || 'Custom Niche';
  const region = params.regionCode || 'US';
  const regionSuffix = region === 'GB' ? 'UK' : 'US';

  // Find matching niche template
  let matchedNiche = DEFAULT_NICHE;
  for (const n of NICHES) {
    if (n.keywords.some(k => fullText.includes(k))) {
      matchedNiche = n;
      break;
    }
  }

  // Personalize hooks & titles to the current topic
  const personalizedHooks = matchedNiche.hooks.map(h => {
    let hookText = h.text;
    if (params.topic) {
      hookText = hookText
        .replace(/invest in \$1,000/g, `invest in ${params.topic}`)
        .replace(/secret tax loophole/g, `secret loophole for ${params.topic}`)
        .replace(/writing code/g, `doing ${params.topic}`)
        .replace(/advice on productivity/g, `advice on ${params.topic}`)
        .replace(/procrastination habit/g, `procrastination on ${params.topic}`)
        .replace(/the case/g, `the case of ${params.topic}`);
    }
    return {
      hookText,
      hookType: h.type,
      whyItWorks: h.why
    };
  });

  const personalizedTitles = matchedNiche.titles.map(t => {
    if (params.topic) {
      return t.replace(/\$1,000/g, `$1,000 of ${params.topic}`)
              .replace(/Do This/g, `Do this for ${params.topic}`)
              .replace(/AI Tools/g, `AI tools for ${params.topic}`)
              .replace(/This Trick/g, `this ${params.topic} hack`);
    }
    return t;
  });

  let estRpm = matchedNiche.estimatedRpm;
  if (region === 'GB') {
    estRpm = estRpm.replace(/\$/g, '£');
  }

  const seed = (topicName.length * 7) % 20;
  const trendStrength = 78 + seed;

  // Generate heuristic G.I.S.T audit if userScript is present
  let gistAudit: any = undefined;
  if (params.userScript) {
    const userWords = params.userScript.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const topicWords = topicName.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    
    let matches = 0;
    for (const tw of topicWords) {
      if (userWords.includes(tw)) matches++;
    }
    
    // Similarity ratio
    const matchRatio = topicWords.length > 0 ? matches / topicWords.length : 0;
    let similarityScore = Math.min(100, Math.round(matchRatio * 75 + (userWords.length < 15 ? 30 : 0)));

    if (params.userScript.toLowerCase().includes(topicName.toLowerCase())) {
      similarityScore = Math.max(similarityScore, 85);
    }

    let conflictRadiusRisk: 'duplicate' | 'somewhat_transformative' | 'significantly_transformative' = 'significantly_transformative';
    let netGain = 90 - Math.round(similarityScore * 0.7);

    if (similarityScore > 75) {
      conflictRadiusRisk = 'duplicate';
      netGain = Math.max(5, netGain - 20);
    } else if (similarityScore > 35) {
      conflictRadiusRisk = 'somewhat_transformative';
    }

    gistAudit = {
      netInformationGain: netGain,
      conflictRadiusRisk,
      similarityScore,
      originalIdeaOverlap: conflictRadiusRisk === 'duplicate'
        ? 'Draf naskah kamu memiliki kecocokan yang sangat tinggi dengan ide asli (Token 7 Overlap ekstrim). Kamu menggunakan konsep, keyword utama, dan sudut pandang yang sama persis tanpa modifikasi.'
        : conflictRadiusRisk === 'somewhat_transformative'
        ? 'Draf naskah kamu memiliki beberapa kemiripan konsep dengan ide asli (Token 7 Overlap sedang). Ada beberapa modifikasi kata, tetapi alur penjelasan masih mengikuti pola yang sama.'
        : 'Sangat bagus! Draf naskah kamu memiliki kemiripan yang sangat rendah (Token 7 Overlap minim). Kamu berhasil membawa sudut pandang baru yang orisinal.',
      deliveryOverlap: conflictRadiusRisk === 'duplicate'
        ? 'Penyampaian (Token 8) terdeteksi sebagai reupload/copy karena pola pembuka naskah meniru persis format umum. Ini akan menaruh video kamu dalam Conflict Radius (views stuck 0-1k).'
        : conflictRadiusRisk === 'somewhat_transformative'
        ? 'Gaya penyampaian (Token 8) terdeteksi agak transformatif. Penonton mungkin bertahan, tetapi algoritma G.I.S.T. masih membatasi jangkauan (Impression Limit ~30k views).'
        : 'Penyampaian (Token 8) sangat orisinal. Kamu menggunakan gaya penuturan unik, analogi segar, atau format penyajian baru yang lolos dari limitasi algoritma.',
      diversityActionPlan: conflictRadiusRisk === 'duplicate'
        ? [
            'Gunakan hook kontradiktif (misal membantah langsung ide asli di 3 detik pertama).',
            'Tambahkan studi kasus personal atau contoh spesifik yang tidak ada di video orisinal.',
            'Ubah struktur penyampaian dengan metode tanya-jawab cepat.'
          ]
        : conflictRadiusRisk === 'somewhat_transformative'
        ? [
            'Tingkatkan kontras argumen dengan menambahkan opini/data pembanding.',
            'Gunakan analogi visual unik di awal video (Token 8 Delivery shift).',
            'Fokuskan pada sub-niche yang lebih spesifik untuk menaikkan Net Information Gain.'
          ]
        : [
            'Pertahankan draf ini! Gunakan visual hook yang orisinal saat memproduksi video.',
            'Pastikan audio jernih dan berenergi untuk memaksimalkan retensi (AVD).',
            'Gunakan judul dengan CTR tinggi yang memicu emosi penonton.'
          ]
    };
  }

  return {
    topic: topicName,
    trendStrength,
    rpmPotential: matchedNiche.rpmPotential,
    estimatedRpm: estRpm,
    whyViral: matchedNiche.whyViral.replace(/US\/UK/g, regionSuffix),
    targetAudience: matchedNiche.targetAudience.replace(/US\/UK/g, regionSuffix),
    hooks: personalizedHooks,
    suggestedTitles: personalizedTitles,
    gistAudit
  };
}
export async function optimizeGistScript(
  params: { topic: string; originalIdea?: string; userScript: string; durationSec?: number; clipId?: string; analyzeVisual?: boolean },
  configManager: ConfigManager,
  images?: string[]
): Promise<import('../../shared/types').GistOptimizationResult> {
  const topic = params.topic;
  const originalIdea = params.originalIdea || '';
  const userScript = params.userScript;
  const durationSec = params.durationSec || 30;
  const maxWords = Math.max(15, Math.floor(durationSec * 2.1)); // 2.1 words per second (~130 WPM)

  log.info({ topic, durationSec, maxWords, hasImages: !!images && images.length > 0 }, 'Running G.I.S.T. Script optimization');

  let visualInstruction = '';
  if (images && images.length > 0) {
    visualInstruction = `\n5. IMPORTANT: You are provided with ${images.length} keyframe images extracted from the video clip at even intervals. The rewritten script MUST correspond and be highly relevant to what is visually occurring in these frames. Write a commentary/reaction script that comments directly on the events, visual details, actions, or subjects visible in the frames, keeping it perfectly paced.`;
  }

  const systemPrompt = `You are a YouTube Shorts content optimization expert.
The user has a video draft script or transcription for the topic "${topic}" (original idea context: "${originalIdea}").
If the provided topic looks like a video title, file name (e.g., ending with .mp4), or platform URL, you MUST ignore the title/URL and extract the true semantic topic/subject matter directly from the "originalScript" below.

Your task is to rewrite this SPECIFIC script/transcription (provided as "originalScript") to make it "Significantly Transformative" under the G.I.S.T. algorithm (meaning it introduces highly unique angles, contrarian hooks, or specific insights), while preserving its original core subject matter, key tutorial steps, arguments, or topics.

CRITICAL INSTRUCTIONS:
1. You MUST base your rewrite directly on the provided "originalScript". Do NOT ignore the "originalScript". Do NOT write a generic marketing pitch, advertisement, or unrelated promotion for "${topic}" or "${originalIdea}" unless the "originalScript" itself is an advertisement. If the "originalScript" is empty, you may draft a script from scratch about the topic.
2. Maintain the same language as the "originalScript" (e.g., if the original script is in Indonesian, the optimized script MUST also be in Indonesian. If in English, write in English, etc.).
3. Re-design the first 3-5 seconds (Token 8 - Delivery) of the original script to use a highly unique/contrarian hook style that instantly interrupts the user's scroll.
4. Infuse original, counter-intuitive arguments, metaphors, or specific insights (Token 7 - Idea) based on the original script's topics.
5. The script MUST be spoken at a natural, human-like pace within exactly ${durationSec} seconds. Therefore, your rewritten script MUST contain AT MOST ${maxWords} words. Simplify, condense sentence structures, and extract only the highest impact/key interesting ideas from the original script. Keep it extremely tight.
6. CRITICAL FOR SAFETY: Do NOT include any platform URLs, website domain names (like rednotedownloader.com), or explicit download-related terms in the "optimizedScript" to prevent safety and policy filters from blocking the output. Instead, use general descriptive terms like "content backup tool", "digital library", "saving files", or "media archiver".
7. Output must be a valid JSON object only. Do not write markdown fences, comments, or intro/outro text. IMPORTANT: Your JSON must be clean and parseable. Do NOT use unescaped double quotes inside any string field (use single quotes ' instead). Do NOT include unescaped newlines in JSON strings.${visualInstruction}
8. CRITICAL: The "optimizedScript" MUST contain ONLY the spoken voiceover/dialogue text. Do NOT include any director notes, scene descriptions, frame labels (e.g. "Frame 1:", "(Visual:)"), camera angles, or non-spoken visual guidelines in the "optimizedScript". Every character in the "optimizedScript" will be read out loud by text-to-speech, so it must only contain read-aloud spoken words.

Format:
{
  "optimizedScript": "string (the fully rewritten script, matching the language of the originalScript)",
  "explanation": "string (a brief 1-2 sentence explanation in Indonesian explaining what you changed to escape the conflict radius while maintaining high retention)"
}`;

  const userPrompt = JSON.stringify({
    topic,
    originalIdea,
    originalScript: userScript
  });

  const serviceAccountPath = configManager.get('googleSttServiceAccountPath') || '';
  const ollamaModel = configManager.get('ollamaModel') || 'llama3';

  // 1. Try Vertex AI Gemini API (if Service Account path set)
  if (serviceAccountPath && fs.existsSync(serviceAccountPath)) {
    try {
      log.info('Attempting Vertex AI Gist optimization...');
      const response = await callGeminiVertexAI(systemPrompt, userPrompt, serviceAccountPath, images);
      return parseOptimizeResponse(response, userScript);
    } catch (err) {
      log.warn({ err }, 'Vertex AI Gist optimization failed, trying fallback to Ollama');
    }
  }

  // 3. Try Ollama (if running)
  try {
    log.info('Attempting Ollama Gist optimization...');
    const response = await callOllamaChat(systemPrompt, userPrompt, ollamaModel);
    return parseOptimizeResponse(response, userScript);
  } catch (err) {
    log.warn({ err }, 'Ollama Gist optimization failed, falling back to heuristic');
  }

  // Fallback heuristic rewrite
  return generateHeuristicOptimization(topic);
}

function parseOptimizeResponse(raw: string, fallbackScript: string): import('../../shared/types').GistOptimizationResult {
  let cleaned = raw.trim();
  const match = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (match) {
    cleaned = match[1].trim();
  }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    cleaned = cleaned.slice(start, end + 1);
  }
  try {
    const result = JSON.parse(cleanJsonString(cleaned));
    return {
      optimizedScript: result.optimizedScript || fallbackScript,
      explanation: result.explanation || 'Naskah dioptimalkan untuk memicu rasa ingin tahu (curiosity loop) dan sudut pandang baru yang lebih tajam.'
    };
  } catch (err) {
    log.error({ err, raw, cleaned }, 'parseOptimizeResponse JSON parsing failed');
    throw err;
  }
}

function generateHeuristicOptimization(topic: string): import('../../shared/types').GistOptimizationResult {
  // Simple heuristic optimization
  const optimizedScript = `Wait! Everyone is talking about ${topic} the wrong way. Here is the real truth: most people make the fatal mistake of following mainstream advice. But if you look at the actual data, the secret lies in doing the exact opposite. [Insert unique case study here]. Stop wasting time, try this instead and watch the magic happen.`;
  return {
    optimizedScript,
    explanation: 'Naskah diubah menggunakan pola "Mitos-Fakta" yang kontradiktif di awal video (Token 8 Shift) untuk memicu retensi visual tinggi, serta menyarankan studi kasus unik (Token 7 Shift).'
  };
}

function cleanJsonString(str: string): string {
  let insideString = false;
  let result = '';
  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    if (char === '"' && str[i - 1] !== '\\') {
      insideString = !insideString;
      result += char;
    } else if (insideString && (char === '\n' || char === '\r')) {
      if (char === '\n') {
        result += '\\n';
      }
    } else {
      result += char;
    }
  }
  return result;
}

