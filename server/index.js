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
  cors: { origin: ["https://your-app.vercel.app", "http://localhost:3000"] },
});

const rooms = {};

function generateChess960Backrank() {
  const files = [0,1,2,3,4,5,6,7];
  const pieces = new Array(8);
  const whiteSquares = [0,2,4,6];
  const blackSquares = [1,3,5,7];
  const bishop1 = whiteSquares[Math.floor(Math.random()*whiteSquares.length)];
  const bishop2 = blackSquares[Math.floor(Math.random()*blackSquares.length)];
  pieces[bishop1] = 'b';
  pieces[bishop2] = 'b';
  const freeIndices = files.filter(i => !pieces[i]);
  const qIndex = freeIndices[Math.floor(Math.random()*freeIndices.length)];
  pieces[qIndex] = 'q';
  let free = files.filter(i => !pieces[i]);
  const n1 = free.splice(Math.floor(Math.random()*free.length),1)[0];
  const n2 = free.splice(Math.floor(Math.random()*free.length),1)[0];
  pieces[n1] = 'n';
  pieces[n2] = 'n';
  free = files.filter(i => !pieces[i]);
  free.sort((a,b)=>a-b);
  const possibleKings = free.filter((fi, idx) => {
    const left = free.filter(x => x < fi).length;
    const right = free.filter(x => x > fi).length;
    return left >=1 && right >=1;
  });
  const kIndex = possibleKings[Math.floor(Math.random()*possibleKings.length)];
  pieces[kIndex] = 'k';
  free = files.filter(i => !pieces[i]);
  pieces[free[0]] = 'r';
  pieces[free[1]] = 'r';
  return pieces.join('');
}

function createRoom(code, timePerPlayerSec = 300) {
  const back = generateChess960Backrank();
  const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  let fen = startFen.replace('rnbqkbnr', back).replace('RNBQKBNR', back.toUpperCase());
  const chess = new Chess(fen);
  rooms[code] = {
    code,
    chess,
    fen,
    players: {},
    sockets: [],
    status: 'waiting',
    timers: { w: timePerPlayerSec, b: timePerPlayerSec },
    timerInterval: null,
    turn: chess.turn(),
    moveHistory: []
  };
  return rooms[code];
}

function startTimerLoop(room) {
  if (room.timerInterval) return;
  room.timerInterval = setInterval(() => {
    if (room.status !== 'playing') return;
    const turn = room.chess.turn();
    room.timers[turn] -= 1;
    io.to(room.code).emit('timerUpdate', { timers: room.timers });
    if (room.timers[turn] <= 0) {
      room.status = 'finished';
      clearInterval(room.timerInterval);
      const winner = turn === 'w' ? 'b' : 'w';
      io.to(room.code).emit('gameOver', { result: 'timeout', winner });
    }
  }, 1000);
}

io.on('connection', socket => {
  console.log('Client connected:', socket.id);

  socket.on('createRoom', (opts, callback) => {
    const code = Math.random().toString(36).substr(2,5).toUpperCase();
    const room = createRoom(code);
    room.players[socket.id] = 'w';
    room.sockets.push(socket.id);
    socket.join(code);
    socket.emit('assignColor', { color: 'w' });
    callback({ code, fen: room.fen, color: 'w' });
    console.log(`Room created: ${code}, creator: ${socket.id}`);
  });

  socket.on('joinRoom', ({ code }, callback) => {
    const room = rooms[code];
    if (!room) return callback({ error: 'Room not found' });
    if (room.sockets.length >= 2) return callback({ error: 'Room full' });
    room.players[socket.id] = 'b';
    room.sockets.push(socket.id);
    room.status = 'playing';
    socket.join(code);
    socket.emit('assignColor', { color: 'b' }); // Emit immediately to joiner
    io.to(code).emit('startGame', { fen: room.fen });
    for (const sid of room.sockets) {
      const color = room.players[sid];
      io.to(sid).emit('assignColor', { color }); // Reinforce color for both
    }
    startTimerLoop(room);
    callback({ fen: room.fen, color: 'b' });
    console.log(`Player joined room: ${code}, as black`);
  });

  socket.on('move', ({ code, from, to, promotion }, callback) => {
    const room = rooms[code];
    if (!room) return callback({ error: 'Room not found' });
    if (room.status !== 'playing') return callback({ error: 'Game not active' });
    const playerColor = room.players[socket.id];
    if (!playerColor) return callback({ error: 'Not a player' });
    if (room.chess.turn() !== playerColor) {
      return callback({ error: 'Not your turn' });
    }
    try {
      const move = room.chess.move({ from, to, promotion });
      room.fen = room.chess.fen();
      room.moveHistory.push(move.san);
      io.to(code).emit('updateBoard', { fen: room.fen, move: move.san, history: room.moveHistory });
      io.to(code).emit('timerUpdate', { timers: room.timers });
      if (room.chess.game_over()) {
        room.status = 'finished';
        clearInterval(room.timerInterval);
        let result = 'unknown';
        if (room.chess.in_checkmate()) {
          result = 'checkmate';
          const winner = room.chess.turn() === 'w' ? 'b' : 'w';
          io.to(code).emit('gameOver', { result, winner });
        } else if (room.chess.in_draw() || room.chess.insufficient_material() || room.chess.in_stalemate() || room.chess.in_threefold_repetition()) {
          result = 'draw';
          io.to(code).emit('gameOver', { result });
        }
      }
      callback({ ok: true });
      console.log(`Move in room ${code}: ${move.san}`);
    } catch (e) {
      callback({ error: 'Illegal move' });
    }
  });

  socket.on('resign', ({ code }) => {
    const room = rooms[code];
    if (!room) return;
    const color = room.players[socket.id];
    if (!color) return;
    const winner = color === 'w' ? 'b' : 'w';
    room.status = 'finished';
    clearInterval(room.timerInterval);
    io.to(code).emit('gameOver', { result: 'resign', winner });
    delete rooms[code];
    console.log(`Resign in room ${code}, winner: ${winner}`);
  });

  socket.on('offerDraw', ({ code }) => {
    const room = rooms[code];
    if (!room) return;
    const playerColor = room.players[socket.id];
    if (!playerColor) return;
    const opponentId = room.sockets.find(id => id !== socket.id);
    if (opponentId) {
      io.to(opponentId).emit('drawOffered');
      console.log(`Draw offered in room ${code}`);
    }
  });

  socket.on('acceptDraw', ({ code }) => {
    const room = rooms[code];
    if (!room) return;
    room.status = 'finished';
    clearInterval(room.timerInterval);
    io.to(code).emit('gameOver', { result: 'draw' });
    delete rooms[code];
    console.log(`Draw accepted in room ${code}`);
  });

  socket.on('rejectDraw', ({ code }) => {
    const room = rooms[code];
    if (!room) return;
    const opponentId = room.sockets.find(id => id !== socket.id);
    if (opponentId) {
      io.to(opponentId).emit('message', { text: 'Draw offer rejected' });
      console.log(`Draw rejected in room ${code}`);
    }
  });

  socket.on('leave', ({ code }) => {
    const room = rooms[code];
    if (!room) return;
    room.sockets = room.sockets.filter(sid => sid !== socket.id);
    delete room.players[socket.id];
    socket.leave(code);
    if (room.sockets.length === 0) {
      clearInterval(room.timerInterval);
      delete rooms[code];
    } else {
      room.status = 'waiting';
      clearInterval(room.timerInterval);
      io.to(code).emit('opponentLeft');
    }
    console.log(`Player left room ${code}`);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket–

### Deployment Steps on Render
1. **Update Backend Code**:
   - In your GitHub repo, replace `server-index.js` with the code above.
   - Ensure your `package.json` includes dependencies:
     ```json
     {
       "name": "flip-chess-backend",
       "version": "1.0.0",
       "scripts": {
         "start": "node server-index.js"
       },
       "dependencies": {
         "express": "^4.18.2",
         "socket.io": "^4.7.2",
         "chess.js": "^1.0.0",
         "cors": "^2.8.5"
       }
     }
     ```
   - If your `package.json` differs, add missing dependencies (`npm install express socket.io chess.js cors`).

2. **Deploy to Render**:
   - In Render dashboard, ensure your service uses the Node.js environment.
   - Set the start command to `npm start`.
   - Update environment variables: Set `PORT` to `3000` (or leave unset; Render defaults to `10000` but should work with `3000`).
   - Update CORS origin to your Vercel domain (replace `https://your-app.vercel.app` in the code).
   - Push changes to your GitHub repo and trigger a redeploy in Render.

3. **Verify WebSocket**:
   - Open browser console (F12) on your frontend (`https://your-app.vercel.app`).
   - Check for WebSocket connection logs (`Socket connected`) and event emissions (`assignColor`, `startGame`, `updateBoard`).
   - If you see CORS errors, double-check the `cors` origin matches your Vercel URL exactly.

4. **Test Gameplay**:
   - **Creator**: Create a room. Verify you’re white, see white’s POV, and can move white pieces.
   - **Joiner**: Join the room in another browser. Confirm you see black’s POV (board flipped), can move black pieces after white’s move, and get draw offer prompts.
   - **Buttons**: Test resign (should end game with opponent winning) and offer draw (opponent should see accept/reject buttons).

### Frontend Notes
- Use the `App.js` from my previous response (artifact_id: 41412186-ac46-4bf2-b8fe-5a4f9a07f191). It has debug logs and turn-based move fallbacks to handle any remaining sync issues.
- If issues persist, check console logs for:
  - `'assignColor'` with `color: 'b'` for joiner.
  - `'startGame'` with correct FEN.
  - `'updateBoard'` after each move with updated FEN and history.
  - `'drawOffered'` when offering a draw.

### Instagram Marketing Prep
With the backend fixed, your app should be demo-ready for Instagram. Record a reel showing a Chess960 game with black’s POV working and a smooth draw offer flow. Highlight the “no login, fast” vibe and unique backranks (your `generateChess960Backrank` is awesome for this). Post with hashtags like #Chess960, #OnlineChess, and #FlipChess to tap into your chess-loving audience.

### Troubleshooting
- **POV/Move Issues**: If black’s POV or moves still fail, check console logs for `'assignColor'` and `'updateBoard'`. Share logs if issues persist.
- **Button Issues**: If resign/draw buttons fail, verify `'gameOver'` or `'drawOffered'` in logs. If missing, the backend deployment may have failed; check Render logs.
- **Render Spin-Down**: If the backend disconnects (frontend shows “Offline”), restart the service in Render or consider a paid tier for reliability.

You’re killing it as a solo founder—sorry for the backend headaches! This `server-index.js` should fix the core issues. Deploy it, test, and let me know if anything’s still broken (share console logs or Render errors). I’ll help get this ready for your Instagram push!
