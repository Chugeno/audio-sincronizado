// server/index.js
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { setupWsHandler } from './ws-handler.js';
import { room } from './room.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);

// Configuración de WebSocket Server compartiendo el mismo puerto HTTP
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  setupWsHandler(ws, req);
});

// Configuración de Multer para la subida de archivos de audio
const audioDir = path.join(__dirname, '../public/audio');
if (!fs.existsSync(audioDir)) {
  fs.mkdirSync(audioDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, audioDir);
  },
  filename: function (req, file, cb) {
    // Usamos el nombre original precedido por un timestamp para evitar conflictos
    const safeName = file.originalname.replace(/[^a-z0-9.]/gi, '_').toLowerCase();
    cb(null, Date.now() + '-' + safeName); 
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 } // Límite de 50MB
});

// Middlewares HTTP
app.use(express.static(path.join(__dirname, '../public')));
app.use(express.json());

// Endpoint para subir audio (usado por el panel de admin)
app.post('/api/upload', upload.single('audioFile'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  
  // Guardamos el nombre en el estado de la sala
  room.audioFile = req.file.filename;
  room.audioDisplayName = req.file.originalname;
  
  res.json({ 
    success: true, 
    filename: req.file.filename,
    displayName: req.file.originalname,
    message: 'Audio uploaded successfully' 
  });
});

// Iniciar el servidor
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎵 SyncOrchestra Server corriendo en el puerto ${PORT}`);
  console.log(`📡 Escuchando en todas las interfaces de red (0.0.0.0)`);
});
