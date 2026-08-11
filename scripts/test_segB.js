const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

async function testSegB() {
  console.log('--- EMPIRICAL TEST: SEGMENT B SUBTITLE RENDER ---');
  const { Processor } = require('../dist/electron/pipeline/Processor');
  const processor = new Processor();

  const sourceVideo = 'D:\\Downloads\\YT SHORT\\clip-c98b17eb-76ba-4e90-b988-ee0d9f4c56be.mp4';
  const outputPath = path.join(__dirname, 'test_segB_output.mp4');

  if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);

  const testWords = [
    { word: 'THIS', startMs: 200, endMs: 600, confidence: 1.0 },
    { word: 'IS', startMs: 700, endMs: 1000, confidence: 1.0 },
    { word: 'A', startMs: 1100, endMs: 1300, confidence: 1.0 },
    { word: 'TEST', startMs: 1400, endMs: 2000, confidence: 1.0 },
    { word: 'SUBTITLE', startMs: 2100, endMs: 3000, confidence: 1.0 },
    { word: 'IN', startMs: 3100, endMs: 3500, confidence: 1.0 },
    { word: 'SEGMENT', startMs: 3600, endMs: 4200, confidence: 1.0 },
    { word: 'TWO', startMs: 4300, endMs: 5000, confidence: 1.0 }
  ];

  console.log('Calling processor.renderCommentaryVideo with Segment B test words...');
  await processor.renderCommentaryVideo({
    sourceVideoPath: sourceVideo,
    ttsAudioPath: sourceVideo,
    words: testWords.slice(0, 3),
    outputPath: outputPath,
    presetId: 'tiktok',
    captionStyle: {
      presetId: 'tiktok',
      font: 'Lilita One',
      fontSize: 80,
      primaryColor: '#FFFF00',
      outlineColor: '#000000',
      highlightColor: '#FF0000',
      position: 'lower-third',
      captionY: 1450,
      lines: 1,
      bold: true,
      outlineSize: 6,
      shadowSize: 2,
      shakeEffect: false,
      karaokeHighlight: true,
    },
    durationMs: 5000,
    commentaryMode: 'hook_replay_outro',
    startMs: 0,
    endMs: 5000,
    originalTranscriptWords: testWords,
    optionsJson: JSON.stringify({ layoutPreset: 'normal' })
  });

  console.log('Video generated at:', outputPath, 'Size:', fs.statSync(outputPath).size, 'bytes');

  // Extract frame during Segment B at 6.0s (after Segment A intro)
  const framePath = path.join(__dirname, 'segB_frame.png');
  execSync(`ffmpeg -y -ss 00:00:06.00 -i "${outputPath}" -vframes 1 "${framePath}"`);
  console.log('SUCCESS: Extracted frame at 6.0s:', framePath, 'Size:', fs.statSync(framePath).size, 'bytes');
}

testSegB().catch(err => {
  console.error('TEST ERROR:', err);
  process.exit(1);
});
