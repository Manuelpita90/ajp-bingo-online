// 1. Conexión con el servidor
if (typeof io === 'undefined') {
    alert("Error crítico: La librería Socket.IO no está cargada. Asegúrate de incluir <script src='/socket.io/socket.io.js'></script> en tu HTML antes de cargar este script.");
    throw new Error("Socket.IO no definido");
}

// Detectar si estamos en GitHub Pages para conectar al servidor de Render
const isGitHubPages = window.location.hostname.includes('github.io');
const socket = io(isGitHubPages ? 'https://ajp-bingo-online.onrender.com' : undefined);

// Identificar este cliente como administrador en el servidor
socket.on('connect', () => {
    const token = sessionStorage.getItem('admin-token');
    if (token) {
        socket.emit('admin-join', token);
    } else {
        mostrarLoginAdmin();
    }
});

let bolasExtraidas = [];
const totalBolas = 75;
let juegoPausado = false;
let isAnimating = false;
let cachedPlayerCount = 0;
let cachedCardCount = 0;
let viewingPlayersList = false;
let currentWinnersList = []; // Almacén local de ganadores
let gameStartTime = null;
let gameTimerInterval = null;
let autoPlayInterval = null;
let autoPlaySpeed = 4000;
let voiceEnabled = true;

socket.on('admin-error', (msg) => {
    sessionStorage.removeItem('admin-token');
    mostrarLoginAdmin("Credenciales inválidas");
});

// Pre-cargar audios para rendimiento
const audioWin = new Audio('sounds/win.mp3');
const audioFail = new Audio('sounds/fail.mp3');
const audioRequest = new Audio('sounds/request.mp3');
const audioAlarm = new Audio('sounds/alarm.mp3'); // Asegúrate de añadir este archivo
audioAlarm.loop = true;
audioAlarm.volume = 0.3; // Volumen suave para no aturdir

// 2. Inicializar el tablero maestro (1-75)
function initTablero() {
    const board = document.getElementById('master-board');
    if (!board) return;
    
    board.innerHTML = ''; 
    for (let i = 1; i <= totalBolas; i++) {
        let slot = document.createElement('div');
        slot.id = `slot-${i}`;
        slot.classList.add('ball-slot');
        slot.textContent = i;
        board.appendChild(slot);
    }

    // Sincronizar visualmente si ya llegaron datos del historial antes de crear el tablero
    if (bolasExtraidas.length > 0) {
        bolasExtraidas.forEach(bola => {
            const slot = document.getElementById(`slot-${bola}`);
            if (slot) slot.classList.add('called');
        });
    }

    // INYECTAR BARRA DE ESTADO (Jugadores Listos)
    const adminContainer = document.querySelector('.admin-container');
    if (adminContainer && !document.getElementById('admin-status-bar')) {
        const statusBar = document.createElement('div');
        statusBar.id = 'admin-status-bar';
        statusBar.className = 'status-bar';
        statusBar.innerHTML = `
            <div style="display:flex; gap:15px">
                <div onclick="verDetallesJugadores()" style="cursor:pointer" title="Ver lista de Jugadores">👥 JUGADORES: <span id="player-count" style="color:white; font-size:1.2em">${cachedPlayerCount}</span></div>
                <div onclick="verDetallesCartones()" style="cursor:pointer" title="Ver lista de IDs">🎫 CARTONES: <span id="card-count" style="color:white; font-size:1.2em">${cachedCardCount}</span></div>
                <div title="Total de bolas extraídas">🎱 BOLAS: <span id="balls-count" style="color:white; font-size:1.2em">${bolasExtraidas.length}</span></div>
                <div title="Tiempo transcurrido">⏱️ <span id="game-timer" style="color:white; font-size:1.2em">00:00</span></div>
            </div>
            <div id="connection-status" style="color:var(--success)">● ONLINE</div>
        `;
        // Insertar antes del tablero
        if (board) adminContainer.insertBefore(statusBar, board);
    }

    // MOVER CONTROLES INFERIORES (Reiniciar + Auto + Voz) DEBAJO DEL TABLERO
    const bottomControls = document.querySelector('.bottom-controls-wrapper');
    if (bottomControls && board && board.parentNode) {
        board.parentNode.insertBefore(bottomControls, board.nextSibling);
    } else {
        const btnReset = document.querySelector('.btn-reset');
        if (btnReset && board && board.parentNode) {
            board.parentNode.insertBefore(btnReset, board.nextSibling);
        } else if (!btnReset && board && board.parentNode) {
            const newBtn = document.createElement('button');
            newBtn.className = 'btn-reset';
            newBtn.textContent = '⚠️ REINICIAR PARTIDA';
            newBtn.onclick = reiniciarJuego;
            board.parentNode.insertBefore(newBtn, board.nextSibling);
        }
    }

    // Crear contenedor de notificaciones si no existe
    if (!document.getElementById('admin-notif-container')) {
        const container = document.createElement('div');
        container.id = 'admin-notif-container';
        container.className = 'admin-notification-container';
        document.body.appendChild(container);
    }

    // PREPARAR CONTENEDOR EXTERNO (Debajo de la interfaz principal)
    let externalContainer = document.getElementById('admin-external-controls');
    
    if (!externalContainer && adminContainer) {
        externalContainer = document.createElement('div');
        externalContainer.id = 'admin-external-controls';
        externalContainer.style.width = '100%';
        externalContainer.style.maxWidth = '850px';
        externalContainer.style.display = 'flex';
        externalContainer.style.flexDirection = 'column';
        externalContainer.style.gap = '10px';
        externalContainer.style.marginTop = '20px';
        
        // Insertar después del contenedor principal
        adminContainer.parentNode.insertBefore(externalContainer, adminContainer.nextSibling);
    }
    
    // Si no hay admin-container, usamos body (fallback)
    const targetContainer = externalContainer || document.body;

    // INYECTAR MENSAJERÍA GLOBAL
    if (!document.getElementById('admin-messaging')) {
        const msgSection = document.createElement('div');
        msgSection.id = 'admin-messaging';
        msgSection.className = 'winners-section'; // Reutilizamos estilo de contenedor
        msgSection.style.marginTop = '0';
        
        msgSection.innerHTML = `
            <div class="winners-title"><span>📢 Enviar Mensaje Global</span></div>
            <div style="display:flex; gap:10px;">
                <input type="text" id="admin-msg-input" placeholder="Escribe un aviso para todos..." class="admin-input">
                <button type="button" onclick="enviarMensajeGlobal()" class="btn-small">ENVIAR</button>
            </div>
        `;
        targetContainer.appendChild(msgSection);
    }

    // --- BOTÓN DE SOLICITUDES ---
    if (!document.getElementById('btn-requests')) {
        const btn = document.createElement('button');
        btn.id = 'btn-requests';
        btn.className = 'btn-outline';
        btn.style.borderColor = 'var(--gold-solid)';
        btn.style.color = 'var(--gold-solid)';
        btn.innerHTML = '📩 SOLICITUDES <span id="btn-req-count">(0)</span>';
        btn.onclick = () => {
            verSolicitudesEnModal();
        };
        targetContainer.appendChild(btn);
    }

    // --- ALMACÉN DE SOLICITUDES (OCULTO) ---
    if (!document.getElementById('requests-storage')) {
        const storage = document.createElement('div');
        storage.id = 'requests-storage';
        storage.style.display = 'none';
        
        const list = document.createElement('div');
        list.id = 'requests-list';
        list.className = 'winners-list';
        
        const emptyMsg = document.createElement('div');
        emptyMsg.id = 'empty-requests-msg';
        emptyMsg.style.cssText = 'color:var(--text-muted); font-style:italic; font-size:0.9rem; text-align:center; padding:10px;';
        emptyMsg.textContent = 'No hay solicitudes pendientes.';
        
        list.appendChild(emptyMsg);
        storage.appendChild(list);
        document.body.appendChild(storage);
    }

    // INYECTAR BOTÓN HISTORIAL GANADORES (Reemplaza la sección fija)
    if (!document.getElementById('btn-winners')) {
        const btn = document.createElement('button');
        btn.id = 'btn-winners';
        btn.className = 'btn-outline';
        btn.textContent = '🏆 HISTORIAL DE GANADORES';
        btn.onclick = window.verHistorialGanadores;
        targetContainer.appendChild(btn);
    }

    // INYECTAR BOTÓN HISTORIAL PARTIDAS
    if (!document.getElementById('btn-history')) {
        const btn = document.createElement('button');
        btn.id = 'btn-history';
        btn.className = 'btn-outline';
        btn.textContent = '📜 HISTORIAL DE PARTIDAS';
        btn.onclick = window.verHistorialPartidas;
        targetContainer.appendChild(btn);
    }

    // INYECTAR BOTÓN PANTALLA COMPLETA
    if (!document.getElementById('btn-fullscreen')) {
        const btn = document.createElement('button');
        btn.id = 'btn-fullscreen';
        btn.className = 'btn-outline';
        btn.textContent = '⛶ PANTALLA COMPLETA';
        btn.onclick = toggleFullScreen;
        targetContainer.appendChild(btn);
    }

    // INYECTAR BOTÓN CERRAR SESIÓN
    if (!document.getElementById('btn-logout')) {
        const btn = document.createElement('button');
        btn.id = 'btn-logout';
        btn.className = 'btn-outline';
        btn.style.borderColor = 'var(--danger)';
        btn.style.color = 'var(--danger)';
        btn.textContent = '🔒 CERRAR SESIÓN';
        btn.onclick = window.cerrarSesionAdmin;
        targetContainer.appendChild(btn);
    }

    // INYECTAR MODAL ADMIN (Para ver detalles)
    if (!document.getElementById('admin-modal')) {
        const modal = document.createElement('div');
        modal.id = 'admin-modal';
        modal.className = 'modal-overlay';
        modal.style.display = 'none';
        modal.innerHTML = `
            <div class="modal-content" style="width: 600px; max-width: 95%;">
                <h2 id="admin-modal-title">TITULO</h2>
                <div id="admin-modal-body" style="max-height: 400px; overflow-y: auto; margin-bottom: 20px; text-align: left;"></div>
                <button onclick="cerrarModalAdmin()">CERRAR</button>
            </div>
        `;
        document.body.appendChild(modal);
    }
    initChatAdmin();

    // Inicializar color del slider
    const slider = document.getElementById('speed-slider');
    if (slider) updateAutoSpeed(slider.value);
}

// 3. Función Principal: Extraer y Anunciar Bola
function extraerBola() {
    if (isAnimating) return;

    if (juegoPausado) {
        if (confirm("⛔ El juego está PAUSADO tras un Bingo válido.\n¿Ya has verificado el cartón y deseas continuar?")) {
            juegoPausado = false;
            // Restaurar botón de extracción
            const btn = document.querySelector('.btn-extract');
            if (btn) {
                btn.textContent = "SACAR BOLA";
                btn.style.background = "";
                btn.style.boxShadow = "";
            }
        } else {
            return;
        }
    }

    if (bolasExtraidas.length >= totalBolas) {
        alert("¡Todas las bolas han sido extraídas!");
        return;
    }

    let bola;
    do {
        bola = Math.floor(Math.random() * totalBolas) + 1;
    } while (bolasExtraidas.includes(bola));

    bolasExtraidas.push(bola);
    isAnimating = true;

    // Animación de Ruleta
    const display = document.getElementById('display-ball');
    const interval = setInterval(() => {
        display.textContent = Math.floor(Math.random() * totalBolas) + 1;
    }, 50);

    setTimeout(() => {
        clearInterval(interval);
        actualizarConsolaAdmin(bola);
        cantarBolaAdmin(bola);
        socket.emit('nueva-bola-admin', bola);
        isAnimating = false;
    }, 1000);
}

function actualizarConsolaAdmin(bola) {
    const display = document.getElementById('display-ball');
    const statusText = document.getElementById('ball-text');
    const slot = document.getElementById(`slot-${bola}`);

    display.textContent = bola;
    
    if (slot) {
        slot.classList.add('called');
    }

    let letra = "";
    if (bola <= 15) letra = "B";
    else if (bola <= 30) letra = "I";
    else if (bola <= 45) letra = "N";
    else if (bola <= 60) letra = "G";
    else letra = "O";

    statusText.textContent = `Número cantado: ${letra}-${bola}`;

    // Actualizar contador de bolas
    const counter = document.getElementById('balls-count');
    if (counter) counter.textContent = bolasExtraidas.length;
}

function cantarBolaAdmin(numero) {
    if (!voiceEnabled) return;
    if ('speechSynthesis' in window) {
        let letra = "";
        if (numero <= 15) letra = "B";
        else if (numero <= 30) letra = "I";
        else if (numero <= 45) letra = "N";
        else if (numero <= 60) letra = "G";
        else letra = "O";

        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(`${letra} ${numero}`);
        utterance.lang = 'es-ES';
        utterance.rate = 0.9;
        window.speechSynthesis.speak(utterance);
    }
}

// --- CONTROL DE VOZ ---
window.toggleVoice = function() {
    voiceEnabled = !voiceEnabled;
    const btn = document.getElementById('btn-voice');
    if (btn) {
        if (voiceEnabled) {
            btn.textContent = "🔊 VOZ: ACTIVADA";
            btn.style.borderColor = "var(--gold-solid)";
            btn.style.color = "var(--gold-solid)";
            btn.style.opacity = "1";
        } else {
            btn.textContent = "🔇 VOZ: DESACTIVADA";
            btn.style.borderColor = "var(--text-muted)";
            btn.style.color = "var(--text-muted)";
            btn.style.opacity = "0.7";
        }
    }
};

// --- CONTROL DE COLAPSO ---
window.toggleBottomControls = function() {
    const content = document.getElementById('controls-content');
    const arrow = document.getElementById('controls-arrow');
    
    if (content) {
        if (content.classList.contains('expanded')) {
            content.classList.remove('expanded');
            if(arrow) arrow.style.transform = 'rotate(0deg)';
        } else {
            content.classList.add('expanded');
            if(arrow) arrow.style.transform = 'rotate(180deg)';
        }
    }
};

// --- CONTROL DE VELOCIDAD ---
window.updateAutoSpeed = function(val) {
    autoPlaySpeed = val * 1000;
    const display = document.getElementById('speed-display');
    const slider = document.getElementById('speed-slider');

    // Calcular color: 2s = Verde (120), 10s = Rojo (0)
    // Fórmula de interpolación lineal
    const hue = 120 - ((val - 2) / 8) * 120; 
    const color = `hsl(${hue}, 100%, 50%)`;

    if (display) {
        display.textContent = val + 's';
        display.style.color = color;
        display.style.textShadow = `0 0 10px ${color}`;
    }

    if (slider) {
        slider.style.accentColor = color;
        slider.style.boxShadow = `0 0 15px ${color.replace('50%', '20%')}`; // Resplandor suave
    }
    
    // Si está corriendo, reiniciar intervalo para aplicar cambio inmediato
    if (autoPlayInterval) {
        clearInterval(autoPlayInterval);
        autoPlayInterval = setInterval(() => {
            if (juegoPausado || bolasExtraidas.length >= totalBolas) {
                detenerAutomatico();
                return;
            }
            extraerBola();
        }, autoPlaySpeed);
    }
};

// --- MODO AUTOMÁTICO ---
window.toggleAutomatico = function() {
    const btn = document.getElementById('btn-auto');
    
    if (autoPlayInterval) {
        detenerAutomatico();
    } else {
        if (juegoPausado) {
            alert("El juego está pausado. Debes reanudarlo antes de activar el modo automático.");
            return;
        }
        if (bolasExtraidas.length >= totalBolas) {
            alert("No quedan bolas por sacar.");
            return;
        }

        if (btn) {
            btn.textContent = "⏹ DETENER AUTO";
            btn.style.background = "var(--danger)";
            btn.classList.add('pulse-animation');
        }
        
        extraerBola(); // Primera bola inmediata
        
        autoPlayInterval = setInterval(() => {
            if (juegoPausado || bolasExtraidas.length >= totalBolas) {
                detenerAutomatico();
                return;
            }
            extraerBola();
        }, autoPlaySpeed);
    }
};

window.detenerAutomatico = function() {
    if (autoPlayInterval) {
        clearInterval(autoPlayInterval);
        autoPlayInterval = null;
    }
    const btn = document.getElementById('btn-auto');
    if (btn) {
        btn.textContent = "🔄 AUTOMÁTICO";
        btn.style.background = "linear-gradient(135deg, #1F4558, #143D59)";
        btn.classList.remove('pulse-animation');
    }
};

// 4. Gestión de Eventos del Servidor
socket.on('jugadores-listos', (cantidad) => {
    cachedPlayerCount = cantidad;
    const contadorUI = document.getElementById('player-count');
    if (contadorUI) {
        contadorUI.textContent = cantidad;
        // Pequeña animación de actualización
        contadorUI.style.color = 'var(--gold-solid)';
        setTimeout(() => contadorUI.style.color = 'white', 500);
    }
});

socket.on('cartones-en-juego', (cantidad) => {
    cachedCardCount = cantidad;
    const contadorUI = document.getElementById('card-count');
    if (contadorUI) {
        contadorUI.textContent = cantidad;
        contadorUI.style.color = 'var(--gold-solid)';
        setTimeout(() => contadorUI.style.color = 'white', 500);
    }
});

// ESCUCHAR CUANDO ALGUIEN CANTA BINGO
socket.on('notificar-bingo', (data) => {
    // Mostrar estado de la reclamación (válido / inválido / pendiente)
    console.log("¡Reclamación de Bingo recibida!", data);
    mostrarNotificacionAdmin(data);

    if (data.valid) {
        agregarGanador(data);
        // Pausa automática al detectar ganador
        if (!juegoPausado) {
            window.pausarJuego(true);
        }
        // Visualizar automáticamente el cartón ganador en pantalla
        verCartonEnModal(data);
        
        // Activar alerta visual en botón de reinicio
        const btnReset = document.querySelector('.btn-reset');
        if (btnReset) {
            btnReset.classList.add('game-over');
            if (audioAlarm.paused) {
                audioAlarm.currentTime = 0;
                audioAlarm.play().catch(e => console.warn("Alarma bloqueada por navegador:", e));
            }
        }
    }
});

// RECIBIR HISTORIAL PERSISTENTE
socket.on('historial-ganadores', (lista) => {
    // Si recibimos esto, el login fue exitoso
    const loginModal = document.getElementById('login-modal');
    if (loginModal) loginModal.style.display = 'none';

    // Actualizar memoria local
    currentWinnersList = lista || [];
    
    // Si hay ganadores al conectar, marcar el botón de reinicio
    if (currentWinnersList.length > 0) {
        const btnReset = document.querySelector('.btn-reset');
        if (btnReset) btnReset.classList.add('game-over');
    }
});

// 5. Reiniciar el Juego
function reiniciarJuego() {
    if (confirm("¿Deseas resetear el tablero para todos los jugadores?")) {
        socket.emit('reiniciar-juego');
    }
}

socket.on('sync-game-id', (id) => {
    // El ID ya no controla el tiempo, solo la sesión
});

socket.on('sync-game-start-time', (timestamp) => {
    gameStartTime = timestamp;
    if (gameStartTime) {
        startTimer();
    } else {
        if (gameTimerInterval) clearInterval(gameTimerInterval);
        updateTimerDisplay(); // Resetear a 00:00
    }
});

socket.on('limpiar-tablero', (newId) => {
    detenerAutomatico();
    gameStartTime = null;
    bolasExtraidas = [];
    initTablero();
    document.getElementById('display-ball').textContent = "--";
    
    document.getElementById('ball-text').textContent = "¡Mucha suerte a todos!";
    
    // Limpiar lista de ganadores
    currentWinnersList = [];

    // Resetear contador de bolas
    const ballCounter = document.getElementById('balls-count');
    if (ballCounter) ballCounter.textContent = '0';

    // Resetear estado de pausa y restaurar botón
    juegoPausado = false;
    const btn = document.querySelector('.btn-extract');
    if (btn) {
        btn.textContent = "SACAR BOLA";
        btn.style.background = "";
        btn.style.boxShadow = "";
    }
    
    // Quitar alerta del botón de reinicio
    const btnReset = document.querySelector('.btn-reset');
    if (btnReset) {
        btnReset.classList.remove('game-over');
        audioAlarm.pause();
        audioAlarm.currentTime = 0;
    }
    
    updateTimerDisplay(); // Mostrar 00:00
});

// Sincronización por si el admin refresca la página
socket.on('historial', (bolas) => {
    bolasExtraidas = bolas;
    bolas.forEach(bola => {
        const slot = document.getElementById(`slot-${bola}`);
        if (slot) slot.classList.add('called');
    });
    if (bolas.length > 0) {
        actualizarConsolaAdmin(bolas[bolas.length - 1]);
    }
});

// 6. Sistema de Notificaciones Admin
function mostrarNotificacionAdmin(data) {
    const container = document.getElementById('admin-notif-container');
    if (!container) return;

    const notif = document.createElement('div');
    const isValid = data.valid;
    
    notif.className = `admin-notification ${isValid ? 'valid' : 'invalid'}`;
    
    const icon = isValid ? '🎉' : '⚠️';
    const title = isValid ? 'BINGO VÁLIDO' : 'RECLAMO INVÁLIDO';
    const colorTitle = isValid ? 'var(--success)' : 'var(--danger)';
    
    const audio = isValid ? audioWin : audioFail;
    if(audio) {
        audio.currentTime = 0;
        audio.play().catch(e => console.warn("Audio bloqueado:", e));
    }

    // Botón de pausa solo si es válido
    let botonPausa = '';
    if (isValid) {
        botonPausa = `<button onclick="event.stopPropagation(); window.pausarJuego();" style="margin-top:8px; padding:6px; width:100%; background:var(--dark-bg); color:var(--danger); border:1px solid var(--danger); border-radius:6px; font-weight:bold; cursor:pointer;">🛑 PAUSAR JUEGO</button>`;
    }

    const nombreDisplay = data.nombre ? `${data.nombre}` : `ID: ${data.id.substr(0,4)}`;
    const winningNumsDisplay = data.winningNumbers && data.winningNumbers.length > 0 
        ? data.winningNumbers.join(', ') 
        : (data.numeros ? data.numeros.join(', ') : '');

    notif.innerHTML = `
        <div class="notif-close-btn" style="position:absolute; top:5px; right:5px; padding:5px; cursor:pointer; opacity:0.6; font-weight:bold; z-index:5;" title="Cerrar notificación">✕</div>
        <div class="notif-header" style="color: ${colorTitle}">
            <span>${icon} ${title}</span>
            <span style="font-size: 0.7em; opacity: 0.7; margin-right:15px;">🎫 ${data.cartonId}</span>
        </div>
        <div class="notif-body">
            <div style="font-size:1.1em; font-weight:bold; color:white; margin-bottom:4px;">${nombreDisplay}</div>
            <div style="margin-bottom:4px;"><strong>Motivo:</strong> ${data.reason || 'Línea correcta'}</div>
            <div><strong>Ganadores:</strong> ${winningNumsDisplay}</div>
            <div style="font-size:0.8em; color:var(--gold-solid); margin-top:5px; font-style:italic;">(Click para ver cartón)</div>
            ${botonPausa}
        </div>
    `;

    // Click en notificación abre el modal
    notif.onclick = () => {
        verCartonEnModal(data);
    };

    // Click en cerrar
    const btnClose = notif.querySelector('.notif-close-btn');
    if (btnClose) {
        btnClose.onclick = (e) => {
            e.stopPropagation();
            notif.style.opacity = '0';
            setTimeout(() => notif.remove(), 300);
        };
    }

    // Auto cerrar en 8 segundos
    setTimeout(() => {
        if (document.body.contains(notif)) {
            notif.style.opacity = '0';
            setTimeout(() => notif.remove(), 300);
        }
    }, 8000);

    container.appendChild(notif);
}

// Función global para pausar desde la notificación
window.pausarJuego = function(automatico = false) {
    detenerAutomatico();
    juegoPausado = true;
    
    // Feedback visual en el botón principal
    const btn = document.querySelector('.btn-extract');
    if (btn) {
        btn.textContent = "🛑 JUEGO PAUSADO";
        btn.style.background = "var(--danger)";
        btn.style.boxShadow = "none";
    }

    if (!automatico) {
        alert("🛑 JUEGO PAUSADO\nNo podrás extraer más bolas hasta que confirmes la reanudación al intentar sacar la siguiente.");
    }
};

// 7. Función para agregar ganador al historial
function agregarGanador(data) {
    // Agregar al principio de la lista en memoria
    currentWinnersList.unshift(data);
    
    // Si el modal de ganadores está abierto, refrescarlo
    const modal = document.getElementById('admin-modal');
    const title = document.getElementById('admin-modal-title');
    if (modal.style.display === 'flex' && title && title.textContent.includes('GANADORES')) {
        window.verHistorialGanadores();
    }
}

// 8. Pantalla Completa
function toggleFullScreen() {
    if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(e => {
            console.log(`Error al entrar en pantalla completa: ${e.message}`);
        });
    } else {
        if (document.exitFullscreen) document.exitFullscreen();
    }
}

// 8.1 Cerrar Sesión
window.cerrarSesionAdmin = function() {
    if (confirm("¿Estás seguro de que deseas cerrar sesión?")) {
        sessionStorage.removeItem('admin-token');
        window.location.reload();
    }
};

// 9. Mensajería Global
window.enviarMensajeGlobal = function() {
    const input = document.getElementById('admin-msg-input');
    const msg = input.value.trim();
    
    if (msg) {
        if (confirm(`¿Enviar mensaje a TODOS los jugadores?\n\n"${msg}"`)) {
            console.log("Enviando mensaje global:", msg);
            socket.emit('admin-mensaje', msg);
            input.value = '';
            
            // Feedback visual para el admin (Confirmación de envío)
            mostrarNotificacionAdmin({ 
                valid: true, 
                id: 'ADMIN', 
                cartonId: 'GLOBAL',
                numeros: [], 
                reason: 'Mensaje enviado: ' + msg 
            });
        }
    }
}

// 10. Ver Detalles de Cartones
window.verDetallesCartones = function() {
    socket.emit('admin-solicitar-detalles-cartones');
};

socket.on('admin-detalles-cartones', (lista) => {
    safeguardRequestsList();
    const html = lista.length > 0 
        ? `<div style="display: flex; flex-wrap: wrap; gap: 10px; justify-content: center;">
            ${lista.map(id => `<span style="background: rgba(255,255,255,0.1); padding: 8px 12px; border-radius: 8px; border: 1px solid var(--glass-border); font-family: monospace; font-size: 1.1em; color: var(--gold-solid);">${id}</span>`).join('')}
           </div>`
        : '<p style="color: var(--text-muted);">No hay cartones activos en este momento.</p>';
    
    const modal = document.getElementById('admin-modal');
    document.getElementById('admin-modal-title').textContent = `🎫 CARTONES ACTIVOS (${lista.length})`;
    document.getElementById('admin-modal-body').innerHTML = html;
    modal.style.display = 'flex';
});

window.verDetallesJugadores = function() {
    viewingPlayersList = true;
    socket.emit('admin-solicitar-detalles-jugadores');
};

socket.on('admin-lista-jugadores', (lista) => {
    safeguardRequestsList();
    if (!viewingPlayersList) return;

    const html = lista.length > 0 
        ? `<div style="display:flex; flex-direction:column; gap:10px;">
            ${lista.map(p => `
                <div style="background:rgba(255,255,255,0.05); padding:10px; border-radius:8px; display:flex; justify-content:space-between; align-items:center; border-left:3px solid var(--gold-solid);">
                    <div>
                        <div style="font-weight:bold; color:white;">${p.nombre}</div>
                        <div style="font-size:0.8em; color:var(--text-muted);">ID: ${p.id.substr(0,4)}</div>
                    </div>
                    <div style="text-align:right;">
                        <div style="font-size:1.2em; font-weight:bold; color:var(--gold-solid);">${p.cartones} <span style="font-size:0.6em; color:var(--text-muted);">CARTONES</span></div>
                        <div style="font-size:0.7em; color:var(--text-muted);">${p.idsCartones.join(', ')}</div>
                    </div>
                </div>
            `).join('')}
           </div>`
        : '<p style="color: var(--text-muted); text-align:center;">No hay jugadores con cartones activos.</p>';

    const modal = document.getElementById('admin-modal');
    document.getElementById('admin-modal-title').textContent = `👥 JUGADORES (${lista.length})`;
    document.getElementById('admin-modal-body').innerHTML = html;
    modal.style.display = 'flex';
});

window.cerrarModalAdmin = function() {
    safeguardRequestsList();
    viewingPlayersList = false;
    document.getElementById('admin-modal').style.display = 'none';
};

// 12. Ver Historial de Ganadores (Estilo Modal)
window.verHistorialGanadores = function() {
    safeguardRequestsList();
    let html = '';
    if (!currentWinnersList || currentWinnersList.length === 0) {
        html = '<p style="color: var(--text-muted); text-align:center;">Aún no hay ganadores en esta partida.</p>';
    } else {
        html = currentWinnersList.map(w => {
            const date = w.timestamp ? new Date(w.timestamp).toLocaleTimeString() : '';
            const rank = w.winnerRank ? `#${w.winnerRank}` : '';
            return `
                <div style="background: rgba(255,255,255,0.05); padding: 15px; margin-bottom: 10px; border-radius: 8px; border-left: 3px solid var(--success);">
                    <div style="display:flex; justify-content:space-between; margin-bottom:5px; align-items:center;">
                        <strong style="color:var(--text-main); font-size:1.1em">
                            <span style="color:var(--gold-solid); margin-right:5px;">${rank}</span> ${w.nombre || 'Anónimo'}
                        </strong>
                        <span style="font-size:0.85em; color:var(--text-muted); font-family:monospace;">${date}</span>
                    </div>
                    <div style="font-size:0.9em; color:var(--text-muted); margin-bottom:5px;">
                        🎫 Cartón: <span style="color:var(--gold-solid);">${w.cartonId}</span>
                    </div>
                    <div style="font-size:0.85em; color:var(--success);">
                        Números: ${w.winningNumbers ? w.winningNumbers.join(', ') : 'N/A'}
                    </div>
                </div>
            `;
        }).join('');
    }

    const modal = document.getElementById('admin-modal');
    document.getElementById('admin-modal-title').textContent = `🏆 GANADORES (${currentWinnersList.length})`;
    document.getElementById('admin-modal-body').innerHTML = html;
    modal.style.display = 'flex';
};

// 11. Ver Historial de Partidas
window.verHistorialPartidas = function() {
    socket.emit('admin-solicitar-historial-partidas');
};

socket.on('admin-historial-partidas', (history) => {
    safeguardRequestsList();
    let html = '';
    if (!history || history.length === 0) {
        html = '<p style="color: var(--text-muted); text-align:center;">No hay partidas registradas en el historial.</p>';
    } else {
        html = history.map(game => {
            const date = new Date(game.timestamp).toLocaleString();
            return `
                <div style="background: rgba(255,255,255,0.05); padding: 15px; margin-bottom: 10px; border-radius: 8px; border-left: 3px solid var(--gold-solid);">
                    <div style="display:flex; justify-content:space-between; margin-bottom:5px; align-items:center;">
                        <strong style="color:var(--gold-solid); font-size:0.95em">${date}</strong>
                        <span style="font-size:0.85em; background:rgba(0,0,0,0.3); padding:2px 6px; border-radius:4px;">🎱 ${game.ballsCalled} bolas</span>
                    </div>
                    <div style="font-size:0.9em; color:var(--text-muted); margin-bottom:5px;">
                        🏆 ${game.winnerCount} Ganadores
                    </div>
                    ${game.winners.length > 0 ? 
                        `<div style="margin-top:5px; font-size:0.85em; padding-top:5px; border-top:1px solid rgba(255,255,255,0.1); color:var(--text-main); opacity:0.8;">
                            ${game.winners.map(w => `<div>• ID ${w.id.substr(0,4)} (🎫 ${w.cartonId})</div>`).join('')}
                         </div>` 
                        : ''}
                </div>
            `;
        }).join('');
    }
    
    const modal = document.getElementById('admin-modal');
    document.getElementById('admin-modal-title').textContent = `📜 ÚLTIMAS PARTIDAS`;
    document.getElementById('admin-modal-body').innerHTML = html;
    modal.style.display = 'flex';
});

// --- GESTIÓN DE SOLICITUDES ---
socket.on('admin-nueva-solicitud', (data) => {
    const list = document.getElementById('requests-list');
    const emptyMsg = document.getElementById('empty-requests-msg');
    
    if (emptyMsg) emptyMsg.remove();
    
    // Reproducir sonido de notificación
    if (audioRequest) {
        audioRequest.currentTime = 0;
        audioRequest.play().catch(e=>{});
    }

    const item = document.createElement('div');
    item.id = `req-${data.socketId}`;
    item.className = 'winner-item'; // Reutilizamos estilo de item
    item.style.borderLeft = '3px solid var(--gold-solid)';
    item.style.flexDirection = 'column';
    item.style.alignItems = 'flex-start';
    item.style.gap = '10px';

    item.innerHTML = `
        <div style="width:100%; display:flex; justify-content:space-between; align-items:center;">
            <div>
                <strong style="color:white; font-size:1.1em">${data.nombre}</strong>
                <div style="font-size:0.85em; color:var(--text-muted)">ID: ${data.socketId.substr(0,4)}</div>
                <div style="font-size:0.85em; color:var(--gold-solid); margin-top:4px; line-height:1.2;">
                    🏦 ${data.banco || 'N/A'} <br> #️⃣ Ref: ${data.referencia || 'N/A'}
                </div>
            </div>
            <div style="background:rgba(255,255,255,0.1); padding:5px 10px; border-radius:8px; color:var(--gold-solid); font-weight:bold;">
                ${data.cantidad} Cartones
            </div>
        </div>
        <div style="width:100%; display:flex; gap:10px;">
            <button onclick="aprobarSolicitud('${data.socketId}', ${data.cantidad}, '${data.nombre}')" style="padding:8px; font-size:0.8em; background:var(--success); color:white;">APROBAR</button>
            <button onclick="rechazarSolicitud('${data.socketId}')" style="padding:8px; font-size:0.8em; background:transparent; border:1px solid var(--danger); color:var(--danger);">RECHAZAR</button>
        </div>
    `;

    list.appendChild(item);
    updateRequestsButton();
});

window.aprobarSolicitud = function(socketId, cantidad, nombre) {
    socket.emit('admin-aprobar-solicitud', { socketId, cantidad });
    const item = document.getElementById(`req-${socketId}`);
    if (item) item.remove();
    updateRequestsButton();
};

window.rechazarSolicitud = function(socketId) {
    if (confirm("¿Rechazar solicitud?")) {
        socket.emit('admin-rechazar-solicitud', { socketId, motivo: "Denegado por el administrador. Favor revise sus datos." });
        const item = document.getElementById(`req-${socketId}`);
        if (item) item.remove();
        updateRequestsButton();
    }
};

function updateRequestsButton() {
    const list = document.getElementById('requests-list');
    const btn = document.getElementById('btn-requests');
    const countSpan = document.getElementById('btn-req-count');
    
    if (!list || !btn) return;
    
    const count = list.querySelectorAll('div[id^="req-"]').length;
    
    if (countSpan) countSpan.textContent = `(${count})`;
    
    if (count > 0) {
        btn.style.backgroundColor = 'var(--danger)';
        btn.style.borderColor = 'var(--danger)';
        btn.style.color = 'white';
    } else {
        btn.style.backgroundColor = 'transparent';
        btn.style.borderColor = 'var(--gold-solid)';
        btn.style.color = 'var(--gold-solid)';
    }

    const emptyMsg = document.getElementById('empty-requests-msg');
    if (count === 0 && !emptyMsg) {
        const msg = document.createElement('div');
        msg.id = 'empty-requests-msg';
        msg.style.cssText = 'color:var(--text-muted); font-style:italic; font-size:0.9rem; text-align:center; padding:10px;';
        msg.textContent = 'No hay solicitudes pendientes.';
        list.appendChild(msg);
    }
}

// --- CHAT SYSTEM (ADMIN) ---
function initChatAdmin() {
    if (document.getElementById('chat-widget')) return;

    const chatBtn = document.createElement('div');
    chatBtn.className = 'chat-toggle-btn';
    chatBtn.innerHTML = '💬<div id="chat-badge" class="chat-badge" style="display:none">0</div>';
    chatBtn.onclick = toggleChat;
    document.body.appendChild(chatBtn);

    const chatWindow = document.createElement('div');
    chatWindow.id = 'chat-widget';
    chatWindow.className = 'chat-window';
    chatWindow.style.display = 'none';
    chatWindow.innerHTML = `
        <div class="chat-header">
            <span>CHAT GLOBAL</span>
            <div style="display:flex; gap:10px; align-items:center;">
                <span onclick="borrarChat()" style="cursor:pointer; font-size:1.1rem;" title="Borrar historial">🗑️</span>
                <span onclick="toggleChat()" style="cursor:pointer">✕</span>
            </div>
        </div>
        <div class="chat-messages" id="chat-messages"></div>
        <div class="chat-input-area">
            <input type="text" id="chat-input" class="admin-input" placeholder="Mensaje como Admin..." style="font-size:0.9rem; padding:8px;">
            <button onclick="enviarMensajeChat()" class="btn-small" style="padding:0 10px;">➤</button>
        </div>
    `;
    document.body.appendChild(chatWindow);

    // Enviar con Enter
    document.getElementById('chat-input').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') enviarMensajeChat();
    });
}

function toggleChat() {
    const w = document.getElementById('chat-widget');
    w.style.display = w.style.display === 'none' ? 'flex' : 'none';
    if (w.style.display === 'flex') {
        const btn = document.querySelector('.chat-toggle-btn');
        if (btn) btn.classList.remove('has-new-messages');
        const badge = document.getElementById('chat-badge');
        if (badge) {
            badge.style.display = 'none';
            badge.textContent = '0';
        }
        document.getElementById('chat-input').focus();
        const msgs = document.getElementById('chat-messages');
        msgs.scrollTop = msgs.scrollHeight;
    }
}

function enviarMensajeChat() {
    const input = document.getElementById('chat-input');
    const texto = input.value.trim();
    if (!texto) return;

    socket.emit('chat-mensaje', { usuario: 'ADMIN', texto: texto, esAdmin: true });
    input.value = '';
}

window.borrarChat = function() {
    if (confirm("¿Estás seguro de que quieres borrar el historial del chat para TODOS los usuarios?")) {
        socket.emit('admin-clear-chat');
    }
};

socket.on('chat-clear-history', () => {
    const container = document.getElementById('chat-messages');
    if (container) container.innerHTML = '<div style="text-align:center; color:var(--text-muted); font-size:0.8em; padding:10px; font-style:italic;">Historial borrado por el administrador.</div>';
});

socket.on('chat-nuevo-mensaje', (data) => {
    const container = document.getElementById('chat-messages');
    if (!container) return;

    // Sonido de notificación si es un mensaje de jugador
    if (!data.esAdmin) {
        const audio = new Audio('sounds/pop.mp3');
        audio.volume = 0.4;
        audio.play().catch(e => {});

        // Animación del botón si el chat está cerrado
        const widget = document.getElementById('chat-widget');
        if (widget && widget.style.display === 'none') {
            const btn = document.querySelector('.chat-toggle-btn');
            if (btn) {
                btn.classList.add('has-new-messages');
                btn.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.3)' }, { transform: 'scale(1)' }], 300);
                const badge = document.getElementById('chat-badge');
                if (badge) {
                    let count = parseInt(badge.textContent) || 0;
                    count++;
                    badge.textContent = count > 99 ? '99+' : count;
                    badge.style.display = 'flex';
                }
            }
        }
    }

    const div = document.createElement('div');
    
    let clase = 'others';
    if (data.esAdmin) {
        clase = 'mine'; // Asumimos que soy yo (el admin)
    }
    
    div.className = `chat-msg ${clase}`;
    // Si es admin, mostrar en rojo/distinto
    
    const time = data.timestamp ? new Date(data.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : '';
    div.innerHTML = `<strong>${data.usuario}:</strong> ${data.texto}<div class="chat-time">${time}</div>`;
    
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
});

function verCartonEnModal(data) {
    safeguardRequestsList();
    const modal = document.getElementById('admin-modal');
    const title = document.getElementById('admin-modal-title');
    const body = document.getElementById('admin-modal-body');
    
    title.textContent = `CARTÓN ${data.cartonId}`;
    
    if (!data.carton || !Array.isArray(data.carton)) {
        body.innerHTML = "<p style='text-align:center; color:var(--text-muted);'>No hay datos visuales del cartón.</p>";
        modal.style.display = 'flex';
        return;
    }

    const marked = new Set((data.numeros || []).map(String));
    const winners = new Set((data.winningNumbers || []).map(String));

    let gridHtml = '<div style="display:grid; grid-template-columns:repeat(5, 1fr); gap:8px; max-width:350px; margin:0 auto; background:rgba(0,0,0,0.3); padding:15px; border-radius:12px; border:1px solid rgba(255,255,255,0.1);">';
    
    // Headers
    ['B','I','N','G','O'].forEach(l => {
        gridHtml += `<div style="text-align:center; font-weight:800; color:var(--gold-solid); padding-bottom:5px; font-size:1.2em;">${l}</div>`;
    });

    // Rows
    for(let r=0; r<5; r++) {
        for(let c=0; c<5; c++) {
            const val = data.carton[r][c];
            let style = 'background:rgba(255,255,255,0.05); color:white; border:1px solid rgba(255,255,255,0.05);';
            let content = val;

            if (val === 'FREE') {
                content = '★';
                style = 'background:rgba(51, 107, 135, 0.15); color:var(--gold-solid); border:1px dashed var(--gold-solid);';
            } else {
                const sVal = String(val);
                if (winners.has(sVal)) {
                    style = 'background:var(--success); color:white; font-weight:bold; box-shadow:0 0 15px rgba(16, 185, 129, 0.4); border:1px solid white; transform:scale(1.05); z-index:2;';
                } else if (marked.has(sVal)) {
                    style = 'background:var(--gold-solid); color:black; font-weight:bold; box-shadow:0 0 5px rgba(51, 107, 135, 0.3);';
                }
            }

            gridHtml += `<div style="${style} aspect-ratio:1; display:flex; align-items:center; justify-content:center; border-radius:8px; font-size:1.1em; transition:all 0.3s;">${content}</div>`;
        }
    }
    gridHtml += '</div>';

    const infoHtml = `
        <div style="text-align:center; margin-bottom:20px;">
            <h3 style="color:white; margin-bottom:5px; font-size:1.4em;">${data.nombre || 'Jugador'}</h3>
            <div style="color:var(--text-muted); font-size:0.9em;">ID: ${data.id}</div>
        </div>
        ${gridHtml}
        <div style="margin-top:20px; text-align:center; padding-top:15px; border-top:1px solid rgba(255,255,255,0.1);">
            <div style="margin-bottom:5px; font-size:1.1em;">Estado: <strong style="color:${data.valid?'var(--success)':'var(--danger)'}">${data.valid?'VÁLIDO':'INVÁLIDO'}</strong></div>
            <div style="font-size:0.9em; opacity:0.8;">${data.reason || ''}</div>
        </div>
    `;

    body.innerHTML = infoHtml;
    modal.style.display = 'flex';
}

window.verSolicitudesEnModal = function() {
    safeguardRequestsList();
    const list = document.getElementById('requests-list');
    const modal = document.getElementById('admin-modal');
    const title = document.getElementById('admin-modal-title');
    const body = document.getElementById('admin-modal-body');

    if (!list) return;

    list.style.maxHeight = 'none';
    title.textContent = "📩 SOLICITUDES PENDIENTES";
    body.innerHTML = ''; 
    body.appendChild(list);
    modal.style.display = 'flex';
};

function safeguardRequestsList() {
    const list = document.getElementById('requests-list');
    const storage = document.getElementById('requests-storage');
    if (list && storage && !storage.contains(list)) {
        storage.appendChild(list);
    }
}

window.onload = initTablero;

// --- PWA INSTALLATION (ADMIN) ---
let deferredPrompt;

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        // Usar ruta relativa para compatibilidad con GitHub Pages
        navigator.serviceWorker.register('./sw.js').catch(err => console.log('Error SW:', err));
    });
}

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    
    // Mostrar Banner si no ha sido descartado previamente
    if (!localStorage.getItem('pwa-banner-dismissed')) {
        mostrarBannerPWA();
    } else {
        // Fallback: Mostrar botón flotante si ya cerró el banner antes
        const btn = document.getElementById('btn-install-pwa');
        if (btn) btn.style.display = 'flex';
    }
});

function mostrarBannerPWA() {
    if (document.getElementById('pwa-install-banner')) return;

    const banner = document.createElement('div');
    banner.id = 'pwa-install-banner';
    banner.className = 'pwa-banner';
    banner.innerHTML = `
        <div class="pwa-content">
            <img src="./icons/ajp.png" alt="App Icon" class="pwa-icon">
            <div class="pwa-text">
                <strong>Instalar Panel Admin</strong>
                <span>Gestiona el Bingo desde una App nativa.</span>
            </div>
        </div>
        <div class="pwa-actions">
            <button onclick="cerrarBannerPWA()" class="pwa-btn-cancel">Ahora no</button>
            <button onclick="instalarPWA()" class="pwa-btn-install">Instalar</button>
        </div>
    `;
    document.body.appendChild(banner);
    
    // Animación de entrada
    requestAnimationFrame(() => {
        banner.classList.add('visible');
    });
}

window.cerrarBannerPWA = function() {
    const banner = document.getElementById('pwa-install-banner');
    if (banner) {
        banner.classList.remove('visible');
        setTimeout(() => banner.remove(), 300);
    }
    localStorage.setItem('pwa-banner-dismissed', 'true');
    
    // Mostrar botón flotante pequeño por si cambia de opinión
    const btn = document.getElementById('btn-install-pwa');
    if (btn) btn.style.display = 'flex';
};

window.instalarPWA = function() {
    // Cerrar banner si está abierto
    const banner = document.getElementById('pwa-install-banner');
    if (banner) {
        banner.classList.remove('visible');
        setTimeout(() => banner.remove(), 300);
    }

    if (deferredPrompt) {
        deferredPrompt.prompt();
        deferredPrompt.userChoice.then((choiceResult) => {
            if (choiceResult.outcome === 'accepted') {
                const btn = document.getElementById('btn-install-pwa');
                if (btn) btn.style.display = 'none';
            }
            deferredPrompt = null;
        });
    }
};

// --- SISTEMA DE LOGIN ---
function mostrarLoginAdmin(errorMsg = "") {
    let modal = document.getElementById('login-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'login-modal';
        modal.className = 'modal-overlay';
        modal.style.zIndex = '20000';
        modal.style.backdropFilter = 'blur(15px)';
        
        modal.innerHTML = `
            <div class="modal-content" style="width: 400px; text-align: center; border-color: var(--gold-solid); animation: smoothLoginEntry 0.6s cubic-bezier(0.22, 1, 0.36, 1);">
                <img src="./icons/ajp.png" alt="Logo AJP" style="width: 80px; margin-bottom: 15px; filter: drop-shadow(0 0 15px rgba(51, 107, 135, 0.5));">
                <h2 style="color: var(--gold-solid); margin-bottom: 10px;">ACCESO ADMIN</h2>
                <p style="color: var(--text-muted); margin-bottom: 20px;">Introduce la clave para gestionar el juego.</p>
                
                <p id="login-error-msg" style="color: var(--danger); margin-bottom: 15px; font-weight: bold; min-height: 1.2em;">${errorMsg}</p>
                
                <form id="login-form" onsubmit="event.preventDefault(); submitLogin();">
                    <div style="position: relative; width: 100%; margin-bottom: 20px;">
                        <input type="password" id="admin-password-input" class="admin-input" placeholder="Contraseña..." style="width: 100%; text-align: center; font-size: 1.2rem; background: rgba(0,0,0,0.5); padding-right: 40px;" oninput="const btn = document.getElementById('btn-login-submit'); btn.disabled = !this.value.trim(); btn.style.opacity = this.value.trim() ? '1' : '0.5';">
                        <span id="toggle-password" onclick="togglePasswordVisibility()" style="position: absolute; right: 15px; top: 50%; transform: translateY(-50%); cursor: pointer; opacity: 0.7; font-size: 1.2rem; user-select: none;" title="Mostrar contraseña">👁️</span>
                    </div>
                    <button id="btn-login-submit" type="submit" disabled style="background: var(--gold-gradient); color: black; box-shadow: 0 0 15px rgba(51, 107, 135, 0.3); opacity: 0.5; transition: opacity 0.3s;">ENTRAR</button>
                </form>
                <div onclick="alert('Por seguridad, la contraseña se gestiona en el servidor.\\n\\nSi eres el administrador, revisa la variable ADMIN_TOKEN en la configuración.')" style="margin-top: 15px; cursor: pointer; color: var(--text-muted); font-size: 0.9rem; text-decoration: underline; opacity: 0.7; transition: opacity 0.2s;" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.7">¿Olvidaste tu contraseña?</div>
            </div>
        `;
        document.body.appendChild(modal);
    } else {
        const errorEl = document.getElementById('login-error-msg');
        if (errorEl) errorEl.textContent = errorMsg;
        modal.style.display = 'flex';
        const btn = document.getElementById('btn-login-submit');
        if (btn) { btn.textContent = "ENTRAR"; }
    }
    
    if (errorMsg) {
        const content = modal.querySelector('.modal-content');
        if (content) {
            content.classList.remove('error-shake');
            void content.offsetWidth; // Trigger reflow para reiniciar animación
            content.classList.add('error-shake');
            setTimeout(() => content.classList.remove('error-shake'), 500);
        }
    }
    
    setTimeout(() => {
        const input = document.getElementById('admin-password-input');
        if (input) { 
            input.value = ''; 
            input.focus(); 
            const btn = document.getElementById('btn-login-submit');
            if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; }
        }
    }, 100);
}

window.submitLogin = function() {
    const input = document.getElementById('admin-password-input');
    if (!input) return;
    const token = input.value.trim();
    if (token) {
        sessionStorage.setItem('admin-token', token);
        socket.emit('admin-join', token);
        
        const btn = document.getElementById('btn-login-submit');
        if (btn) { btn.textContent = "VERIFICANDO..."; btn.disabled = true; btn.style.opacity = 0.7; }
    }
};

window.togglePasswordVisibility = function() {
    const input = document.getElementById('admin-password-input');
    const icon = document.getElementById('toggle-password');
    if (!input || !icon) return;
    
    if (input.type === "password") {
        input.type = "text";
        icon.textContent = "🙈"; // Icono de ocultar
        icon.title = "Ocultar contraseña";
    } else {
        input.type = "password";
        icon.textContent = "👁️"; // Icono de mostrar
        icon.title = "Mostrar contraseña";
    }
    input.focus();
};

function startTimer() {
    if (gameTimerInterval) clearInterval(gameTimerInterval);
    updateTimerDisplay();
    gameTimerInterval = setInterval(updateTimerDisplay, 1000);
}

function updateTimerDisplay() {
    const el = document.getElementById('game-timer');
    if (!el) return;
    
    if (!gameStartTime) {
        el.textContent = "00:00";
        return;
    }
    
    const diff = Math.floor((Date.now() - gameStartTime) / 1000);
    if (diff < 0) return; // Evitar negativos si el reloj local está desajustado

    const h = Math.floor(diff / 3600);
    const m = Math.floor((diff % 3600) / 60);
    const s = diff % 60;
    
    const txt = (h > 0 ? h + ':' : '') + 
                (m < 10 ? '0' : '') + m + ':' + 
                (s < 10 ? '0' : '') + s;
    el.textContent = txt;
}