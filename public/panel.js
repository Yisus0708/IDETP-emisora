/**
 * Lógica del Panel de Emisora: selección de cámara/mic o de un archivo de
 * música/video como fuente, previsualización, envío por WebRTC a cada
 * espectador conectado (topología en estrella: una RTCPeerConnection por
 * estudiante) y métricas en vivo.
 */
(() => {
  const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

  const socket = io();

  // ---------- Elementos ----------
  const insecureContextBanner = document.getElementById('insecureContextBanner');

  const tabCamera = document.getElementById('tabCamera');
  const tabFile = document.getElementById('tabFile');
  const tabYoutube = document.getElementById('tabYoutube');
  const cameraSourcePanel = document.getElementById('cameraSourcePanel');
  const fileSourcePanel = document.getElementById('fileSourcePanel');
  const youtubeSourcePanel = document.getElementById('youtubeSourcePanel');
  const mediaMonitorWrap = document.getElementById('mediaMonitorWrap');

  const cameraSelect = document.getElementById('cameraSelect');
  const micSelect = document.getElementById('micSelect');
  const deviceWarning = document.getElementById('deviceWarning');
  const goLiveBtn = document.getElementById('goLiveBtn');
  const panelError = document.getElementById('panelError');

  const youtubeUrlInput = document.getElementById('youtubeUrlInput');
  const youtubeLoadBtn = document.getElementById('youtubeLoadBtn');
  const youtubeWarning = document.getElementById('youtubeWarning');

  const fileInput = document.getElementById('fileInput');
  const fileNameLabel = document.getElementById('fileNameLabel');
  const mediaFilePreview = document.getElementById('mediaFilePreview');
  const fileLoopCheckbox = document.getElementById('fileLoopCheckbox');

  const playerWrap = document.getElementById('playerWrap');
  const localPreview = document.getElementById('localPreview');
  const playerOverlay = document.getElementById('playerOverlay');
  const optionsToggle = document.getElementById('optionsToggle');
  const panelGrid = document.getElementById('panelGrid');
  const liveBadge = document.getElementById('liveBadge');
  const playerLiveBadge = document.getElementById('playerLiveBadge');
  const viewerCountEl = document.getElementById('viewerCount');

  const statTime = document.getElementById('statTime');
  const statViewers = document.getElementById('statViewers');
  const statBitrate = document.getElementById('statBitrate');
  const statResolution = document.getElementById('statResolution');

  const chatMessages = document.getElementById('chatMessages');
  const chatInput = document.getElementById('chatInput');
  const chatSendBtn = document.getElementById('chatSendBtn');

  let cameraStream = null;
  let fileStream = null;
  let sourceMode = 'camera'; // 'camera' | 'file' | 'youtube'
  let isLive = false;
  let streamStartedAt = null;
  let timerInterval = null;
  let statsInterval = null;
  let canvasAnimId = null;

  // viewerId -> RTCPeerConnection
  const peers = new Map();
  // para el cálculo de bitrate: viewerId -> { bytes, time }
  const lastStats = new Map();

  function getActiveStream() {
    return sourceMode === 'camera' ? cameraStream : fileStream;
  }

  function friendlyMediaError(err) {
    const map = {
      NotAllowedError: 'Permiso denegado. Habilita el acceso a cámara/micrófono para este sitio en la configuración del navegador.',
      NotFoundError: 'No se encontró el dispositivo seleccionado.',
      NotReadableError: 'La cámara o el micrófono ya están siendo usados por otra aplicación (cierra Zoom, Teams, otra pestaña, etc.) e inténtalo de nuevo.',
      OverconstrainedError: 'El dispositivo seleccionado ya no está disponible. Elige otro en la lista.',
      AbortError: 'Se interrumpió el acceso al dispositivo. Intenta de nuevo.',
    };
    return map[err.name] || err.message || String(err);
  }

  // ---------- Verificación de contexto seguro (requisito de los navegadores
  // para permitir cámara/micrófono) ----------
  function checkSecureContext() {
    const ok = !!(window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    if (!ok) {
      const localUrl = `http://localhost:${location.port || 80}/panel-emisora`;
      insecureContextBanner.innerHTML =
        '⚠️ <strong>No se puede acceder a la cámara/micrófono desde esta dirección.</strong> ' +
        'Los navegadores solo permiten usar cámara y micrófono en <code>localhost</code> o en HTTPS, nunca en una ' +
        `IP de red por HTTP. Abre el panel como <code>${localUrl}</code> desde el mismo equipo que ejecuta el ` +
        'servidor. (Los estudiantes sí pueden seguir entrando desde la IP de red normalmente; solo el panel de ' +
        'emisora necesita localhost por la cámara.) La fuente de Archivo/YouTube sigue funcionando igual.';
      insecureContextBanner.classList.remove('hidden');
      cameraSelect.disabled = true;
      micSelect.disabled = true;
    }
    return ok;
  }

  // ---------- Pestañas de fuente: Cámara / Archivo / YouTube ----------
  function setTab(mode) {
    sourceMode = mode;
    tabCamera.classList.toggle('active', mode === 'camera');
    tabFile.classList.toggle('active', mode === 'file');
    tabYoutube.classList.toggle('active', mode === 'youtube');
    cameraSourcePanel.classList.toggle('active', mode === 'camera');
    fileSourcePanel.classList.toggle('active', mode === 'file');
    youtubeSourcePanel.classList.toggle('active', mode === 'youtube');
    mediaMonitorWrap.classList.toggle('active', mode !== 'camera');
    panelError.textContent = '';
    updateBigPreview();
    if (isLive) {
      const stream = getActiveStream();
      if (stream) replaceTracksOnAllPeers(stream);
    }
  }

  tabCamera.addEventListener('click', () => setTab('camera'));
  tabFile.addEventListener('click', () => setTab('file'));
  tabYoutube.addEventListener('click', () => setTab('youtube'));

  function updateBigPreview() {
    const stream = getActiveStream();
    localPreview.srcObject = stream || null;
    if (stream) {
      // En algunos navegadores, asignar srcObject no basta para arrancar la
      // reproducción de forma fiable; forzamos play() como red de seguridad
      // (el <video> ya está muted, así que el navegador lo permite sin gesto).
      localPreview.play().catch(() => {});
    }
    playerOverlay.classList.toggle('hidden', !!stream);
  }

  // ---------- Sección de opciones desplegable ----------
  function setOptionsCollapsed(collapsed) {
    panelGrid.classList.toggle('collapsed', collapsed);
    optionsToggle.classList.toggle('collapsed', collapsed);
    optionsToggle.setAttribute('aria-expanded', String(!collapsed));
  }

  optionsToggle.addEventListener('click', () => {
    setOptionsCollapsed(!panelGrid.classList.contains('collapsed'));
  });

  // Red de seguridad: en cuanto el <video> del panel realmente empieza a
  // pintar frames, se oculta el overlay sí o sí, sin depender de que el
  // resto del código haya actualizado el estado a tiempo.
  localPreview.addEventListener('loadedmetadata', () => playerOverlay.classList.add('hidden'));
  localPreview.addEventListener('playing', () => playerOverlay.classList.add('hidden'));

  // ---------- Dispositivos de cámara/micrófono ----------
  async function populateDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cams = devices.filter((d) => d.kind === 'videoinput');
      const mics = devices.filter((d) => d.kind === 'audioinput');

      cameraSelect.innerHTML = cams
        .map((d, i) => `<option value="${d.deviceId}">${d.label || `Cámara ${i + 1}`}</option>`)
        .join('') || '<option value="">No se encontraron cámaras</option>';

      micSelect.innerHTML = mics
        .map((d, i) => `<option value="${d.deviceId}">${d.label || `Micrófono ${i + 1}`}</option>`)
        .join('') || '<option value="">No se encontraron micrófonos</option>';

      if (!cams.length || !mics.length) {
        deviceWarning.textContent = 'Conecta una cámara y un micrófono, luego recarga la página.';
      } else {
        deviceWarning.textContent = '';
      }
    } catch (err) {
      deviceWarning.textContent = 'No se pudo listar los dispositivos: ' + err.message;
    }
  }

  // Selecciona en los <select> los dispositivos que realmente quedaron activos.
  function syncSelectsWithStream(stream) {
    const videoTrack = stream.getVideoTracks()[0];
    const audioTrack = stream.getAudioTracks()[0];
    const videoId = videoTrack?.getSettings?.().deviceId;
    const audioId = audioTrack?.getSettings?.().deviceId;
    if (videoId && [...cameraSelect.options].some((o) => o.value === videoId)) {
      cameraSelect.value = videoId;
    }
    if (audioId && [...micSelect.options].some((o) => o.value === audioId)) {
      micSelect.value = audioId;
    }
  }

  async function startPreview() {
    try {
      // Una sola petición inicial: evita pedir la cámara dos veces seguidas,
      // lo que en Windows suele producir "NotReadableError" por choque de
      // acceso al dispositivo entre dos getUserMedia() consecutivos.
      cameraStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      panelError.textContent = '';
      updateBigPreview();
      await populateDevices();
      syncSelectsWithStream(cameraStream);
    } catch (err) {
      panelError.textContent = 'No se pudo acceder a la cámara/micrófono: ' + friendlyMediaError(err);
      await populateDevices().catch(() => {});
    }
  }

  // Solo se llama cuando el usuario cambia manualmente un <select>.
  async function applySelectedDevices() {
    const videoId = cameraSelect.value;
    const audioId = micSelect.value;
    if (!videoId || !audioId) return;

    const previousStream = cameraStream;

    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: videoId } },
        audio: { deviceId: { exact: audioId } },
      });

      // Solo detenemos el stream anterior una vez el nuevo ya está listo,
      // para no dejar al operador sin vista previa si algo falla.
      if (previousStream) {
        previousStream.getTracks().forEach((t) => t.stop());
      }

      cameraStream = newStream;
      panelError.textContent = '';
      if (sourceMode === 'camera') updateBigPreview();

      if (isLive && sourceMode === 'camera') {
        replaceTracksOnAllPeers(cameraStream);
      }
    } catch (err) {
      panelError.textContent = 'Error al cambiar de dispositivo: ' + friendlyMediaError(err);
    }
  }

  cameraSelect.addEventListener('change', applySelectedDevices);
  micSelect.addEventListener('change', applySelectedDevices);

  function replaceTracksOnAllPeers(stream) {
    const videoTrack = stream.getVideoTracks()[0];
    const audioTrack = stream.getAudioTracks()[0];
    peers.forEach((pc) => {
      pc.getSenders().forEach((sender) => {
        if (sender.track && sender.track.kind === 'video' && videoTrack) {
          sender.replaceTrack(videoTrack);
        }
        if (sender.track && sender.track.kind === 'audio' && audioTrack) {
          sender.replaceTrack(audioTrack);
        }
      });
    });
  }

  // ---------- Fuente: archivo de música / video ----------
  function stopCanvasLoop() {
    if (canvasAnimId) {
      cancelAnimationFrame(canvasAnimId);
      canvasAnimId = null;
    }
  }

  // Para archivos solo-audio (mp3, etc.) no hay pista de video: se dibuja
  // una tarjeta "ahora suena" en un canvas y se usa como pista de video.
  function buildAudioOnlyVideoTrack(label) {
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext('2d');

    function draw() {
      ctx.fillStyle = '#0e0e10';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.textAlign = 'center';
      ctx.fillStyle = '#22c55e';
      ctx.font = 'bold 120px sans-serif';
      ctx.fillText('🎵', canvas.width / 2, canvas.height / 2 - 20);
      ctx.fillStyle = '#ffffff';
      ctx.font = '32px sans-serif';
      ctx.fillText('Reproduciendo audio', canvas.width / 2, canvas.height / 2 + 70);
      ctx.fillStyle = '#facc15';
      ctx.font = '22px sans-serif';
      ctx.fillText(label.slice(0, 48), canvas.width / 2, canvas.height / 2 + 110);
      canvasAnimId = requestAnimationFrame(draw);
    }
    draw();
    return canvas.captureStream(15).getVideoTracks()[0];
  }

  function buildFileStream(fileName) {
    const captureFn = mediaFilePreview.captureStream || mediaFilePreview.mozCaptureStream;
    if (!captureFn) {
      panelError.textContent = 'Este navegador no soporta capturar el archivo para transmitirlo (usa Chrome o Edge actualizado).';
      return;
    }
    const captured = captureFn.call(mediaFilePreview);
    const audioTrack = captured.getAudioTracks()[0];
    const hasVideo = mediaFilePreview.videoWidth > 0;

    stopCanvasLoop();
    const videoTrack = hasVideo ? captured.getVideoTracks()[0] : buildAudioOnlyVideoTrack(fileName);

    if (fileStream) {
      fileStream.getTracks().forEach((t) => {
        if (t !== audioTrack && t !== videoTrack) t.stop();
      });
    }

    fileStream = new MediaStream([videoTrack, audioTrack].filter(Boolean));

    if (sourceMode !== 'camera') {
      updateBigPreview();
      if (isLive) replaceTracksOnAllPeers(fileStream);
    }
  }

  // Carga cualquier fuente reproducible (blob local o URL del proxy de
  // YouTube) en el <video> monitor y arma el stream que se transmite.
  function loadMediaIntoPreview(src, label) {
    panelError.textContent = '';
    mediaFilePreview.src = src;
    mediaFilePreview.loop = fileLoopCheckbox.checked;

    mediaFilePreview.onloadedmetadata = async () => {
      try {
        await mediaFilePreview.play();
        buildFileStream(label);
      } catch (err) {
        panelError.textContent = 'No se pudo reproducir: ' + err.message;
      }
    };
    mediaFilePreview.onerror = () => {
      panelError.textContent = 'No se pudo cargar el contenido. Verifica el archivo o el enlace.';
    };
  }

  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (!file) return;
    fileNameLabel.textContent = file.name;
    loadMediaIntoPreview(URL.createObjectURL(file), file.name);
  });

  fileLoopCheckbox.addEventListener('change', () => {
    mediaFilePreview.loop = fileLoopCheckbox.checked;
  });

  // ---------- Fuente: enlace de YouTube (vía proxy del servidor) ----------
  youtubeLoadBtn.addEventListener('click', () => {
    const link = youtubeUrlInput.value.trim();
    if (!link) {
      youtubeWarning.textContent = 'Pega un enlace de YouTube.';
      return;
    }
    youtubeWarning.textContent = 'Cargando desde YouTube (requiere internet)...';
    const proxyUrl = '/api/youtube?url=' + encodeURIComponent(link);
    loadMediaIntoPreview(proxyUrl, 'YouTube: ' + link);
    youtubeWarning.textContent = 'Requiere conexión a internet en este equipo.';
  });

  youtubeUrlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') youtubeLoadBtn.click();
  });

  // ---------- Iniciar / detener transmisión ----------
  goLiveBtn.addEventListener('click', () => {
    if (!isLive) {
      if (!getActiveStream()) {
        const messages = {
          camera: 'Selecciona cámara y micrófono antes de transmitir.',
          file: 'Selecciona un archivo de música o video antes de transmitir.',
          youtube: 'Carga un enlace de YouTube antes de transmitir.',
        };
        panelError.textContent = messages[sourceMode];
        return;
      }
      socket.emit('broadcaster:start');
    } else {
      socket.emit('broadcaster:stop');
    }
  });

  socket.on('broadcaster:error', (message) => {
    panelError.textContent = message;
  });

  socket.on('broadcaster:started-ack', ({ startedAt }) => {
    goLive(startedAt);
  });

  socket.on('stream:started', ({ startedAt }) => {
    // Por si otro operador ya inició (no debería pasar en flujo normal).
    if (!isLive) goLive(startedAt);
  });

  socket.on('stream:stopped', () => {
    endLive();
  });

  function goLive(startedAt) {
    isLive = true;
    streamStartedAt = startedAt;
    panelError.textContent = '';
    goLiveBtn.textContent = 'Detener Transmisión';
    goLiveBtn.classList.add('is-live');
    liveBadge.textContent = 'En vivo';
    liveBadge.className = 'badge badge-live';
    playerLiveBadge.style.display = 'inline-flex';
    playerWrap.classList.add('on-air');
    setOptionsCollapsed(true);

    timerInterval = setInterval(updateElapsedTime, 1000);
    statsInterval = setInterval(updateBitrateStats, 2000);
  }

  function endLive() {
    isLive = false;
    goLiveBtn.textContent = 'Iniciar Transmisión';
    goLiveBtn.classList.remove('is-live');
    liveBadge.textContent = 'Fuera de aire';
    liveBadge.className = 'badge badge-offline';
    playerLiveBadge.style.display = 'none';
    playerWrap.classList.remove('on-air');
    setOptionsCollapsed(false);

    clearInterval(timerInterval);
    clearInterval(statsInterval);
    statTime.textContent = '00:00:00';
    statBitrate.textContent = '0 kbps';
    statResolution.textContent = '--';

    peers.forEach((pc) => pc.close());
    peers.clear();
    lastStats.clear();
  }

  function updateElapsedTime() {
    if (!streamStartedAt) return;
    const diff = Math.floor((Date.now() - streamStartedAt) / 1000);
    const h = String(Math.floor(diff / 3600)).padStart(2, '0');
    const m = String(Math.floor((diff % 3600) / 60)).padStart(2, '0');
    const s = String(diff % 60).padStart(2, '0');
    statTime.textContent = `${h}:${m}:${s}`;
  }

  async function updateBitrateStats() {
    if (peers.size === 0) {
      statBitrate.textContent = '0 kbps';
      return;
    }
    // Toma la primera conexión activa como referencia representativa.
    const [viewerId, pc] = [...peers.entries()][0];
    try {
      const stats = await pc.getStats();
      let bytesSent = 0;
      let frameWidth = null;
      let frameHeight = null;

      stats.forEach((report) => {
        if (report.type === 'outbound-rtp' && report.kind === 'video') {
          bytesSent = report.bytesSent || 0;
        }
        if (report.type === 'track' && report.frameWidth) {
          frameWidth = report.frameWidth;
          frameHeight = report.frameHeight;
        }
      });

      const prev = lastStats.get(viewerId) || { bytes: 0, time: Date.now() - 2000 };
      const now = Date.now();
      const deltaBytes = Math.max(bytesSent - prev.bytes, 0);
      const deltaSeconds = (now - prev.time) / 1000;
      const kbps = deltaSeconds > 0 ? Math.round((deltaBytes * 8) / deltaSeconds / 1000) : 0;

      lastStats.set(viewerId, { bytes: bytesSent, time: now });
      statBitrate.textContent = `${kbps} kbps`;

      const activeStream = getActiveStream();
      const track = activeStream?.getVideoTracks?.()[0];
      const settings = track?.getSettings?.();
      if (settings?.width && settings?.height) {
        statResolution.textContent = `${settings.width}x${settings.height}`;
      } else if (frameWidth) {
        statResolution.textContent = `${frameWidth}x${frameHeight}`;
      }
    } catch (err) {
      // silencioso: las stats son solo informativas
    }
  }

  // ---------- WebRTC (lado emisor): una conexión por espectador ----------
  function createPeerForViewer(viewerId) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const stream = getActiveStream();

    stream.getTracks().forEach((track) => pc.addTrack(track, stream));

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('webrtc:ice', { to: viewerId, candidate: event.candidate });
      }
    };

    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
        peers.delete(viewerId);
        lastStats.delete(viewerId);
      }
    };

    peers.set(viewerId, pc);
    return pc;
  }

  socket.on('viewer:new', async ({ viewerId }) => {
    if (!isLive || !getActiveStream()) return;
    if (peers.has(viewerId)) return; // ya conectado
    const pc = createPeerForViewer(viewerId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('webrtc:offer', { to: viewerId, sdp: pc.localDescription });
  });

  socket.on('webrtc:answer', async ({ from, sdp }) => {
    const pc = peers.get(from);
    if (pc) {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    }
  });

  socket.on('webrtc:ice', async ({ from, candidate }) => {
    const pc = peers.get(from);
    if (pc && candidate) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.warn('Error agregando ICE candidate:', err);
      }
    }
  });

  socket.on('viewer:left', ({ viewerId }) => {
    const pc = peers.get(viewerId);
    if (pc) {
      pc.close();
      peers.delete(viewerId);
      lastStats.delete(viewerId);
    }
  });

  // ---------- Contador de estudiantes ----------
  socket.on('viewers:count', (count) => {
    viewerCountEl.textContent = count;
    statViewers.textContent = count;
  });

  // ---------- Chat ----------
  function formatTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
  }

  function renderMessage(entry) {
    const div = document.createElement('div');
    div.className = `chat-msg${entry.role === 'broadcaster' ? ' role-broadcaster' : ''}`;
    const nameSpan = document.createElement('span');
    nameSpan.className = 'msg-name';
    nameSpan.textContent = entry.nickname;
    const textSpan = document.createElement('span');
    textSpan.className = 'msg-text';
    textSpan.textContent = entry.text;
    const timeSpan = document.createElement('span');
    timeSpan.className = 'msg-time';
    timeSpan.textContent = formatTime(entry.time);

    div.appendChild(nameSpan);
    div.appendChild(textSpan);
    div.appendChild(timeSpan);
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  socket.on('chat:history', (history) => {
    chatMessages.innerHTML = '';
    history.forEach(renderMessage);
  });

  socket.on('chat:new', renderMessage);

  function sendChat() {
    const text = chatInput.value.trim();
    if (!text) return;
    socket.emit('chat:send', text);
    chatInput.value = '';
  }

  chatSendBtn.addEventListener('click', sendChat);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChat();
  });

  // Identificarse como "Emisora" para el chat, sin contar como estudiante.
  socket.on('connect', () => {
    socket.emit('broadcaster:identify');
  });

  // ---------- Init ----------
  if (checkSecureContext()) {
    startPreview();
    navigator.mediaDevices.addEventListener?.('devicechange', populateDevices);
  }
})();

