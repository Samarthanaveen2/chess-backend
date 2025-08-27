import express from "express";
import http from "http";
import { Server } from "socket.io";
import { Chess } from "chess.js";
import cors from "cors";

const app = express();
app.use(cors());
app.get("/", (req, res) => res.send("Chess backend live"));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

// Rooms store
const rooms = {};

// Helper: generate valid Chess960-like backrank (bishops opposite colors, king between rooks)
function generateChess960Backrank() {
  const files = [0,1,2,3,4,5,6,7];
  const pieces = new Array(8);
  // place bishops on opposite colors
  const whiteSquares = [0,2,4,6];
  const blackSquares = [1,3,5,7];
  const bishop1 = whiteSquares[Math.floor(Math.random()*whiteSquares.length)];
  const bishop2 = blackSquares[Math.floor(Math.random()*blackSquares.length)];
  pieces[bishop1] = 'b';
  pieces[bishop2] = 'b';
  // place queen
  const freeIndices = files.filter(i => !pieces[i]);
  const qIndex = freeIndices[Math.floor(Math.random()*freeIndices.length)];
  pieces[qIndex] = 'q';
  // place knights
  let free = files.filter(i => !pieces[i]);
  const n1 = free.splice(Math.floor(Math.random()*free.length),1)[0];
  const n2 = free.splice(Math.floor(Math.random()*free.length),1)[0];
  pieces[n1] = 'n';
  pieces[n2] = 'n';
  // place rooks and king: ensure king between rooks
  free = files.filter(i => !pieces[i]);
  // sort free positions to find possible rook-king-rook placements
  free.sort((a,b)=>a-b);
  // choose king position not at ends such that there are at least one free index left on both sides
  let kIndex;
  const possibleKings = free.filter((fi, idx) => {
    const left = free.filter(x => x < fi).length;
    const right = free.filter(x => x > fi).length;
    return left >=1 && right >=1;
  });
  kIndex = possibleKings[Math.floor(Math.random()*possibleKings.length)];
  pieces[kIndex] = 'k';
  free = files.filter(i => !pieces[i]);
  // remaining two are rooks
  pieces[free[0]] = 'r';
  pieces[free[1]] = 'r';
  return pieces.join('');
}

// Create room object
function createRoom(code, timePerPlayerSec = 300) {
  const back = generateChess960Backrank();
  // build FEN from default starting FEN but with new backranks
  const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  let fen = startFen.replace('rnbqkbnr', back).replace('RNBQKBNR', back.toUpperCase());
  const chess = new Chess(fen);
  rooms[code] = {
    code,
    chess,
    fen,
    players: {}, // socketId -> color
    sockets: [], // [socketId]
    status: 'waiting',
    timers: { w: timePerPlayerSec, b: timePerPlayerSec }, // seconds
    timerInterval: null,
    turn: chess.turn(), // 'w' or 'b'
    moveHistory: []
  };
  return rooms[code];
}

// Start per-room timer loop
function startTimerLoop(room) {
  if (room.timerInterval) return;
  room.timerInterval = setInterval(() => {
    if (room.status !== 'playing') return;
    const turn = room.chess.turn(); // 'w' or 'b'
    room.timers[turn] -= 1;
    io.to(room.code).emit('timerUpdate', { timers: room.timers });
    if (room.timers[turn] <= 0) {
      // time out -> other player wins
      room.status = 'finished';
      clearInterval(room.timerInterval);
      const winner = turn === 'w' ? 'b' : 'w';
      io.to(room.code).emit('gameOver', { result: 'timeout', winner });
    }
  }, 1000);
}

io.on('connection', socket => {
  // create room
  socket.on('createRoom', (opts, callback) => {
    const code = Math.random().toString(36).substr(2,5).toUpperCase();
    const room = createRoom(code);
    // first player is white
    room.players[socket.id] = 'w';
    room.sockets.push(socket.id);
    socket.join(code);
    callback && callback({ code, fen: room.fen, color: 'w' });
  });

  // join room
  socket.on('joinRoom', ({ code }, callback) => {
    const room = rooms[code];
    if (!room) return callback && callback({ error: 'Room not found' });
    if (room.sockets.length >= 2) return callback && callback({ error: 'Room full' });
    // second player is black
    room.players[socket.id] = 'b';
    room.sockets.push(socket.id);
    room.status = 'playing';
    socket.join(code);
    // emit start game to both, include each player's color and FEN
    io.to(code).emit('startGame', { fen: room.fen });
    // tell each socket its color
    for (const sid of room.sockets) {
      const color = room.players[sid];
      io.to(sid).emit('assignColor', { color });
    }
    // start timers
    startTimerLoop(room);
    callback && callback({ fen: room.fen });
  });

  // move handling: server validates and enforces turn
  socket.on('move', ({ code, from, to, promotion }, callback) => {
    const room = rooms[code];
    if (!room) return;
    if (room.status !== 'playing') return;
    const playerColor = room.players[socket.id];
    if (!playerColor) return;
    // Only allow move if it's this player's turn
    if (room.chess.turn() !== playerColor) {
      callback && callback({ error: 'Not your turn' });
      return;
    }
    // attempt move
    const move = room.chess.move({ from, to, promotion });
    if (!move) {
      callback && callback({ error: 'Illegal move' });
      return;
    }
    // valid move -> update fen & history & broadcast
    room.fen = room.chess.fen();
    room.moveHistory.push(move.san);
    io.to(code).emit('updateBoard', { fen: room.fen, move: move.san, history: room.moveHistory });
    // check game over
    if (room.chess.game_over()) {
      room.status = 'finished';
      clearInterval(room.timerInterval);
      let result = 'unknown';
      if (room.chess.in_checkmate()) {
        result = 'checkmate';
      } else if (room.chess.in_draw() || room.chess.insufficient_material() || room.chess.in_stalemate() || room.chess.in_threefold_repetition()) {
        result = 'draw';
      }
      io.to(code).emit('gameOver', { result, fen: room.fen });
    }
    callback && callback({ ok: true });
  });

  socket.on('resign', ({ code }) => {
    const room = rooms[code];
    if (!room) return;
    const color = room.players[socket.id];
    const winner = color === 'w' ? 'b' : 'w';
    room.status = 'finished';
    clearInterval(room.timerInterval);
    io.to(code).emit('gameOver', { result: 'resign', winner });
  });

  socket.on('offerDraw', ({ code }) => {
    // naive: immediately accept -> broadcast draw
    const room = rooms[code];
    if (!room) return;
    room.status = 'finished';
    clearInterval(room.timerInterval);
    io.to(code).emit('gameOver', { result: 'draw' });
  });

  socket.on('leave', ({ code }) => {
    const room = rooms[code];
    if (!room) return;
    // remove socket
    room.sockets = room.sockets.filter(sid => sid !== socket.id);
    delete room.players[socket.id];
    socket.leave(code);
    // if room empty -> delete
    if (room.sockets.length === 0) {
      clearInterval(room.timerInterval);
      delete rooms[code];
    } else {
      // still someone remains -> mark waiting
      room.status = 'waiting';
      clearInterval(room.timerInterval);
      io.to(code).emit('opponentLeft');
    }
  });

  socket.on('disconnect', () => {
    // clean up any rooms where this socket existed
    for (const code in rooms) {
      const room = rooms[code];
      if (room.players[socket.id]) {
        room.sockets = room.sockets.filter(sid => sid !== socket.id);
        delete room.players[socket.id];
        if (room.sockets.length === 0) {
          clearInterval(room.timerInterval);
          delete rooms[code];
        } else {
          room.status = 'waiting';
          clearInterval(room.timerInterval);
          io.to(code).emit('opponentLeft');
        }
      }
    }
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
