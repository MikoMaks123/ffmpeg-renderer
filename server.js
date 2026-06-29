# FFmpeg Railway Server — Complete server.js

> **⚠️ ACTION REQUIRED: Replace your entire Railway `server.js` with the code below and push to redeploy.**
>
> The previous version used `curl` or downloaded the full video to disk before running ffmpeg.  
> This version streams directly via ffmpeg's built-in HTTP client — no curl, no wget, no full download needed.

---

## Complete server.js — copy this entire file

```js
const express = require('express');
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

const API_KEY = process.env.API_KEY;
function authMiddleware(req, res, next) {
  const key = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  if (API_KEY && key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}
app.use(authMiddleware);

// ──────────────────────────────────────────────
// POST /proxy-extract-audio-url
// Streams video directly from URL via ffmpeg HTTP — no curl, no local download
// ──────────────────────────────────────────────
app.post('/proxy-extract-audio-url', (req, res) => {
  const { sourceUrl } = req.body;
  if (!sourceUrl) return res.status(400).json({ error: 'sourceUrl required' });

  const workDir = path.join(os.tmpdir(), uuidv4());
  fs.mkdirSync(workDir, { recursive: true });
  const outPath = path.join(workDir, 'audio.mp3');

  // ffmpeg reads directly from the URL — no curl dependency
  const args = [
    '-user_agent', 'Mozilla/5.0',
    '-i', sourceUrl,
    '-vn', '-acodec', 'mp3', '-ab', '24k', '-ac', '1', '-ar', '16000',
    '-y', outPath,
  ];
  console.log(`[proxy-extract-audio-url] ffmpeg ${args.join(' ')}`);

  const ff = spawn('ffmpeg', args, { timeout: 300000 });
  ff.stderr.on('data', d => process.stderr.write(d));
  ff.on('close', (code) => {
    if (code !== 0) {
      fs.rmSync(workDir, { recursive: true, force: true });
      return res.status(500).json({ error: `ffmpeg exited with code ${code}` });
    }
    const stat = fs.statSync(outPath);
    console.log(`[proxy-extract-audio-url] Done: ${(stat.size / 1024 / 1024).toFixed(2)}MB`);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', stat.size);
    const stream = fs.createReadStream(outPath);
    stream.pipe(res);
    stream.on('close', () => fs.rmSync(workDir, { recursive: true, force: true }));
    stream.on('error', () => fs.rmSync(workDir, { recursive: true, force: true }));
  });
});

// ──────────────────────────────────────────────
// POST /proxy-cut-url
// Seeks directly in the source URL — only fetches the needed bytes
// ──────────────────────────────────────────────
app.post('/proxy-cut-url', (req, res) => {
  const { sourceUrl, startSeconds, endSeconds } = req.body;
  if (!sourceUrl) return res.status(400).json({ error: 'sourceUrl required' });
  if (startSeconds == null || endSeconds == null) return res.status(400).json({ error: 'startSeconds and endSeconds required' });

  const workDir = path.join(os.tmpdir(), uuidv4());
  fs.mkdirSync(workDir, { recursive: true });
  const outPath = path.join(workDir, 'clip.mp4');

  const args = [
    '-user_agent', 'Mozilla/5.0',
    '-ss', String(startSeconds),
    '-to', String(endSeconds),
    '-i', sourceUrl,
    '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
    '-c:a', 'aac', '-movflags', '+faststart',
    '-y', outPath,
  ];
  console.log(`[proxy-cut-url] ffmpeg ${args.join(' ')}`);

  const ff = spawn('ffmpeg', args, { timeout: 180000 });
  ff.stderr.on('data', d => process.stderr.write(d));
  ff.on('close', (code) => {
    if (code !== 0) {
      fs.rmSync(workDir, { recursive: true, force: true });
      return res.status(500).json({ error: `ffmpeg exited with code ${code}` });
    }
    const stat = fs.statSync(outPath);
    console.log(`[proxy-cut-url] Done: ${(stat.size / 1024 / 1024).toFixed(2)}MB`);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Disposition', 'attachment; filename="clip.mp4"');
    const stream = fs.createReadStream(outPath);
    stream.pipe(res);
    stream.on('close', () => fs.rmSync(workDir, { recursive: true, force: true }));
    stream.on('error', () => fs.rmSync(workDir, { recursive: true, force: true }));
  });
});

// ──────────────────────────────────────────────
// POST /render
// Burns ASS subtitles into a clip. inputUrl should be a small Supabase clip URL.
// ──────────────────────────────────────────────
function hexToAss(hex, alpha = '00') {
  hex = (hex || '#ffffff').replace('#', '');
  if (hex.length === 6) {
    const [r, g, b] = [hex.slice(0,2), hex.slice(2,4), hex.slice(4,6)];
    return `&H${alpha}${b}${g}${r}`;
  }
  if (hex.length === 8) {
    const [aa, r, g, b] = [hex.slice(0,2), hex.slice(2,4), hex.slice(4,6), hex.slice(6,8)];
    return `&H${aa}${b}${g}${r}`;
  }
  return `&H00ffffff`;
}

function positionToAlignment(position) {
  switch ((position || 'BOTTOM').toUpperCase()) {
    case 'TOP':    return 8;
    case 'CENTER': return 5;
    default:       return 2;
  }
}

function applyTransform(text, transform) {
  switch ((transform || 'NONE').toUpperCase()) {
    case 'UPPERCASE':  return text.toUpperCase();
    case 'CAPITALIZE': return text.replace(/\b\w/g, c => c.toUpperCase());
    default:           return text;
  }
}

function chunkWords(text, n) {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks = [];
  for (let i = 0; i < words.length; i += n) chunks.push(words.slice(i, i + n));
  return chunks;
}

function toAssTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.round((seconds % 1) * 100);
  return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(cs).padStart(2,'0')}`;
}

function generateASS(captionStyle, segments, hookText, videoDuration) {
  const {
    fontFamily = 'Arial', fontSize = 48, color = '#ffffff',
    strokeColor = '#000000', strokeWidth = 2, position = 'BOTTOM',
    animation = 'WORD_BY_WORD', textTransform = 'NONE', maxWordsPerLine = 3,
  } = captionStyle || {};

  const alignment = positionToAlignment(position);
  const primaryColor = hexToAss(color);
  const outlineColor = hexToAss(strokeColor);
  const highlightColor = hexToAss('#ffff00');
  const outline = strokeWidth || 2;
  const anim = (animation || 'WORD_BY_WORD').toUpperCase();

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${fontFamily},${fontSize},${primaryColor},${primaryColor},${outlineColor},&H00000000,1,0,0,0,100,100,0,0,1,${outline},0,${alignment},40,40,60,1
Style: Highlight,${fontFamily},${fontSize},${highlightColor},${highlightColor},${outlineColor},&H00000000,1,0,0,0,100,100,0,0,1,${outline},0,${alignment},40,40,60,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const lines = [];
  if (!segments || segments.length === 0) {
    const text = applyTransform(hookText || '', textTransform);
    lines.push(`Dialogue: 0,${toAssTime(0)},${toAssTime(videoDuration || 30)},Default,,0,0,0,,${text}`);
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
      const mw = Math.max(1, maxWordsPerLine || 3);
      const chunks = chunkWords(rawText, mw);
      if (!chunks.length) continue;
      const chunkDur = (segEnd - segStart) / chunks.length;
      for (let i = 0; i < chunks.length; i++) {
        const cs = segStart + i * chunkDur;
        const ce = cs + chunkDur;
        lines.push(`Dialogue: 0,${toAssTime(cs)},${toAssTime(ce)},Highlight,,0,0,0,,${chunks[i].join(' ')}`);
      }
    }
  }

  return header + lines.join('\n');
}

app.post('/render', async (req, res) => {
  const { inputUrl, captionStyle, segments, hookText } = req.body;
  if (!inputUrl) return res.status(400).json({ error: 'inputUrl required' });

  const workDir = path.join(os.tmpdir(), uuidv4());
  fs.mkdirSync(workDir, { recursive: true });
  const inputPath  = path.join(workDir, 'input.mp4');
  const assPath    = path.join(workDir, 'subs.ass');
  const outputPath = path.join(workDir, 'output.mp4');

  try {
    console.log(`[render] Downloading: ${inputUrl}`);
    const videoRes = await fetch(inputUrl);
    if (!videoRes.ok) throw new Error(`Failed to download video: HTTP ${videoRes.status}`);
    const videoBuffer = await videoRes.arrayBuffer();
    fs.writeFileSync(inputPath, Buffer.from(videoBuffer));

    let videoDuration = 30;
    try {
      const probe = execSync(
        `ffprobe -v error -show_entries format=duration -of csv=p=0 "${inputPath}"`,
        { encoding: 'utf8' }
      ).trim();
      videoDuration = parseFloat(probe) || 30;
    } catch (_) {}

    const assContent = generateASS(captionStyle, segments, hookText, videoDuration);
    fs.writeFileSync(assPath, assContent, 'utf8');
    console.log(`[render] ASS generated (${assContent.length} chars), duration=${videoDuration}s`);

    const assEscaped = assPath.replace(/\\/g, '/').replace(/:/g, '\\:');

    await new Promise((resolve, reject) => {
      const args = [
        '-y', '-i', inputPath,
        '-vf', `scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,ass=${assEscaped}`,
        '-c:v', 'libx264', '-crf', '18', '-preset', 'fast',
        '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart',
        outputPath,
      ];
      console.log(`[render] ffmpeg ${args.join(' ')}`);
      const ff = spawn('ffmpeg', args);
      ff.stderr.on('data', d => process.stderr.write(d));
      ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)));
    });

    const stat = fs.statSync(outputPath);
    console.log(`[render] Done — ${(stat.size / 1024 / 1024).toFixed(2)}MB`);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Disposition', 'attachment; filename="output.mp4"');
    const readStream = fs.createReadStream(outputPath);
    readStream.pipe(res);
    readStream.on('close', () => fs.rmSync(workDir, { recursive: true, force: true }));
  } catch (err) {
    console.error(`[render] ERROR: ${err.message}`);
    fs.rmSync(workDir, { recursive: true, force: true });
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(process.env.PORT || 3000, () => console.log('FFmpeg server running'));
```

---

## Deploy

```bash
git add server.js && git commit -m "fix: use spawn+ffmpeg HTTP, no curl" && git push
```

Railway auto-deploys on push.

---

## Endpoint Summary

| Endpoint | Method | Purpose | How it accesses the video |
|---|---|---|---|
| `/proxy-extract-audio-url` | POST | Full video → MP3 audio | `ffmpeg -i <url>` — native HTTP, no curl |
| `/proxy-cut-url` | POST | Full video → trimmed MP4 | `ffmpeg -ss -to -i <url>` — HTTP seek |
| `/render` | POST | Clip MP4 → captioned MP4 | `fetch()` (clips are small Supabase URLs) |
| `/health` | GET | Health check | — |
