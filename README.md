# Emisora Escolar IDETP — Plataforma de Streaming Local

Plataforma de streaming en vivo 100% local: sin base de datos, sin login/registro
complejo. Todo el estado (chat, contador de espectadores, estado de la
transmisión) vive en memoria del proceso Node.js mientras el servidor está
corriendo.

## Arquitectura

- **Servidor:** Node.js + Express (archivos estáticos y rutas) + Socket.io
  (chat en tiempo real y señalización WebRTC).
- **Video/Audio:** WebRTC nativo del navegador (`getUserMedia` +
  `RTCPeerConnection`). El servidor **no** procesa ni reenvía el video: solo
  actúa de relé de señalización (SDP/ICE) entre la emisora y cada estudiante.
  La emisora abre una conexión WebRTC directa por cada estudiante conectado
  (topología en estrella), ideal para una red local de colegio con un número
  moderado de espectadores.
- **Persistencia:** ninguna. Al reiniciar el servidor se pierde el chat y el
  estado de la transmisión (es el comportamiento esperado).

## Estructura del proyecto

```
idetp web/
├── package.json
├── server.js            # Servidor Express + Socket.io (estado en memoria)
├── README.md
└── public/
    ├── index.html        # Vista de estudiantes (estilo YouTube Live)
    ├── emisora.html       # Panel de la emisora (estilo Twitch Studio)
    ├── style.css         # Tema oscuro compartido
    ├── app.js             # Lógica del estudiante: nickname, chat, WebRTC (viewer)
    └── panel.js            # Lógica de la emisora: dispositivos, WebRTC (broadcaster), métricas
```

## Requisitos

- Node.js 18 o superior instalado.
- Navegador moderno con soporte WebRTC (Chrome, Edge o Firefox).
- Cámara y micrófono conectados en el equipo que hará de emisora.

## Instalación y ejecución

1. Abre una terminal en la carpeta del proyecto.
2. Instala las dependencias:
   ```bash
   npm install
   ```
3. Inicia el servidor:
   ```bash
   npm start
   ```
4. La consola mostrará algo como:
   ```
   Vista estudiantes:  http://localhost:3000
   Panel de emisora:   http://localhost:3000/panel-emisora

   Accesible en la red Wi-Fi local desde:
     http://192.168.1.XX:3000
   ```

## Cómo probar la transmisión

### En el mismo equipo (dos pestañas)

1. Abre `http://localhost:3000/panel-emisora` **usando exactamente
   `localhost`** (no la IP de red) — este es el panel de la emisora. Es
   obligatorio usar `localhost` (o HTTPS) porque los navegadores bloquean el
   acceso a cámara/micrófono en direcciones IP por HTTP; si abres el panel
   con la IP de red (p. ej. `http://192.168.1.20:3000/panel-emisora`) la
   cámara y el micrófono **no funcionarán** y el panel te lo advertirá con
   un aviso amarillo.
2. El navegador pedirá permiso de cámara/micrófono. Acepta.
3. Selecciona la cámara y el micrófono deseados en los menús desplegables.
4. Abre `http://localhost:3000` en otra pestaña (o en modo incógnito) —
   aquí entrarás como estudiante. Escribe un apodo en el modal de bienvenida.
5. Vuelve a la pestaña del panel y haz clic en **"Iniciar Transmisión"**.
6. En unos segundos, el video en vivo debería aparecer en la pestaña del
   estudiante, con el badge rojo "En vivo" activo.
7. Prueba el chat escribiendo mensajes desde ambas pestañas y las
   reacciones con emoji desde la vista de estudiante.
8. Haz clic en **"Detener Transmisión"** en el panel para finalizar.

### Desde varios dispositivos en la misma red Wi-Fi del colegio

1. Asegúrate de que el equipo emisor y los dispositivos de los estudiantes
   estén conectados a la **misma red Wi-Fi/LAN** (sin aislamiento de
   clientes activado en el router, ya que WebRTC necesita que los
   dispositivos puedan verse entre sí).
2. En el equipo servidor, ejecuta `npm start` y anota la IP local que
   imprime la consola (ej. `http://192.168.1.20:3000`).
3. En el equipo de la emisora, abre el panel con **`localhost`**, no con la
   IP de red: `http://localhost:3000/panel-emisora` (ver nota sobre cámara
   más arriba). La IP de red es solo para que los estudiantes entren desde
   otros dispositivos.
4. En los celulares/computadores de los estudiantes, abre la IP base
   (ej. `http://192.168.1.20:3000`) y escribe un apodo.
5. Inicia la transmisión desde el panel de la emisora; todos los
   dispositivos conectados a esa dirección recibirán el video en vivo y
   podrán chatear.

> Nota: si algún estudiante no logra conectar el video (pero sí el chat),
> generalmente se debe a "aislamiento de clientes" (AP/Client Isolation) en
> el router del colegio, una función de seguridad Wi-Fi que impide que los
> dispositivos conectados se vean entre sí. Debe desactivarse para que
> WebRTC funcione en la red local.

## Funcionalidades incluidas

**Vista de estudiantes (`/`)**
- Modal de ingreso solo con apodo (sin contraseña), guardado en
  `localStorage` para no pedirlo de nuevo en el mismo navegador.
- Reproductor en vivo con badge "EN VIVO", control de volumen y pantalla
  completa.
- Chat lateral en tiempo real con nombre del remitente y hora.
- Botones de reacciones con animación flotante sobre el video.
- Contador de estudiantes conectados en el header.

**Panel de emisora (`/panel-emisora`)**
- Tres pestañas de fuente, separadas y claras: **🎥 Cámara**, **📁 Archivo**
  y **🔗 YouTube**. Cada una tiene sus propios controles; solo una está
  activa a la vez y se puede cambiar entre ellas sin cortar la transmisión.
- 🎥 Cámara: selección de cámara y micrófono vía `navigator.mediaDevices`.
- 📁 Archivo: sube un archivo local (mp3, mp4, etc.) y se transmite en vivo,
  con reproductor y control de bucle.
- 🔗 YouTube: pega un enlace y se transmite en vivo (ver detalle abajo).
- Previsualización en vivo antes y durante la transmisión, con un borde
  rojo que confirma visualmente que lo que se ve es lo que está "al aire".
- Botón "Iniciar Transmisión" / "Detener Transmisión".
- Métricas en vivo: tiempo transmitido, estudiantes conectados, bitrate y
  resolución.
- Chat en vivo para interactuar con los estudiantes, identificado como
  "Emisora".
- Si abres el panel desde una dirección donde el navegador bloquea la
  cámara (ver nota de `localhost` más arriba), aparece un aviso amarillo
  explicando cómo corregirlo; la pestaña de Archivo/YouTube sigue
  funcionando igual porque no depende de la cámara.

**Reproducir un enlace de YouTube**

En el panel, pestaña "🔗 YouTube", pega la URL y presiona "Cargar". El
servidor usa el binario de **yt-dlp** para descargar el video/audio y lo
transmite desde su propio origen (`/api/youtube?...`) para que el navegador
pueda capturarlo con `captureStream()` y retransmitirlo por WebRTC — un
`<iframe>` de YouTube no se puede capturar directamente por restricciones de
seguridad del navegador. yt-dlp se descarga automáticamente la primera vez
que se instalan las dependencias (`npm install`).

> **Importante:**
> - Esta función específica necesita que el **equipo que corre el
>   servidor** tenga conexión a internet (el resto de la plataforma sigue
>   funcionando 100% local/offline).
> - YouTube cambia su código con frecuencia y aplica límites anti-bots. Si
>   un enlace no carga, espera unos segundos y reintenta; si el problema
>   persiste, actualiza el extractor con `npm update yt-dlp-exec`.
> - Si desde el mismo equipo se cargan muchos enlaces distintos en pocos
>   minutos (como en pruebas), YouTube puede limitar temporalmente esa IP;
>   en uso normal (poner una canción de vez en cuando) esto no debería
>   notarse.
> - No hay soporte de búsqueda de tiempo (seek): el video se reproduce
>   desde el inicio cada vez que se carga.
> - La calidad queda limitada a los formatos "progresivos" (video+audio ya
>   combinados) que ofrece YouTube, suficiente para música de fondo o
>   clips de apoyo.

## Notas y límites conocidos

- La topología es en estrella (un `RTCPeerConnection` por espectador desde
  el equipo emisor), por lo que el ancho de banda de subida del equipo
  emisor es el límite práctico de espectadores simultáneos. Para una
  emisora escolar dentro de un aula/red local, esto es adecuado hasta
  varias decenas de espectadores.
- Solo puede haber **una** transmisión activa a la vez; si otro navegador
  intenta iniciar `/panel-emisora` mientras hay una transmisión en curso,
  el servidor rechaza la solicitud.
- Todo el estado (chat, contador, transmisión activa) se reinicia al
  reiniciar el proceso `node server.js`, por diseño (sin base de datos).
