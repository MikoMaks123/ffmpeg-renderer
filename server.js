// Shorts Factory — FFmpeg render server (Railway).
// Deploy this whole folder to the Railway project the app points at
// (ffmpeg_endpoint_url). The Dockerfile installs ffmpeg WITH libass + fonts so
// the ass= caption filter actually burns captions.
//
// Endpoints:
//   POST /proxy-extract-audio-url  { sourceUrl }                    -> audio/mpeg (binary)
//   POST /proxy-cut-url            { sourceUrl, startSeconds, endSeconds } -> video/mp4 (binary)
//   POST /render                   { inputUrl, captionStyle, segments, hookText, titleOverlay, blurBackground } -> video/mp4 (binary)
//   POST /full-pipeline            { inputUrl, startSeconds, endSeconds, captionStyle, segments, hookText, titleOverlay, blurBackground, supabaseUrl, supabaseKey, bucket, jobId } -> { outputUrl, duration, fileSize }
//   GET  /health
const express = require('express');
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json({ limit: '2mb' }));

const API_KEY = process.env.API_KEY;
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const key = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  if (API_KEY && key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

// ── helpers ────────────────────────────────────────────────────────────────
function hexToAss(hex, alpha = '00') {
  hex = (hex || '#ffffff').replace('#', '');
  if (hex.length === 6) { const r = hex.slice(0,2), g = hex.slice(2,4), b = hex.slice(4,6); return `&H${alpha}${b}${g}${r}`; }
  if (hex.length === 8) { const aa = hex.slice(0,2), r = hex.slice(2,4), g = hex.slice(4,6), b = hex.slice(6,8); return `&H${aa}${b}${g}${r}`; }
  return `&H00ffffff`;
}
function positionToAlignment(position) {
  switch ((position || 'BOTTOM').toUpperCase()) { case 'TOP': return 8; case 'CENTER': return 5; default: return 2; }
}
function applyTransform(text, transform) {
  switch ((transform || 'NONE').toUpperCase()) {
    case 'UPPERCASE': return (text || '').toUpperCase();
    case 'CAPITALIZE': return (text || '').replace(/\b\w/g, c => c.toUpperCase());
    default: return text || '';
  }
}
function chunkWords(text, n) {
  const words = (text || '').split(/\s+/).filter(Boolean);
  const chunks = [];
  for (let i = 0; i < words.length; i += n) chunks.push(words.slice(i, i + n));
  return chunks;
}
function toAssTime(seconds) {
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = Math.floor(seconds % 60), cs = Math.round((seconds % 1) * 100);
  return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(cs).padStart(2,'0')}`;
}

// IMPORTANT: when a filter's file argument is passed inline in -vf/-filter_complex,
// the filtergraph parser needs the path escaped ('\' before : and ') — otherwise you
// get "No option name near <path>". We write the .ass with a plain name in the cwd of
// the ffmpeg call and reference it by a fully-escaped absolute path.
function escapeFilterPath(p) {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function generateASS(captionStyle, segments, hookText, videoDuration) {
  const {
    fontFamily = 'DejaVu Sans', fontSize = 48, color = '#ffffff',
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
    lines.push(`Dialogue: 0,${toAssTime(0)},${toAssTime(videoDuration || 30)},Default,,0,0,0,,${applyTransform(hookText || '', textTransform)}`);
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
        const cs = segStart + i * chunkDur, ce = cs + chunkDur;
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
Style: Title,DejaVu Sans,${fontSize},${primaryColor},${primaryColor},&H00000000,${bgColor},1,0,0,0,100,100,0,0,${showBackground ? 3 : 1},0,0,${alignment},40,40,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,${toAssTime(videoDuration)},Title,,0,0,0,,${text}
`;
}

function runFfmpeg(args, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', args, { timeout: timeoutMs });
    let stderr = '';
    ff.stderr.on('data', d => { process.stderr.write(d); stderr += d.toString(); });
    ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-500)}`)));
    ff.on('error', reject);
  });
}

// ── /proxy-extract-audio-url ────────────────────────────────────────────────
app.post('/proxy-extract-audio-url', (req, res) => {
  const { sourceUrl } = req.body;
  if (!sourceUrl) return res.status(400).json({ error: 'sourceUrl required' });
  const workDir = path.join(os.tmpdir(), uuidv4());
  fs.mkdirSync(workDir, { recursive: true });
  const outPath = path.join(workDir, 'audio.mp3');
  const args = ['-user_agent', 'Mozilla/5.0', '-i', sourceUrl, '-vn', '-acodec', 'mp3', '-ab', '24k', '-ac', '1', '-ar', '16000', '-y', outPath];
  const ff = spawn('ffmpeg', args, { timeout: 300000 });
  ff.stderr.on('data', d => process.stderr.write(d));
  ff.on('close', code => {
    if (code !== 0) { fs.rmSync(workDir, { recursive: true, force: true }); return res.status(500).json({ error: `ffmpeg exited ${code}` }); }
    const stat = fs.statSync(outPath);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', stat.size);
    const s = fs.createReadStream(outPath); s.pipe(res);
    s.on('close', () => fs.rmSync(workDir, { recursive: true, force: true }));
  });
});

// ── /proxy-cut-url ──────────────────────────────────────────────────────────
app.post('/proxy-cut-url', (req, res) => {
  const { sourceUrl, startSeconds, endSeconds } = req.body;
  if (!sourceUrl) return res.status(400).json({ error: 'sourceUrl required' });
  if (startSeconds == null || endSeconds == null) return res.status(400).json({ error: 'startSeconds and endSeconds required' });
  const workDir = path.join(os.tmpdir(), uuidv4());
  fs.mkdirSync(workDir, { recursive: true });
  const outPath = path.join(workDir, 'clip.mp4');
  const args = ['-user_agent', 'Mozilla/5.0', '-ss', String(startSeconds), '-to', String(endSeconds), '-i', sourceUrl,
    '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-c:a', 'aac', '-movflags', '+faststart', '-y', outPath];
  let stderrBuf = '';
  const ff = spawn('ffmpeg', args, { timeout: 180000 });
  ff.stderr.on('data', d => { process.stderr.write(d); stderrBuf += d.toString(); });
  ff.on('close', code => {
    if (code !== 0) { fs.rmSync(workDir, { recursive: true, force: true }); return res.status(500).json({ error: `ffmpeg exited ${code}: ${stderrBuf.slice(-300)}` }); }
    const stat = fs.statSync(outPath);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', stat.size);
    const s = fs.createReadStream(outPath); s.pipe(res);
    s.on('close', () => fs.rmSync(workDir, { recursive: true, force: true }));
  });
});

// ── /render (binary out) ────────────────────────────────────────────────────
app.post('/render', async (req, res) => {
  const { inputUrl, captionStyle, segments, hookText, titleOverlay, blurBackground } = req.body;
  if (!inputUrl) return res.status(400).json({ error: 'inputUrl required' });
  const workDir = path.join(os.tmpdir(), uuidv4());
  fs.mkdirSync(workDir, { recursive: true });
  const inputPath = path.join(workDir, 'input.mp4');
  const outputPath = path.join(workDir, 'output.mp4');
  try {
    const r = await fetch(inputUrl);
    if (!r.ok) throw new Error(`download HTTP ${r.status}`);
    fs.writeFileSync(inputPath, Buffer.from(await r.arrayBuffer()));
    let dur = 30;
    try { dur = parseFloat(execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${inputPath}"`, { encoding: 'utf8' }).trim()) || 30; } catch (_) {}
    fs.writeFileSync(path.join(workDir, 'subs.ass'), generateASS(captionStyle, segments, hookText, dur), 'utf8');
    const captionFilter = buildCaptionFilter(workDir, titleOverlay, dur);
    const vf = `scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,${captionFilter}`;
    await runFfmpeg(['-y', '-i', inputPath, '-vf', vf, '-c:v', 'libx264', '-crf', '20', '-preset', 'fast', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', outputPath]);
    const stat = fs.statSync(outputPath);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', stat.size);
    const s = fs.createReadStream(outputPath); s.pipe(res);
    s.on('close', () => fs.rmSync(workDir, { recursive: true, force: true }));
  } catch (err) {
    fs.rmSync(workDir, { recursive: true, force: true });
    res.status(500).json({ error: err.message });
  }
});

// Build the caption filter (captions + optional title), writing .ass files into workDir
// and referencing them with escaped absolute paths.
function buildCaptionFilter(workDir, titleOverlay, dur) {
  const assEscaped = escapeFilterPath(path.join(workDir, 'subs.ass'));
  let filter = `ass='${assEscaped}'`;
  if (titleOverlay && titleOverlay.text) {
    const titlePath = path.join(workDir, 'title.ass');
    fs.writeFileSync(titlePath, generateTitleASS(titleOverlay, dur), 'utf8');
    filter += `,ass='${escapeFilterPath(titlePath)}'`;
  }
  return filter;
}

// ── /full-pipeline (cut + caption + upload to Supabase; returns URL only) ─────
app.post('/full-pipeline', async (req, res) => {
  const { inputUrl, startSeconds, endSeconds, captionStyle, hookText, segments, blurBackground, titleOverlay, supabaseUrl, supabaseKey, bucket = 'rendered-videos', jobId } = req.body;
  if (!inputUrl) return res.status(400).json({ error: 'inputUrl required' });
  if (!supabaseUrl) return res.status(400).json({ error: 'supabaseUrl required' });
  if (!supabaseKey) return res.status(400).json({ error: 'supabaseKey required' });
  if (startSeconds == null || endSeconds == null) return res.status(400).json({ error: 'startSeconds and endSeconds required' });

  const workDir = path.join(os.tmpdir(), uuidv4());
  fs.mkdirSync(workDir, { recursive: true });
  const cutPath = path.join(workDir, 'cut.mp4');
  const outputPath = path.join(workDir, 'output.mp4');
  try {
    // 1) cut clip (stream copy)
    await runFfmpeg(['-user_agent', 'Mozilla/5.0', '-ss', String(startSeconds), '-to', String(endSeconds), '-i', inputUrl,
      '-c', 'copy', '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', '-y', cutPath], 120000);

    // 2) duration
    let dur = endSeconds - startSeconds;
    try { dur = parseFloat(execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${cutPath}"`, { encoding: 'utf8' }).trim()) || dur; } catch (_) {}

    // 3) captions
    fs.writeFileSync(path.join(workDir, 'subs.ass'), generateASS(captionStyle, segments, hookText, dur), 'utf8');
    const captionFilter = buildCaptionFilter(workDir, titleOverlay, dur);

    // 4) render (720p to stay within memory)
    let renderArgs;
    if (blurBackground) {
      const fc = `[0:v]scale=720:1280,boxblur=20:5[bg];[0:v]scale=720:405,setsar=1[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,${captionFilter}`;
      renderArgs = ['-y', '-i', cutPath, '-filter_complex', fc, '-c:v', 'libx264', '-crf', '28', '-preset', 'ultrafast', '-threads', '1', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', outputPath];
    } else {
      const vf = `scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2,${captionFilter}`;
      renderArgs = ['-y', '-i', cutPath, '-vf', vf, '-c:v', 'libx264', '-crf', '28', '-preset', 'ultrafast', '-threads', '1', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', outputPath];
    }
    await runFfmpeg(renderArgs, 280000);

    // 5) upload to Supabase
    const stat = fs.statSync(outputPath);
    const fileName = `rendered_${jobId || uuidv4()}_${Date.now()}.mp4`;
    const up = await fetch(`${supabaseUrl}/storage/v1/object/${bucket}/${fileName}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${supabaseKey}`, 'Content-Type': 'video/mp4', 'x-upsert': 'true' },
      body: fs.readFileSync(outputPath),
    });
    if (!up.ok) throw new Error(`Supabase upload failed (HTTP ${up.status}): ${(await up.text()).slice(0, 300)}`);
    const outputUrl = `${supabaseUrl}/storage/v1/object/public/${bucket}/${fileName}`;
    fs.rmSync(workDir, { recursive: true, force: true });
    res.json({ outputUrl, duration: dur, fileSize: stat.size });
  } catch (err) {
    fs.rmSync(workDir, { recursive: true, force: true });
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true, ffmpeg: hasLibass() }));

// Report whether this ffmpeg build has the ass filter (needs libass).
function hasLibass() {
  try { return execSync('ffmpeg -hide_banner -filters 2>/dev/null | grep -c " ass "', { encoding: 'utf8' }).trim() !== '0'; }
  catch (_) { return false; }
}

app.listen(process.env.PORT || 3000, () => console.log('FFmpeg server on ' + (process.env.PORT || 3000) + ' (libass=' + hasLibass() + ')'));
