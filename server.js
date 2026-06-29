const express = require('express');
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json({ limit: '10mb' }));

const API_KEY = process.env.API_KEY || 'changeme';
const PORT = process.env.PORT || 3000;

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use((req, res, next) => {
  if (req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

function hexToAss(hex, alpha = '00') {
  hex = (hex || '#ffffff').replace('#', '');
  if (hex.length === 6) {
    const r = hex.slice(0,2), g = hex.slice(2,4), b = hex.slice(4,6);
    return `&H${alpha}${b}${g}${r}`;
  }
  return `&H00ffffff`;
}

function positionToAlignment(position) {
  switch ((position||'BOTTOM').toUpperCase()) {
    case 'TOP': return 8;
    case 'CENTER': return 5;
    default: return 2;
  }
}

function applyTransform(text, transform) {
  switch ((transform||'NONE').toUpperCase()) {
    case 'UPPERCASE': return text.toUpperCase();
    case 'CAPITALIZE': return text.replace(/\b\w/g, c => c.toUpperCase());
    default: return text;
  }
}

function chunkWords(text, n) {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks = [];
  for (let i = 0; i < words.length; i += n) chunks.push(words.slice(i, i+n));
  return chunks;
}

function toAssTime(seconds) {
  const h = Math.floor(seconds/3600);
  const m = Math.floor((seconds%3600)/60);
  const s = Math.floor(seconds%60);
  const cs = Math.round((seconds%1)*100);
  return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(cs).padStart(2,'0')}`;
}

function generateASS(captionStyle, segments, hookText, videoDuration) {
  const {
    fontFamily = 'Impact',
    fontSize = 72,
    color = '#ffffff',
    strokeColor = '#000000',
    strokeWidth = 4,
    position = 'BOTTOM',
    animation = 'WORD_BY_WORD',
    textTransform = 'UPPERCASE',
    maxWordsPerLine = 3,
  } = captionStyle || {};

  const alignment = positionToAlignment(position);
  const primaryColor = hexToAss(color);
  const outlineColor = hexToAss(strokeColor);
  const highlightColor = hexToAss('#ffff00');
  const anim = (animation||'WORD_BY_WORD').toUpperCase();

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${fontFamily},${fontSize},${primaryColor},${primaryColor},${outlineColor},&H00000000,1,0,0,0,100,100,0,0,1,${strokeWidth},0,${alignment},40,40,60,1
Style: Highlight,${fontFamily},${fontSize},${highlightColor},${highlightColor},${outlineColor},&H00000000,1,0,0,0,100,100,0,0,1,${strokeWidth},0,${alignment},40,40,60,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const lines = [];

  if (!segments || segments.length === 0) {
    const text = applyTransform(hookText || '', textTransform);
    lines.push(`Dialogue: 0,${toAssTime(0)},${toAssTime(videoDuration||30)},Default,,0,0,0,,${text}`);
    return header + lines.join('\n');
  }

  for (const seg of segments) {
    const segStart = seg.start ?? 0;
    const segEnd = seg.end ?? segStart + 2;
    const rawText = applyTransform(seg.text || '', textTransform);

    if (anim === 'FADE') {
      lines.push(`Dialogue: 0,${toAssTime(segStart)},${toAssTime(segEnd)},Default,,0,0,0,,{\\fad(150,150)}${rawText}`);
    } else if (anim === 'LINE_BY_LINE') {
      lines.push(`Dialogue: 0,${toAssTime(segStart)},${toAssTime(segEnd)},Default,,0,0,0,,${rawText}`);
    } else {
      const mw = Math.max(1, maxWordsPerLine||3);
      const chunks = chunkWords(rawText, mw);
      if (!chunks.length) continue;
      const chunkDur = (segEnd - segStart) / chunks.length;
      for (let i = 0; i < chunks.length; i++) {
        const chunkStart = segStart + i * chunkDur;
        const chunkEnd = chunkStart + chunkDur;
        lines.push(`Dialogue: 0,${toAssTime(chunkStart)},${toAssTime(chunkEnd)},Highlight,,0,0,0,,${chunks[i].join(' ')}`);
      }
    }
  }

  return header + lines.join('\n');
}

app.post('/extract-audio-full', (req, res) => {
  const { inputUrl } = req.body;
  if (!inputUrl) return res.status(400).json({ error: 'inputUrl required' });
  const outFile = `/tmp/audio_${Date.now()}.mp3`;
  const cmd = `ffmpeg -i "${inputUrl}" -vn -acodec mp3 -ab 24k -ac 1 -ar 16000 -y "${outFile}"`;
  const { exec } = require('child_process');
  exec(cmd, { timeout: 300000, maxBuffer: 50*1024*1024 }, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    const stats = fs.statSync(outFile);
    console.log('Audio extracted:', Math.round(stats.size/1024/1024*100)/100, 'MB');
    res.setHeader('Content-Type', 'audio/mpeg');
    res.download(outFile, 'audio.mp3', () => {
      try { fs.unlinkSync(outFile); } catch(e) {}
    });
  });
});

app.post('/cut', (req, res) => {
  const { inputUrl, startSeconds, endSeconds } = req.body;
  if (!inputUrl) return res.status(400).json({ error: 'inputUrl required' });
  const outFile = `/tmp/clip_${Date.now()}.mp4`;
  const cmd = `ffmpeg -ss ${startSeconds} -to ${endSeconds} -i "${inputUrl}" -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2" -c:v libx264 -preset fast -crf 18 -c:a aac -movflags +faststart -y "${outFile}"`;
  const { exec } = require('child_process');
  exec(cmd, { timeout: 120000, maxBuffer: 50*1024*1024 }, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.download(outFile, 'clip.mp4', () => {
      try { fs.unlinkSync(outFile); } catch(e) {}
    });
  });
});

app.post('/render', async (req, res) => {
  const { inputUrl, captionStyle, segments, hookText } = req.body;
  if (!inputUrl) return res.status(400).json({ error: 'inputUrl required' });

  const workDir = path.join(os.tmpdir(), uuidv4());
  fs.mkdirSync(workDir, { recursive: true });

  const inputPath = path.join(workDir, 'input.mp4');
  const assPath = path.join(workDir, 'subs.ass');
  const outputPath = path.join(workDir, 'output.mp4');

  try {
    console.log('[render] Downloading:', inputUrl);
    const videoRes = await fetch(inputUrl);
    if (!videoRes.ok) throw new Error(`Download failed: HTTP ${videoRes.status}`);
    const videoBuffer = await videoRes.arrayBuffer();
    fs.writeFileSync(inputPath, Buffer.from(videoBuffer));

    let videoDuration = 30;
    try {
      const probe = execSync(
        `ffprobe -v error -show_entries format=duration -of csv=p=0 "${inputPath}"`,
        { encoding: 'utf8' }
      ).trim();
      videoDuration = parseFloat(probe) || 30;
    } catch(_) {}

    const assContent = generateASS(captionStyle, segments, hookText, videoDuration);
    fs.writeFileSync(assPath, assContent, 'utf8');
    console.log('[render] ASS generated, duration:', videoDuration);

    const assEscaped = assPath.replace(/\\/g, '/').replace(/:/g, '\\:');

    await new Promise((resolve, reject) => {
      const args = [
        '-y', '-i', inputPath,
        '-vf', `scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,ass=${assEscaped}`,
        '-c:v', 'libx264', '-crf', '18', '-preset', 'fast',
        '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart',
        outputPath
      ];
      const ff = spawn('ffmpeg', args);
      ff.stderr.on('data', d => process.stderr.write(d));
      ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg code ${code}`)));
    });

    const stat = fs.statSync(outputPath);
    console.log('[render] Done:', Math.round(stat.size/1024/1024*100)/100, 'MB');

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Disposition', 'attachment; filename="output.mp4"');
    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on('end', () => fs.rmSync(workDir, { recursive: true, force: true }));

  } catch(err) {
    console.error('[render] ERROR:', err.message);
    fs.rmSync(workDir, { recursive: true, force: true });
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`FFmpeg renderer on port ${PORT}`));
