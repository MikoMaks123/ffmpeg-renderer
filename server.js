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
// ──────────────────────────────────────────────
app.post('/proxy-extract-audio-url', (req, res) => {
  const { sourceUrl } = req.body;
  if (!sourceUrl) return res.status(400).json({ error: 'sourceUrl required' });

  const workDir = path.join(os.tmpdir(), uuidv4());
  fs.mkdirSync(workDir, { recursive: true });
  const outPath = path.join(workDir, 'audio.mp3');

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

  let stderrBuf = '';
  const ff = spawn('ffmpeg', args, { timeout: 180000 });
  ff.stderr.on('data', d => { process.stderr.write(d); stderrBuf += d.toString(); });
  ff.on('close', (code) => {
    if (code !== 0) {
      fs.rmSync(workDir, { recursive: true, force: true });
      return res.status(500).json({ error: `ffmpeg exited with code ${code}: ${stderrBuf.slice(-300)}` });
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
// ASS subtitle helpers
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

function generateTitleASS(titleOverlay, videoDuration) {
  const { text, fontSize = 72, position = 'TOP', color = '#ffffff', showBackground = true } = titleOverlay;
  const alignment = position === 'TOP' ? 8 : position === 'CENTER' ? 5 : 2;
  const primaryColor = hexToAss(color);
  const bgColor = showBackground ? '&H99000000' : '&H00000000';
  const marginV = position === 'TOP' ? 80 : 60;

  return `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Title,Impact,${fontSize},${primaryColor},${primaryColor},&H00000000,${bgColor},1,0,0,0,100,100,0,0,${showBackground ? 3 : 1},0,0,${alignment},40,40,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,${toAssTime(videoDuration)},Title,,0,0,0,,${text}
`;
}

// ──────────────────────────────────────────────
// POST /render
// Burns captions into a pre-cut clip (downloads from URL)
// ──────────────────────────────────────────────
app.post('/render', async (req, res) => {
  const { inputUrl, captionStyle, segments, hookText, titleOverlay, blurBackground } = req.body;
  if (!inputUrl) return res.status(400).json({ error: 'inputUrl required' });

  const workDir  = path.join(os.tmpdir(), uuidv4());
  fs.mkdirSync(workDir, { recursive: true });
  const inputPath  = path.join(workDir, 'input.mp4');
  const assPath    = path.join(workDir, 'subs.ass');
  const titlePath  = path.join(workDir, 'title.ass');
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
    const assEscaped = assPath.replace(/\\/g, '/').replace(/:/g, '\\:');

    let titleEscaped = null;
    if (titleOverlay?.text) {
      fs.writeFileSync(titlePath, generateTitleASS(titleOverlay, videoDuration), 'utf8');
      titleEscaped = titlePath.replace(/\\/g, '/').replace(/:/g, '\\:');
    }

    const captionFilter = titleEscaped
      ? `ass=${assEscaped},ass=${titleEscaped}`
      : `ass=${assEscaped}`;

    let ffArgs;
    if (blurBackground) {
      const fc = `[0:v]scale=1080:1920,boxblur=20:5[bg];[0:v]scale=1080:608,setsar=1[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,${captionFilter}`;
      ffArgs = ['-y', '-i', inputPath, '-filter_complex', fc, '-c:v', 'libx264', '-crf', '18', '-preset', 'fast', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', outputPath];
    } else {
      const vf = `scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,${captionFilter}`;
      ffArgs = ['-y', '-i', inputPath, '-vf', vf, '-c:v', 'libx264', '-crf', '18', '-preset', 'fast', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', outputPath];
    }

    console.log(`[render] ffmpeg ${ffArgs.join(' ').slice(0, 300)}`);

    await new Promise((resolve, reject) => {
      const ff = spawn('ffmpeg', ffArgs);
      let stderrBuf = '';
      ff.stderr.on('data', d => { process.stderr.write(d); stderrBuf += d.toString(); });
      ff.on('close', code => code === 0 ? resolve() : reject(new Error(`Render failed (code ${code}): ${stderrBuf.slice(-300)}`)));
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

// ──────────────────────────────────────────────
// POST /full-pipeline
// Cut (stream copy) + render captions + upload to Supabase
// ──────────────────────────────────────────────
app.post('/full-pipeline', async (req, res) => {
  const {
    inputUrl, startSeconds, endSeconds,
    captionStyle, hookText, segments, blurBackground, titleOverlay,
    supabaseUrl, supabaseKey, bucket = 'rendered-videos', jobId,
  } = req.body;

  if (!inputUrl)    return res.status(400).json({ error: 'inputUrl required' });
  if (!supabaseUrl) return res.status(400).json({ error: 'supabaseUrl required' });
  if (!supabaseKey) return res.status(400).json({ error: 'supabaseKey required' });
  if (startSeconds == null || endSeconds == null) return res.status(400).json({ error: 'startSeconds and endSeconds required' });

  const workDir  = path.join(os.tmpdir(), uuidv4());
  fs.mkdirSync(workDir, { recursive: true });
  const cutPath    = path.join(workDir, 'cut.mp4');
  const assPath    = path.join(workDir, 'subs.ass');
  const titlePath  = path.join(workDir, 'title.ass');
  const outputPath = path.join(workDir, 'output.mp4');

  try {
    // ── Step 1: Cut using stream copy — no re-encode, no OOM ──
    console.log(`[full-pipeline] Cutting ${startSeconds}s-${endSeconds}s from ${inputUrl}`);
    const cutArgs = [
      '-user_agent', 'Mozilla/5.0',
      '-ss', String(startSeconds),
      '-to', String(endSeconds),
      '-i', inputUrl,
      '-c', 'copy',
      '-avoid_negative_ts', 'make_zero',
      '-movflags', '+faststart',
      '-y', cutPath,
    ];
    await new Promise((resolve, reject) => {
      const ff = spawn('ffmpeg', cutArgs, { timeout: 120000 });
      let stderrBuf = '';
      ff.stderr.on('data', d => { process.stderr.write(d); stderrBuf += d.toString(); });
      ff.on('close', code => code === 0 ? resolve() : reject(new Error(`Cut failed (code ${code}): ${stderrBuf.slice(-300)}`)));
    });

    // ── Step 2: Probe duration ──
    let videoDuration = endSeconds - startSeconds;
    try {
      const probe = execSync(
        `ffprobe -v error -show_entries format=duration -of csv=p=0 "${cutPath}"`,
        { encoding: 'utf8' }
      ).trim();
      videoDuration = parseFloat(probe) || videoDuration;
    } catch (_) {}

    // ── Step 3: Generate ASS subtitles ──
    const assContent = generateASS(captionStyle, segments, hookText, videoDuration);
    fs.writeFileSync(assPath, assContent, 'utf8');
    const assEscaped = assPath.replace(/\\/g, '/').replace(/:/g, '\\:');

    let titleEscaped = null;
    if (titleOverlay?.text) {
      fs.writeFileSync(titlePath, generateTitleASS(titleOverlay, videoDuration), 'utf8');
      titleEscaped = titlePath.replace(/\\/g, '/').replace(/:/g, '\\:');
    }

    const captionFilter = titleEscaped
      ? `ass=${assEscaped},ass=${titleEscaped}`
      : `ass=${assEscaped}`;

    // ── Step 4: Render captions ──
    console.log(`[full-pipeline] Rendering captions, blurBackground=${blurBackground}`);
    let renderArgs;
    if (blurBackground) {
      const fc = `[0:v]scale=1080:1920,boxblur=20:5[bg];[0:v]scale=1080:608,setsar=1[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,${captionFilter}`;
      renderArgs = ['-y', '-i', cutPath, '-filter_complex', fc, '-c:v', 'libx264', '-crf', '18', '-preset', 'fast', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', outputPath];
    } else {
      const vf = `scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,${captionFilter}`;
      renderArgs = ['-y', '-i', cutPath, '-vf', vf, '-c:v', 'libx264', '-crf', '18', '-preset', 'fast', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', outputPath];
    }

    await new Promise((resolve, reject) => {
      const ff = spawn('ffmpeg', renderArgs);
      let stderrBuf = '';
      ff.stderr.on('data', d => { process.stderr.write(d); stderrBuf += d.toString(); });
      ff.on('close', code => code === 0 ? resolve() : reject(new Error(`Render failed (code ${code}): ${stderrBuf.slice(-300)}`)));
    });

    // ── Step 5: Upload to Supabase ──
    const stat = fs.statSync(outputPath);
    console.log(`[full-pipeline] Uploading ${(stat.size / 1024 / 1024).toFixed(2)}MB to Supabase bucket=${bucket}`);

    const fileName  = `rendered_${jobId || uuidv4()}_${Date.now()}.mp4`;
    const fileBytes = fs.readFileSync(outputPath);

    const uploadRes = await fetch(`${supabaseUrl}/storage/v1/object/${bucket}/${fileName}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'video/mp4',
        'x-upsert': 'true',
      },
      body: fileBytes,
    });

    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      throw new Error(`Supabase upload failed (HTTP ${uploadRes.status}): ${errText.slice(0, 300)}`);
    }

    const outputUrl = `${supabaseUrl}/storage/v1/object/public/${bucket}/${fileName}`;
    console.log(`[full-pipeline] Done: ${outputUrl}`);

    fs.rmSync(workDir, { recursive: true, force: true });
    res.json({ outputUrl, duration: videoDuration, fileSize: stat.size });

  } catch (err) {
    console.error(`[full-pipeline] ERROR: ${err.message}`);
    fs.rmSync(workDir, { recursive: true, force: true });
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(process.env.PORT || 3000, () => console.log('FFmpeg server running'));
