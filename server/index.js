import express from "express";
import { WebSocketServer } from "ws";
import BadWordsFilter from "bad-words";
import badwords from "badwords/array.js";

const serverPort = parseInt(process.env.SERVER_PORT || "9090");
const wss = new WebSocketServer({ port: serverPort });
wss.on("listening", () => {
	console.log(`Server port: ${serverPort}`);
});

const app = express();
const clientPort = parseInt(process.env.CLIENT_PORT || "9091");
app.use(express.static("../app"));
app.get("/", (_, res) => res.sendFile("index.html"));
app.listen(clientPort, () => console.log(`App port: ${clientPort}`));

const activeConnections = new Map();	// key: CLient ID, value: ws
const clientsInGame = new Map();		// key: Client ID, value: Game ID
const games = {};
const profanityFilter = new BadWordsFilter();
profanityFilter.addWords(...badwords);

wss.on("connection", ws => {
	const id = newId(16);
	const clientData = { "id": id };
	ws.clientData = clientData;
	activeConnections.set(id, ws);

	const payload = {
		"method": "connect",
		"client": clientData
	};

	ws.send(JSON.stringify(payload));

	ws.on("close", () => {
		const clientInGame = clientsInGame.get(ws.clientData.id);
		if (clientInGame) removePlayerFromGame(clientInGame, ws.clientData.id);
		activeConnections.delete(ws.clientData.id);
	});

	ws.on("message", (message) => {
		const result = JSON.parse(message);
		const method = result.method;		// method is a property send by the client

		// Client wants to create a game
		if (method === "createGame") {
			let payload = {};

			if (clientsInGame.has(result.client.id)) {
				payload = {
					"method": "error",
					"message": "You're already in a game!"
				};

				ws.send(JSON.stringify(payload));
				return;
			}

			const newGameId = newId(8);

			games[newGameId] = {
				"id": newGameId,
				"players": []
			};

			payload = {
				"method": "createGame",
				"gameId": newGameId
			};

			ws.send(JSON.stringify(payload));
			return;
		}

		// Client wants to join a game
		if (method === "joinGame") {
			const gameId = result.gameId;
			let payload = {};

			if (clientsInGame.has(result.client.id)) {
				payload = {
					"method": "error",
					"message": "You're already in a game!"
				};

				ws.send(JSON.stringify(payload));
				return;
			}

			if (!games[gameId]) {
				payload = {
					"method": "error",
					"message": "That game doesn't exist!"
				};

				ws.send(JSON.stringify(payload));
				return;
			}

			if (games[gameId].players.length >= 2) {
				payload = {
					"method": "error",
					"message": "Game reached max players!"
				};

				ws.send(JSON.stringify(payload));
				return;
			}

			games[gameId].players.push({
				"id": result.client.id
			});

			clientsInGame.set(result.client.id, games[gameId].id);

			games[gameId].players.forEach(player => {
				if (player.id === result.client.id) {
					payload = {
						"method": "joinGame",
						"game": games[gameId]
					};
					ws.send(JSON.stringify(payload));
				}
				else {
					payload = {
						"method": "updateGame",
						"game": games[gameId]
					};

					activeConnections.get(player.id).send(JSON.stringify(payload));

					payload = {
						"method": "updateChat",
						"type": "system",
						"text": `<b>${result.client.id}</b> joined`
					};

					activeConnections.get(player.id).send(JSON.stringify(payload));
				}
			});
			return;
		}

		if (method === "leaveGame") {
			removePlayerFromGame(result.gameId, result.client.id);
			return;
		}

		if (method === "sendChatMessage") {
			const gameId = result.gameId;
			let payload = {};

			if (!games[gameId]) {
				payload = {
					"method": "error",
					"message": "That game doesn't exist!"
				};

				ws.send(JSON.stringify(payload));
				return;
			}

			payload = {
				"method": "updateChat",
				"type": "user",
				"username": result.clientId,
				"text": profanityFilter.clean(result.text)
			};

			games[gameId].players.forEach((player) => {
				activeConnections.get(player.id).send(JSON.stringify(payload));
			});
			return;
		}
	});
});

function newId(_length) {
	const characters =
		"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	let result = "";
	let i = 0;

	while (i < _length) {
		result += characters.charAt(Math.floor(Math.random() * characters.length));
		i++;
	}

	return result;
}

function removePlayerFromGame(_gameId, _leavingPlayerId) {
	if (!games[_gameId]) {
		const payload = {
			"method": "error",
			"message": "You're not in any game!"
		};

		activeConnections.get(_leavingPlayerId).send(JSON.stringify(payload));
		return;
	}

	let i = 0;

	for (const player of games[_gameId].players) {
		if (player.id === _leavingPlayerId) {
			games[_gameId].players.splice(i, 1);
			clientsInGame.delete(_leavingPlayerId);
			break;
		}

		i++;
	}

	if (games[_gameId].players.length === 0) {
		delete games[_gameId];
		return;
	}

	let payload = {};

	for (const player of games[_gameId].players) {
		payload = {
			"method": "updateGame",
			"game": games[_gameId]
		};

		activeConnections.get(player.id).send(JSON.stringify(payload));

		payload = {
			"method": "updateChat",
			"type": "system",
			"text": `<b>${_leavingPlayerId}</b> left`
		};

		activeConnections.get(player.id).send(JSON.stringify(payload));
	}
}
