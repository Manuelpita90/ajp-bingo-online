const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Servir archivos estáticos desde la carpeta 'public'
app.use(express.static(path.join(__dirname, 'public')));
app.use('/icons', express.static(path.join(__dirname, 'icons')));

// ESTADO GLOBAL DEL JUEGO
let bolasCantadas = [];
let usuariosConectados = 0;
const activeCartones = new Map(); // Key: ID, Value: { socketId, matrix }
const cartonesEnJuego = new Map(); // Key: ID, Value: Matrix (Autoritativa para la partida)
let currentGameId = Date.now().toString();

// PERSISTENCIA DE GANADORES
const WINNERS_FILE = path.join(__dirname, 'winners.json');
const GAMES_FILE = path.join(__dirname, 'games_history.json');

function loadWinners() {
    try {
        if (fs.existsSync(WINNERS_FILE)) {
            return JSON.parse(fs.readFileSync(WINNERS_FILE, 'utf8'));
        }
    } catch (e) { console.error("Error leyendo ganadores:", e); }
    return [];
}

function saveWinner(winner) {
    const list = loadWinners();
    list.unshift(winner); // Añadir al principio
    try {
        fs.writeFileSync(WINNERS_FILE, JSON.stringify(list, null, 2));
    } catch (e) { console.error("Error guardando ganador:", e); }
}

function clearWinners() {
    try {
        if (fs.existsSync(WINNERS_FILE)) fs.unlinkSync(WINNERS_FILE);
    } catch (e) { console.error("Error borrando historial:", e); }
}

function saveGameHistory(gameData) {
    let history = [];
    try {
        if (fs.existsSync(GAMES_FILE)) {
            history = JSON.parse(fs.readFileSync(GAMES_FILE, 'utf8'));
        }
    } catch (e) { console.error("Error leyendo historial partidas:", e); }
    
    history.unshift(gameData);
    if (history.length > 20) history = history.slice(0, 20); // Guardar últimas 20
    
    try {
        fs.writeFileSync(GAMES_FILE, JSON.stringify(history, null, 2));
    } catch (e) { console.error("Error guardando historial partidas:", e); }
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
    io.emit('jugadores-listos', count);
    io.emit('cartones-en-juego', activeCartones.size);
    // Enviar lista detallada a los administradores
    io.to('admins').emit('admin-lista-jugadores', detalles);
}

io.on('connection', (socket) => {
    // 1. Manejo de Conexiones
    usuariosConectados++;
    console.log(`Nueva conexión. Total: ${usuariosConectados}`);

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
            if (!cartonesEnJuego.has(id)) {
                return callback({ accepted: false, reason: 'GAME_IN_PROGRESS' });
            }
            // ANTI-CHEAT: Verificar integridad de la matriz
            const originalMatrix = JSON.stringify(cartonesEnJuego.get(id));
            const incomingMatrix = JSON.stringify(matrix);
            if (originalMatrix !== incomingMatrix) {
                console.warn(`ALERTA DE SEGURIDAD: ID ${id} intentó modificar su cartón durante la partida.`);
                return callback({ accepted: false, reason: 'INVALID_MATRIX_INTEGRITY' });
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

        // Si el ID está ocupado por OTRO socket
        if (activeCartones.has(id)) {
            // MEJORA DE CONSISTENCIA: Verificar si es una reconexión del mismo cartón
            const existing = activeCartones.get(id);
            // Si la matriz es idéntica, asumimos que es el usuario recuperando sesión (o refresh rápido)
            if (matrix && JSON.stringify(existing.matrix) === JSON.stringify(matrix)) {
                existing.socketId = socket.id; // Actualizar dueño
                socket.data.cartonIds.add(id);
                callback({ accepted: true });
                console.log(`ID ${id} recuperado por socket ${socket.id}`);
            } else {
                callback({ accepted: false });
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

    // 2. Sincronización Inicial
    // Enviamos al jugador que entra las bolas que ya salieron
    socket.emit('historial', bolasCantadas);
    socket.emit('sync-game-id', currentGameId);

    // 3. Lógica de Bolas (Admin -> Servidor -> Todos)
    socket.on('nueva-bola-admin', (numero) => {
        if (!bolasCantadas.includes(numero)) {
            bolasCantadas.push(numero);
            io.emit('anuncio-bola', numero);
            console.log(`Bola emitida: ${numero}`);
        }
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

    // 9. Admin solicita historial de partidas pasadas
    socket.on('admin-solicitar-historial-partidas', () => {
        let history = [];
        try {
            if (fs.existsSync(GAMES_FILE)) {
                history = JSON.parse(fs.readFileSync(GAMES_FILE, 'utf8'));
            }
        } catch (e) {}
        socket.emit('admin-historial-partidas', history);
    });

    // --- NUEVO: SISTEMA DE SOLICITUDES Y CHAT ---
    socket.on('solicitar-cartones', (data) => {
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
        io.to(data.socketId).emit('solicitud-aprobada', { cantidad: data.cantidad });
    });

    socket.on('admin-rechazar-solicitud', (data) => {
        io.to(data.socketId).emit('solicitud-rechazada', { motivo: data.motivo });
    });

    // --- CHAT GLOBAL ---
    socket.on('chat-mensaje', (data) => {
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
    socket.on('reclamar-bingo', (data) => {
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

            // Helper para comprobar si todos los números de una línea fueron cantados
            function lineaTieneBolasCantadas(cells) {
                for (const [r, c] of cells) {
                    const val = carton[r][c];
                    if (val === 'FREE') continue;
                    if (!bolasCantadas.includes(Number(val))) return false;
                }
                return true;
            }

            // Revisar filas
            for (let r = 0; r < 5; r++) {
                const all = matrix[r].every(Boolean);
                if (all) {
                    const cells = [[r,0],[r,1],[r,2],[r,3],[r,4]];
                    if (!lineaTieneBolasCantadas(cells)) return { win: false, reason: 'Algunos números no han sido cantados' };
                    const winningNumbers = cells.map(([rr, cc]) => carton[rr][cc]).filter(v => v !== 'FREE');
                    return { win: true, type: 'fila', index: r, winningNumbers };
                }
            }

            // Revisar columnas
            for (let c = 0; c < 5; c++) {
                let all = true;
                for (let r = 0; r < 5; r++) if (!matrix[r][c]) { all = false; break; }
                if (all) {
                    const cells = [[0,c],[1,c],[2,c],[3,c],[4,c]];
                    if (!lineaTieneBolasCantadas(cells)) return { win: false, reason: 'Algunos números no han sido cantados' };
                    const winningNumbers = cells.map(([rr, cc]) => carton[rr][cc]).filter(v => v !== 'FREE');
                    return { win: true, type: 'columna', index: c, winningNumbers };
                }
            }

            // Revisar diagonales
            let diag1 = true;
            for (let i = 0; i < 5; i++) if (!matrix[i][i]) { diag1 = false; break; }
            if (diag1) {
                const cells = [[0,0],[1,1],[2,2],[3,3],[4,4]];
                if (!lineaTieneBolasCantadas(cells)) return { win: false, reason: 'Algunos números no han sido cantados' };
                const winningNumbers = cells.map(([rr, cc]) => carton[rr][cc]).filter(v => v !== 'FREE');
                return { win: true, type: 'diagonal', index: 1, winningNumbers };
            }

            let diag2 = true;
            for (let i = 0; i < 5; i++) if (!matrix[i][4 - i]) { diag2 = false; break; }
            if (diag2) {
                const cells = [[0,4],[1,3],[2,2],[3,1],[4,0]];
                if (!lineaTieneBolasCantadas(cells)) return { win: false, reason: 'Algunos números no han sido cantados' };
                const winningNumbers = cells.map(([rr, cc]) => carton[rr][cc]).filter(v => v !== 'FREE');
                return { win: true, type: 'diagonal', index: 2, winningNumbers };
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
        const winnersList = loadWinners();
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
            saveWinner(winnerData);

            socket.emit('bingo-validado', { message: '¡Tu Bingo cumple condiciones (línea válida y números cantados)!' });
            console.log(`Bingo válido para socket ${socket.id}.`);

            // Anunciar a TODOS los jugadores quién ganó
            io.emit('anuncio-ganador', {
                id: socket.id,
                nombre: nombreJugador,
                cartonId: data.cartonId
            });
        } else {
            socket.emit('bingo-rechazado', { message: `Reclamo inválido: ${resultado.reason}` });
            console.log(`Bingo inválido para socket ${socket.id}: ${resultado.reason}`);
        }
    });

    // Evento para que un cliente se registre como admin
    socket.on('admin-join', () => {
        socket.join('admins');
        console.log(`Socket ${socket.id} se ha unido a la sala 'admins'.`);
        // Enviar historial persistente al conectar
        socket.emit('historial-ganadores', loadWinners());
        emitirJugadoresListos(); // Enviar conteo actual al admin
    });

    // 5. Reinicio del Juego
    socket.on('reiniciar-juego', () => {
        // Guardar partida actual en el historial antes de borrar
        if (bolasCantadas.length > 0) {
            const winners = loadWinners();
            saveGameHistory({
                timestamp: new Date().toISOString(),
                ballsCalled: bolasCantadas.length,
                winnerCount: winners.length,
                winners: winners
            });
        }
        bolasCantadas = [];
        clearWinners(); // Borrar archivo al iniciar nueva partida
        
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
        console.log("Reiniciando partida...");
        io.emit('limpiar-tablero', currentGameId);
        io.emit('sync-game-id', currentGameId);
    });

    // 6. Desconexión
    socket.on('disconnect', () => {
        if (socket.data.cartonIds) {
            socket.data.cartonIds.forEach(id => activeCartones.delete(id));
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
    console.log(`URL Local: http://localhost:${PORT}`);
    console.log('------------------------------------');
});