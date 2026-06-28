const express = require('express');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
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

app.post('/extract-audio-full', (req, res) => {
  const { inputUrl, format = 'mp3' } = req.body;
  if (!inputUrl) return res.status(400).json({ error: 'inputUrl required' });
  
  const outFile = `/tmp/audio_${Date.now()}.mp3`;
  // Extract audio, compress heavily to stay under 25MB
  const cmd = `ffmpeg -i "${inputUrl}" -vn -acodec mp3 -ab 24k -ac 1 -ar 16000 -y "${outFile}"`;
  
  console.log('Extracting audio:', inputUrl);
  exec(cmd, { timeout: 300000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) {
      console.error('FFmpeg error:', err.message);
      return res.status(500).json({ error: err.message });
    }
    
    const stats = fs.statSync(outFile);
    console.log('Audio extracted, size:', Math.round(stats.size / 1024 / 1024), 'MB');
    
    res.setHeader('X-File-Size', stats.size);
    res.download(outFile, 'audio.mp3', (err) => {
      try { fs.unlinkSync(outFile); } catch(e) {}
    });
  });
});

app.post('/cut', (req, res) => {
  const { inputUrl, startSeconds, endSeconds } = req.body;
  if (!inputUrl) return res.status(400).json({ error: 'inputUrl required' });
  
  const outFile = `/tmp/clip_${Date.now()}.mp4`;
  const cmd = `ffmpeg -ss ${startSeconds} -to ${endSeconds} -i "${inputUrl}" -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2" -c:v libx264 -c:a aac -movflags +faststart -y "${outFile}"`;
  
  console.log('Cutting clip:', startSeconds, '-', endSeconds);
  exec(cmd, { timeout: 120000, maxBuffer: 10 * 1024 * 1024 }, (err) => {
    if (err) {
      console.error('Cut error:', err.message);
      return res.status(500).json({ error: err.message });
    }
    res.download(outFile, 'clip.mp4', (err) => {
      try { fs.unlinkSync(outFile); } catch(e) {}
    });
  });
});

app.post('/render', (req, res) => {
  const { inputUrl, captionStyle = {}, hookText = '' } = req.body;
  if (!inputUrl) return res.status(400).json({ error: 'inputUrl required' });
  
  const outFile = `/tmp/render_${Date.now()}.mp4`;
  const fontColor = (captionStyle.color || '#ffffff').replace('#', '');
  const fontSize = captionStyle.fontSize || 48;
  const position = captionStyle.position === 'TOP' ? '50' : 
                   captionStyle.position === 'CENTER' ? '(h/2)' : '(h-150)';
  const safeText = hookText.replace(/'/g, "\\'").replace(/:/g, "\\:").replace(/\n/g, ' ');
  
  const drawtext = safeText 
    ? `,drawtext=text='${safeText}':fontsize=${fontSize}:fontcolor=0x${fontColor}:x=(w-text_w)/2:y=${position}:borderw=3:bordercolor=black`
    : '';
    
  const cmd = `ffmpeg -i "${inputUrl}" -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2${drawtext}" -c:v libx264 -c:a aac -movflags +faststart -y "${outFile}"`;
  
  console.log('Rendering with captions');
  exec(cmd, { timeout: 180000, maxBuffer: 10 * 1024 * 1024 }, (err) => {
    if (err) {
      console.error('Render error:', err.message);
      return res.status(500).json({ error: err.message });
    }
    res.download(outFile, 'rendered.mp4', (err) => {
      try { fs.unlinkSync(outFile); } catch(e) {}
    });
  });
});

app.listen(PORT, () => console.log(`FFmpeg renderer on port ${PORT}`));
