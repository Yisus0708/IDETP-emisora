/**
 * Servidor de la Emisora Escolar IDETP
 * Express (estáticos + rutas) + Socket.io (chat / señalización WebRTC)
 * Todo el estado vive en memoria del proceso Node. No hay base de datos.
 */

const express = require('express');
const http = require('http');
const path = require('path');
const os = require('os');
const { Server } = require('socket.io');
const ytdlp = require('yt-dlp-exec');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const MAX_CHAT_HISTORY = 100;
const MAX_NICKNAME_LEN = 24;
const MAX_MESSAGE_LEN = 300;
const ALLOWED_REACTIONS = ['👍', '❤️', '🎉', '👏', '😂', '🔥', '😮'];

app.use(express.static(path.join(__dirname, 'public')));

app.get('/panel-emisora', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'emisora.html'));
});

// ---------------------------------------------------------------------------
// Proxy de YouTube: usa el binario de yt-dlp para descargar el video/audio
// y transmitirlo (piped) desde nuestro propio origen, para que el navegador
// pueda capturarlo con captureStream() y retransmitirlo por WebRTC (un
// <iframe> de YouTube no se puede capturar directamente por restricciones
// de origen cruzado). Requiere que el equipo que corre el servidor tenga
// acceso a internet. yt-dlp se encarga de todo el manejo de cabeceras y
// descifrado internamente, que es más confiable que reimplementarlo aquí.
// ---------------------------------------------------------------------------
const YOUTUBE_URL_RE = /^https?:\/\/(www\.|m\.)?(youtube\.com\/(watch\?v=|shorts\/|live\/)|youtu\.be\/)/i;
// Alojado en la nube (p. ej. Render), la IP del servidor es de datacenter y
// YouTube suele frenarla con bot-detection ("Sign in to confirm you're not
// a bot") o simplemente responder muy lento cuando yt-dlp usa el cliente
// "web" por defecto. El cliente "android" evita bastante de eso porque no
// depende del reproductor JS de YouTube para descifrar firmas. Se prueba
// android primero (rápido) y web como respaldo si un video en particular no
// tiene formatos para android.
const YOUTUBE_CLIENTS_BY_ATTEMPT = ['android', 'web'];
const YOUTUBE_FETCH_ATTEMPTS = YOUTUBE_CLIENTS_BY_ATTEMPT.length;
// Si yt-dlp no entrega ningún byte en este tiempo (extracción colgada, red
// lenta, YouTube bloqueando la petición sin que yt-dlp lo reporte como error),
// lo matamos y reintentamos en vez de dejar al navegador "cargando" para
// siempre sin ninguna señal de error.
const YOUTUBE_START_TIMEOUT_MS = 20000;

function streamYoutube(videoUrl, res, activeChildRef, attempt = 1) {
  const playerClient = YOUTUBE_CLIENTS_BY_ATTEMPT[attempt - 1] || 'web';
  const child = ytdlp.exec(
    videoUrl,
    {
      format: 'best[ext=mp4]/best',
      output: '-',
      noWarnings: true,
      noPart: true,
      extractorArgs: `youtube:player_client=${playerClient}`,
    },
    { buffer: false }
  );
  activeChildRef.current = child;

  let sentAnyData = false;
  let stderrTail = '';

  const startTimeout = setTimeout(() => {
    if (!sentAnyData) {
      stderrTail = (stderrTail + `\n[timeout] yt-dlp no envió datos en ${YOUTUBE_START_TIMEOUT_MS}ms`).slice(-2000);
      child.kill();
    }
  }, YOUTUBE_START_TIMEOUT_MS);

  child.stdout.once('data', () => {
    sentAnyData = true;
    clearTimeout(startTimeout);
    if (!res.headersSent) res.setHeader('Content-Type', 'video/mp4');
  });
  // end:false en todos los intentos: si este intento falla, no queremos que
  // el pipe cierre la respuesta antes de que el reintento pueda usarla.
  child.stdout.pipe(res, { end: false });

  child.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2000);
  });

  child.on('exit', (code) => {
    clearTimeout(startTimeout);
    if (code === 0) {
      res.end();
      return;
    }
    if (!sentAnyData) {
      if (attempt < YOUTUBE_FETCH_ATTEMPTS) {
        streamYoutube(videoUrl, res, activeChildRef, attempt + 1);
        return;
      }
      console.error('yt-dlp falló tras reintentos:', stderrTail);
      if (!res.headersSent) {
        res.status(502).send(
          'No se pudo obtener el video de YouTube tras varios intentos (o se colgó sin responder). Puede que el ' +
          'enlace no sea válido, el video no esté disponible en este país, la conexión a internet del equipo esté ' +
          'fallando, o YouTube haya cambiado algo que yt-dlp aún no soporta (prueba actualizarlo con ' +
          '"npm update yt-dlp-exec").'
        );
        return;
      }
    }
    res.end();
  });

  child.catch(() => {
    // El manejo real ya ocurre en el evento 'exit'; se captura para que
    // execa no genere un unhandledRejection cuando el proceso termina mal.
  });
}

app.get('/api/youtube', (req, res) => {
  const videoUrl = req.query.url;

  if (!videoUrl || typeof videoUrl !== 'string' || !YOUTUBE_URL_RE.test(videoUrl)) {
    res.status(400).send('Enlace de YouTube inválido.');
    return;
  }

  const activeChildRef = { current: null };
  streamYoutube(videoUrl, res, activeChildRef);
  req.on('close', () => activeChildRef.current && activeChildRef.current.kill());
});

// ---------------------------------------------------------------------------
// Estado en memoria (se pierde al reiniciar el servidor, por diseño)
// ---------------------------------------------------------------------------
const state = {
  broadcasterId: null,
  streamActive: false,
  streamStartedAt: null,
  chatHistory: [], // { id, nickname, text, time, role }
};

const students = new Map(); // socketId -> nickname

function pushChat(entry) {
  state.chatHistory.push(entry);
  if (state.chatHistory.length > MAX_CHAT_HISTORY) {
    state.chatHistory.shift();
  }
}

function broadcastViewerCount() {
  io.emit('viewers:count', students.size);
}

function stopStream() {
  state.streamActive = false;
  state.broadcasterId = null;
  state.streamStartedAt = null;
  io.emit('stream:stopped');
}

// ---------------------------------------------------------------------------
// Socket.io
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  // Estado actual para quien se acaba de conectar
  socket.emit('stream:status', {
    active: state.streamActive,
    startedAt: state.streamStartedAt,
  });
  socket.emit('chat:history', state.chatHistory);
  socket.emit('viewers:count', students.size);

  // --- Registro de estudiante (audiencia) ---
  socket.on('join', ({ nickname } = {}) => {
    const safeName = String(nickname || 'Anónimo').trim().slice(0, MAX_NICKNAME_LEN) || 'Anónimo';
    socket.data.nickname = safeName;
    socket.data.role = 'student';
    students.set(socket.id, safeName);
    broadcastViewerCount();

    if (state.streamActive && state.broadcasterId) {
      io.to(state.broadcasterId).emit('viewer:new', {
        viewerId: socket.id,
        nickname: safeName,
      });
    }
  });

  // --- Identificación del panel de emisora (no cuenta como estudiante) ---
  socket.on('broadcaster:identify', () => {
    socket.data.nickname = socket.data.nickname || 'Emisora';
    socket.data.role = socket.data.role || 'broadcaster';
  });

  // --- Chat en tiempo real (sin persistencia en disco) ---
  socket.on('chat:send', (text) => {
    if (!socket.data.nickname) return;
    const clean = String(text || '').trim().slice(0, MAX_MESSAGE_LEN);
    if (!clean) return;
    const entry = {
      id: `${socket.id}-${Date.now()}`,
      nickname: socket.data.nickname,
      text: clean,
      time: Date.now(),
      role: socket.data.role || 'student',
    };
    pushChat(entry);
    io.emit('chat:new', entry);
  });

  // --- Reacciones rápidas ---
  socket.on('reaction:send', (emoji) => {
    if (!socket.data.nickname) return;
    if (!ALLOWED_REACTIONS.includes(emoji)) return;
    io.emit('reaction:new', { emoji, nickname: socket.data.nickname });
  });

  // --- Panel de la emisora ---
  socket.on('broadcaster:start', () => {
    if (state.streamActive && state.broadcasterId !== socket.id) {
      socket.emit('broadcaster:error', 'Ya hay una transmisión activa en este momento.');
      return;
    }
    state.broadcasterId = socket.id;
    state.streamActive = true;
    state.streamStartedAt = Date.now();
    socket.data.role = 'broadcaster';
    socket.data.nickname = socket.data.nickname || 'Emisora';

    socket.emit('broadcaster:started-ack', { startedAt: state.streamStartedAt });
    socket.broadcast.emit('stream:started', { startedAt: state.streamStartedAt });

    // Avisar al panel de todos los estudiantes ya conectados para que
    // el emisor abra una conexión WebRTC con cada uno.
    for (const [viewerId, nickname] of students.entries()) {
      io.to(state.broadcasterId).emit('viewer:new', { viewerId, nickname });
    }
  });

  socket.on('broadcaster:stop', () => {
    if (state.broadcasterId !== socket.id) return;
    stopStream();
  });

  // --- Señalización WebRTC: el servidor solo actúa de relé (no toca el SDP) ---
  socket.on('webrtc:offer', ({ to, sdp } = {}) => {
    if (!to) return;
    io.to(to).emit('webrtc:offer', { from: socket.id, sdp });
  });

  socket.on('webrtc:answer', ({ to, sdp } = {}) => {
    if (!to) return;
    io.to(to).emit('webrtc:answer', { from: socket.id, sdp });
  });

  socket.on('webrtc:ice', ({ to, candidate } = {}) => {
    if (!to) return;
    io.to(to).emit('webrtc:ice', { from: socket.id, candidate });
  });

  // Un espectador (re)solicita conectarse al stream en curso
  socket.on('viewer:ready', () => {
    if (state.streamActive && state.broadcasterId) {
      io.to(state.broadcasterId).emit('viewer:new', {
        viewerId: socket.id,
        nickname: socket.data.nickname || 'Anónimo',
      });
    }
  });

  socket.on('disconnect', () => {
    if (socket.data.role === 'student') {
      students.delete(socket.id);
      broadcastViewerCount();
      if (state.broadcasterId) {
        io.to(state.broadcasterId).emit('viewer:left', { viewerId: socket.id });
      }
    }
    if (socket.data.role === 'broadcaster' && state.broadcasterId === socket.id) {
      stopStream();
    }
  });
});

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------
function getLanAddresses() {
  const nets = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        addresses.push(net.address);
      }
    }
  }
  return addresses;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('==========================================================');
  console.log(' Emisora Escolar IDETP - Servidor de streaming local');
  console.log('==========================================================');
  console.log(` Vista estudiantes:  http://localhost:${PORT}`);
  console.log(` Panel de emisora:   http://localhost:${PORT}/panel-emisora`);
  const lan = getLanAddresses();
  if (lan.length) {
    console.log('\n Accesible en la red Wi-Fi local desde:');
    lan.forEach((ip) => console.log(`   http://${ip}:${PORT}`));
  }
  console.log('==========================================================');
});
