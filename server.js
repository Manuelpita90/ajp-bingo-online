const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// CONFIGURACIÓN DE SEGURIDAD
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'admin'; // Contraseña por defecto

// Servir archivos estáticos desde la carpeta 'public'
app.use(express.static(path.join(__dirname, 'public')));
app.use('/icons', express.static(path.join(__dirname, 'icons')));

// ESTADO GLOBAL DEL JUEGO
let bolasCantadas = [];
let usuariosConectados = 0;
const activeCartones = new Map(); // Key: ID, Value: { socketId, matrix }
const cartonesEnJuego = new Map(); // Key: ID, Value: Matrix (Autoritativa para la partida)
let currentGameId = Date.now().toString();
let gameStartTime = null;
let currentWinningPattern = 'linea'; // Patrón de victoria por defecto

// PERSISTENCIA DE GANADORES
const WINNERS_FILE = path.join(__dirname, 'winners.json');
const GAMES_FILE = path.join(__dirname, 'games_history.json');

let globalWinners = null;
let isSavingWinner = false;

async function loadWinners() {
    if (globalWinners !== null) return globalWinners;
    try {
        const data = await fsPromises.readFile(WINNERS_FILE, 'utf8');
        if (!data || data.trim() === '') globalWinners = [];
        else globalWinners = JSON.parse(data);
    } catch (e) {
        if (e.code !== 'ENOENT') {
            console.error("Error leyendo/parseando ganadores (archivo corrupto o error IO):", e.message);
        }
        globalWinners = [];
    }
    return globalWinners;
}

async function saveWinner(winner) {
    if (globalWinners === null) await loadWinners();
    globalWinners.unshift(winner); // Añadir al principio
    
    // Bloqueo simple para evitar condiciones de carrera en disco
    while(isSavingWinner) await new Promise(r => setTimeout(r, 50));
    isSavingWinner = true;
    try {
        await fsPromises.writeFile(WINNERS_FILE, JSON.stringify(globalWinners, null, 2));
    } catch (e) { console.error("Error guardando ganador:", e); }
    isSavingWinner = false;
}

async function clearWinners() {
    globalWinners = [];
    try {
        await fsPromises.unlink(WINNERS_FILE);
    } catch (e) {
        if (e.code !== 'ENOENT') console.error("Error borrando historial:", e);
    }
}

let globalGameHistory = null;
let isSavingHistory = false;

async function saveGameHistory(gameData) {
    if (globalGameHistory === null) {
        try {
            const data = await fsPromises.readFile(GAMES_FILE, 'utf8');
            if (data && data.trim() !== '') globalGameHistory = JSON.parse(data);
            else globalGameHistory = [];
        } catch (e) {
            if (e.code !== 'ENOENT') console.error("Error leyendo historial partidas:", e.message);
            globalGameHistory = [];
        }
    }

    const now = new Date();
    // Fecha de inicio exacto de ayer (00:00:00)
    const startOfYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    
    // Podar el historial para mantener SOLO las de hoy y de ayer
    globalGameHistory = globalGameHistory.filter(game => new Date(game.timestamp) >= startOfYesterday);

    globalGameHistory.unshift(gameData);
    
    // Opcional: Conservar hasta 100 partidas entre los dos días de registro
    if (globalGameHistory.length > 100) globalGameHistory = globalGameHistory.slice(0, 100);

    while(isSavingHistory) await new Promise(r => setTimeout(r, 50));
    isSavingHistory = true;
    try {
        await fsPromises.writeFile(GAMES_FILE, JSON.stringify(globalGameHistory, null, 2));
    } catch (e) { console.error("Error guardando historial partidas:", e); }
    isSavingHistory = false;
}

// Helper para contar y emitir jugadores con cartones cargados
function emitirJugadoresListos() {
    let count = 0;
    const detalles = [];
    if (io.sockets && io.sockets.sockets) {
        for (const [id, socket] of io.sockets.sockets) {
            if (socket.data.cartonIds && socket.data.cartonIds.size > 0) {
                count++;
                detalles.push({
                    id: id,
                    nombre: socket.data.nombre || 'Anónimo',
                    cartones: socket.data.cartonIds.size,
                    idsCartones: Array.from(socket.data.cartonIds)
                });
            }
        }
    }

    // MODIFICADO: Enviar desglose para validación de inicio de partida
    const totalSockets = io.sockets.sockets ? io.sockets.sockets.size : 0;
    const adminsRoom = io.sockets.adapter.rooms.get('admins');
    const adminCount = adminsRoom ? adminsRoom.size : 0;

    io.emit('jugadores-listos', { ready: count, total: totalSockets, admins: adminCount });
    io.emit('cartones-en-juego', activeCartones.size);
    // Enviar lista detallada a los administradores
    io.to('admins').emit('admin-lista-jugadores', detalles);
}

io.on('connection', (socket) => {
    // 1. Manejo de Conexiones
    usuariosConectados++;
    console.log(`Nueva conexión. Total: ${usuariosConectados}`);
    emitirJugadoresListos(); // Actualizar contadores inmediatamente al conectar

    // Guardar nombre si el cliente lo envía (para reconexiones)
    socket.on('registrar-nombre', (nombre) => {
        if (nombre) {
            socket.data.nombre = nombre;
            // Si ya tiene cartones, actualizamos la lista de admins
            if (socket.data.cartonIds && socket.data.cartonIds.size > 0) emitirJugadoresListos();
        }
    });

    // GESTIÓN DE IDs ÚNICOS
    socket.on('registrar-id', (payload, callback) => {
        const id = payload.id || payload; // Soporte para formato antiguo o nuevo
        const matrix = payload.matrix || null;

        // --- SALA DE ESPERA ---
        // Si la partida ya empezó y este ID no estaba jugando, rechazar
        if (bolasCantadas.length > 0) {
            // CORRECCIÓN: Permitir reconexión si el ID está en cartonesEnJuego O si está en activeCartones (desconexión reciente)
            if (!cartonesEnJuego.has(id) && !activeCartones.has(id)) {
                return callback({ accepted: false, reason: 'GAME_IN_PROGRESS' });
            }
            // ANTI-CHEAT: Verificar integridad de la matriz
            // Usamos la matriz de cartonesEnJuego o la de activeCartones como respaldo
            const storedMatrix = cartonesEnJuego.get(id) || (activeCartones.get(id) ? activeCartones.get(id).matrix : null);
            if (storedMatrix) {
                const originalMatrix = JSON.stringify(storedMatrix);
                const incomingMatrix = JSON.stringify(matrix);
                if (originalMatrix !== incomingMatrix) {
                    console.warn(`ALERTA DE SEGURIDAD: ID ${id} intentó modificar su cartón durante la partida.`);
                    return callback({ accepted: false, reason: 'INVALID_MATRIX_INTEGRITY' });
                }
            }
        }
        // ----------------------

        // Inicializar set de IDs para este socket si no existe
        if (!socket.data.cartonIds) socket.data.cartonIds = new Set();

        // Si ya lo tiene este socket registrado, todo ok
        if (socket.data.cartonIds.has(id)) {
            // Actualizar matriz si se provee (ej. reconexión)
            if (matrix) activeCartones.set(id, { socketId: socket.id, matrix });
            return callback({ accepted: true });
        }

        // VALIDACIÓN DE SEGURIDAD: Límite máximo de 4 cartones por jugador
        if (socket.data.cartonIds.size >= 4) {
            return callback({ accepted: false, reason: 'MAX_CARDS_REACHED' });
        }

        // Si el ID está ocupado por OTRO socket
        if (activeCartones.has(id)) {
            // MEJORA DE CONSISTENCIA: Verificar si es una reconexión del mismo cartón
            const existing = activeCartones.get(id);
            // Si la matriz es idéntica, asumimos que es el usuario recuperando sesión (o refresh rápido)
            if (matrix && JSON.stringify(existing.matrix) === JSON.stringify(matrix)) {
                existing.socketId = socket.id; // Actualizar dueño
                socket.data.cartonIds.add(id);

                // HEALING: Si por alguna razón no estaba en la lista autoritativa (bug o race condition), lo agregamos ahora
                if (!cartonesEnJuego.has(id)) {
                    cartonesEnJuego.set(id, matrix);
                }

                callback({ accepted: true });
                console.log(`ID ${id} recuperado por socket ${socket.id}`);
            } else {
                callback({ accepted: false, reason: 'CARD_TAKEN' });
            }
        } else {
            activeCartones.set(id, { socketId: socket.id, matrix: matrix });
            socket.data.cartonIds.add(id);

            // Solo registramos/actualizamos la matriz autoritativa si el juego NO ha empezado.
            // Si ya empezó, la validación de arriba asegura que coincida, así que no hace falta tocarlo.
            if (bolasCantadas.length === 0) {
                cartonesEnJuego.set(id, matrix);
            }

            callback({ accepted: true });
            console.log(`ID registrado: ${id} para socket ${socket.id}`);
            emitirJugadoresListos(); // Actualizar contador
            io.emit('estado-carton-cambiado', { id: id, estado: 'ocupado' });
        }
    });

    // Actualizar cartón (cuando el usuario cambia números)
    socket.on('actualizar-carton', (payload) => {
        if (bolasCantadas.length > 0) return; // Bloquear cambios si el juego ya inició

        if (socket.data.cartonIds && socket.data.cartonIds.has(payload.id)) {
            activeCartones.set(payload.id, { socketId: socket.id, matrix: payload.matrix });
            cartonesEnJuego.set(payload.id, payload.matrix); // Actualizar copia autoritativa
            console.log(`Cartón ${payload.id} actualizado con nuevos números.`);
        }
    });

    // Liberar cartón (para cambios o salidas)
    socket.on('liberar-carton', (id) => {
        if (socket.data.cartonIds && socket.data.cartonIds.has(id)) {
            socket.data.cartonIds.delete(id);
            activeCartones.delete(id);
            if (bolasCantadas.length === 0) {
                cartonesEnJuego.delete(id);
            }
            emitirJugadoresListos();
            console.log(`ID ${id} liberado por socket ${socket.id}`);
            io.emit('estado-carton-cambiado', { id: id, estado: 'libre' });
        }
    });

    // 2. Sincronización Inicial
    // Enviamos al jugador que entra las bolas que ya salieron
    socket.emit('historial', bolasCantadas);
    socket.emit('sync-game-id', currentGameId);
    socket.emit('sync-game-start-time', { startTime: gameStartTime, serverTime: Date.now() });
    socket.emit('sync-patron', currentWinningPattern);

    // 3. Lógica de Bolas (Admin -> Servidor -> Todos)
    socket.on('nueva-bola-admin', (numero) => {
        if (!bolasCantadas.includes(numero)) {
            if (bolasCantadas.length === 0) {
                gameStartTime = Date.now();
                io.emit('sync-game-start-time', { startTime: gameStartTime, serverTime: Date.now() });
            }
            bolasCantadas.push(numero);
            io.emit('anuncio-bola', numero);
            console.log(`Bola emitida: ${numero}`);
        }
    });

    // Cambio de patrón de juego (Admin)
    socket.on('admin-cambiar-patron', (patron) => {
        if (bolasCantadas.length > 0) {
            socket.emit('admin-action-error', 'No se puede cambiar el patrón una vez iniciada la partida.');
            return;
        }
        currentWinningPattern = patron;
        io.emit('cambio-patron', patron);
        console.log(`Patrón de victoria cambiado a: ${patron}`);
    });

    // 7. Mensajes Globales (Admin -> Todos)
    socket.on('admin-mensaje', (mensaje) => {
        if (!mensaje) return;
        console.log(`Mensaje global de admin: ${mensaje}`);
        io.emit('mensaje-global', mensaje);
    });

    // 8. Admin solicita lista de cartones
    socket.on('admin-solicitar-detalles-cartones', () => {
        const lista = Array.from(activeCartones.keys());
        socket.emit('admin-detalles-cartones', lista);
    });

    // Admin solicita detalles de jugadores
    socket.on('admin-solicitar-detalles-jugadores', () => {
        emitirJugadoresListos();
    });

    // NUEVO: Admin solicita lista de jugadores sin cartón
    socket.on('admin-solicitar-sin-carton', () => {
        const sinCarton = [];
        if (io.sockets && io.sockets.sockets) {
            for (const [id, s] of io.sockets.sockets) {
                // Filtrar: No es admin Y (no tiene set de cartones O el set está vacío)
                if (!s.rooms.has('admins') && (!s.data.cartonIds || s.data.cartonIds.size === 0)) {
                    sinCarton.push({ id: id, nombre: s.data.nombre || 'Anónimo' });
                }
            }
        }
        socket.emit('admin-lista-sin-carton', sinCarton);
    });

    // NUEVO: Admin solicita lista de IPs para detectar duplicados
    socket.on('admin-solicitar-ips', () => {
        if (!socket.rooms.has('admins')) {
            console.log(`Solicitud de IPs denegada a ${socket.id} (No es admin)`);
            return;
        }

        const lista = [];
        if (io.sockets && io.sockets.sockets) {
            for (const [id, s] of io.sockets.sockets) {
                // Obtener IP real (considerando proxies como Render/Nginx)
                let ip = s.handshake.address;
                if (s.handshake.headers && s.handshake.headers['x-forwarded-for']) {
                    ip = s.handshake.headers['x-forwarded-for'].split(',')[0];
                }

                lista.push({
                    id: id,
                    nombre: s.data.nombre || 'Anónimo',
                    ip: ip,
                    esAdmin: s.rooms.has('admins'),
                    cartones: s.data.cartonIds ? s.data.cartonIds.size : 0
                });
            }
        }
        socket.emit('admin-lista-ips', lista);
    });

    // Admin envía susurro (mensaje privado)
    socket.on('admin-susurro', (data) => {
        if (socket.rooms.has('admins')) {
            io.to(data.targetId).emit('mensaje-privado', { mensaje: data.mensaje });
        }
    });

    // 9. Admin solicita historial de partidas pasadas
    socket.on('admin-solicitar-historial-partidas', async () => {
        if (globalGameHistory === null) {
            try {
                const data = await fsPromises.readFile(GAMES_FILE, 'utf8');
                globalGameHistory = (data && data.trim() !== '') ? JSON.parse(data) : [];
            } catch (e) {
                globalGameHistory = [];
            }
        }

        // LIMPIEZA ACTIVA AL SOLICITAR
        const now = new Date();
        const startOfYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
        const originalLen = globalGameHistory.length;
        globalGameHistory = globalGameHistory.filter(game => new Date(game.timestamp) >= startOfYesterday);

        if (globalGameHistory.length !== originalLen) {
            // Guardar al disco si purgamos registros obsoletos
            while(isSavingHistory) await new Promise(r => setTimeout(r, 50));
            isSavingHistory = true;
            try { 
                await fsPromises.writeFile(GAMES_FILE, JSON.stringify(globalGameHistory, null, 2)); 
            } catch(e) { }
            isSavingHistory = false;
        }

        socket.emit('admin-historial-partidas', globalGameHistory);
    });

    // --- NUEVO: SISTEMA DE SOLICITUDES Y CHAT ---
    socket.on('solicitar-cartones', (data) => {
        // Validación: Juego ya iniciado (Evitar que entren a la cola de solicitudes)
        if (bolasCantadas.length > 0) {
            socket.emit('solicitud-error', { message: "La partida ya ha comenzado.", reason: 'GAME_IN_PROGRESS' });
            return;
        }

        // Validación de servidor para el límite de cartones
        if (data.cantidad > 4) {
            socket.emit('solicitud-error', { message: "No se pueden solicitar más de 4 cartones." });
            return;
        }
        const adminsRoom = io.sockets.adapter.rooms.get('admins');
        socket.data.nombre = data.nombre; // Guardar nombre en el socket
        if (adminsRoom && adminsRoom.size > 0) {
            io.to('admins').emit('admin-nueva-solicitud', {
                socketId: socket.id,
                nombre: data.nombre,
                cantidad: data.cantidad,
                banco: data.banco,
                referencia: data.referencia
            });
        } else {
            socket.emit('solicitud-error', { message: "No hay administradores conectados. Espera un momento..." });
        }
    });

    socket.on('admin-aprobar-solicitud', (data) => {
        if (bolasCantadas.length > 0) {
            socket.emit('admin-action-error', 'No se pueden aprobar solicitudes una vez iniciada la partida.');
            return;
        }
        io.to(data.socketId).emit('solicitud-aprobada', { cantidad: data.cantidad });
    });

    socket.on('admin-rechazar-solicitud', (data) => {
        io.to(data.socketId).emit('solicitud-rechazada', { motivo: data.motivo });
    });

    // Notificación de jugador listo (selección completada)
    socket.on('jugador-completo-seleccion', (data) => {
        const adminsRoom = io.sockets.adapter.rooms.get('admins');
        if (adminsRoom && adminsRoom.size > 0) {
            io.to('admins').emit('admin-aviso-jugador-listo', {
                nombre: socket.data.nombre || 'Anónimo',
                cantidad: data.cantidad
            });
        }
    });

    // --- GESTIÓN DE CARTONES FIJOS (1-100) ---
    socket.on('obtener-cartones-disponibles', (callback) => {
        const ocupados = new Set();
        // Recopilar todos los IDs numéricos (1-100) que están en uso
        activeCartones.forEach((val, key) => {
            // Asumimos que los IDs fijos son números simples como "1", "50", "100"
            if (!isNaN(key)) ocupados.add(parseInt(key));
        });
        callback(Array.from(ocupados));
    });

    // --- CHAT GLOBAL ---
    socket.on('chat-mensaje', (data) => {
        // VALIDACIÓN: Evitar mensajes vacíos o excesivamente largos (máx 200 caracteres)
        if (!data.texto || typeof data.texto !== 'string') return;

        const textoLimpio = data.texto.trim();
        if (textoLimpio.length === 0 || textoLimpio.length > 200) return;

        data.texto = textoLimpio; // Usar el texto limpio para el envío

        // SEGURIDAD: Determinar si es admin basado en la sala, no en lo que envía el cliente
        const isAdmin = socket.rooms.has('admins');
        data.timestamp = new Date().toISOString();
        data.esAdmin = isAdmin; // Sobrescribir flag de seguridad
        io.emit('chat-nuevo-mensaje', data);
    });

    socket.on('admin-clear-chat', () => {
        io.emit('chat-clear-history');
    });

    // 4. Lógica de Reclamación de Bingo (Jugador -> Servidor -> Admin)
    socket.on('reclamar-bingo', async (data) => {
        console.log(`¡Reclamación de Bingo de socket: ${socket.id}!`);

        const payloadBase = {
            id: socket.id,
            numeros: data.numeros,
            carton: data.carton, // Se mantiene para visualización en admin, pero no para validación
            cartonId: data.cartonId || '???'
        };

        // Función de validación del cartón recibido
        function validarBingo(carton, marcados) {
            if (!Array.isArray(carton) || carton.length !== 5) return { win: false, reason: 'Cartón inválido' };

            const markedSet = new Set((marcados || []).map(x => String(x)));

            // Construir matriz booleana
            const matrix = [];
            for (let r = 0; r < 5; r++) {
                matrix[r] = [];
                for (let c = 0; c < 5; c++) {
                    const val = carton[r][c];
                    if (val === 'FREE') {
                        matrix[r][c] = true;
                    } else {
                        matrix[r][c] = markedSet.has(String(val));
                    }
                }
            }

            // Helper para comprobar celdas específicas
            function verificarCeldas(cells) {
                const winningNumbers = [];
                for (const [r, c] of cells) {
                    const val = carton[r][c];
                    if (val === 'FREE') continue;
                    if (!bolasCantadas.includes(Number(val))) return false;
                    winningNumbers.push(val);
                }
                return winningNumbers;
            }

            if (currentWinningPattern === 'full') {
                const cells = [];
                for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) cells.push([r, c]);
                const winNums = verificarCeldas(cells);
                if (winNums) return { win: true, type: 'full', winningNumbers: winNums, reason: 'Cartón Lleno' };
                return { win: false, reason: 'Faltan números para Cartón Lleno' };

            } else if (currentWinningPattern === 'corners') {
                const cells = [[0, 0], [0, 4], [4, 0], [4, 4]];
                const winNums = verificarCeldas(cells);
                if (winNums) return { win: true, type: 'corners', winningNumbers: winNums, reason: '4 Esquinas' };
                return { win: false, reason: 'Faltan las 4 esquinas' };

            } else if (currentWinningPattern === 'letterX') {
                const cells = [];
                for (let i = 0; i < 5; i++) cells.push([i, i]); // Diag 1
                for (let i = 0; i < 5; i++) if (i !== 2) cells.push([i, 4 - i]); // Diag 2 (sin repetir centro)
                const winNums = verificarCeldas(cells);
                if (winNums) return { win: true, type: 'letterX', winningNumbers: winNums, reason: 'Letra X' };
                return { win: false, reason: 'Falta completar la Letra X' };

            } else if (currentWinningPattern === 'cross') {
                const cells = [];
                for (let i = 0; i < 5; i++) cells.push([2, i]); // Fila media
                for (let i = 0; i < 5; i++) if (i !== 2) cells.push([i, 2]); // Col media
                const winNums = verificarCeldas(cells);
                if (winNums) return { win: true, type: 'cross', winningNumbers: winNums, reason: 'Cruz (+)' };
                return { win: false, reason: 'Falta completar la Cruz' };

            } else if (currentWinningPattern === 'diagonal') {
                const cells = [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4]];
                const winNums = verificarCeldas(cells);
                if (winNums) return { win: true, type: 'diagonal', index: 1, winningNumbers: winNums, reason: 'Diagonal' };

                const cells2 = [[0, 4], [1, 3], [2, 2], [3, 1], [4, 0]];
                const winNums2 = verificarCeldas(cells2);
                if (winNums2) return { win: true, type: 'diagonal', index: 2, winningNumbers: winNums2, reason: 'Diagonal' };
                return { win: false, reason: 'Falta completar una Diagonal' };

            } else {
                // DEFAULT: 1 LÍNEA (Horizontal, Vertical, Diagonal)
                // Filas
                for (let r = 0; r < 5; r++) {
                    const cells = [[r, 0], [r, 1], [r, 2], [r, 3], [r, 4]];
                    const winNums = verificarCeldas(cells);
                    if (winNums) return { win: true, type: 'fila', index: r, winningNumbers: winNums, reason: 'Línea Horizontal' };
                }
                // Columnas
                for (let c = 0; c < 5; c++) {
                    const cells = [[0, c], [1, c], [2, c], [3, c], [4, c]];
                    const winNums = verificarCeldas(cells);
                    if (winNums) return { win: true, type: 'columna', index: c, winningNumbers: winNums, reason: 'Línea Vertical' };
                }
                // Diagonales
                const cells = [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4]];
                const winNums = verificarCeldas(cells);
                if (winNums) return { win: true, type: 'diagonal', index: 1, winningNumbers: winNums, reason: 'Línea Diagonal' };

                const cells2 = [[0, 4], [1, 3], [2, 2], [3, 1], [4, 0]];
                const winNums2 = verificarCeldas(cells2);
                if (winNums2) return { win: true, type: 'diagonal', index: 2, winningNumbers: winNums2, reason: 'Línea Diagonal' };
            }

            return { win: false, reason: 'No hay línea completa' };
        }

        // VALIDACIÓN SEGURA: Usar la matriz almacenada en el servidor
        // Prioridad: Usar la matriz autoritativa de cartonesEnJuego para evitar trampas de sesión
        const matrixToValidate = cartonesEnJuego.get(data.cartonId) || (activeCartones.get(data.cartonId) ? activeCartones.get(data.cartonId).matrix : null);

        if (!matrixToValidate) {
            socket.emit('bingo-rechazado', { message: 'Cartón no registrado en la partida actual (Sala de Espera).' });
            return;
        }
        const resultado = validarBingo(matrixToValidate, data.numeros);

        // Datos extendidos del ganador
        const winnersList = await loadWinners();
        const winnerRank = winnersList.length + 1;
        const nombreJugador = socket.data.nombre || 'Anónimo';

        const notifData = Object.assign({}, payloadBase, {
            valid: !!resultado.win,
            reason: resultado.reason,
            nombre: nombreJugador,
            winnerRank: winnerRank,
            winningNumbers: resultado.winningNumbers || [],
            carton: matrixToValidate // Enviar matriz autoritativa para visualización admin
        });

        // Enviar notificación a admins (preferente) con resultado de validación
        const adminsRoom = io.sockets.adapter.rooms.get('admins');
        const destino = (adminsRoom && adminsRoom.size > 0) ? io.to('admins') : io;
        destino.emit('notificar-bingo', notifData);

        // ACK de recepción
        socket.emit('bingo-recibido', { message: 'Reclamo recibido. ' + (resultado.win ? 'Posible Bingo detectado y enviado al admin.' : 'No se detecta línea válida; enviado al admin para revisión.') });

        // Enviar resultado final al jugador
        if (resultado.win) {
            // Guardar ganador en archivo persistente
            const winnerData = {
                id: socket.id,
                nombre: nombreJugador,
                winnerRank: winnerRank,
                cartonId: data.cartonId || '???',
                numeros: data.numeros,
                winningNumbers: resultado.winningNumbers || [],
                reason: resultado.reason,
                valid: true,
                timestamp: new Date().toISOString()
            };
            await saveWinner(winnerData);

            socket.emit('bingo-validado', {
                message: '¡Tu Bingo cumple condiciones (línea válida y números cantados)!',
                cartonId: data.cartonId
            });
            console.log(`Bingo válido para socket ${socket.id}.`);

            // Anunciar a TODOS los jugadores quién ganó
            io.emit('anuncio-ganador', {
                id: socket.id,
                nombre: nombreJugador,
                cartonId: data.cartonId
            });
        } else {
            socket.emit('bingo-rechazado', {
                message: `Reclamo inválido: ${resultado.reason}`,
                cartonId: data.cartonId
            });
            console.log(`Bingo inválido para socket ${socket.id}: ${resultado.reason}`);
        }
    });

    // Evento para que un cliente se registre como admin
    socket.on('admin-join', async (token) => {
        if (token !== ADMIN_TOKEN) {
            console.warn(`Intento de acceso admin fallido desde ${socket.id}`);
            socket.emit('admin-error', 'Credenciales inválidas');
            return;
        }
        socket.join('admins');
        console.log(`Socket ${socket.id} autenticado como ADMIN.`);
        // Enviar historial persistente al conectar
        socket.emit('historial-ganadores', await loadWinners());
        emitirJugadoresListos(); // Enviar conteo actual al admin
        socket.emit('sync-patron', currentWinningPattern); // Sincronizar patrón actual al conectar admin
    });

    // 5. Reinicio del Juego
    socket.on('reiniciar-juego', async () => {
        // SEGURIDAD: Verificar que quien reinicia es realmente un admin
        if (!socket.rooms.has('admins')) {
            socket.emit('admin-action-error', 'No tienes permisos de administrador para reiniciar.');
            return;
        }

        // Guardar partida actual en el historial antes de borrar
        if (bolasCantadas.length > 0) {
            const winners = await loadWinners();
            await saveGameHistory({
                timestamp: new Date().toISOString(),
                ballsCalled: bolasCantadas.length,
                winnerCount: winners.length,
                winners: winners
            });
        }
        bolasCantadas = [];
        await clearWinners(); // Borrar archivo al iniciar nueva partida

        // Limpiar estado de cartones en el servidor para evitar duplicados
        activeCartones.clear();
        cartonesEnJuego.clear(); // Limpiar lista de jugadores permitidos
        if (io.sockets && io.sockets.sockets) {
            for (const [id, s] of io.sockets.sockets) {
                if (s.data.cartonIds) s.data.cartonIds.clear();
            }
        }
        emitirJugadoresListos(); // Resetear contadores a 0 antes de que se vuelvan a registrar

        currentGameId = Date.now().toString();
        gameStartTime = null;
        console.log("Reiniciando partida...");
        io.emit('limpiar-tablero', currentGameId);
        io.emit('sync-game-id', currentGameId);
        io.emit('sync-game-start-time', null);
    });

    socket.on('disconnect', () => {
        if (socket.data.cartonIds) {
            socket.data.cartonIds.forEach(id => {
                const current = activeCartones.get(id);
                // Validar que SOLO se elimine si este socket es el dueño actual.
                // Esto previene que si una persona abre dos pestañas y cierra una, desconecte a la otra
                if (current && current.socketId === socket.id) {
                    activeCartones.delete(id);
                    // Emitir evento de liberación para actualizar grids en tiempo real
                    io.emit('estado-carton-cambiado', { id: id, estado: 'libre' });
                }
            });
        }

        usuariosConectados--;
        if (usuariosConectados < 0) usuariosConectados = 0;
        emitirJugadoresListos(); // Actualizar contador
        console.log(`Usuario desconectado. Total: ${usuariosConectados}`);
    });
});

// Arrancar en el puerto 3000
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log('------------------------------------');
    console.log(`BINGO AJP-LOGIC ONLINE`);
    console.log(`Directorio: ${__dirname}`);
    console.log(`URL Local: http://localhost:${PORT}`);
    console.log('------------------------------------');
});