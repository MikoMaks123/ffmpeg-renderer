const express = require('express');
const { execSync, exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

const API_KEY = process.env.API_KEY;

app.get('/health', (req, res) => res.json({ ok: true, status: 'ok' }));

function authMiddleware(req, res, next) {
  const key = req.headers['x-api-key'] || (req.headers['authorization'] || '').replace('Bearer ', '');
  if (API_KEY && key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}
app.use(authMiddleware);

app.post('/proxy-extract-audio-url', (req, res) => {
  const { sourceUrl } = req.body;
  if (!sourceUrl) return res.status(400).json({ error: 'sourceUrl required' });

  const workDir = path.join(os.tmpdir(), uuidv4());
  fs.mkdirSync(workDir, { recursive: true });
  const inputPath = path.join(workDir, 'input.mp4');
  const outPath = path.join(workDir, 'audio.mp3');

  console.log('[audio] Downloading via curl:', sourceUrl);
  exec(
    `curl -L --max-time 600 --retry 3 -A "Mozilla/5.0" -o "${inputPath}" "${sourceUrl}"`,
    { timeout: 620000 },
    (dlErr) => {
      if (dlErr) {
        fs.rmSync(workDir, { recursive: true, force: true });
        return res.status(500).json({ error: 'Download failed: ' + dlErr.message });
      }
      const sizeMB = (fs.statSync(inputPath).size / 1024 / 1024).toFixed(2);
      console.log('[audio] Downloaded:', sizeMB, 'MB');
      exec(
        `ffmpeg -i "${inputPath}" -vn -acodec mp3 -ab 24k -ac 1 -ar 16000 -y "${outPath}"`,
        { timeout: 300000, maxBuffer: 10 * 1024 * 1024 },
        (err) => {
          if (err) {
            fs.rmSync(workDir, { recursive: true, force: true });
            return res.status(500).json({ error: err.message });
          }
          const stat = fs.statSync(outPath);
          console.log('[audio] Done:', (stat.size / 1024 / 1024).toFixed(2), 'MB');
          res.setHeader('Content-Type', 'audio/mpeg');
          res.setHeader('Content-Length', stat.size);
          const stream = fs.createReadStream(outPath);
          stream.pipe(res);
          stream.on('close', () => fs.rmSync(workDir, { recursive: true, force: true }));
        }
      );
    }
  );
});

app.post('/full-pipeline', async (req, res) => {
  const { 
    inputUrl, startSeconds, endSeconds,
    captionStyle, hookText, blurBackground,
    supabaseUrl, supabaseKey, bucket, jobId
  } = req.body;

  if (!inputUrl) return res.status(400).json({ error: 'inputUrl required' });
  if (!supabaseUrl || !supabaseKey) return res.status(400).json({ error: 'supabase credentials required' });

  const workDir = path.join(os.tmpdir(), uuidv4());
  fs.mkdirSync(workDir, { recursive: true });
  const cutPath = path.join(workDir, 'cut.mp4');
  const assPath = path.join(workDir, 'subs.ass');
  const outPath = path.join(workDir, 'output.mp4');

  try {
    // STEP 1: Cut clip
    console.log('[pipeline] Cutting clip:', startSeconds, '-', endSeconds);
    await new Promise((resolve, reject) => {
      const args = [
        '-ss', String(Math.max(0, (startSeconds || 0) - 1)),
        '-to', String((endSeconds || 30) + 1),
        '-i', inputUrl,
        '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
        '-c:a', 'aac', '-movflags', '+faststart',
        '-y', cutPath
      ];
      const ff = spawn('ffmpeg', args);
      ff.stderr.on('data', d => process.stderr.write(d));
      ff.on('close', code => code === 0 ? resolve() : reject(new Error(`Cut failed: code ${code}`)));
    });

    const cutSize = (fs.statSync(cutPath).size / 1024 / 1024).toFixed(2);
    console.log('[pipeline] Cut done:', cutSize, 'MB');

    // STEP 2: Generate ASS captions
    let videoDuration = 30;
    try {
      const probe = execSync(
        `ffprobe -v error -show_entries format=duration -of csv=p=0 "${cutPath}"`,
        { encoding: 'utf8' }
      ).trim();
      videoDuration = parseFloat(probe) || 30;
    } catch (_) {}

    const assContent = generateASS(captionStyle || {}, [], hookText || '', videoDuration);
    fs.writeFileSync(assPath, assContent, 'utf8');

    // STEP 3: Render captions
    console.log('[pipeline] Rendering captions...');
    const assEscaped = assPath.replace(/\\/g, '/').replace(/:/g, '\\:');

    let vfFilter;
    if (blurBackground) {
      vfFilter = null; // use filter_complex
    } else {
      vfFilter = `ass=${assEscaped}`;
    }

    await new Promise((resolve, reject) => {
      let args;
      if (blurBackground) {
        args = [
          '-y', '-i', cutPath,
          '-filter_complex', `[0:v]scale=1080:1920,boxblur=20:5[bg];[0:v]scale=1080:608,setsar=1[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,ass=${assEscaped}`,
          '-c:v', 'libx264', '-crf', '18', '-preset', 'fast',
          '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart',
          outPath
        ];
      } else {
        args = [
          '-y', '-i', cutPath,
          '-vf', `ass=${assEscaped}`,
          '-c:v', 'libx264', '-crf', '18', '-preset', 'fast',
          '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart',
          outPath
        ];
      }
      const ff = spawn('ffmpeg', args);
      ff.stderr.on('data', d => process.stderr.write(d));
      ff.on('close', code => code === 0 ? resolve() : reject(new Error(`Render failed: code ${code}`)));
    });

    const outSize = (fs.statSync(outPath).size / 1024 / 1024).toFixed(2);
    console.log('[pipeline] Render done:', outSize, 'MB');

    // STEP 4: Upload to Supabase directly from Railway
    console.log('[pipeline] Uploading to Supabase...');
    const fileBuffer = fs.readFileSync(outPath);
    const fileName = `rendered_${jobId || uuidv4()}_${Date.now()}.mp4`;

    const uploadRes = await fetch(
      `${supabaseUrl}/storage/v1/object/${bucket}/${fileName}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'video/mp4',
          'x-upsert': 'true'
        },
        body: fileBuffer
      }
    );

    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      throw new Error('Supabase upload failed: ' + errText);
    }

    const outputUrl = `${supabaseUrl}/storage/v1/object/public/${bucket}/${fileName}`;
    console.log('[pipeline] Uploaded:', outputUrl);

    fs.rmSync(workDir, { recursive: true, force: true });

    res.json({ 
      outputUrl,
      duration: videoDuration,
      fileSize: outSize + 'MB'
    });

  } catch (err) {
    console.error('[pipeline] ERROR:', err.message);
    fs.rmSync(workDir, { recursive: true, force: true });
    res.status(500).json({ error: err.message });
  }
});

app.post('/proxy-cut-url', (req, res) => {
  const { sourceUrl, startSeconds, endSeconds } = req.body;
  if (!sourceUrl) return res.status(400).json({ error: 'sourceUrl required' });
  if (startSeconds == null || endSeconds == null) return res.status(400).json({ error: 'startSeconds and endSeconds required' });

  const workDir = path.join(os.tmpdir(), uuidv4());
  fs.mkdirSync(workDir, { recursive: true });
  const outPath = path.join(workDir, 'clip.mp4');

  // Use ffmpeg directly with URL — seeks without downloading full file
  const args = [
    '-ss', String(Math.max(0, startSeconds - 1)),
    '-to', String(endSeconds + 1),
    '-i', sourceUrl,
    '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
    '-c:a', 'aac', '-movflags', '+faststart',
    '-y', outPath,
  ];

  console.log('[cut] Cutting from URL directly:', sourceUrl, startSeconds, '-', endSeconds);
  const ff = spawn('ffmpeg', args);
  let stderrOutput = '';
  ff.stderr.on('data', d => {
    stderrOutput += d.toString();
    process.stderr.write(d);
  });
  ff.on('close', (code) => {
    if (code !== 0) {
      fs.rmSync(workDir, { recursive: true, force: true });
      return res.status(500).json({ 
        error: `ffmpeg exited with code ${code}`,
        stderr: stderrOutput.slice(-1000)
      });
    }
    const stat = fs.statSync(outPath);
    console.log('[cut] Done:', (stat.size / 1024 / 1024).toFixed(2), 'MB');
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Disposition', 'attachment; filename="clip.mp4"');
    const stream = fs.createReadStream(outPath);
    stream.pipe(res);
    stream.on('close', () => fs.rmSync(workDir, { recursive: true, force: true }));
  });
});

function hexToAss(hex, alpha = '00') {
  hex = (hex || '#ffffff').replace('#', '');
  if (hex.length === 6) {
    const r = hex.slice(0,2), g = hex.slice(2,4), b = hex.slice(4,6);
    return `&H${alpha}${b}${g}${r}`;
  }
  if (hex.length === 8) {
    const aa = hex.slice(0,2), r = hex.slice(2,4), g = hex.slice(4,6), b = hex.slice(6,8);
    return `&H${aa}${b}${g}${r}`;
  }
  return `&H00ffffff`;
}

function positionToAlignment(position) {
  switch ((position || 'BOTTOM').toUpperCase()) {
    case 'TOP': return 8;
    case 'CENTER': return 5;
    default: return 2;
  }
}

function applyTransform(text, transform) {
  switch ((transform || 'NONE').toUpperCase()) {
    case 'UPPERCASE': return text.toUpperCase();
    case 'CAPITALIZE': return text.replace(/\b\w/g, c => c.toUpperCase());
    default: return text;
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
  const { inputUrl, captionStyle, segments, hookText, 
          titleOverlay, blurBackground } = req.body;
  if (!inputUrl) return res.status(400).json({ error: 'inputUrl required' });

  const workDir = path.join(os.tmpdir(), uuidv4());
  fs.mkdirSync(workDir, { recursive: true });
  const inputPath = path.join(workDir, 'input.mp4');
  const assPath = path.join(workDir, 'subs.ass');
  const outputPath = path.join(workDir, 'output.mp4');

  try {
    console.log('[render] Downloading:', inputUrl);
    await new Promise((resolve, reject) => {
      exec(
        `curl -L --max-time 300 --retry 3 -A "Mozilla/5.0" -o "${inputPath}" "${inputUrl}"`,
        { timeout: 310000 },
        (err) => err ? reject(err) : resolve()
      );
    });

    let videoDuration = 30;
    try {
      const probe = execSync(
        `ffprobe -v error -show_entries format=duration -of csv=p=0 "${inputPath}"`,
        { encoding: 'utf8' }
      ).trim();
      videoDuration = parseFloat(probe) || 30;
    } catch (_) {}

    // Build ASS with optional title overlay
    const assContent = generateASSWithTitle(
      captionStyle, segments, hookText, videoDuration, titleOverlay
    );
    fs.writeFileSync(assPath, assContent, 'utf8');

    const assEscaped = assPath.replace(/\\/g, '/').replace(/:/g, '\\:');

    // Build video filter
    let vf;
    if (blurBackground) {
      vf = `[0:v]scale=1080:1920,boxblur=20:5[bg];[0:v]scale=1080:608,setsar=1[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,ass=${assEscaped}`;
    } else {
      vf = `scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,ass=${assEscaped}`;
    }

    await new Promise((resolve, reject) => {
      const args = blurBackground
        ? ['-y', '-i', inputPath,
           '-filter_complex', vf,
           '-c:v', 'libx264', '-crf', '18', '-preset', 'fast',
           '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart',
           outputPath]
        : ['-y', '-i', inputPath,
           '-vf', vf,
           '-c:v', 'libx264', '-crf', '18', '-preset', 'fast',
           '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart',
           outputPath];

      const ff = spawn('ffmpeg', args);
      ff.stderr.on('data', d => process.stderr.write(d));
      ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg code ${code}`)));
    });

    const stat = fs.statSync(outputPath);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Disposition', 'attachment; filename="output.mp4"');
    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on('close', () => fs.rmSync(workDir, { recursive: true, force: true }));

  } catch (err) {
    console.error('[render] ERROR:', err.message);
    fs.rmSync(workDir, { recursive: true, force: true });
    res.status(500).json({ error: err.message });
  }
});

function generateASSWithTitle(captionStyle, segments, hookText, videoDuration, titleOverlay) {
  const base = generateASS(captionStyle, segments, hookText, videoDuration);
  
  if (!titleOverlay || !titleOverlay.text) return base;

  const titleAlign = titleOverlay.position === 'TOP' ? 8 : 
                     titleOverlay.position === 'CENTER' ? 5 : 2;
  const titleColor = hexToAss((titleOverlay.color || '#ffffff').replace('#',''));
  const titleSize = titleOverlay.fontSize || 72;
  const titleBg = titleOverlay.showBackground ? '&H99000000' : '&H00000000';
  const safeTitle = (titleOverlay.text || '')
    .replace(/'/g, "\\'").replace(/:/g, "\\:");

  const titleStyle = `Style: Title,Impact,${titleSize},${titleColor},${titleColor},&H00000000,${titleBg},1,0,0,0,100,100,0,0,1,3,0,${titleAlign},40,40,60,1`;
  const titleDialogue = `Dialogue: 0,0:00:00.00,${toAssTime(videoDuration)},Title,,0,0,0,,${safeTitle}`;

  return base
    .replace('Style: Highlight,', titleStyle + '\nStyle: Highlight,')
    .replace('[Events]', '[Events]\n' + titleDialogue.split('\n')[0])
    .replace(
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n' + titleDialogue + '\n'
    );
}
app.listen(process.env.PORT || 3000, () => console.log('FFmpeg server running'));
