import { describe, it, expect } from 'vitest';
import { buildAssSubtitles } from '../../electron/pipeline/Processor';
import type { CaptionStyle, TranscriptWord } from '../../shared/types';

describe('buildAssSubtitles — word grouping and timing', () => {
  const baseStyle: CaptionStyle = {
    font: 'Lilita One',
    fontSize: 100,
    position: 'lower-third',
    animation: 'pop',
    lines: 2,
    primaryColor: '#FFFFFF',
    outlineColor: '#000000',
    highlightColor: '#D2FF00',
    bold: true,
    uppercase: true,
    outlineSize: 7,
    shadowSize: 3,
    shakeEffect: false,
    karaokeHighlight: true,
    presetId: 'custom',
    captionY: 1100,
  };

  function parseDialogueEvents(ass: string) {
    const lines = ass.split(/\r?\n/);
    const events: Array<{ start: string; end: string; startMs: number; endMs: number; text: string }> = [];
    for (const l of lines) {
      if (!l.startsWith('Dialogue:')) continue;
      const parts = l.split(',');
      const start = parts[1];
      const end = parts[2];
      const text = parts.slice(9).join(',');

      const toMs = (timeStr: string) => {
        const [h, m, s] = timeStr.split(':');
        const [sec, cs] = s.split('.');
        return parseInt(h) * 3600000 + parseInt(m) * 60000 + parseInt(sec) * 1000 + parseInt(cs) * 10;
      };

      events.push({
        start,
        end,
        startMs: toMs(start),
        endMs: toMs(end),
        text,
      });
    }
    return events;
  }

  it('generates zero-overlap dialogues when words have overlapping STT timestamps', async () => {
    const words: TranscriptWord[] = [
      { word: 'GARDO.', startMs: 26920, endMs: 27400, probability: 0.9 },
      { word: 'ardo', startMs: 27000, endMs: 27320, probability: 0.9 }, // Overlaps GARDO
      { word: 'Oh', startMs: 35080, endMs: 35160, probability: 0.9 }, // 7.7s pause
      { word: 'my', startMs: 35160, endMs: 35360, probability: 0.9 },
    ];

    const ass = await buildAssSubtitles(words, 0, 40000, baseStyle);
    const events = parseDialogueEvents(ass);

    expect(events.length).toBeGreaterThan(0);

    // Verify strictly no overlapping timestamps between consecutive events
    for (let i = 1; i < events.length; i++) {
      const prev = events[i - 1];
      const curr = events[i];
      expect(curr.startMs).toBeGreaterThanOrEqual(prev.endMs);
    }
  });

  it('splits groups across large pause gaps (> 600ms)', async () => {
    const words: TranscriptWord[] = [
      { word: 'Hello', startMs: 1000, endMs: 1500, probability: 0.9 },
      { word: 'World', startMs: 8000, endMs: 8500, probability: 0.9 }, // 6.5s gap
    ];

    const ass = await buildAssSubtitles(words, 0, 10000, baseStyle);
    const events = parseDialogueEvents(ass);

    expect(events.length).toBe(2);
    // Event 1 should end around 1500, not stay till 8000
    expect(events[0].endMs).toBeLessThan(2000);
    // Event 2 should start at 8000
    expect(events[1].startMs).toBe(8000);
  });

  it('supports words/line = 2 in non-karaoke mode without overlap', async () => {
    const nonKaraokeStyle: CaptionStyle = {
      ...baseStyle,
      karaokeHighlight: false,
      lines: 2,
    };

    const words: TranscriptWord[] = [
      { word: 'First', startMs: 1000, endMs: 1400, probability: 0.9 },
      { word: 'Second', startMs: 1400, endMs: 1800, probability: 0.9 },
      { word: 'Third', startMs: 2000, endMs: 2400, probability: 0.9 },
      { word: 'Fourth', startMs: 2400, endMs: 2800, probability: 0.9 },
    ];

    const ass = await buildAssSubtitles(words, 0, 5000, nonKaraokeStyle);
    const events = parseDialogueEvents(ass);

    // 4 words grouped by 2 = 2 events
    expect(events.length).toBe(2);
    expect(events[0].text).toContain('FIRST SECOND');
    expect(events[1].text).toContain('THIRD FOURTH');
    expect(events[1].startMs).toBeGreaterThanOrEqual(events[0].endMs);
  });

  it('generates micro-segment camera shake when shakeEffect is enabled', async () => {
    const shakeStyle: CaptionStyle = {
      ...baseStyle,
      shakeEffect: true,
    };

    const words: TranscriptWord[] = [
      { word: 'LOUD', startMs: 1000, endMs: 1300, probability: 0.9 },
    ];

    const ass = await buildAssSubtitles(words, 0, 2000, shakeStyle);
    const events = parseDialogueEvents(ass);

    // Should generate valid dialogue events
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].text).toContain('LOUD');
  });
});

