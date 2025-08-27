// server/index.js
import express from "express";
import http from "http";
import { Server } from "socket.io";
import { Chess } from "chess.js";
import cors from "cors";

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
  },
});

// Store rooms
let rooms = {};

// Function to generate random backrank (like chess960)
function generateRandomBackrank() {
  let pieces = ["r", "n", "b", "q", "k", "b", "n", "r"];
  function shuffle(array) {
    return array.sort(() => Math.random() - 0.5);
  }
  let valid = false;
  let backrank;
  while (!valid) {
    backrank = shuffle([...pieces]);
    // Ensure bishops are on opposite colors
    const bishopSquares = backrank
      .map((p, i) => (p === "b" ? i : -1))
      .filter((i) => i !== -1);
    if (bishopSquares.length === 2 && bishopSquares[0] % 2 !== bishopSquares[1] % 2) {
      valid = true;
    }
  }
  return backrank.join("");
}

// Create new room
function createRoom(code) {
  let fen = new Chess().fen();
  let chess = new Chess();
  let backrank = generateRandomBackrank();

  // Replace white and black backrank
  fen = fen
    .replace("rnbqkbnr", backrank)
    .replace("RNBQKBNR", backrank.toUpperCase());

  rooms[code] = {
    players: [],
    chess: new Chess(fen),
    fen,
    timers: { w: 300, b: 300 }, // 5 minutes each
    turn: "w",
    interval: null,
  };
}

io.on("connection", (socket) => {
  socket.on("createRoom", (callback) => {
    const code = Math.random().toString(36).substr(2, 5).toUpperCase();
    createRoom(code);
    rooms[code].players.push(socket.id);
    socket.join(code);
    callback({ code, fen: rooms[code].fen });
  });

  socket.on("joinRoom", ({ code }, callback) => {
    if (!rooms[code]) return callback({ error: "Room not found" });
    if (rooms[code].players.length >= 2)
      return callback({ error: "Room full" });

    rooms[code].players.push(socket.id);
    socket.join(code);
    callback({ fen: rooms[code].fen });
    io.to(code).emit("startGame", { fen: rooms[code].fen });
  });

  socket.on("move", ({ code, from, to, promotion }) => {
    const game = rooms[code].chess;
    try {
      game.move({ from, to, promotion });
      rooms[code].fen = game.fen();
      io.to(code).emit("updateBoard", { fen: rooms[code].fen });
    } catch (e) {
      console.log("Invalid move");
    }
  });

  socket.on("resign", ({ code }) => {
    io.to(code).emit("gameOver", { result: "resign" });
  });

  socket.on("draw", ({ code }) => {
    io.to(code).emit("gameOver", { result: "draw" });
  });
});

server.listen(10000, () => {
  console.log("Server running on port 10000");
});
