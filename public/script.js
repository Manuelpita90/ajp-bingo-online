if (typeof io === 'undefined') {
    alert("Error crítico: La librería Socket.IO no está cargada. Asegúrate de incluir <script src='/socket.io/socket.io.js'></script> en tu HTML antes de cargar este script.");
    throw new Error("Socket.IO no definido");
}
const socket = io();

let historialBolas = [];
let juegoIniciado = false;

// 1. CARGA INICIAL: Revisa si hay una partida en curso en el navegador
function cargarJuego() {
    // Intentar cargar array de cartones
    let cartones = JSON.parse(sessionStorage.getItem('bingo-ajp-cartones'));

    // Migración: Si existe el formato antiguo (un solo cartón), convertirlo
    if (!cartones && sessionStorage.getItem('bingo-ajp-carton')) {
        const oldData = JSON.parse(sessionStorage.getItem('bingo-ajp-carton'));
        const oldId = sessionStorage.getItem('bingo-ajp-carton-id') || generarIdAleatorio();
        cartones = [{ id: oldId, data: oldData }];
        sessionStorage.setItem('bingo-ajp-cartones', JSON.stringify(cartones));
    }

    if (!cartones || cartones.length === 0) {
        // MODIFICADO: En lugar de crear automáticamente, pedir solicitud
        mostrarModalSolicitud();
    } else {
        // Registrar IDs en el servidor y renderizar
        cartones.forEach(c => registrarIdEnServidor(c.id));
        renderizarCartones();
    }
    initChat();
}

function generarIdAleatorio() {
    // Implementación sencilla (para producción, considera UUID)
    return '#' + Math.floor(1000 + Math.random() * 9000); 
}

function generarIdUnico() {
    //TODO: Implementar generador de id unico
    return
}

function registrarIdEnServidor(id) {
    socket.emit('registrar-id', id, (response) => {
        if (response && response.accepted) {
            console.log(`ID ${id} registrado correctamente.`);
        } else {
            console.warn(`ID ${id} ocupado.`);
            // En un caso real, aquí deberíamos regenerar el ID de este cartón específico y guardar
        }
    });
}

function agregarNuevoCarton(render = true, callback = null) {
    let cartones = JSON.parse(sessionStorage.getItem('bingo-ajp-cartones')) || [];
    
    if (cartones.length >= 4) {
        mostrarModal("LÍMITE ALCANZADO", "Solo puedes jugar con un máximo de 4 cartones.", "warning");
        if (callback) callback();
        return;
    }

    const nuevoId = generarIdAleatorio();
    
    // Validar ID con servidor antes de guardar
    socket.emit('registrar-id', nuevoId, (response) => {
        if (response && response.accepted) {
            
            // CRÍTICO: Re-leer sessionStorage aquí para evitar condiciones de carrera
            let cartonesActuales = JSON.parse(sessionStorage.getItem('bingo-ajp-cartones')) || [];
            
            const nuevoData = generarNuevoSetDeNumeros();
            
            //TODO: Guardar matriz en sessionStorage
            //const cartonMatrix = convertirA_Matriz(nuevoData);
            //sessionStorage.setItem(`matrix-${nuevoId}`, JSON.stringify(cartonMatrix));


            cartonesActuales.push({ id: nuevoId, data: nuevoData });
            sessionStorage.setItem('bingo-ajp-cartones', JSON.stringify(cartonesActuales));
            
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

    if (confirm("¿Deseas cambiar los números de este cartón?")) {
        let cartones = JSON.parse(sessionStorage.getItem('bingo-ajp-cartones')) || [];
        const index = cartones.findIndex(c => c.id === id);
        if (index !== -1) {
            cartones[index].data = generarNuevoSetDeNumeros();
            sessionStorage.setItem('bingo-ajp-cartones', JSON.stringify(cartones));
            renderizarCartones();
            reproducirSonido('audio-ball');

            // Confirmación visual
            const wrapper = document.getElementById(`card-wrapper-${id.replace('#', '')}`);
            if (wrapper) {
                const overlay = document.createElement('div');
                overlay.className = 'success-overlay';
                overlay.innerHTML = '✔';
                wrapper.appendChild(overlay);
                setTimeout(() => overlay.remove(), 1500);
            }
        }
    }
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
    const cartones = JSON.parse(sessionStorage.getItem('bingo-ajp-cartones')) || [];
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
                img.src = '/icons/ajp.png';
                img.className = 'free-img';
                celda.appendChild(img);
            } else {
                celda.textContent = num;
                
                // RECUPERAR ESTADO: ¿Estaba marcado antes de refrescar?
                if (sessionStorage.getItem(`marcado-${num}`)) {
                    celda.classList.add('marked');
                }

                celda.onclick = () => {
                    celda.classList.toggle('marked');
                    // Guardar estado de la marca
                    const isMarked = celda.classList.contains('marked');
                    if (celda.classList.contains('marked')) {
                        sessionStorage.setItem(`marcado-${num}`, 'true');
                    } else {
                        sessionStorage.removeItem(`marcado-${num}`);
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
    const cartones = JSON.parse(sessionStorage.getItem('bingo-ajp-cartones'));
    if (cartones && cartones.length > 0) {
        cartones.forEach(c => registrarIdEnServidor(c.id));
    }
    
    // Registrar nombre si existe (para que el admin lo vea en la lista)
    const nombre = sessionStorage.getItem('player-name');
    if (nombre) socket.emit('registrar-nombre', nombre);
});

socket.on('disconnect', () => {
    mostrarMensajeDesconexion();
});

socket.on('anuncio-bola', (numero) => {
    reproducirSonido('audio-ball');
    juegoIniciado = true;
    
    // Ocultar botón de añadir cartón si existe
    const btnAdd = document.querySelector('.add-card-btn');
    if (btnAdd) btnAdd.style.display = 'none';

    // Ocultar mensaje de espera y mostrar bolas
    document.getElementById('waiting-message').style.display = 'none';
    document.getElementById('last-calls').style.display = 'flex';

    actualizarUltimasBolas(numero);
    
    // Resaltar en el cartón si el número coincide con la bola cantada
    const celdas = document.querySelectorAll('.cell');
    celdas.forEach(celda => {
        if (parseInt(celda.textContent) === numero) {
            celda.style.border = "2px solid var(--gold-solid)";
            celda.style.boxShadow = "0 0 15px rgba(212, 175, 55, 0.4)";
        }
    });
});

socket.on('historial', (bolas) => {
    // Verificar si el juego ya empezó para ocultar/mostrar el botón de cambio
    juegoIniciado = bolas.length > 0;

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
});

socket.on('limpiar-tablero', (newGameId) => {
    // Guardar nombre para no obligar a escribirlo de nuevo
    const savedName = sessionStorage.getItem('player-name');
    
    // Cuando el admin reinicia, borramos todo rastro del juego anterior
    sessionStorage.clear();
    if (savedName) sessionStorage.setItem('player-name', savedName);
    if (newGameId) sessionStorage.setItem('bingo-game-id', newGameId);
    
    // Reiniciar estado local
    historialBolas = [];
    juegoIniciado = false;

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
    const localGameId = sessionStorage.getItem('bingo-game-id');
    
    // Si hay un ID local y es distinto al del servidor -> Reinicio ocurrido mientras estaba desconectado
    if (localGameId && localGameId !== serverGameId) {
        console.log("Sincronización: Partida nueva detectada. Limpiando...");
        const savedName = sessionStorage.getItem('player-name');
        sessionStorage.clear();
        if (savedName) sessionStorage.setItem('player-name', savedName);
        sessionStorage.setItem('bingo-game-id', serverGameId);
        window.location.reload(); // Recargar para asegurar estado limpio y mostrar solicitud
    } else if (!localGameId) {
        sessionStorage.setItem('bingo-game-id', serverGameId);
    }
});

socket.on('mensaje-global', (mensaje) => {
    console.log("Mensaje del admin recibido:", mensaje);
    reproducirSonido('audio-ball'); // Usamos sonido para llamar la atención
    mostrarModal("📢 MENSAJE DEL ADMIN", mensaje, 'info');
});

// RESPUESTAS DE VALIDACIÓN DE BINGO
socket.on('bingo-validado', (data) => {
    reproducirSonido('audio-win');
    lanzarConfeti();
    mostrarModal("🎉 ¡BINGO VÁLIDO!", data.message, 'success');
});

socket.on('bingo-rechazado', (data) => {
    reproducirSonido('audio-fail');
    mostrarModal("❌ BINGO RECHAZADO", data.message, 'error');
});

// Función para cantar Bingo de un cartón específico
function reclamarBingoIndividual(cartonObj) {
    const todosMarcados = [];
    Object.keys(sessionStorage).forEach(key => {
        if (key.startsWith('marcado-')) todosMarcados.push(key.replace('marcado-', ''));
    });

    if (todosMarcados.length < 4) {
        mostrarModal("⚠️ ATENCIÓN", "¡Necesitas marcar más números antes de cantar Bingo!", 'warning');
        return;
    }

    if (confirm(`¿Cantar BINGO con el cartón ${cartonObj.id}?`)) {
        const cartonMatrix = convertirA_Matriz(cartonObj.data);

        socket.emit('reclamar-bingo', {
            numeros: todosMarcados,
            carton: cartonMatrix,
            cartonId: cartonObj.id
        });
        mostrarModal("⏳ ENVIADO", `Tu cartón ${cartonObj.id} ha sido enviado. Espera la validación.`, 'info');
    }
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

// Función para verificar si algún cartón tiene 4 o más aciertos en línea
function verificarEstadoBotonesBingo() {
    const cartones = JSON.parse(sessionStorage.getItem('bingo-ajp-cartones')) || [];
    const marcados = new Set();
    Object.keys(sessionStorage).forEach(key => {
        if (key.startsWith('marcado-')) marcados.add(key.replace('marcado-', ''));
    });

    cartones.forEach(carton => {
        const btnId = `btn-bingo-${carton.id.replace('#', '')}`;
        const btn = document.getElementById(btnId);
        if (!btn) return;

        const matrix = convertirA_Matriz(carton.data);
        let maxAciertosEnLinea = 0;

        // Helper para contar aciertos en una lista de coordenadas
        const contarAciertos = (coords) => {
            let count = 0;
            coords.forEach(([r, c]) => {
                const val = matrix[r][c];
                if (val === 'FREE' || marcados.has(String(val))) count++;
            });
            return count;
        };

        // Revisar todas las líneas posibles
        for(let i=0; i<5; i++) {
            maxAciertosEnLinea = Math.max(maxAciertosEnLinea, contarAciertos([[i,0],[i,1],[i,2],[i,3],[i,4]])); // Filas
            maxAciertosEnLinea = Math.max(maxAciertosEnLinea, contarAciertos([[0,i],[1,i],[2,i],[3,i],[4,i]])); // Columnas
        }
        maxAciertosEnLinea = Math.max(maxAciertosEnLinea, contarAciertos([[0,0],[1,1],[2,2],[3,3],[4,4]])); // Diag 1
        maxAciertosEnLinea = Math.max(maxAciertosEnLinea, contarAciertos([[0,4],[1,3],[2,2],[3,1],[4,0]])); // Diag 2

        // Gestión de estados visuales del botón
        btn.classList.remove('pulse-animation', 'bingo-ready');
        
        if (maxAciertosEnLinea === 5) {
            // ¡BINGO COMPLETO! -> Rojo intenso
            btn.classList.add('bingo-ready');
        } else if (maxAciertosEnLinea === 4) {
            // A punto de ganar -> Dorado pulsante
            btn.classList.add('pulse-animation');
        }

        // Actualizar contador de faltantes
        const counter = document.getElementById(`counter-${carton.id.replace('#', '')}`);
        if (counter) {
            const faltan = 5 - maxAciertosEnLinea;
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

window.cerrarModal = function() {
    const modal = document.getElementById('custom-modal');
    modal.style.display = 'none';
    modal.querySelector('.modal-content').classList.remove('about-modal-pulse');
};

// 8. Efecto de Confeti
function lanzarConfeti() {
    const duration = 3000;
    const end = Date.now() + duration;

    (function frame() {
        // Lanzar confeti desde las esquinas inferiores con colores dorados y blancos
        confetti({ particleCount: 5, angle: 60, spread: 55, origin: { x: 0 }, colors: ['#d4af37', '#ffffff'], zIndex: 2000 });
        confetti({ particleCount: 5, angle: 120, spread: 55, origin: { x: 1 }, colors: ['#d4af37', '#ffffff'], zIndex: 2000 });

        if (Date.now() < end) {
            requestAnimationFrame(frame);
        }
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
            <input type="text" id="player-name" class="admin-input" style="width:100%" placeholder="Ej. Juan Pérez">
        </div>

        <div style="text-align:left; margin-bottom:15px;">
            <label style="display:block; color:white; margin-bottom:5px;">Banco Emisor:</label>
            <input type="text" id="player-bank" class="admin-input" style="width:100%" placeholder="Ej. Banco Venezuela">
        </div>

        <div style="text-align:left; margin-bottom:15px;">
            <label style="display:block; color:white; margin-bottom:5px;">Referencia Pago Móvil:</label>
            <input type="text" id="player-ref" class="admin-input" style="width:100%" placeholder="Ej. 123456">
        </div>
        
        <div style="text-align:left; margin-bottom:20px;">
            <label style="display:block; color:white; margin-bottom:5px;">Cantidad de Cartones:</label>
            <select id="card-quantity" class="admin-input" style="width:100%; background:rgba(0,0,0,0.5);">
                <option value="1">1 Cartón</option>
                <option value="2">2 Cartones</option>
                <option value="3">3 Cartones</option>
                <option value="4">4 Cartones</option>
            </select>
        </div>

        <button onclick="enviarSolicitud()" style="background:var(--gold-gradient); color:black;">ENVIAR SOLICITUD</button>
        <p id="solicitud-status" style="margin-top:10px; font-size:0.9em; color:var(--text-muted);"></p>
    `;
    
    modal.style.display = 'flex';
}

function enviarSolicitud() {
    const nombre = document.getElementById('player-name').value.trim();
    const banco = document.getElementById('player-bank').value.trim();
    const referencia = document.getElementById('player-ref').value.trim();
    const cantidad = parseInt(document.getElementById('card-quantity').value);
    const status = document.getElementById('solicitud-status');
    const btn = document.querySelector('#custom-modal button');

    if (!nombre || !banco || !referencia) {
        status.textContent = "Por favor, completa todos los campos (Nombre, Banco y Referencia).";
        status.style.color = "var(--danger)";
        return;
    }

    if (!/^\d+$/.test(referencia)) {
        status.textContent = "La referencia debe contener solo números.";
        status.style.color = "var(--danger)";
        return;
    }
    
    // Guardar nombre para el chat
    sessionStorage.setItem('player-name', nombre);

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

    mostrarModal("✅ SOLICITUD APROBADA", `El administrador te ha habilitado ${data.cantidad} cartones.`, "success");
    setTimeout(() => cerrarModal(), 2000);

    // Generar los cartones de forma secuencial para evitar errores de guardado
    let creados = 0;
    function crearSiguiente() {
        if (creados < data.cantidad) {
            agregarNuevoCarton(false, () => {
                creados++;
                crearSiguiente();
            });
        } else {
            renderizarCartones();
        }
    }
    crearSiguiente();
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
        const nombre = sessionStorage.getItem('player-name');
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

    let nombre = sessionStorage.getItem('player-name');

    if (!nombre) {
        nombre = prompt("Para participar en el chat, por favor escribe tu nombre:");
        if (nombre) {
            sessionStorage.setItem('player-name', nombre);
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
    const miNombre = sessionStorage.getItem('player-name') || 'Jugador';
    
    let clase = 'others';
    if (data.esAdmin) clase = 'admin';
    else if (data.usuario === miNombre) clase = 'mine';

    // Sonido de notificación si no soy yo
    if (clase !== 'mine') {
        const audio = new Audio('sounds/pop.mp3');
        audio.volume = 0.4; // Suave
        audio.play().catch(e => {});

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
    
    const time = data.timestamp ? new Date(data.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : '';
    div.innerHTML = `<strong>${data.usuario}:</strong> ${data.texto}<div class="chat-time">${time}</div>`;
    
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
            <img src="/icons/ajp.png" class="spin-animation" style="width: 80px; margin-bottom: 15px; filter: drop-shadow(0 0 10px rgba(212, 175, 55, 0.5));">
            <h2 class="shine-text" style="margin-bottom: 10px; text-transform: uppercase; font-size: 1.5rem;">Bingo Online</h2>
            <p style="color: white; margin-bottom: 5px; font-size: 1.1em;">Desarrollado por <strong>AJP-Logic</strong></p>
            
            <div style="background: rgba(255,255,255,0.05); padding: 15px; border-radius: 12px; margin: 20px 0; border: 1px solid rgba(255,255,255,0.1);">
                <p style="color: var(--text-muted); font-size: 0.9em; margin-bottom: 5px;">Versión 1.00</p>
                <p style="color: var(--text-muted); font-size: 0.9em;">Fecha de actualización: ${new Date().toLocaleDateString()}</p>
            </div>
            
            <div style="margin-top: 15px; font-size: 0.8em; opacity: 0.6; color: var(--text-muted); line-height: 1.4;">
                &copy; 2025 AJP-Logic<br>Todos los derechos reservados.
            </div>
            
            <button onclick="cerrarModal()" style="margin-top: 20px; background: var(--gold-gradient); color: black; width: auto; padding: 10px 30px;">CERRAR</button>
        </div>
    `;
    
    modal.style.display = 'flex';
}

// --- PWA INSTALLATION ---
let deferredPrompt;

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(err => console.log('Error SW:', err));
    });
}

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    const btn = document.getElementById('btn-install-pwa');
    if (btn) btn.style.display = 'flex';
});

window.instalarPWA = function() {
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