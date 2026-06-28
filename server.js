const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const app = express();
app.use(express.json());

const API_KEY = process.env.API_KEY || 'changeme';
const PORT = process.env.PORT || 3000;

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use((req, res, next) => {
  if (req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

app.post('/extract-audio-full', (req, res) => {
  const { inputUrl } = req.body;
  const outFile = `/tmp/audio_${Date.now()}.mp3`;
  const cmd = `ffmpeg -i "${inputUrl}" -vn -acodec mp3 -ab 16k -ac 1 -ar 16000 -y ${outFile}`;
  exec(cmd, { timeout: 120000 }, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.download(outFile, () => fs.unlinkSync(outFile));
  });
});

app.post('/extract-audio', (req, res) => {
  const { inputUrl, bitrate = '16k' } = req.body;
  const outFile = `/tmp/audio_${Date.now()}.mp3`;
  const cmd = `ffmpeg -i "${inputUrl}" -vn -acodec mp3 -ab ${bitrate} -ac 1 -ar 16000 -y ${outFile}`;
  exec(cmd, { timeout: 120000 }, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.download(outFile, () => fs.unlinkSync(outFile));
  });
});

app.post('/cut', (req, res) => {
  const { inputUrl, startSeconds, endSeconds } = req.body;
  const outFile = `/tmp/clip_${Date.now()}.mp4`;
  const cmd = `ffmpeg -ss ${startSeconds} -to ${endSeconds} -i "${inputUrl}" -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2" -c:v libx264 -c:a aac -y ${outFile}`;
  exec(cmd, { timeout: 120000 }, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.download(outFile, () => fs.unlinkSync(outFile));
  });
});

app.post('/render', (req, res) => {
  const { inputUrl, captionStyle, hookText } = req.body;
  const outFile = `/tmp/render_${Date.now()}.mp4`;
  const fontColor = (captionStyle.color || '#ffffff').replace('#', '');
  const fontSize = captionStyle.fontSize || 48;
  const position = captionStyle.position === 'TOP' ? '50' : captionStyle.position === 'CENTER' ? '(h/2)' : '(h-100)';
  const safeText = (hookText || '').replace(/'/g, "\\'").replace(/:/g, "\\:");
  const cmd = `ffmpeg -i "${inputUrl}" -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,drawtext=text='${safeText}':fontsize=${fontSize}:fontcolor=0x${fontColor}:x=(w-text_w)/2:y=${position}:borderw=3:bordercolor=black" -c:v libx264 -c:a aac -y ${outFile}`;
  exec(cmd, { timeout: 120000 }, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.download(outFile, () => fs.unlinkSync(outFile));
  });
});

app.listen(PORT, () => console.log(`FFmpeg renderer on port ${PORT}`));
