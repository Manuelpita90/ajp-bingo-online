// 1. Conexión con el servidor
if (typeof io === 'undefined') {
    alert("Error crítico: La librería Socket.IO no está cargada. Asegúrate de incluir <script src='/socket.io/socket.io.js'></script> en tu HTML antes de cargar este script.");
    throw new Error("Socket.IO no definido");
}
const socket = io();

// Identificar este cliente como administrador en el servidor
socket.on('connect', () => {
    socket.emit('admin-join');
    console.log('Admin conectado y registrado como admin en el servidor.');
});

let bolasExtraidas = [];
const totalBolas = 75;
let juegoPausado = false;
let isAnimating = false;
let cachedPlayerCount = 0;
let cachedCardCount = 0;
let viewingPlayersList = false;

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
            </div>
            <div id="connection-status" style="color:var(--success)">● ONLINE</div>
        `;
        // Insertar antes del tablero
        if (board) adminContainer.insertBefore(statusBar, board);
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
            const sec = document.getElementById('requests-section');
            if (sec) sec.style.display = sec.style.display === 'none' ? 'block' : 'none';
        };
        targetContainer.appendChild(btn);
    }

    // --- SECCIÓN DE SOLICITUDES PENDIENTES (OCULTA) ---
    if (!document.getElementById('requests-section')) {
        const section = document.createElement('div');
        section.id = 'requests-section';
        section.className = 'winners-section'; // Reutilizamos estilo
        section.style.marginTop = '10px';
        section.style.borderLeft = '3px solid var(--gold-solid)';
        section.style.display = 'none';
        section.innerHTML = `
            <div class="winners-title">
                <span>📩 Lista de Solicitudes</span>
            </div>
            <div id="requests-list" class="winners-list" style="max-height: 200px;">
                <div id="empty-requests-msg" style="color:var(--text-muted); font-style:italic; font-size:0.9rem; text-align:center; padding:10px;">No hay solicitudes pendientes.</div>
            </div>
        `;
        targetContainer.appendChild(section);
    }

    // INYECTAR SECCIÓN DE GANADORES (Si no existe)
    if (!document.getElementById('winners-section')) {
        const section = document.createElement('div');
        section.id = 'winners-section';
        section.className = 'winners-section';
        section.style.marginTop = '0'; // Resetear margen porque el contenedor ya tiene gap
        section.innerHTML = `
            <div class="winners-title">
                <span>🏆 Historial de Ganadores</span>
                <span id="winners-count" style="background:var(--gold-solid); color:#000; padding:2px 8px; border-radius:10px; font-size:0.8em">0</span>
            </div>
            <div id="winners-list" class="winners-list">
                <div id="empty-winners-msg" style="color:var(--text-muted); font-style:italic; font-size:0.9rem; text-align:center; padding:10px;">Aún no hay ganadores...</div>
            </div>
        `;
        targetContainer.appendChild(section);
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

    // INYECTAR BOTÓN HISTORIAL PARTIDAS
    if (!document.getElementById('btn-history')) {
        const btn = document.createElement('button');
        btn.id = 'btn-history';
        btn.className = 'btn-outline';
        btn.textContent = '📜 HISTORIAL DE PARTIDAS';
        btn.onclick = window.verHistorialPartidas;
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
}

// 3. Función Principal: Extraer y Anunciar Bola
function extraerBola() {
    if (isAnimating) return;

    if (juegoPausado) {
        if (confirm("⛔ El juego está PAUSADO tras un Bingo válido.\n¿Ya has verificado el cartón y deseas continuar?")) {
            juegoPausado = false;
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
}

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
    }
});

// RECIBIR HISTORIAL PERSISTENTE
socket.on('historial-ganadores', (lista) => {
    const list = document.getElementById('winners-list');
    if (list) list.innerHTML = '';
    
    if (!lista || lista.length === 0) {
        if (list) list.innerHTML = '<div id="empty-winners-msg" style="color:var(--text-muted); font-style:italic; font-size:0.9rem; text-align:center; padding:10px;">Aún no hay ganadores...</div>';
        const count = document.getElementById('winners-count');
        if (count) count.textContent = '0';
        return;
    }

    // Insertar en orden inverso (del más viejo al más nuevo) porque agregarGanador hace prepend
    for (let i = lista.length - 1; i >= 0; i--) {
        agregarGanador(lista[i]);
    }
});

// 5. Reiniciar el Juego
function reiniciarJuego() {
    if (confirm("¿Deseas resetear el tablero para todos los jugadores?")) {
        socket.emit('reiniciar-juego');
    }
}

socket.on('limpiar-tablero', () => {
    bolasExtraidas = [];
    initTablero();
    document.getElementById('display-ball').textContent = "--";
    
    document.getElementById('ball-text').textContent = "¡Mucha suerte a todos!";
    
    // Limpiar lista de ganadores
    const list = document.getElementById('winners-list');
    const count = document.getElementById('winners-count');
    if (list) list.innerHTML = '<div id="empty-winners-msg" style="color:var(--text-muted); font-style:italic; font-size:0.9rem; text-align:center; padding:10px;">Aún no hay ganadores...</div>';
    if (count) count.textContent = '0';
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
    
    // Reproducir sonido (usando los archivos que ya tienes en public/sounds)
    //TODO: Usar objetos de audio pre-cargados para mejor rendimiento
    const audioWin = new Audio('sounds/win.mp3');
    const audioFail =  new Audio('sounds/fail.mp3');

    const audio = isValid ? audioWin : audioFail;
    if(audio) audio.play().catch(e => console.warn("Audio bloqueado:", e));

    // Botón de pausa solo si es válido
    let botonPausa = '';
    if (isValid) {
        botonPausa = `<button onclick="event.stopPropagation(); window.pausarJuego();" style="margin-top:8px; padding:6px; width:100%; background:var(--dark-bg); color:var(--danger); border:1px solid var(--danger); border-radius:6px; font-weight:bold; cursor:pointer;">🛑 PAUSAR JUEGO</button>`;
    }

    notif.innerHTML = `
        <div class="notif-header" style="color: ${colorTitle}">
            <span>${icon} ${title}</span>
            <span style="font-size: 0.7em; opacity: 0.7">ID: ${data.id.substr(0,4)} | 🎫 ${data.cartonId}</span>
        </div>
        <div class="notif-body">
            <div style="margin-bottom:4px;"><strong>Motivo:</strong> ${data.reason || 'Línea correcta'}</div>
            <div><strong>Números:</strong> ${data.numeros.join(', ')}</div>
            ${botonPausa}
        </div>
    `;

    // Cerrar al hacer click
    notif.onclick = () => {
        notif.style.opacity = '0';
        setTimeout(() => notif.remove(), 300);
    };

    // Auto cerrar en 8 segundos
    setTimeout(() => {
        if (document.body.contains(notif)) notif.click();
    }, 8000);

    container.appendChild(notif);
}

// Función global para pausar desde la notificación
window.pausarJuego = function() {
    juegoPausado = true;
    alert("🛑 JUEGO PAUSADO\nNo podrás extraer más bolas hasta que confirmes la reanudación al intentar sacar la siguiente.");
};

// 7. Función para agregar ganador al historial
function agregarGanador(data) {
    const list = document.getElementById('winners-list');
    const count = document.getElementById('winners-count');
    const emptyMsg = document.getElementById('empty-winners-msg');
    
    if (!list) return;
    if (emptyMsg) emptyMsg.remove();

    const item = document.createElement('div');
    item.className = 'winner-item';
    
    // Usar timestamp del servidor si existe, o el actual
    const now = data.timestamp ? new Date(data.timestamp) : new Date();
    const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    item.innerHTML = `
        <div class="winner-info">
            <div style="font-weight:bold; color:var(--text-main)">
                JUGADOR ID: ${data.id.substr(0,4)} 
                <span style="color:var(--gold-solid); font-size:0.9em; margin-left:5px;">(🎫 ${data.cartonId})</span>
            </div>
            <div style="font-size:0.85em; opacity:0.8">${data.reason || 'Bingo Válido'}</div>
        </div>
        <div class="winner-time">${time}</div>
    `;

    list.insertBefore(item, list.firstChild);
    
    if (count) count.textContent = list.children.length;
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
    viewingPlayersList = false;
    document.getElementById('admin-modal').style.display = 'none';
};

// 11. Ver Historial de Partidas
window.verHistorialPartidas = function() {
    socket.emit('admin-solicitar-historial-partidas');
};

socket.on('admin-historial-partidas', (history) => {
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
    const audio = new Audio('sounds/request.mp3'); 
    audio.play().catch(e=>{});

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

window.onload = initTablero;