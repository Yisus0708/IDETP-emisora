/**
 * Lógica del lado estudiante: nickname, chat en vivo, reacciones
 * y recepción del stream vía WebRTC (el navegador actúa como "viewer").
 */
(() => {
  const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
  const STORAGE_KEY = 'idetp_nickname';

  const socket = io();

  // ---------- Elementos ----------
  const modalBackdrop = document.getElementById('nicknameModal');
  const nicknameInput = document.getElementById('nicknameInput');
  const nicknameSubmit = document.getElementById('nicknameSubmit');
  const nicknameError = document.getElementById('nicknameError');
  const chatNickLabel = document.getElementById('chatNickLabel');

  const liveBadge = document.getElementById('liveBadge');
  const playerLiveBadge = document.getElementById('playerLiveBadge');
  const playerOverlay = document.getElementById('playerOverlay');
  const remoteVideo = document.getElementById('remoteVideo');
  const viewerCountEl = document.getElementById('viewerCount');
  const reactionsLayer = document.getElementById('reactionsLayer');

  const btnVolumeToggle = document.getElementById('btnVolumeToggle');
  const volumeSlider = document.getElementById('volumeSlider');
  const btnFullscreen = document.getElementById('btnFullscreen');
  const reactionBar = document.getElementById('reactionBar');

  const chatMessages = document.getElementById('chatMessages');
  const chatInput = document.getElementById('chatInput');
  const chatSendBtn = document.getElementById('chatSendBtn');

  let nickname = null;
  let pc = null; // RTCPeerConnection hacia la emisora
  let broadcasterId = null;
  let streamActive = false;

  // ---------- Nickname ----------
  function openModal() {
    modalBackdrop.classList.remove('hidden');
    nicknameInput.focus();
  }
  function closeModal() {
    modalBackdrop.classList.add('hidden');
  }

  function confirmNickname() {
    const value = nicknameInput.value.trim();
    if (!value) {
      nicknameError.textContent = 'Por favor escribe un nombre para continuar.';
      return;
    }
    if (value.length > 24) {
      nicknameError.textContent = 'Máximo 24 caracteres.';
      return;
    }
    nickname = value;
    localStorage.setItem(STORAGE_KEY, nickname);
    chatNickLabel.textContent = `Conectado como ${nickname}`;
    closeModal();
    socket.emit('join', { nickname });
  }

  nicknameSubmit.addEventListener('click', confirmNickname);
  nicknameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmNickname();
  });

  const savedNick = localStorage.getItem(STORAGE_KEY);
  if (savedNick) {
    nicknameInput.value = savedNick;
  }
  openModal();

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

  function renderSystemMessage(text) {
    const div = document.createElement('div');
    div.className = 'chat-system';
    div.textContent = text;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function sendChat() {
    const text = chatInput.value.trim();
    if (!text || !nickname) return;
    socket.emit('chat:send', text);
    chatInput.value = '';
  }

  chatSendBtn.addEventListener('click', sendChat);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChat();
  });

  // ---------- Reacciones ----------
  reactionBar.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-emoji]');
    if (!btn || !nickname) return;
    socket.emit('reaction:send', btn.dataset.emoji);
  });

  function spawnFloatingEmoji(emoji) {
    const span = document.createElement('span');
    span.className = 'floating-emoji';
    span.textContent = emoji;
    span.style.left = `${10 + Math.random() * 80}%`;
    reactionsLayer.appendChild(span);
    setTimeout(() => span.remove(), 2700);
  }

  // ---------- Controles del reproductor ----------
  volumeSlider.addEventListener('input', () => {
    remoteVideo.volume = Number(volumeSlider.value);
    remoteVideo.muted = remoteVideo.volume === 0;
    btnVolumeToggle.textContent = remoteVideo.muted ? '🔇' : '🔊';
  });

  btnVolumeToggle.addEventListener('click', () => {
    remoteVideo.muted = !remoteVideo.muted;
    btnVolumeToggle.textContent = remoteVideo.muted ? '🔇' : '🔊';
    if (!remoteVideo.muted && remoteVideo.volume === 0) {
      remoteVideo.volume = 1;
      volumeSlider.value = 1;
    }
  });

  btnFullscreen.addEventListener('click', () => {
    const wrap = document.getElementById('playerWrap');
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      wrap.requestFullscreen?.();
    }
  });

  // ---------- Estado de la transmisión ----------
  function setLiveUI(isLive) {
    streamActive = isLive;
    if (isLive) {
      liveBadge.textContent = 'En vivo';
      liveBadge.className = 'badge badge-live';
      playerLiveBadge.style.display = 'inline-flex';
      playerOverlay.classList.add('hidden');
    } else {
      liveBadge.textContent = 'Fuera de aire';
      liveBadge.className = 'badge badge-offline';
      playerLiveBadge.style.display = 'none';
      playerOverlay.classList.remove('hidden');
      remoteVideo.srcObject = null;
      closePeerConnection();
    }
  }

  // ---------- WebRTC (lado espectador) ----------
  function createPeerConnection() {
    const connection = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    connection.ontrack = (event) => {
      if (remoteVideo.srcObject !== event.streams[0]) {
        remoteVideo.srcObject = event.streams[0];
      }
    };

    connection.onicecandidate = (event) => {
      if (event.candidate && broadcasterId) {
        socket.emit('webrtc:ice', { to: broadcasterId, candidate: event.candidate });
      }
    };

    connection.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(connection.connectionState)) {
        closePeerConnection();
      }
    };

    return connection;
  }

  function closePeerConnection() {
    if (pc) {
      pc.close();
      pc = null;
    }
  }

  socket.on('webrtc:offer', async ({ from, sdp }) => {
    broadcasterId = from;
    closePeerConnection();
    pc = createPeerConnection();
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('webrtc:answer', { to: from, sdp: pc.localDescription });
  });

  socket.on('webrtc:ice', async ({ candidate }) => {
    if (pc && candidate) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.warn('Error agregando ICE candidate:', err);
      }
    }
  });

  // ---------- Eventos del servidor ----------
  socket.on('stream:status', ({ active }) => {
    setLiveUI(active);
    if (active) socket.emit('viewer:ready');
  });

  socket.on('stream:started', () => {
    setLiveUI(true);
    socket.emit('viewer:ready');
    renderSystemMessage('📡 La transmisión ha comenzado.');
  });

  socket.on('stream:stopped', () => {
    setLiveUI(false);
    renderSystemMessage('📴 La transmisión ha finalizado.');
  });

  socket.on('viewers:count', (count) => {
    viewerCountEl.textContent = count;
  });

  socket.on('chat:history', (history) => {
    chatMessages.innerHTML = '';
    history.forEach(renderMessage);
  });

  socket.on('chat:new', (entry) => {
    renderMessage(entry);
  });

  socket.on('reaction:new', ({ emoji }) => {
    spawnFloatingEmoji(emoji);
  });

  socket.on('connect', () => {
    if (nickname) socket.emit('join', { nickname });
  });
})();
