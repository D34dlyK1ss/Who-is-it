import dotenv from "dotenv";
import https from "https";
import fs from "fs";
import express from "express";
import { WebSocketServer } from "ws";
import mysql from "mysql2";
import badWords from "./badWords.js";
dotenv.config();

const app = express();
const clientPort = parseInt(process.env.CLIENT_PORT);
app.use(express.static("public"));
app.get("/", (req, res) => res.sendFile("index.html"));
app.listen(clientPort);

const key = fs.readFileSync("key.pem");
const cert = fs.readFileSync("cert.pem");
const options = { key: key, cert: cert };
const server = https.createServer(options, app);
server.on("error", (err) => console.error(err));
server.listen(parseInt(process.env.SERVER_PORT));

const wss = new WebSocketServer({ server: server });
const db = mysql.createConnection({
	host: "localhost",
	user: "who_is_it_game",
	database: "who_is_it"
});
const activeConnections = new Map();	// key: connection ID, value: ws
const usersInGame = new Map();			// key: user ID, value: game ID
const lobbies = {};

wss.on("connection", ws => {
	const id = newId(32);

	ws.connectionData = { "id": id };
	activeConnections.set(id, ws);

	let payload = {
		"method": "connect",
		"connectionData": ws.connectionData
	};

	ws.send(JSON.stringify(payload));

	ws.on("close", () => {
		const username = ws.connectionData.username;
		const connectionId = ws.connectionData.id;

		activeConnections.delete(connectionId);

		if (username) {
			if (lobbies[username]) removePlayerFromGame(lobbies[username], username);

			logoutToConsole(username);
		}
	});

	ws.on("message", (message) => {
		const result = JSON.parse(message);
		const method = result.method;		// method is a property send by the client

		// Client wants to login
		if (method === "login") {
			if (result.type === "auto") return doLogin(ws, result.username, result.id);

			loginQuery(ws, result.username, result.password);
			return;
		}

		// Client wants to logout
		if (method === "logout") {
			const username = result.username;

			payload = {
				"method": "loggedOut"
			};

			ws.send(JSON.stringify(payload));

			logoutToConsole(username);
			return;
		}

		// Client wants to register
		if (method === "register") {
			const username = result.username;
			const email = result.email;
			const password = result.password;

			db.query(
				`SELECT id FROM user WHERE (username = '${username}' OR email = '${email}')`,
				(err, res) => {
					if (err) return console.error(err);
					if (res.length > 0) {
						payload = {
							"method": "error",
							"type": "register",
							"message": "Failed to register. Username or email are already in use."
						};

						return ws.send(JSON.stringify(payload));
					}

					db.query(
						`INSERT INTO user (username, email, password) VALUES ('${username}', '${email}', SHA2('${password}', 256))`,
						(err) => {
							if (err) return console.error(err);

							loginQuery(ws, username, password);
						}
					);
					return;
				}
			);
		}

		if (method === "getCategoryList") {
			db.query(
				"SELECT id, user_id, name, items, type FROM category",
				(err, res) => {
					if (err) return console.error(err);

					const categoryList = [];

					for (const category of res) {
						categoryList.push(category);
					}

					payload = {
						"method": "getCategoryList",
						"categoryList": categoryList
					};

					ws.send(JSON.stringify(payload));
					return;
				}
			);
		}

		// Client wants to create a game
		if (method === "newGame") {
			if (usersInGame.has(result.username)) {
				payload = {
					"method": "error",
					"type": "joinGame",
					"message": "Failed to create a new game. You're already playing a game."
				};

				ws.send(JSON.stringify(payload));
				return;
			}

			let newGameId = 0;

			do newGameId = newId(8);
			while (lobbies[newGameId]);

			lobbies[newGameId] = {
				"id": newGameId,
				"status": "waiting",
				"categoryId": result.categoryId,
				"categoryName": result.categoryName,
				"items": result.items,
				"players": []
			};

			payload = {
				"method": "newGame",
				"gameId": newGameId
			};

			ws.send(JSON.stringify(payload));
			return;
		}

		// Client wants to join a game
		if (method === "joinGame") {
			const gameId = result.gameId;
			const username = result.username;

			if (usersInGame.has(result.username)) {
				payload = {
					"method": "error",
					"type": "joinGame",
					"message": "Failed to join a game. You're already playing a game."
				};

				ws.send(JSON.stringify(payload));
				return;
			}

			if (!lobbies[gameId]) {
				payload = {
					"method": "error",
					"type": "joinGame",
					"message": "Failed to join a game. The game doesn't exist."
				};

				ws.send(JSON.stringify(payload));
				return;
			}

			if (lobbies[gameId].players.length >= 2) {
				payload = {
					"method": "error",
					"type": "joinGame",
					"message": "Failed to join game. The game reached max players."
				};

				ws.send(JSON.stringify(payload));
				return;
			}

			lobbies[gameId].players.push({
				"id": ws.connectionData.userId,
				"username": username,
				"connectionId": result.connectionId
			});

			usersInGame.set(username, lobbies[gameId].id);

			lobbies[gameId].players.forEach(player => {
				if (player.username === username) {
					payload = {
						"method": "joinGame",
						"game": lobbies[gameId]
					};
					ws.send(JSON.stringify(payload));
				}
				else {
					payload = {
						"method": "updatePlayers",
						"players": lobbies[gameId].players
					};

					activeConnections.get(player.connectionId).send(JSON.stringify(payload));

					payload = {
						"method": "updateChat",
						"type": "system",
						"text": `<b>${username}</b> joined`
					};

					activeConnections.get(player.connectionId).send(JSON.stringify(payload));
				}
			});
			return;
		}

		if (method === "startGame") {
			const gameId = result.gameId;
			const items = lobbies[gameId].items;

			lobbies[gameId].status = "playing";
			lobbies[gameId].answers = {};
			lobbies[gameId].triesLeft = {};

			let itemsToGuess = [];
			let i = 0;

			do {
				itemsToGuess[0] = Math.floor(Math.random() * items.length);
				itemsToGuess[1] = Math.floor(Math.random() * items.length);
			}
			while (itemsToGuess[0] === itemsToGuess[1]);

			lobbies[gameId].players.forEach(player => {
				const itemToGuess = lobbies[gameId].items[itemsToGuess[i]].name;
				const tries = 2;

				lobbies[gameId].answers[player.username] = itemToGuess;
				lobbies[gameId].triesLeft[player.username] = tries;

				payload = {
					"method": "updateGame",
					"game": lobbies[gameId]
				};

				activeConnections.get(player.connectionId).send(JSON.stringify(payload));
				i++;
			});
		}

		if (method === "leaveGame") {
			removePlayerFromGame(result.gameId, result.username);
			return;
		}

		if (method === "sendChatMessage") {
			const gameId = result.gameId;

			payload = {
				"method": "updateChat",
				"type": "user",
				"username": result.username,
				"text": cleanMessage(result.text)
			};

			lobbies[gameId].players.forEach(player => {
				activeConnections.get(player.connectionId).send(JSON.stringify(payload));
			});

			return;
		}

		if (method === "guess") {
			const gameId = result.gameId;
			const guesserUsername = result.username;
			let rightAnswer = null;

			Object.keys(lobbies[gameId].answers).forEach(player => {
				if (player !== guesserUsername) rightAnswer = lobbies[gameId].answers[player];
			});

			lobbies[gameId].triesLeft[guesserUsername]--;

			payload = {
				"method": "updateTries",
				"nTries": lobbies[gameId].triesLeft[guesserUsername]
			};

			ws.send(JSON.stringify(payload));

			if (result.guess.toLowerCase() === rightAnswer.toLowerCase()) {
				let payload = {
					"method": "gameWon"
				};

				ws.send(JSON.stringify(payload));

				payload = {
					"method": "gameLost"
				};

				lobbies[gameId].players.forEach(player => {
					if (player.username === guesserUsername) {
						lobbies[gameId].winner = guesserUsername;
					}
					else {
						activeConnections.get(player.connectionId).send(JSON.stringify(payload));
					}
				});

				return saveResultsToDatabase(lobbies[gameId]);
			}
			else if (lobbies[gameId].triesLeft[guesserUsername] <= 0) {
				let payload = {
					"method": "gameLost",
					"winner": lobbies[gameId].players.filter((playerId => playerId !== guesserUsername))
				};

				ws.send(JSON.stringify(payload));

				payload = {
					"method": "gameWon"
				};

				lobbies[gameId].players.forEach(player => {
					if (player.username !== guesserUsername) activeConnections.get(player.connectionId).send(JSON.stringify(payload));
				});

				return saveResultsToDatabase(lobbies[gameId]);
			}

			return ws.send(JSON.stringify(payload));
		}
	});
});

function newId(_length) {
	const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	let result = "";
	let i = 0;

	while (i < _length) {
		result += characters.charAt(Math.floor(Math.random() * characters.length));
		i++;
	}

	return result;
}

function loginQuery(_ws, _username, _password) {
	let payload = {};

	db.query(
		`SELECT id, username, email FROM user WHERE (username = '${_username}' OR email = '${_username}') AND password = SHA2('${_password}', 256)`,
		(err, res) => {
			if (err) return console.error(err);
			if (res.length === 0) {
				payload = {
					"method": "error",
					"type": "login",
					"message": "Failed to log in. Username/email or password incorrect."
				};

				return _ws.send(JSON.stringify(payload));
			}

			doLogin(_ws, res[0].username, res[0].id);
		}
	);
}

function doLogin(_ws, _username, _id) {
	loginToConsole(_username);

	let payload = {
		"method": "loggedIn",
		"userId": _id,
		"username": _username
	};

	_ws.connectionData.username = _username;
	_ws.connectionData.userId = _id;
	_ws.send(JSON.stringify(payload));

	return activeConnections.set(_ws.connectionData.id, _ws);
}

function removePlayerFromGame(_gameId, _leavingPlayer) {
	const game = lobbies[_gameId];

	if (game.players.length === 0) {
		delete lobbies[_gameId];
		return;
	}
	
	let i = 0;

	for (const player of game.players) {
		if (player.username === _leavingPlayer) {
			game.players.splice(i, 1);
			usersInGame.delete(_leavingPlayer);
			break;
		}
		if (player.username !== _leavingPlayer && lobbies[_gameId].status === "playing") {
			lobbies[_leavingPlayer].winner = player.username;

			payload = {
				"method": "gameWon"
			};

			activeConnections.get(player.connectionId).send(JSON.stringify(payload));

			saveResultsToDatabase(lobbies[_leavingPlayer]);
		}

		i++;
	}

	let payload = {};

	for (const player of game.players) {
		payload = {
			"method": "updatePlayers",
			"players": game.players
		};

		activeConnections.get(player.connectionId).send(JSON.stringify(payload));

		payload = {
			"method": "updateChat",
			"type": "system",
			"text": `<b>${_leavingPlayer}</b> left`
		};

		activeConnections.get(player.connectionId).send(JSON.stringify(payload));
	}
}

function saveResultsToDatabase(_game) {
	const categoryId = _game.categoryId;
	const player1 = _game.players[0];
	const player2 = _game.players[1];
	const playerId1 = player1.id;
	const playerId2 = player2.id;
	const playerUsername1 = player1.username;
	const playerUsername2 = player2.username;
	const playerTries1 = 2 - _game.triesLeft[playerUsername1];
	const playerTries2 = 2 - _game.triesLeft[playerUsername2];
	const winner = _game.winner;

	db.query(
		`INSERT INTO game_match (category_id, player1_id,  player2_id, player1_tries,  player2_tries, duration, winner) VALUES (${categoryId}, ${playerId1}, ${playerId2}, ${playerTries1}, ${playerTries2}, 0, ${winner.id})`,
		(err) => {
			if (err) return console.error(err);
		}
	);
}

function cleanMessage(_message) {
	let sanitizedMessage = _message;

	for (const word of badWords) {
		sanitizedMessage = sanitizedMessage.replace(/0|º/g, "o");
		sanitizedMessage = sanitizedMessage.replace(/1|!/g, "i");
		sanitizedMessage = sanitizedMessage.replace(/3|£|€|&/g, "e");
		sanitizedMessage = sanitizedMessage.replace(/4|@|ª/g, "a");
		sanitizedMessage = sanitizedMessage.replace(/5|\$|§/g, "s");
		sanitizedMessage = sanitizedMessage.replace(/6|9/g, "g");
		sanitizedMessage = sanitizedMessage.replace(/7|\+/g, "t");
		sanitizedMessage = sanitizedMessage.replace(/8/g, "ate");

		for (let i = 0; i <= sanitizedMessage.length - word.length; i++) {
			const batch = sanitizedMessage.substr(i, word.length);

			if (batch.toLowerCase() === word) _message = _message.slice(0, i) + "*".repeat(word.length) + _message.slice(i + word.length);
		}
	}

	return _message;
}

function dateTimeString() {
	const date = new Date();
	const HH = date.getHours().toString().padStart(2, "0");
	const mm = date.getMinutes().toString().padStart(2, "0");
	const ss = date.getSeconds().toString().padStart(2, "0");
	const sss = date.getMilliseconds().toString().padStart(3, "0");
	const DD = date.getDate().toString().padStart(2, "0");
	const MM = (date.getMonth() + 1).toString().padStart(2, "0");
	const YYYY = date.getFullYear();

	return `${DD}-${MM}-${YYYY} ${HH}:${mm}:${ss}.${sss}`;
}

function loginToConsole(_username) {
	return console.log(`${dateTimeString()} \u001b[32m${_username}\u001b[0m`);
}

function logoutToConsole(_username) {
	return console.log(`${dateTimeString()} \u001b[31m${_username}\u001b[0m`);
}