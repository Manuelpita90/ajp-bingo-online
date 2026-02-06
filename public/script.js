if (typeof io === 'undefined') {
    alert("Error crítico: La librería Socket.IO no está cargada. Asegúrate de incluir <script src='/socket.io/socket.io.js'></script> en tu HTML antes de cargar este script.");
    throw new Error("Socket.IO no definido");
}

// Detectar si estamos en GitHub Pages para conectar al servidor de Render
const isGitHubPages = window.location.hostname.includes('github.io');

// FIX: Evitar que el script del jugador se ejecute en el panel de admin (evita jugador fantasma)
if (window.location.pathname.includes('admin')) {
    throw new Error("Script de jugador detenido en panel admin para evitar duplicidad de conexión.");
}

const socket = io(isGitHubPages ? 'https://ajp-bingo-online.onrender.com' : undefined);

let historialBolas = [];
let juegoIniciado = false;
let numerosCantados = new Set(); // Registro de bolas válidas para marcar
let estadoSincronizado = false;
let esperandoSolicitud = false;
let currentPattern = 'linea'; // Patrón actual
let cartonesSeleccionadosTemp = new Set(); // Para el modal de selección
let cartonesConBingoEnviado = new Set(); // Evitar spam de botón Bingo

// 1. CARGA INICIAL: Revisa si hay una partida en curso en el navegador
function cargarJuego() {
    // Intentar cargar array de cartones
    let cartones = [];
    try {
        cartones = JSON.parse(localStorage.getItem('bingo-ajp-cartones'));
    } catch (e) {
        console.error("Datos locales corruptos, reiniciando cartones.", e);
        localStorage.removeItem('bingo-ajp-cartones');
    }

    // Migración: Si existe el formato antiguo (un solo cartón), convertirlo
    if (!cartones && localStorage.getItem('bingo-ajp-carton')) {
        const oldData = JSON.parse(localStorage.getItem('bingo-ajp-carton'));
        const oldId = localStorage.getItem('bingo-ajp-carton-id') || generarIdAleatorio();
        cartones = [{ id: oldId, data: oldData }];
        localStorage.setItem('bingo-ajp-cartones', JSON.stringify(cartones));
    }

    if (!cartones || cartones.length === 0) {
        // NUEVO: Recuperar estado de selección pendiente (Persistencia)
        const pendingSelection = localStorage.getItem('bingo-pending-selection');
        if (pendingSelection) {
            mostrarModalSeleccionCartones(parseInt(pendingSelection));
            initChat();
            return;
        }

        // MODIFICADO: Verificar estado del juego antes de mostrar solicitud
        if (estadoSincronizado) {
            if (juegoIniciado) {
                mostrarModalSalaEspera();
            } else {
                mostrarModalSolicitud();
            }
        } else {
            esperandoSolicitud = true;
        }
    } else {
        // Registrar IDs en el servidor y renderizar
        cartones.forEach(c => registrarIdEnServidor(c));
        renderizarCartones();
    }
    initChat();
}

function generarIdAleatorio() {
    // Uso de crypto.randomUUID si está disponible para evitar colisiones
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return '#' + crypto.randomUUID().split('-')[0].toUpperCase();
    }
    // Fallback mejorado
    return '#' + Math.floor(100000 + Math.random() * 900000);
}

function generarIdUnico() {
    return '#' + Math.floor(10000 + Math.random() * 90000);
}

function registrarIdEnServidor(cartonObj) {
    const id = cartonObj.id || cartonObj; // Soporte para string o objeto
    const data = cartonObj.data || null;
    const matrix = data ? convertirA_Matriz(data) : null;

    socket.emit('registrar-id', { id, matrix }, (response) => {
        if (!response) {
            console.error("El servidor no respondió a la solicitud de registro.");
            return;
        }

        if (response && response.accepted) {
            console.log(`ID ${id} registrado correctamente.`);
        } else {
            console.warn(`ID ${id} ocupado.`);

            // MANEJO DE SALA DE ESPERA
            if (response && response.reason === 'GAME_IN_PROGRESS') {
                mostrarModalSalaEspera();
                return;
            }

            // MANEJO DE ERROR DE INTEGRIDAD (ANTI-CHEAT)
            if (response && response.reason === 'INVALID_MATRIX_INTEGRITY') {
                mostrarModal("⛔ ERROR DE INTEGRIDAD", "Se ha detectado una modificación no autorizada en tu cartón. Por seguridad, este cartón será eliminado.", "error");
                // Eliminar cartón corrupto del storage
                let cartones = [];
                try {
                    cartones = JSON.parse(localStorage.getItem('bingo-ajp-cartones')) || [];
                } catch(e) {
                    cartones = [];
                }
                const nuevosCartones = cartones.filter(c => c.id !== id);
                localStorage.setItem('bingo-ajp-cartones', JSON.stringify(nuevosCartones));
                setTimeout(() => location.reload(), 3000);
                return;
            }

            // MANEJO DE LÍMITE DE CARTONES (Servidor)
            if (response && response.reason === 'MAX_CARDS_REACHED') {
                mostrarModal("⛔ LÍMITE EXCEDIDO", "El servidor ha bloqueado este cartón porque ya tienes el máximo de 4 activos.", "error");
                // Eliminar cartón excedente del storage local
                let cartones = [];
                try {
                    cartones = JSON.parse(localStorage.getItem('bingo-ajp-cartones')) || [];
                } catch(e) { cartones = []; }

                const nuevosCartones = cartones.filter(c => c.id !== id);
                localStorage.setItem('bingo-ajp-cartones', JSON.stringify(nuevosCartones));
                renderizarCartones();
                return;
            }

            // MEJORA: Si el servidor rechaza el ID al cargar (ej. colisión o sesión fantasma),
            // intentamos regenerarlo para que el usuario no juegue con un cartón inválido.
            if (confirm(`El ID ${id} ya está en uso o hubo un error de sincronización. ¿Generar nuevo ID para este cartón?`)) {
                let cartones = [];
                try {
                    cartones = JSON.parse(localStorage.getItem('bingo-ajp-cartones')) || [];
                } catch(e) { cartones = []; }
                const index = cartones.findIndex(c => c.id === id);
                if (index !== -1) {
                    cartones[index].id = generarIdAleatorio();
                    localStorage.setItem('bingo-ajp-cartones', JSON.stringify(cartones));
                    registrarIdEnServidor(cartones[index]); // Reintentar
                    renderizarCartones(); // Actualizar UI
                }
            }
        }
    });
}

function agregarNuevoCarton(render = true, callback = null) {
    let cartones = [];
    try {
        cartones = JSON.parse(localStorage.getItem('bingo-ajp-cartones')) || [];
    } catch (e) { cartones = []; }

    if (juegoIniciado) {
        mostrarModal("⛔ ACCIÓN DENEGADA", "No puedes agregar cartones con la partida iniciada.", 'error');
        if (callback) callback();
        return;
    }

    if (cartones.length >= 4) {
        mostrarModal("LÍMITE ALCANZADO", "Solo puedes jugar con un máximo de 4 cartones.", "warning");
        if (callback) callback();
        return;
    }

    const nuevoId = generarIdAleatorio();
    const nuevoData = generarNuevoSetDeNumeros(); // Nota: Esto es para cartones aleatorios (legacy/admin)
    const matrix = convertirA_Matriz(nuevoData);

    // Validar ID con servidor antes de guardar
    socket.emit('registrar-id', { id: nuevoId, matrix: matrix }, (response) => {
        if (response && response.accepted) {

            // CRÍTICO: Re-leer localStorage aquí para evitar condiciones de carrera
            let cartonesActuales = [];
            try {
                cartonesActuales = JSON.parse(localStorage.getItem('bingo-ajp-cartones')) || [];
            } catch(e) { cartonesActuales = []; }

            cartonesActuales.push({ id: nuevoId, data: nuevoData });
            localStorage.setItem('bingo-ajp-cartones', JSON.stringify(cartonesActuales));

            if (render) {
                renderizarCartones();
                reproducirSonido('audio-ball'); // Sonido de confirmación
            }

            if (callback) callback();
        } else {
            agregarNuevoCarton(render, callback); // Reintentar con otro ID
        }
    });
}

function cambiarCartonIndividual(id) {
    if (juegoIniciado) {
        mostrarModal("⛔ ACCIÓN DENEGADA", "El juego ya ha comenzado, no puedes cambiar el cartón.", 'error');
        return;
    }
    mostrarModalCambioCarton(id);
}

// --- GENERACIÓN DETERMINISTA (Cartones Fijos 1-100) ---
// Algoritmo PRNG simple (Mulberry32) para generar siempre los mismos números dado un ID (semilla)
function mulberry32(a) {
    return function () {
        var t = a += 0x6D2B79F5;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    }
}

function generarCartonFijo(idCarton) {
    // Usamos el ID del cartón como semilla.
    // MEJORA: Usar hash para soportar IDs alfanuméricos (UUID) y evitar colisiones
    let hash = 5381;
    const str = String(idCarton);
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash) + str.charCodeAt(i); /* hash * 33 + c */
    }
    const seed = Math.abs(hash);
    const rng = mulberry32(seed);

    // Función auxiliar que usa nuestro RNG determinista en lugar de Math.random
    const obtenerColumnaFija = (min, max) => {
        let col = [];
        while (col.length < 5) {
            // Generar número entre min y max usando rng()
            let n = Math.floor(rng() * (max - min + 1)) + min;
            if (!col.includes(n)) col.push(n);
        }
        return col.sort((a, b) => a - b);
    };

    return {
        B: obtenerColumnaFija(1, 15),
        I: obtenerColumnaFija(16, 30),
        N: obtenerColumnaFija(31, 45),
        G: obtenerColumnaFija(46, 60),
        O: obtenerColumnaFija(61, 75)
    };
}

// 2. Lógica para generar los números del cartón
function generarNuevoSetDeNumeros() {
    return {
        B: obtenerNumerosColumna(1, 15),
        I: obtenerNumerosColumna(16, 30),
        N: obtenerNumerosColumna(31, 45),
        G: obtenerNumerosColumna(46, 60),
        O: obtenerNumerosColumna(61, 75)
    };
}

function obtenerNumerosColumna(min, max) {
    let col = [];
    while (col.length < 5) {
        let n = Math.floor(Math.random() * (max - min + 1)) + min;
        if (!col.includes(n)) col.push(n);
    }
    return col.sort((a, b) => a - b);
}

// 3. Renderizar TODOS los cartones
function renderizarCartones() {
    let cartones = [];
    try {
        cartones = JSON.parse(localStorage.getItem('bingo-ajp-cartones')) || [];
    } catch(e) { cartones = []; }

    const contenedorPrincipal = document.getElementById('cards-container');
    contenedorPrincipal.innerHTML = '';

    cartones.forEach((cartonObj, index) => {
        const wrapper = document.createElement('div');
        wrapper.className = 'single-card-wrapper';
        wrapper.id = `card-wrapper-${cartonObj.id.replace('#', '')}`;

        const headerRow = document.createElement('div');
        headerRow.className = 'card-header-row';

        const label = document.createElement('div');
        label.className = 'card-id-label';
        label.textContent = `CARTÓN ${cartonObj.id}`;

        // Contenedor de controles (Bingo + Eliminar)
        const controls = document.createElement('div');
        controls.style.display = 'flex';
        controls.style.alignItems = 'center';

        const btnMini = document.createElement('button');
        btnMini.className = 'btn-mini-bingo';
        btnMini.id = `btn-bingo-${cartonObj.id.replace('#', '')}`;
        btnMini.textContent = '¡BINGO!';
        btnMini.onclick = () => reclamarBingoIndividual(cartonObj);

        const btnChange = document.createElement('button');
        btnChange.className = 'btn-change-card';
        btnChange.innerHTML = '↻';
        btnChange.title = "Cambiar números de este cartón";
        btnChange.onclick = () => cambiarCartonIndividual(cartonObj.id);

        controls.appendChild(btnMini);
        controls.appendChild(btnChange);

        headerRow.appendChild(label);
        headerRow.appendChild(controls);
        wrapper.appendChild(headerRow);

        const grid = document.createElement('div');
        grid.className = 'bingo-grid';
        grid.innerHTML = '<div class="header">B</div><div class="header">I</div><div class="header">N</div><div class="header">G</div><div class="header">O</div>';

        dibujarCeldas(grid, cartonObj.data);
        wrapper.appendChild(grid);

        const counter = document.createElement('div');
        counter.className = 'missing-counter';
        counter.id = `counter-${cartonObj.id.replace('#', '')}`;
        counter.textContent = 'Calculando...';
        wrapper.appendChild(counter);

        contenedorPrincipal.appendChild(wrapper);
    });

    // Verificar estado inicial por si ya hay líneas avanzadas al recargar
    verificarEstadoBotonesBingo();
}

function dibujarCeldas(contenedor, columnas) {
    for (let f = 0; f < 5; f++) {
        ['B', 'I', 'N', 'G', 'O'].forEach(letra => {
            const num = columnas[letra][f];
            const celda = document.createElement('div');
            celda.classList.add('cell');

            if (letra === 'N' && f === 2) {
                celda.classList.add('free', 'marked');

                const img = document.createElement('img');
                img.src = './icons/ajp.png';
                img.className = 'free-img';
                celda.appendChild(img);
            } else {
                celda.textContent = num;

                // RECUPERAR ESTADO: ¿Estaba marcado antes de refrescar?
                if (localStorage.getItem(`marcado-${num}`)) {
                    celda.classList.add('marked');
                }

                // RECUPERAR ESTADO: ¿Ha salido la bola? (Resaltar borde)
                if (numerosCantados.has(num)) {
                    celda.classList.add('called-highlight');
                }

                celda.onclick = () => {
                    // VALIDACIÓN: Si intenta marcar y el número NO ha salido -> Bloquear
                    if (!celda.classList.contains('marked') && !numerosCantados.has(num)) {
                        celda.classList.add('error-shake'); // Feedback visual
                        setTimeout(() => celda.classList.remove('error-shake'), 500);
                        // Opcional: reproducirSonido('audio-fail');
                        return;
                    }

                    celda.classList.toggle('marked');
                    // Guardar estado de la marca
                    const isMarked = celda.classList.contains('marked');
                    if (celda.classList.contains('marked')) {
                        localStorage.setItem(`marcado-${num}`, 'true');
                    } else {
                        localStorage.removeItem(`marcado-${num}`);
                    }
                    // Sincronizar visualmente con otros cartones que tengan el mismo número
                    document.querySelectorAll('.cell').forEach(c => {
                        if (c.textContent === String(num)) isMarked ? c.classList.add('marked') : c.classList.remove('marked');
                    });

                    // Verificar si algún cartón está a punto de Bingo
                    verificarEstadoBotonesBingo();
                };
            }
            contenedor.appendChild(celda);
        });
    }
}

// 4. Gestión del Historial de Bolas (Horizontal)
function actualizarUltimasBolas(nuevoNumero) {
    // Evitar duplicados en el historial visual
    if (historialBolas[0] === nuevoNumero) return;

    historialBolas.unshift(nuevoNumero);
    if (historialBolas.length > 5) historialBolas.pop();

    const contenedorBolas = document.getElementById('last-calls');
    contenedorBolas.innerHTML = '';

    historialBolas.forEach((num, index) => {
        const bolaDiv = document.createElement('div');
        bolaDiv.classList.add('ball-placeholder');
        if (index === 0) bolaDiv.classList.add('active-ball');

        // Calcular letra correspondiente
        let letra = "";
        if (num <= 15) letra = "B";
        else if (num <= 30) letra = "I";
        else if (num <= 45) letra = "N";
        else if (num <= 60) letra = "G";
        else letra = "O";

        bolaDiv.style.flexDirection = 'column';
        bolaDiv.innerHTML = `<span style="font-size:0.6em; line-height:1; opacity:0.9">${letra}</span><span style="line-height:1">${num}</span>`;
        contenedorBolas.appendChild(bolaDiv);
    });
}

// --- ESCUCHA DE EVENTOS DEL SERVIDOR ---

socket.on('connect', () => {
    // Ocultar mensaje de desconexión si existe al reconectar
    const disconnectModal = document.getElementById('disconnect-modal');
    if (disconnectModal) disconnectModal.style.display = 'none';

    // Re-registrar cartones al conectar o reconectar (ej. reinicio de servidor)
    let cartones = [];
    try {
        cartones = JSON.parse(localStorage.getItem('bingo-ajp-cartones'));
    } catch(e) { cartones = []; }

    if (cartones && cartones.length > 0) {
        cartones.forEach(c => registrarIdEnServidor(c)); // CORRECCIÓN: Enviar objeto completo (con matriz) para validar reconexión
    }

    // Registrar nombre si existe (para que el admin lo vea en la lista)
    const nombre = localStorage.getItem('player-name');
    if (nombre) socket.emit('registrar-nombre', nombre);
});

socket.on('disconnect', () => {
    mostrarMensajeDesconexion();
});

socket.on('anuncio-bola', (numero) => {
    numerosCantados.add(numero); // Registrar bola como válida
    reproducirSonido('audio-ball');
    cantarBola(numero); // Cantar letra y número en voz alta
    juegoIniciado = true;

    // Ocultar botón de añadir cartón si existe
    const btnAdd = document.querySelector('.add-card-btn');
    if (btnAdd) btnAdd.style.display = 'none';

    // Ocultar mensaje de espera y mostrar bolas
    document.getElementById('waiting-message').style.display = 'none';
    document.getElementById('last-calls').style.display = 'flex';

    actualizarUltimasBolas(numero);

    // Actualizar contador en sala de espera si está visible
    const waitingCounter = document.getElementById('waiting-ball-count');
    if (waitingCounter) {
        waitingCounter.textContent = numerosCantados.size;
        waitingCounter.style.transition = "transform 0.2s";
        waitingCounter.style.transform = "scale(1.3)";
        setTimeout(() => waitingCounter.style.transform = "scale(1)", 200);
    }

    // Resaltar en el cartón si el número coincide con la bola cantada
    const celdas = document.querySelectorAll('.cell');
    celdas.forEach(celda => {
        if (parseInt(celda.textContent) === numero) {
            celda.classList.add('called-highlight');
        }
    });
});

socket.on('historial', (bolas) => {
    numerosCantados = new Set(bolas); // Sincronizar lista completa al conectar
    // Verificar si el juego ya empezó para ocultar/mostrar el botón de cambio
    juegoIniciado = bolas.length > 0;
    estadoSincronizado = true;

    // Si había una solicitud pendiente de mostrar (usuario nuevo entrando)
    if (esperandoSolicitud) {
        esperandoSolicitud = false;
        if (juegoIniciado) {
            mostrarModalSalaEspera();
        } else {
            mostrarModalSolicitud();
        }
    }

    // Controlar visibilidad del mensaje de espera
    const msg = document.getElementById('waiting-message');
    const row = document.getElementById('last-calls');
    if (!juegoIniciado) {
        msg.style.display = 'block';
        row.style.display = 'none';
    } else {
        msg.style.display = 'none';
        row.style.display = 'flex';
    }

    // Al conectar/refrescar, cargar las últimas 5 bolas emitidas
    if (bolas.length > 0) {
        const ultimas = [...bolas].reverse().slice(0, 5);
        historialBolas = []; // Limpiar para reconstruir
        ultimas.forEach(b => actualizarUltimasBolas(b));
    }

    // Actualizar visualmente los cartones (por si es un refresh de página)
    const celdas = document.querySelectorAll('.cell');
    celdas.forEach(celda => {
        const val = parseInt(celda.textContent);
        if (numerosCantados.has(val)) {
            celda.classList.add('called-highlight');
        }
    });
});

socket.on('limpiar-tablero', (newGameId) => {
    // Guardar nombre para no obligar a escribirlo de nuevo
    const savedName = localStorage.getItem('player-name');
    const pwaDismissed = localStorage.getItem('pwa-banner-dismissed'); // Preservar estado PWA

    // Cuando el admin reinicia, borramos todo rastro del juego anterior
    localStorage.clear();
    if (savedName) localStorage.setItem('player-name', savedName);
    if (pwaDismissed) localStorage.setItem('pwa-banner-dismissed', pwaDismissed);
    if (newGameId) localStorage.setItem('bingo-game-id', newGameId);

    cerrarModal(true); // Forzar cierre de cualquier modal bloqueante (Sala de Espera) al reiniciar
    // Reiniciar estado local
    historialBolas = [];
    juegoIniciado = false;
    numerosCantados.clear(); // Limpiar validación
    cartonesConBingoEnviado.clear(); // Limpiar bloqueos de envío

    // Resetear UI
    document.getElementById('waiting-message').style.display = 'block';
    document.getElementById('last-calls').style.display = 'none';
    document.getElementById('last-calls').innerHTML = `
        <div class="ball-placeholder">--</div>
        <div class="ball-placeholder">--</div>
        <div class="ball-placeholder">--</div>
        <div class="ball-placeholder">--</div>
        <div class="ball-placeholder">--</div>
    `;

    // Generar nuevo cartón
    cargarJuego();
});

socket.on('sync-game-id', (serverGameId) => {
    const localGameId = localStorage.getItem('bingo-game-id');

    // Si hay un ID local y es distinto al del servidor -> Reinicio ocurrido mientras estaba desconectado
    if (localGameId && localGameId !== serverGameId) {
        console.log("Sincronización: Partida nueva detectada. Limpiando...");
        const savedName = localStorage.getItem('player-name');
        const pwaDismissed = localStorage.getItem('pwa-banner-dismissed');
        localStorage.clear();
        if (savedName) localStorage.setItem('player-name', savedName);
        if (pwaDismissed) localStorage.setItem('pwa-banner-dismissed', pwaDismissed);
        localStorage.setItem('bingo-game-id', serverGameId);
        window.location.reload(); // Recargar para asegurar estado limpio y mostrar solicitud
    } else if (!localGameId) {
        localStorage.setItem('bingo-game-id', serverGameId);
    }
});

socket.on('sync-patron', (patron) => {
    currentPattern = patron;
    actualizarIndicadorPatron(patron);
    verificarEstadoBotonesBingo(); // Re-verificar con nueva regla
});

socket.on('cambio-patron', (patron) => {
    currentPattern = patron;
    actualizarIndicadorPatron(patron);
    reproducirSonido('audio-ball');

    let nombrePatron = "1 Línea";
    if (patron === 'full') nombrePatron = "Cartón Lleno";
    else if (patron === 'diagonal') nombrePatron = "Diagonal";
    else if (patron === 'corners') nombrePatron = "4 Esquinas";
    else if (patron === 'letterX') nombrePatron = "Letra X";
    else if (patron === 'cross') nombrePatron = "Cruz (+)";

    mostrarModal("🎯 NUEVA REGLA", `El administrador ha cambiado la forma de ganar a: ${nombrePatron}`, "info");

    // Actualizar UI de botones
    verificarEstadoBotonesBingo();
});

socket.on('mensaje-global', (mensaje) => {
    console.log("Mensaje del admin recibido:", mensaje);
    reproducirSonido('audio-ball'); // Usamos sonido para llamar la atención
    mostrarModal("📢 MENSAJE DEL ADMIN", mensaje, 'info');
});

socket.on('mensaje-privado', (data) => {
    console.log("Mensaje privado recibido:", data);
    reproducirSonido('audio-ball');
    mostrarModal("💬 MENSAJE PRIVADO", data.mensaje, 'info');
});

// RESPUESTAS DE VALIDACIÓN DE BINGO
socket.on('bingo-validado', (data) => {
    reproducirSonido('audio-win');
    lanzarConfeti();
    mostrarModal("🎉 ¡BINGO VÁLIDO!", data.message, 'success');

    // Actualizar visualmente el botón a estado de victoria
    if (data.cartonId) {
        const btn = document.getElementById(`btn-bingo-${data.cartonId.replace('#', '')}`);
        if (btn) {
            btn.textContent = '🏆';
            btn.classList.add('bingo-ready');
        }
    }
});

socket.on('bingo-rechazado', (data) => {
    reproducirSonido('audio-fail');
    mostrarModal("❌ BINGO RECHAZADO", data.message, 'error');

    // Desbloquear el botón para permitir reintentar
    if (data.cartonId) {
        cartonesConBingoEnviado.delete(data.cartonId);
        const btn = document.getElementById(`btn-bingo-${data.cartonId.replace('#', '')}`);
        if (btn) {
            btn.disabled = false;
            btn.textContent = '¡BINGO!';
            btn.style.opacity = '1';
            btn.style.cursor = 'pointer';
        }
    }
});

// NUEVO: Mostrar anuncio global de ganador
socket.on('anuncio-ganador', (data) => {
    reproducirSonido('audio-win');
    lanzarConfeti();

    // Anunciar ganador con voz
    if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel(); // Detener bola anterior si estaba hablando

        let texto = `¡Bingo! El jugador ${data.nombre} ha ganado.`;
        if (socket.id && data.id === socket.id) {
            texto = "¡Felicidades! ¡Has ganado el Bingo!";
        }

        const utterance = new SpeechSynthesisUtterance(texto);
        utterance.lang = 'es-ES';
        window.speechSynthesis.speak(utterance);
    }

    // MODIFICADO: Mostrar modal bloqueante SIN botón de cerrar
    const modal = document.getElementById('custom-modal');
    const content = modal.querySelector('.modal-content');

    // Guardar contenido original para restaurarlo cuando se reinicie la partida
    if (!window.originalModalContent) window.originalModalContent = content.innerHTML;

    modal.dataset.blocking = 'true'; // Bloquear cierre manual

    content.innerHTML = `
        <div style="font-size:5rem; margin-bottom:15px; animation: bounceIn 1s;">🏆</div>
        <h2 style="color:var(--success); margin-bottom:15px; text-transform:uppercase;">¡Tenemos Ganador!</h2>
        <p style="color:white; margin-bottom:10px; font-size:1.2em;">
            El jugador <strong style="color:var(--gold-solid); font-size:1.3em;">${data.nombre}</strong>
        </p>
        <p style="color:white; margin-bottom:20px;">
            Ha cantado BINGO con el cartón <strong style="color:var(--gold-solid);">${data.cartonId}</strong>
        </p>
        <div style="margin-top:20px; padding:15px; background:rgba(0,0,0,0.3); border-radius:12px; border:1px solid rgba(255,255,255,0.1);">
            <p style="color:var(--text-muted); font-size:0.9em; margin:0;">
                ⏳ Esperando a que el administrador reinicie la partida...
            </p>
        </div>
    `;

    modal.style.display = 'flex';
});

// Función para cantar Bingo de un cartón específico
function reclamarBingoIndividual(cartonObj) {
    // VALIDACIÓN: Si ya se envió este cartón, no hacer nada
    if (cartonesConBingoEnviado.has(cartonObj.id)) {
        mostrarModal("⏳ YA ENVIADO", `El cartón ${cartonObj.id} ya está en proceso de validación.`, 'warning');
        return;
    }

    const todosMarcados = [];
    Object.keys(localStorage).forEach(key => {
        if (key.startsWith('marcado-')) todosMarcados.push(key.replace('marcado-', ''));
    });
    const marcadosSet = new Set(todosMarcados);

    // Validación local del patrón antes de enviar
    const matrix = convertirA_Matriz(cartonObj.data);
    let aciertos = 0;
    let totalNecesario = 5;

    const contarAciertos = (coords) => {
        let count = 0;
        coords.forEach(([r, c]) => {
            const val = matrix[r][c];
            if (val === 'FREE' || marcadosSet.has(String(val))) count++;
        });
        return count;
    };

    if (currentPattern === 'full') {
        totalNecesario = 25;
        const todas = [];
        for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) todas.push([r, c]);
        aciertos = contarAciertos(todas);
    } else if (currentPattern === 'corners') {
        totalNecesario = 4;
        aciertos = contarAciertos([[0, 0], [0, 4], [4, 0], [4, 4]]);
    } else if (currentPattern === 'letterX') {
        totalNecesario = 9;
        const coords = [];
        for (let i = 0; i < 5; i++) coords.push([i, i]);
        for (let i = 0; i < 5; i++) if (i !== 2) coords.push([i, 4 - i]);
        aciertos = contarAciertos(coords);
    } else if (currentPattern === 'cross') {
        totalNecesario = 9;
        const coords = [];
        for (let i = 0; i < 5; i++) coords.push([2, i]);
        for (let i = 0; i < 5; i++) if (i !== 2) coords.push([i, 2]);
        aciertos = contarAciertos(coords);
    } else if (currentPattern === 'diagonal') {
        totalNecesario = 5;
        let maxDiag = 0;
        maxDiag = Math.max(maxDiag, contarAciertos([[0, 0], [1, 1], [2, 2], [3, 3], [4, 4]]));
        maxDiag = Math.max(maxDiag, contarAciertos([[0, 4], [1, 3], [2, 2], [3, 1], [4, 0]]));
        aciertos = maxDiag;
    } else {
        // LINEA
        totalNecesario = 5;
        let maxLinea = 0;
        for (let i = 0; i < 5; i++) {
            maxLinea = Math.max(maxLinea, contarAciertos([[i, 0], [i, 1], [i, 2], [i, 3], [i, 4]]));
            maxLinea = Math.max(maxLinea, contarAciertos([[0, i], [1, i], [2, i], [3, i], [4, i]]));
        }
        maxLinea = Math.max(maxLinea, contarAciertos([[0, 0], [1, 1], [2, 2], [3, 3], [4, 4]]));
        maxLinea = Math.max(maxLinea, contarAciertos([[0, 4], [1, 3], [2, 2], [3, 1], [4, 0]]));
        aciertos = maxLinea;
    }

    if (aciertos < totalNecesario) {
        mostrarModal("❌ NO TIENES BINGO", "Aún te faltan números para completar el patrón.", 'error');
        reproducirSonido('audio-fail');
        return;
    }

    // BLOQUEO: Marcar como enviado y deshabilitar botón visualmente
    cartonesConBingoEnviado.add(cartonObj.id);
    const btnId = `btn-bingo-${cartonObj.id.replace('#', '')}`;
    const btn = document.getElementById(btnId);
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<div class="spinner-loader"></div>';
        btn.style.opacity = '1';
        btn.style.cursor = 'wait';
    }

    const cartonMatrix = convertirA_Matriz(cartonObj.data);
    socket.emit('reclamar-bingo', {
        numeros: todosMarcados,
        carton: cartonMatrix,
        cartonId: cartonObj.id
    });
    mostrarModal("⏳ ENVIADO", `Tu cartón ${cartonObj.id} ha sido enviado al administrador para validación.`, 'info');
}

function convertirA_Matriz(columnas) {
    const matrix = [];
    const cols = ['B', 'I', 'N', 'G', 'O'];
    for (let r = 0; r < 5; r++) {
        const row = [];
        for (let c = 0; c < 5; c++) {
            if (r === 2 && c === 2) row.push('FREE');
            else row.push(columnas[cols[c]][r]);
        }
        matrix.push(row);
    }
    return matrix;
}

// Función para actualizar el indicador visual del modo de juego
function actualizarIndicadorPatron(patron) {
    let nombrePatron = "1 Línea";
    if (patron === 'full') nombrePatron = "Cartón Lleno";
    else if (patron === 'diagonal') nombrePatron = "Diagonal";
    else if (patron === 'corners') nombrePatron = "4 Esquinas";
    else if (patron === 'letterX') nombrePatron = "Letra X";
    else if (patron === 'cross') nombrePatron = "Cruz (+)";

    let display = document.getElementById('game-mode-display');
    if (!display) {
        display = document.createElement('div');
        display.id = 'game-mode-display';
        display.className = 'game-mode-badge';

        const h1 = document.querySelector('h1');
        if (h1 && h1.parentNode) {
            h1.parentNode.insertBefore(display, h1.nextSibling);
        }
    }

    display.innerHTML = `🎯 MODO: <span>${nombrePatron}</span>`;

    // Animación de actualización
    display.classList.remove('pulse-update');
    void display.offsetWidth; // Trigger reflow
    display.classList.add('pulse-update');
}

// Función para verificar si algún cartón tiene 4 o más aciertos en línea
function verificarEstadoBotonesBingo() {
    let cartones = [];
    try {
        cartones = JSON.parse(localStorage.getItem('bingo-ajp-cartones')) || [];
    } catch(e) { cartones = []; }

    const marcados = new Set();
    Object.keys(localStorage).forEach(key => {
        if (key.startsWith('marcado-')) marcados.add(key.replace('marcado-', ''));
    });

    cartones.forEach(carton => {
        const btnId = `btn-bingo-${carton.id.replace('#', '')}`;
        const btn = document.getElementById(btnId);
        if (!btn) return;

        const matrix = convertirA_Matriz(carton.data);
        let aciertos = 0;
        let totalNecesario = 5; // Default para línea

        // Helper para contar aciertos en una lista de coordenadas
        const contarAciertos = (coords) => {
            let count = 0;
            coords.forEach(([r, c]) => {
                const val = matrix[r][c];
                if (val === 'FREE' || marcados.has(String(val))) count++;
            });
            return count;
        };

        if (currentPattern === 'full') {
            totalNecesario = 25; // 24 nums + free
            const todas = [];
            for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) todas.push([r, c]);
            aciertos = contarAciertos(todas);

        } else if (currentPattern === 'corners') {
            totalNecesario = 4;
            aciertos = contarAciertos([[0, 0], [0, 4], [4, 0], [4, 4]]);

        } else if (currentPattern === 'letterX') {
            totalNecesario = 9; // 5 + 4 (centro compartido)
            const coords = [];
            for (let i = 0; i < 5; i++) coords.push([i, i]);
            for (let i = 0; i < 5; i++) if (i !== 2) coords.push([i, 4 - i]);
            aciertos = contarAciertos(coords);

        } else if (currentPattern === 'cross') {
            totalNecesario = 9; // Fila media + Col media
            const coords = [];
            for (let i = 0; i < 5; i++) coords.push([2, i]);
            for (let i = 0; i < 5; i++) if (i !== 2) coords.push([i, 2]);
            aciertos = contarAciertos(coords);

        } else if (currentPattern === 'diagonal') {
            totalNecesario = 5;
            let maxDiag = 0;
            maxDiag = Math.max(maxDiag, contarAciertos([[0, 0], [1, 1], [2, 2], [3, 3], [4, 4]]));
            maxDiag = Math.max(maxDiag, contarAciertos([[0, 4], [1, 3], [2, 2], [3, 1], [4, 0]]));
            aciertos = maxDiag;

        } else {
            // LINEA (Lógica original)
            totalNecesario = 5;
            let maxLinea = 0;
            for (let i = 0; i < 5; i++) {
                maxLinea = Math.max(maxLinea, contarAciertos([[i, 0], [i, 1], [i, 2], [i, 3], [i, 4]])); // Filas
                maxLinea = Math.max(maxLinea, contarAciertos([[0, i], [1, i], [2, i], [3, i], [4, i]])); // Columnas
            }
            maxLinea = Math.max(maxLinea, contarAciertos([[0, 0], [1, 1], [2, 2], [3, 3], [4, 4]])); // Diag 1
            maxLinea = Math.max(maxLinea, contarAciertos([[0, 4], [1, 3], [2, 2], [3, 1], [4, 0]])); // Diag 2
            aciertos = maxLinea;
        }

        // Gestión de estados visuales del botón
        btn.classList.remove('pulse-animation', 'bingo-ready');

        if (aciertos === totalNecesario) {
            // ¡BINGO COMPLETO! -> Rojo intenso
            btn.classList.add('bingo-ready');
        } else if (aciertos >= totalNecesario - 1) {
            // A punto de ganar -> Dorado pulsante
            btn.classList.add('pulse-animation');
        }

        // Actualizar contador de faltantes
        const counter = document.getElementById(`counter-${carton.id.replace('#', '')}`);
        if (counter) {
            const faltan = totalNecesario - aciertos;
            if (faltan <= 0) {
                counter.innerHTML = "¡TIENES BINGO!";
                counter.style.color = "var(--danger)";
                counter.style.fontWeight = "800";
            } else {
                counter.innerHTML = `Faltan para Bingo: <span style="color:var(--gold-solid); font-size:1.1em">${faltan}</span>`;
                counter.style.color = "var(--text-muted)";
                counter.style.fontWeight = "600";
            }
        }
    });
}

// 7. Sistema de Modales
function mostrarModal(titulo, mensaje, tipo) {
    const modal = document.getElementById('custom-modal');

    // Si el usuario está en Sala de Espera (bloqueado), ignorar otros mensajes para evitar errores y mantener el bloqueo
    if (modal.dataset.blocking === 'true') return;

    // Limpiar efecto especial si existe
    modal.querySelector('.modal-content').classList.remove('about-modal-pulse');
    const h2 = document.getElementById('modal-title');
    const p = document.getElementById('modal-message');

    h2.textContent = titulo;
    p.textContent = mensaje;

    // Colores según el tipo de mensaje
    if (tipo === 'success') h2.style.color = 'var(--success)';
    else if (tipo === 'error') h2.style.color = 'var(--danger)';
    else h2.style.color = 'var(--gold-solid)';

    modal.style.display = 'flex';
}

function mostrarModalSalaEspera() {
    const modal = document.getElementById('custom-modal');
    const content = modal.querySelector('.modal-content');
    content.classList.remove('about-modal-pulse');

    // Guardar estructura original para restaurarla después
    if (!window.originalModalContent) window.originalModalContent = content.innerHTML;

    // Marcar como bloqueante para impedir cierre manual
    modal.dataset.blocking = 'true';

    // Inyectar contenido SIN botones de cierre
    content.innerHTML = `
        <div style="font-size:4rem; margin-bottom:15px; animation: pulse 2s infinite;">⏳</div>
        <h2 style="color:var(--gold-solid); margin-bottom:15px;">SALA DE ESPERA</h2>
        <p style="color:white; margin-bottom:20px; font-size:1.1em;">La partida ya ha comenzado.</p>
        
        <div style="margin-bottom:20px; padding:15px; background:rgba(0,0,0,0.3); border-radius:12px; border:1px solid rgba(255,255,255,0.1);">
            <div style="color:var(--text-muted); font-size:0.85em; text-transform:uppercase; letter-spacing:1px; margin-bottom:5px;">Bolas Cantadas</div>
            <div style="font-size:2.5rem; font-weight:800; color:var(--gold-solid); line-height:1;">
                <span id="waiting-ball-count" style="display:inline-block;">${numerosCantados.size}</span>
            </div>
        </div>

        <p style="color:var(--text-muted); font-size:0.9em; margin-bottom:20px;">
            Por favor, espera a que el administrador inicie una nueva ronda para unirte automáticamente.
        </p>
    `;

    modal.style.display = 'flex';
}

window.cerrarModal = function (force = false) {
    const modal = document.getElementById('custom-modal');

    // Si está bloqueado y no es un cierre forzado por el sistema, impedir cierre
    if (!force && modal.dataset.blocking === 'true') return;

    modal.dataset.blocking = 'false'; // Resetear bloqueo
    modal.style.display = 'none';
    detenerSonido('audio-suspense'); // Detener sonido si cancelan/cierran
    modal.querySelector('.modal-content').classList.remove('about-modal-pulse');

    // Restaurar contenido original para evitar errores en futuros modales
    if (window.originalModalContent) {
        modal.querySelector('.modal-content').innerHTML = window.originalModalContent;
    }
    // Resetear estilos modificados (ancho)
    const content = modal.querySelector('.modal-content');
    content.style.width = '';
    content.style.maxWidth = '';
};

// 8. Efecto de Confeti y Fuegos Artificiales
function lanzarConfeti() {
    const duration = 8000;
    const animationEnd = Date.now() + duration;
    const defaults = { startVelocity: 30, spread: 360, ticks: 60, zIndex: 2000 };
    const colors = ['#FFD700', '#C0C0C0', '#ffffff', '#ef4444', '#336B87']; // Paleta Premium

    // Sonido base de fuegos artificiales
    const audioFireworks = document.getElementById('audio-fireworks');
    if (audioFireworks) {
        audioFireworks.volume = 0.6; // Volumen principal
        audioFireworks.currentTime = 0;
        audioFireworks.play().catch(() => {});
    }

    function randomInRange(min, max) {
        return Math.random() * (max - min) + min;
    }

    // 1. Explosión inicial central (Estilo Realista)
    const count = 200;
    const defaultsInit = { origin: { y: 0.7 }, zIndex: 2001, colors: colors };

    function fire(particleRatio, opts) {
        confetti(Object.assign({}, defaultsInit, opts, {
            particleCount: Math.floor(count * particleRatio)
        }));
    }

    fire(0.25, { spread: 26, startVelocity: 55 });
    fire(0.2, { spread: 60 });
    fire(0.35, { spread: 100, decay: 0.91, scalar: 0.8 });
    fire(0.1, { spread: 120, startVelocity: 25, decay: 0.92, scalar: 1.2 });
    fire(0.1, { spread: 120, startVelocity: 45 });

    // Intervalo para explosiones tipo fuegos artificiales
    const interval = setInterval(function () {
        const timeLeft = animationEnd - Date.now();

        if (timeLeft <= 0) {
            return clearInterval(interval);
        }

        const particleCount = 50 * (timeLeft / duration);

        // Sincronización: Reproducir estallidos secundarios aleatorios
        if (audioFireworks && Math.random() > 0.6) {
            const clone = audioFireworks.cloneNode(); // Clonar para permitir superposición de sonidos
            clone.volume = 0.3; // Volumen más bajo para el fondo
            clone.play().catch(() => {});
        }

        // Explosiones aleatorias (izquierda y derecha)
        confetti(Object.assign({}, defaults, { particleCount, origin: { x: randomInRange(0.1, 0.3), y: Math.random() - 0.2 }, colors: colors, shapes: ['circle', 'square'] }));
        confetti(Object.assign({}, defaults, { particleCount, origin: { x: randomInRange(0.7, 0.9), y: Math.random() - 0.2 }, colors: colors, shapes: ['circle', 'square'] }));
    }, 250);

    // Lluvia lateral continua
    (function frame() {
        const timeLeft = animationEnd - Date.now();
        if (timeLeft <= 0) return;

        // Estrellas doradas desde los lados
        confetti({ particleCount: 2, angle: 60, spread: 55, origin: { x: 0 }, colors: ['#FFD700', '#ffffff'], shapes: ['star'], zIndex: 2000 });
        confetti({ particleCount: 2, angle: 120, spread: 55, origin: { x: 1 }, colors: ['#FFD700', '#ffffff'], shapes: ['star'], zIndex: 2000 });

        requestAnimationFrame(frame);
    }());
}

// 9. Helper de Sonido
function reproducirSonido(id) {
    const audio = document.getElementById(id);
    if (audio) {
        audio.currentTime = 0; // Reiniciar si ya estaba sonando
        audio.play().catch(e => console.log("Audio bloqueado (interacción requerida):", e));
    }
}

function detenerSonido(id) {
    const audio = document.getElementById(id);
    if (audio) {
        audio.pause();
        audio.currentTime = 0;
    }
}

// 10. Función Text-to-Speech para cantar la bola
function cantarBola(numero) {
    if ('speechSynthesis' in window) {
        let letra = "";
        if (numero <= 15) letra = "B";
        else if (numero <= 30) letra = "I";
        else if (numero <= 45) letra = "N";
        else if (numero <= 60) letra = "G";
        else letra = "O";

        window.speechSynthesis.cancel(); // Detener cualquier audio anterior
        const utterance = new SpeechSynthesisUtterance(`${letra} ${numero}`);
        utterance.lang = 'es-ES'; // Configurar idioma español
        utterance.rate = 0.9;     // Velocidad ligeramente pausada para claridad
        window.speechSynthesis.speak(utterance);
    }
}

function mostrarMensajeDesconexion() {
    let modal = document.getElementById('disconnect-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'disconnect-modal';
        modal.className = 'modal-overlay';
        modal.style.zIndex = '20000'; // Asegurar que esté por encima de todo

        modal.innerHTML = `
            <div class="modal-content" style="border-color: var(--danger); text-align: center;">
                <div style="font-size: 4rem; margin-bottom: 15px;">🔌</div>
                <h2 style="color: var(--danger); margin-bottom: 10px;">DESCONECTADO</h2>
                <p style="color: var(--text-muted); margin-bottom: 10px;">Se ha perdido la conexión con el servidor.</p>
                <p style="font-size: 0.9rem; opacity: 0.8;">Intentando reconectar automáticamente...</p>
            </div>
        `;
        document.body.appendChild(modal);
    }
    modal.style.display = 'flex';
}

// --- LÓGICA DE SOLICITUD DE CARTONES ---

function mostrarModalSolicitud() {
    const modal = document.getElementById('custom-modal');
    // Usamos el modal existente pero inyectamos un formulario
    const content = modal.querySelector('.modal-content');
    content.classList.remove('about-modal-pulse');

    // Guardar contenido original para restaurarlo luego si es necesario
    if (!window.originalModalContent) window.originalModalContent = content.innerHTML;

    content.innerHTML = `
        <h2 style="color:var(--gold-solid); margin-bottom:15px;">SOLICITUD DE CARTONES</h2>
        <p style="color:var(--text-muted); margin-bottom:20px;">Contacta al administrador para ingresar.</p>
        
        <div style="text-align:left; margin-bottom:15px;">
            <label style="display:block; color:white; margin-bottom:5px;">Tu Nombre:</label>
            <input type="text" id="player-name" class="admin-input" style="width:100%" placeholder="Ej. JUAN PÉREZ" oninput="this.value = this.value.toUpperCase(); validarFormularioSolicitud()">
        </div>

        <div style="text-align:left; margin-bottom:15px;">
            <label style="display:block; color:white; margin-bottom:5px;">Banco Emisor:</label>
            <select id="player-bank" class="admin-input" style="width:100%; background:rgba(0,0,0,0.5); color: white;" onchange="validarFormularioSolicitud()">
                <option value="" disabled selected>Seleccione Banco...</option>
                <option value="Banco de Venezuela" style="color:black;">Banco de Venezuela</option>
                <option value="Banesco" style="color:black;">Banesco</option>
                <option value="Banco Mercantil" style="color:black;">Banco Mercantil</option>
                <option value="BBVA Provincial" style="color:black;">BBVA Provincial</option>
                <option value="Banco Bicentenario" style="color:black;">Banco Bicentenario</option>
                <option value="Banco del Tesoro" style="color:black;">Banco del Tesoro</option>
                <option value="Bancamiga" style="color:black;">Bancamiga</option>
                <option value="BNC" style="color:black;">Banco Nacional de Crédito (BNC)</option>
                <option value="Bancaribe" style="color:black;">Bancaribe</option>
                <option value="Banco Exterior" style="color:black;">Banco Exterior</option>
                <option value="BFC" style="color:black;">Banco Fondo Común (BFC)</option>
                <option value="Banplus" style="color:black;">Banplus</option>
                <option value="Banco Plaza" style="color:black;">Banco Plaza</option>
                <option value="Banco Caroní" style="color:black;">Banco Caroní</option>
                <option value="100% Banco" style="color:black;">100% Banco</option>
                <option value="Banco Sofitasa" style="color:black;">Banco Sofitasa</option>
                <option value="Bancrecer" style="color:black;">Bancrecer</option>
                <option value="Mi Banco" style="color:black;">Mi Banco</option>
                <option value="Banco Activo" style="color:black;">Banco Activo</option>
                <option value="Otro" style="color:black;">Otro</option>
            </select>
        </div>

        <div style="text-align:left; margin-bottom:15px;">
            <label style="display:block; color:white; margin-bottom:5px;">Referencia Pago Móvil:</label>
            <input type="text" id="player-ref" class="admin-input" style="width:100%" placeholder="Ej. 123456" oninput="validarFormularioSolicitud()">
        </div>
        
        <div style="text-align:left; margin-bottom:20px;">
            <label style="display:block; color:white; margin-bottom:5px;">Cantidad de Cartones:</label>
            <select id="card-quantity" class="admin-input" style="width:100%; background:rgba(0,0,0,0.5); color:white;">
                <option value="1" style="color:black;">1 Cartón</option>
                <option value="2" style="color:black;">2 Cartones</option>
                <option value="3" style="color:black;">3 Cartones</option>
                <option value="4" style="color:black;">4 Cartones</option>
            </select>
        </div>

        <button id="btn-enviar-solicitud" onclick="enviarSolicitud()" disabled style="background:var(--gold-gradient); color:black; opacity:0.5; cursor:not-allowed;">ENVIAR SOLICITUD</button>
        <p id="solicitud-status" style="margin-top:10px; font-size:0.9em; color:var(--text-muted);"></p>
    `;

    modal.style.display = 'flex';
}

window.validarFormularioSolicitud = function () {
    const nombre = document.getElementById('player-name').value.trim();
    const banco = document.getElementById('player-bank').value;
    const ref = document.getElementById('player-ref').value.trim();
    const btn = document.getElementById('btn-enviar-solicitud');

    if (nombre && banco && ref) {
        btn.disabled = false;
        btn.style.opacity = "1";
        btn.style.cursor = "pointer";
    } else {
        btn.disabled = true;
        btn.style.opacity = "0.5";
        btn.style.cursor = "not-allowed";
    }
};

function enviarSolicitud() {
    const nombre = document.getElementById('player-name').value.trim();
    const banco = document.getElementById('player-bank').value.trim();
    const referencia = document.getElementById('player-ref').value.trim();
    const cantidad = parseInt(document.getElementById('card-quantity').value);
    const status = document.getElementById('solicitud-status');
    const btn = document.querySelector('#custom-modal button');

    if (!nombre) {
        status.textContent = "Por favor, escribe tu nombre.";
        status.style.color = "var(--danger)";
        return;
    }

    if (!banco) {
        status.textContent = "⚠️ Debes seleccionar un Banco de la lista.";
        status.style.color = "var(--danger)";
        return;
    }

    if (!referencia) {
        status.textContent = "Falta el número de referencia.";
        status.style.color = "var(--danger)";
        return;
    }

    if (!/^\d+$/.test(referencia)) {
        status.textContent = "La referencia debe contener solo números.";
        status.style.color = "var(--danger)";
        return;
    }

    if (isNaN(cantidad) || cantidad < 1 || cantidad > 4) {
        status.textContent = "La cantidad de cartones debe ser entre 1 y 4.";
        status.style.color = "var(--danger)";
        return;
    }

    // Validar si el juego inició mientras llenaba el formulario
    if (juegoIniciado) {
        mostrarModalSalaEspera();
        return;
    }

    // Guardar nombre para el chat
    localStorage.setItem('player-name', nombre);

    status.textContent = "Enviando solicitud al administrador...";
    status.style.color = "var(--gold-solid)";
    btn.disabled = true;
    btn.style.opacity = "0.5";

    socket.emit('solicitar-cartones', { nombre, banco, referencia, cantidad });
}

socket.on('solicitud-aprobada', (data) => {
    const modal = document.getElementById('custom-modal');
    modal.style.display = 'none';

    // Restaurar modal (opcional)
    if (window.originalModalContent) {
        modal.querySelector('.modal-content').innerHTML = window.originalModalContent;
    }

    localStorage.setItem('bingo-pending-selection', data.cantidad); // Guardar estado por si recarga
    mostrarModal("✅ SOLICITUD APROBADA", `El administrador te ha habilitado ${data.cantidad} cartones.`, "success");
    setTimeout(() => cerrarModal(), 2000);

    // EN LUGAR DE GENERAR AUTOMÁTICAMENTE, ABRIMOS EL SELECTOR
    setTimeout(() => {
        mostrarModalSeleccionCartones(data.cantidad);
    }, 2100);
});

socket.on('solicitud-rechazada', (data) => {
    const status = document.getElementById('solicitud-status');
    const btn = document.querySelector('#custom-modal button');

    if (status) {
        status.textContent = `Solicitud rechazada: ${data.motivo || 'Sin motivo'}`;
        status.style.color = "var(--danger)";
    }
    if (btn) {
        btn.disabled = false;
        btn.style.opacity = "1";
    }
});

socket.on('solicitud-error', (data) => {
    // Si el servidor rechaza por juego iniciado, enviar a sala de espera
    if (data.reason === 'GAME_IN_PROGRESS') {
        mostrarModalSalaEspera();
        return;
    }

    const status = document.getElementById('solicitud-status');
    const btn = document.querySelector('#custom-modal button');
    if (status) {
        status.textContent = data.message;
        status.style.color = "var(--danger)";
    }
    if (btn) {
        btn.disabled = false;
        btn.style.opacity = "1";
    }
});

// --- FUNCIONES PARA CAMBIAR CARTÓN (SWAP) ---
window.mostrarModalCambioCarton = function (idOld) {
    socket.emit('obtener-cartones-disponibles', (ocupados) => {
        const setOcupados = new Set(ocupados);
        const modal = document.getElementById('custom-modal');
        const content = modal.querySelector('.modal-content');
        content.classList.remove('about-modal-pulse');

        if (!window.originalModalContent) window.originalModalContent = content.innerHTML;

        modal.dataset.blocking = 'true'; // Bloquear cierre manual

        let gridHtml = `<div class="selection-grid" data-context="swap" data-old-id="${idOld}">`;
        for (let i = 1; i <= 50; i++) {
            const isTaken = setOcupados.has(i);
            const isSelf = String(i) === String(idOld).replace('#', ''); // ¿Es el cartón que estamos cambiando?

            let className = 'select-card-item';
            let onClick = '';
            let title = `Cartón #${i}`;
            let style = '';

            if (isSelf) {
                className += ' taken';
                style = 'border: 2px solid var(--gold-solid); background: rgba(51, 107, 135, 0.4); color: white;';
                title = 'Tu cartón actual';
            } else if (isTaken) {
                className += ' taken';
                title = 'Ocupado';
            } else {
                onClick = `onclick="confirmarCambioCarton('${idOld}', '${i}')"`;
            }

            gridHtml += `<div class="${className}" style="${style}" ${onClick} title="${title}">${i}</div>`;
        }
        gridHtml += '</div>';

        content.innerHTML = `
            <h2 style="color:var(--gold-solid); margin-bottom:5px;">CAMBIAR CARTÓN</h2>
            <p style="color:white; margin-bottom:10px;">Estás cambiando el cartón <strong style="color:var(--gold-solid)">${idOld}</strong></p>
            <p style="color:var(--text-muted); font-size:0.9em;">Selecciona uno nuevo de la lista:</p>
            ${gridHtml}
            <button onclick="cerrarModal(true)" style="margin-top:15px; background:transparent; border:1px solid var(--text-muted); color:var(--text-muted);">CANCELAR</button>
        `;
        modal.style.display = 'flex';
    });
}

window.confirmarCambioCarton = function (idOld, idNew) {
    if (!confirm(`¿Confirmas el cambio del cartón ${idOld} por el #${idNew}?`)) return;

    // 1. Liberar el viejo en el servidor
    socket.emit('liberar-carton', idOld);

    // 2. Preparar el nuevo
    const newId = String(idNew);
    const dataFija = generarCartonFijo(newId);
    const matrix = convertirA_Matriz(dataFija);

    // 3. Actualizar LocalStorage
    let cartones = [];
    try {
        cartones = JSON.parse(localStorage.getItem('bingo-ajp-cartones')) || [];
    } catch(e) { cartones = []; }

    const index = cartones.findIndex(c => c.id === idOld);
    if (index !== -1) {
        cartones[index] = { id: newId, data: dataFija };
        localStorage.setItem('bingo-ajp-cartones', JSON.stringify(cartones));
    }

    // 4. Registrar el nuevo
    socket.emit('registrar-id', { id: newId, matrix: matrix }, (res) => {
        if (res && res.accepted) {
            renderizarCartones();
            cerrarModal(true);
            reproducirSonido('audio-ball');
            mostrarModal("✅ CAMBIO EXITOSO", `Ahora juegas con el cartón ${newId}.`, "success");
            setTimeout(() => cerrarModal(), 1500);
        } else {
            // REVERTIR CAMBIOS (Rollback)
            if (index !== -1) {
                // Recuperar estado anterior si falló (necesitaríamos haber guardado backup, 
                // pero para simplificar, recargamos o avisamos)
                // En este flujo simple, avisamos y el usuario tendrá que intentar de nuevo.
            }
            if (res.reason === 'CARD_TAKEN') {
                mostrarModal("⛔ CARTÓN OCUPADO", `El cartón #${newId} ya está en uso por otro jugador.`, "error");
            } else {
                mostrarModal("❌ ERROR", "No se pudo registrar el nuevo cartón.", "error");
            }
            // Recargar para asegurar estado consistente
            setTimeout(() => location.reload(), 3000);
        }
    });
}

// --- NUEVO: MODAL DE SELECCIÓN DE CARTONES (1-100) ---
function mostrarModalSeleccionCartones(cantidadPermitida) {
    // Pedir al servidor cuáles están ocupados
    socket.emit('obtener-cartones-disponibles', (ocupados) => {
        const setOcupados = new Set(ocupados);
        cartonesSeleccionadosTemp.clear();

        const modal = document.getElementById('custom-modal');
        const content = modal.querySelector('.modal-content');
        content.classList.remove('about-modal-pulse');

        // Guardar original
        if (!window.originalModalContent) window.originalModalContent = content.innerHTML;

        // Ajustar ancho para vista previa
        content.style.width = '800px';
        content.style.maxWidth = '95%';

        // Bloquear cierre manual para obligar a seleccionar
        modal.dataset.blocking = 'true';

        let gridHtml = `<div class="selection-grid" data-context="select" data-max="${cantidadPermitida}">`;
        for (let i = 1; i <= 50; i++) {
            const isTaken = setOcupados.has(i);
            const className = isTaken ? 'select-card-item taken' : 'select-card-item';
            const onClick = isTaken ? '' : `onclick="toggleSeleccionCarton(this, ${i}, ${cantidadPermitida})"`;
            const title = isTaken ? 'Ocupado' : `Cartón #${i}`;
            gridHtml += `<div id="sel-card-${i}" class="${className}" ${onClick} title="${title}">${i}</div>`;
        }
        gridHtml += '</div>';

        content.innerHTML = `
            <h2 style="color:var(--gold-solid); margin-bottom:5px;">ELIGE TUS CARTONES</h2>
            <p style="color:white; margin-bottom:10px;">Tienes aprobados: <strong style="color:var(--success); font-size:1.2em;">${cantidadPermitida}</strong></p>
            <p style="color:var(--text-muted); font-size:0.9em;">Selecciona los números que deseas jugar (1-50).</p>
            
            <div style="display:flex; flex-wrap:wrap; gap:20px; justify-content:center; align-items:flex-start;">
                <div style="flex:1; min-width:260px;">
                    ${gridHtml}
                </div>
                <div id="preview-container" style="flex: 1; min-width: 200px; max-width: 300px; background:rgba(0,0,0,0.3); padding:15px; border-radius:12px; border:1px solid rgba(255,255,255,0.1); display:flex; flex-direction:column; align-items:center; min-height:230px; justify-content:center;">
                    <p style="color:var(--text-muted); font-size:0.85em; text-align:center; font-style:italic;">Toca un número para ver la vista previa.</p>
                </div>
            </div>

            <div style="display:flex; justify-content:space-between; align-items:center; margin-top:15px; width:100%;">
                <div id="selection-count" style="color:var(--text-muted);">Seleccionados: 0 / ${cantidadPermitida}</div>
                <button id="btn-confirm-selection" onclick="confirmarSeleccionCartones(${cantidadPermitida})" disabled style="width:auto; padding:10px 25px; background:var(--gold-gradient); opacity:0.5; cursor:not-allowed;">JUGAR</button>
            </div>
        `;

        modal.style.display = 'flex';
    });
}

function mostrarVistaPreviaCarton(id) {
    const container = document.getElementById('preview-container');
    if (!container) return;

    const data = generarCartonFijo(id);
    const matrix = convertirA_Matriz(data);

    let html = `<div class="preview-content">`;
    html += `<div style="color:var(--gold-solid); font-weight:bold; margin-bottom:10px;">CARTÓN #${id}</div>`;
    html += '<div style="display:grid; grid-template-columns:repeat(5, 1fr); gap:4px; width:100%;">';

    ['B', 'I', 'N', 'G', 'O'].forEach(l => {
        html += `<div style="text-align:center; font-weight:bold; color:var(--text-muted); font-size:0.8em;">${l}</div>`;
    });

    for (let r = 0; r < 5; r++) {
        for (let c = 0; c < 5; c++) {
            const val = matrix[r][c];
            let content = val;
            let style = 'background:rgba(255,255,255,0.05); aspect-ratio:1; display:flex; align-items:center; justify-content:center; border-radius:4px; font-size:0.85em; color:white;';

            if (val === 'FREE') {
                content = '★';
                style = 'background:rgba(51, 107, 135, 0.2); aspect-ratio:1; display:flex; align-items:center; justify-content:center; border-radius:4px; font-size:0.85em; color:var(--gold-solid); border:1px dashed var(--gold-solid);';
            }
            html += `<div style="${style}">${content}</div>`;
        }
    }
    html += '</div></div>';

    container.innerHTML = html;
}

window.toggleSeleccionCarton = function (el, id, max) {
    if (cartonesSeleccionadosTemp.has(id)) {
        cartonesSeleccionadosTemp.delete(id);
        el.classList.remove('selected');
    } else {
        if (cartonesSeleccionadosTemp.size >= max) {
            // Feedback visual de límite alcanzado (opcional)
            return;
        }
        cartonesSeleccionadosTemp.add(id);
        el.classList.add('selected');
    }
    actualizarUISeleccion(max);
    // Mostrar vista previa del cartón tocado
    mostrarVistaPreviaCarton(id);
};

function actualizarUISeleccion(max) {
    const countDiv = document.getElementById('selection-count');
    const btn = document.getElementById('btn-confirm-selection');
    if (!countDiv || !btn) return;

    countDiv.textContent = `Seleccionados: ${cartonesSeleccionadosTemp.size} / ${max}`;

    if (cartonesSeleccionadosTemp.size === max) {
        btn.disabled = false;
        btn.style.opacity = '1';
        btn.style.cursor = 'pointer';
        countDiv.style.color = 'var(--success)';
    } else {
        btn.disabled = true;
        btn.style.opacity = '0.5';
        btn.style.cursor = 'not-allowed';
        countDiv.style.color = 'var(--text-muted)';
    }
}

// Sincronización en tiempo real de la cuadrícula de selección
socket.on('estado-carton-cambiado', (data) => {
    const el = document.getElementById(`sel-card-${data.id}`);
    if (!el) return;

    const grid = el.parentElement;
    const context = grid.dataset.context;

    if (data.estado === 'ocupado') {
        el.classList.add('taken');
        el.title = 'Ocupado';
        el.onclick = null;
        el.style.cursor = 'not-allowed';

        // Si yo lo tenía seleccionado (y alguien más me ganó), deseleccionarlo
        if (context === 'select') {
            const id = parseInt(data.id);
            if (cartonesSeleccionadosTemp.has(id)) {
                cartonesSeleccionadosTemp.delete(id);
                el.classList.remove('selected');
                const max = parseInt(grid.dataset.max);
                actualizarUISeleccion(max);
            }
        }
    } else {
        el.classList.remove('taken');
        el.title = `Cartón #${data.id}`;
        el.style.cursor = 'pointer';

        // Restaurar evento click según el contexto
        if (context === 'select') {
            const max = parseInt(grid.dataset.max);
            el.onclick = () => toggleSeleccionCarton(el, parseInt(data.id), max);
        } else if (context === 'swap') {
            const oldId = grid.dataset.oldId;
            el.onclick = () => confirmarCambioCarton(oldId, data.id);
        }
    }
});

window.confirmarSeleccionCartones = function (cantidad) {
    if (cartonesSeleccionadosTemp.size !== cantidad) return;

    localStorage.removeItem('bingo-pending-selection'); // Limpiar estado pendiente al confirmar
    // Cerrar modal primero para mejor UX
    cerrarModal(true);
    reproducirSonido('audio-ball');

    // Procesar selección
    cartonesSeleccionadosTemp.forEach(id => {
        const dataFija = generarCartonFijo(id);
        const matrix = convertirA_Matriz(dataFija);

        // Guardar localmente (Optimista)
        let cartonesActuales = [];
        try {
            cartonesActuales = JSON.parse(localStorage.getItem('bingo-ajp-cartones')) || [];
        } catch(e) { cartonesActuales = []; }

        // Usamos el ID numérico como string para consistencia
        cartonesActuales.push({ id: String(id), data: dataFija });
        localStorage.setItem('bingo-ajp-cartones', JSON.stringify(cartonesActuales));

        // Renderizar inmediatamente
        renderizarCartones();

        // Registrar en servidor
        socket.emit('registrar-id', { id: String(id), matrix: matrix }, (res) => {
            if (!res.accepted) {
                console.error(`Error registrando cartón ${id}: ${res.reason}`);

                if (res.reason === 'CARD_TAKEN') {
                    // 1. Notificar al usuario
                    mostrarModal("⛔ CARTÓN OCUPADO", `El cartón #${id} fue seleccionado por otro jugador hace un instante.`, "error");

                    // 2. Revertir cambio local (Eliminar el cartón inválido)
                    let cartones = [];
                    try {
                        cartones = JSON.parse(localStorage.getItem('bingo-ajp-cartones')) || [];
                    } catch(e) { cartones = []; }

                    const filtrados = cartones.filter(c => c.id !== String(id));
                    localStorage.setItem('bingo-ajp-cartones', JSON.stringify(filtrados));

                    // 3. Actualizar UI
                    renderizarCartones();
                }
            }
        });
    });

    // Notificar al servidor que se ha completado la selección
    socket.emit('jugador-completo-seleccion', { cantidad: cartonesSeleccionadosTemp.size });
};

// --- CHAT SYSTEM ---
function initChat() {
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
            <span>SALA DE CHAT</span>
            <span onclick="toggleChat()" style="cursor:pointer">✕</span>
        </div>
        <div class="chat-messages" id="chat-messages"></div>
        <div class="chat-input-area">
            <input type="text" id="chat-input" class="admin-input" placeholder="Mensaje..." style="font-size:0.9rem; padding:8px;">
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
        const input = document.getElementById('chat-input');
        const nombre = localStorage.getItem('player-name');
        if (nombre) {
            input.placeholder = `Escribe como ${nombre}...`;
        }
        const btn = document.querySelector('.chat-toggle-btn');
        if (btn) btn.classList.remove('has-new-messages');
        const badge = document.getElementById('chat-badge');
        if (badge) {
            badge.style.display = 'none';
            badge.textContent = '0';
        }
        input.focus();
        // Scroll al fondo
        const msgs = document.getElementById('chat-messages');
        msgs.scrollTop = msgs.scrollHeight;
    }
}

function enviarMensajeChat() {
    const input = document.getElementById('chat-input');
    const texto = input.value.trim();
    if (!texto) return;

    let nombre = localStorage.getItem('player-name');

    if (!nombre) {
        nombre = prompt("Para participar en el chat, por favor escribe tu nombre:");
        if (nombre) {
            localStorage.setItem('player-name', nombre);
            socket.emit('registrar-nombre', nombre);
            input.placeholder = `Escribe como ${nombre}...`;
        } else {
            return; // Cancelar si no introduce nombre
        }
    }

    socket.emit('chat-mensaje', { usuario: nombre, texto: texto, esAdmin: false });
    input.value = '';
}

socket.on('chat-nuevo-mensaje', (data) => {
    const container = document.getElementById('chat-messages');
    if (!container) return;

    const div = document.createElement('div');
    const miNombre = localStorage.getItem('player-name') || 'Jugador';

    let clase = 'others';
    if (data.esAdmin) clase = 'admin';
    else if (data.usuario === miNombre) clase = 'mine';

    // Sonido de notificación si no soy yo
    if (clase !== 'mine') {
        const audio = new Audio('sounds/pop.mp3');
        audio.volume = 0.4; // Suave
        audio.play().catch(e => { });

        // Animación del botón si el chat está cerrado
        const widget = document.getElementById('chat-widget');
        if (widget && widget.style.display === 'none') {
            if (data.esAdmin) {
                toggleChat(); // Abrir automáticamente para ver el mensaje del admin
            } else {
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
    }

    div.className = `chat-msg ${clase}`;

    const time = data.timestamp ? new Date(data.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

    // SEGURIDAD: Usar textContent para evitar XSS
    const userStrong = document.createElement('strong');
    userStrong.textContent = data.usuario + ': ';

    const msgText = document.createTextNode(data.texto);

    const timeDiv = document.createElement('div');
    timeDiv.className = 'chat-time';
    timeDiv.textContent = time;

    div.appendChild(userStrong);
    div.appendChild(msgText);
    div.appendChild(timeDiv);

    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
});

socket.on('chat-clear-history', () => {
    const container = document.getElementById('chat-messages');
    if (container) container.innerHTML = '<div style="text-align:center; color:var(--text-muted); font-size:0.8em; padding:10px; font-style:italic;">El historial del chat ha sido borrado por el administrador.</div>';
});

// --- ACERCA DE ---
function mostrarAcercaDe() {
    const modal = document.getElementById('custom-modal');
    const content = modal.querySelector('.modal-content');

    content.classList.add('about-modal-pulse');

    // Guardar contenido original si no existe para poder restaurarlo
    if (!window.originalModalContent) window.originalModalContent = content.innerHTML;

    // Generar estrellas de fondo
    let stars = '<div class="about-stars-bg">';
    for (let i = 0; i < 50; i++) {
        const top = Math.random() * 100;
        const left = Math.random() * 100;
        const delay = Math.random() * 5;
        const size = Math.random() * 2 + 1;
        stars += `<div class="star-particle" style="top:${top}%; left:${left}%; width:${size}px; height:${size}px; animation-delay:${delay}s"></div>`;
    }
    stars += '</div>';

    content.innerHTML = stars + `
        <div style="text-align: center; position: relative; z-index: 2;">
            <img src="./icons/ajp.png" class="spin-animation" style="width: 80px; margin-bottom: 15px; filter: drop-shadow(0 0 10px rgba(51, 107, 135, 0.5));">
            <h2 class="shine-text" style="margin-bottom: 10px; text-transform: uppercase; font-size: 1.5rem;">Bingo Online</h2>
            <p style="color: white; margin-bottom: 5px; font-size: 1.1em;">Desarrollado por <strong>AJP-Logic</strong></p>
            
            <div style="background: rgba(255,255,255,0.05); padding: 15px; border-radius: 12px; margin: 20px 0; border: 1px solid rgba(255,255,255,0.1);">
                <p style="color: var(--text-muted); font-size: 0.9em; margin-bottom: 5px;">Versión 3.00</p>
                <p style="color: var(--text-muted); font-size: 0.9em;">Fecha de actualización: ${new Date().toLocaleDateString()}</p>
            </div>
            
            <div style="text-align: left; background: rgba(0,0,0,0.3); padding: 15px; border-radius: 12px; max-height: 150px; overflow-y: auto; border: 1px solid rgba(255,255,255,0.05); margin-bottom: 15px;">
                <h4 style="color: var(--gold-solid); margin-bottom: 10px; font-size: 0.9em; text-transform: uppercase;">Historial de Cambios</h4>
                <ul style="list-style: none; padding: 0; font-size: 0.85em; color: var(--text-muted);">
                    <li style="margin-bottom: 8px;">
                        <strong style="color: white;">v3.00</strong> - Mejoras en PWA, iconos adaptativos y optimización de rendimiento.
                    </li>
                    <li style="margin-bottom: 8px;">
                        <strong style="color: white;">v2.00</strong> - Actualización mayor de UI, sistema de chat, PWA y optimización móvil.
                    </li>
                    <li style="margin-bottom: 8px;">
                        <strong style="color: white;">v1.50</strong> - Agregado soporte para múltiples cartones (hasta 4).
                    </li>
                    <li style="margin-bottom: 8px;">
                        <strong style="color: white;">v1.20</strong> - Mejoras en la sincronización de sockets y reconexión.
                    </li>
                    <li>
                        <strong style="color: white;">v1.00</strong> - Lanzamiento inicial.
                    </li>
                </ul>
            </div>
            
            <div style="margin-top: 15px; font-size: 0.8em; opacity: 0.6; color: var(--text-muted); line-height: 1.4;">
                &copy; 2025 AJP-Logic<br>Todos los derechos reservados.
            </div>
            
            <button onclick="cerrarModal()" style="margin-top: 20px; background: var(--gold-gradient); color: black; width: auto; padding: 10px 30px;">CERRAR</button>
        </div>
    `;

    modal.style.display = 'flex';
}

// --- COMPARTIR ENLACE ---
window.compartirEnlace = function () {
    const url = window.location.href; // Compartir la URL actual (GitHub Pages o Render)
    const text = "¡Únete a mi partida de Bingo Online! " + url;

    if (navigator.share) {
        navigator.share({
            title: 'Bingo Online - AJP-Logic',
            text: '¡Únete a mi partida de Bingo Online!',
            url: url
        }).catch(console.error);
    } else {
        // Fallback: Modal con opción de WhatsApp y Copiar
        const modal = document.getElementById('custom-modal');
        const content = modal.querySelector('.modal-content');
        content.classList.remove('about-modal-pulse');

        if (!window.originalModalContent) window.originalModalContent = content.innerHTML;

        // Detectar si es móvil para usar esquema directo
        const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
        const whatsappUrl = isMobile
            ? `whatsapp://send?text=${encodeURIComponent(text)}`
            : `https://api.whatsapp.com/send?text=${encodeURIComponent(text)}`;

        content.innerHTML = `
            <h2 style="color:var(--gold-solid); margin-bottom:15px;">COMPARTIR</h2>
            <p style="color:var(--text-muted); margin-bottom:20px;">Elige una opción:</p>
            
            <a href="${whatsappUrl}" target="_blank" onclick="cerrarModal()" style="display:flex; align-items:center; justify-content:center; gap:10px; width:100%; padding:15px; background:#25D366; color:white; text-decoration:none; border-radius:12px; font-weight:bold; margin-bottom:15px; transition:transform 0.2s;">
                <span style="font-size:1.2em">📱</span> Enviar por WhatsApp
            </a>

            <button onclick="mostrarQR('${url}')" style="background:rgba(255,255,255,0.1); border:1px solid var(--glass-border); color:white; margin-bottom:15px;">🔳 Mostrar QR</button>
            
            <button onclick="cerrarModal()" style="background:transparent; border:1px solid var(--text-muted); color:var(--text-muted); font-size:0.9rem; padding:10px;">CANCELAR</button>
        `;

        modal.style.display = 'flex';
    }
};

window.mostrarQR = function (url) {
    const modal = document.getElementById('custom-modal');
    const content = modal.querySelector('.modal-content');

    // Usamos una API pública para generar el QR
    const qrApi = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(url)}`;

    content.innerHTML = `
        <h2 style="color:var(--gold-solid); margin-bottom:15px;">CÓDIGO QR</h2>
        <div style="background:white; padding:15px; border-radius:12px; display:inline-block; margin-bottom:20px;">
            <img src="${qrApi}" alt="QR Code" style="width:180px; height:180px; display:block;">
        </div>
        <p style="color:var(--text-muted); font-size:0.9em; margin-bottom:20px;">Escanea para unirte a la partida</p>
        
        <button onclick="compartirEnlace()" style="background:transparent; border:1px solid var(--gold-solid); color:var(--gold-solid); margin-bottom:10px;">⬅ VOLVER</button>
        <button onclick="cerrarModal()" style="background:transparent; border:1px solid var(--text-muted); color:var(--text-muted);">CERRAR</button>
    `;
};

// --- PWA INSTALLATION ---
let deferredPrompt;

if ('serviceWorker' in navigator && window.location.protocol.startsWith('http')) {
    window.addEventListener('load', () => {
        // Usar ruta relativa para compatibilidad con GitHub Pages (subdirectorios)
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
                <strong>Instalar Bingo Online</strong>
                <span>Instala la App para una mejor experiencia de juego.</span>
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

window.cerrarBannerPWA = function () {
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

window.instalarPWA = function () {
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

window.onload = cargarJuego;