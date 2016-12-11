"use strict"

var pg = require("pg");
var _ = require("lodash");
var url = require("url");
var auth = require("http-auth");
var throng = require("throng");
var compression = require("compression");
var constants = require("./analysis-constants.json");

var PORT = process.env.PORT || 5000;
var WORKERS = process.env.WEB_CONCURRENCY || 1;

throng({
	workers: WORKERS,
	lifetime: Infinity,
	start: start
});

function start() {
	// Configure and initialize the Postgres connection pool
	// Get the DATABASE_URL config var and parse it into its components
	var params = url.parse(process.env.HEROKU_POSTGRESQL_COPPER_URL);
	var authParams = params.auth.split(":");
	var pgConfig = {
		user: authParams[0],
		password: authParams[1],
		host: params.hostname,
		port: params.port,
		database: params.pathname.split("/")[1],
		ssl: true,
		max: 16 / WORKERS,			// Maximum number of clients in the pool
		idleTimeoutMillis: 30000	// Duration a client can remain idle before being closed
	};
	var pool = new pg.Pool(pgConfig);

	// Create an Express server
	var express = require("express");
	var server = express();
	server.use(compression());

	// Add user authentication if AUTHENTICATION isn't set to 'off'
	if (process.env.AUTHENTICATION.toLowerCase() !== "off") {
		var basic = auth.basic(
			{ },
			(username, password, callback) => { 
		        callback(username === process.env.AUTHENTICATION_USER && password === process.env.AUTHENTICATION_PASSWORD);
		    }
		);
		server.use(auth.connect(basic));
	}

	// Serve static files, including the Vue application in public/index.html
	server.use(express.static("public"));
	
	//
	// Handle GET request for players api
	//

	server.get("/api/players/", function(request, response) {

		var season = 2016;

		// Create query string: result1 is used to get players' stats; result2 is used to get the number of games played by a player
		var queryString = "SELECT result1.*, result2.gp"
			+ " FROM "
			+ " ( "
				+ " SELECT s.team, s.player_id, r.first, r.last, r.position, s.score_sit, s.strength_sit,"
				+ "		SUM(toi) AS toi, SUM(ig) AS ig, SUM(\"is\") AS \"is\", (SUM(\"is\") + SUM(ibs) + SUM(ims)) AS ic, SUM(ia1) AS ia1, SUM(ia2) AS ia2,"
				+ "		SUM(gf) AS gf, SUM(ga) AS ga, SUM(sf) AS sf, SUM(sa) AS sa, (SUM(sf) + SUM(bsf) + SUM(msf)) AS cf, (SUM(sa) + SUM(bsa) + SUM(msa)) AS ca,"
				+ "		SUM(cf_off) AS cf_off, SUM(ca_off) AS ca_off " 
				+ " FROM game_stats AS s"
				+ " 	LEFT JOIN game_rosters AS r"
				+ " 	ON s.player_id = r.player_id AND s.season = r.season AND s.game_id = r.game_id"
				+ " WHERE s.player_id > 2 AND r.position <> 'na' AND r.position <> 'g' AND s.season = $1"
				+ " GROUP BY s.team, s.player_id, r.first, r.last, r.position, s.score_sit, s.strength_sit"
			+ " ) AS result1"
			+ " LEFT JOIN"
			+ " ( "
				+ " SELECT player_id, COUNT(DISTINCT game_id) AS gp"
				+ " FROM game_rosters"
				+ " WHERE position != 'na' AND season = $1"
				+ " GROUP BY player_id"
			+ " ) AS result2"
			+ " ON result1.player_id = result2.player_id";

		// Run query
		var statRows;
		query(queryString, [season], function(err, rows) {
			if (err) { return response.status(500).send("Error running query: " + err); }
			statRows = rows;
			processResults();
		});

		// Process query results
		function processResults() {

			// Postgres aggregate functions like SUM return strings, so cast them as ints
			// Calculate score-adjusted corsi
			statRows.forEach(function(r) {
				["gp", "toi", "ig", "is", "ic", "ia1", "ia2", "gf", "ga", "sf", "sa", "cf", "ca", "cf_off", "ca_off"].forEach(function(col) {
					r[col] = +r[col];
				});
				r["cf_adj"] = constants["cfWeights"][r["score_sit"]] * r["cf"];
				r["ca_adj"] = constants["cfWeights"][-1 * r["score_sit"]] * r["ca"];
			});

			// Group rows by playerId:
			//	{ 123: [rows for player 123], 234: [rows for player 234] }
			statRows = _.groupBy(statRows, "player_id");

			// Structure results as an array of objects:
			// [ { playerId: 123, data: [rows for player 123] }, { playerId: 234, data: [rows for player 234] } ]
			var result = { players: [] };
			for (var pId in statRows) {
				if (!statRows.hasOwnProperty(pId)) {
					continue;
				}

				// Get all teams and positions the player has been on
				var teams = _.uniqBy(statRows[pId], "team").map(function(d) { return d.team; });
				var positions = _.uniqBy(statRows[pId], "position").map(function(d) { return d.position; });

				result["players"].push({
					player_id: +pId,
					teams: teams,
					positions: positions,
					first: statRows[pId][0]["first"],
					last: statRows[pId][0]["last"],
					gp: statRows[pId][0]["gp"],
					data: statRows[pId]
				});
			}

			// Set redundant properties in each player's data rows to be undefined - this removes them from the response
			// Setting the properties to undefined is ~10sec faster than deleting the properties completely
			result["players"].forEach(function(p) {
				p.data.forEach(function(r) {
					r.team = undefined;
					r.player_id = undefined;
					r.first = undefined;
					r.last = undefined;
					r.position = undefined;
					r.gp = undefined;
				});
			});

			return response.status(200).send(result);
		}
	});

	//
	// Handle GET request for a particular player id
	//

	server.get("/api/players/:id", function(request, response) {

		var pId = +request.params.id;
		var season = 2016;
		
		// 'p' contains all of the specified player's game_rosters rows (i.e., all games they played in, regardless of team)
		// 'sh' contains all player shifts, including player names
		// Join 'p' with 'sh' to get all shifts belonging to the specified player and his teammates
		var queryStr = "SELECT sh.*"
			+ " FROM game_rosters AS p"
			+ " LEFT JOIN ("
				+ " SELECT s.game_id, s.team, s.player_id, s.period, s.shifts, r.\"first\", r.\"last\", r.\"position\""
				+ " FROM game_shifts AS s"
				+ " LEFT JOIN game_rosters as r"
				+ " ON s.season = r.season AND s.game_id = r.game_id AND s.player_id = r.player_id"
				+ " WHERE r.\"position\" != 'g' AND r.\"position\" != 'na' AND s.season = $1"
			+ " ) AS sh"
			+ " ON p.game_id = sh.game_id AND p.team = sh.team"
			+ " WHERE p.season = $1 AND p.\"position\" != 'na' AND p.player_id = $2";

		var shiftsByPrd;
		query(queryStr, [season, pId], function(err, rows) {
			if (err) { return response.status(500).send("Error running query: " + err); }
			shiftsByPrd = rows;
			processResults();
		});

		function processResults() {

			// The 'shift' property in each row of shiftsByPrd is formatted as a string: "start-end;start-end;..."
			// First split the string into an array of intervals: ["start-end", "start-end", ...]
			// Then convert each interval into an array of seconds played: [[start, start+1, start+2,..., end], [start, start+1, start+2,..., end]]
			// Then flatten the nested arrays: [1,2,3,4,10,11,12,13,...]
			shiftsByPrd.forEach(function(s) {
				s.shifts = s.shifts
					.split(";")					
					.map(function(interval) {
						var times = interval.split("-");
						return _.range(+times[0], +times[1]);
					});
				s.shifts = [].concat.apply([], s.shifts);
			});

			// Loop through each of the players' period rows and calculate toi with linemates
			var linemateResults = {};
			var pRows = shiftsByPrd.filter(function(d) { return d.player_id === pId; });
			pRows.forEach(function(pr) {
				// Select all teammates' period rows that have the same game and period
				var tmRows = shiftsByPrd.filter(function(tr) { 
					return tr.player_id !== pId && tr.game_id === pr.game_id && tr.period === pr.period;
				});
				// Loop through each teammate row and add their data to the results
				tmRows.forEach(function(tr) {
					// Create a result object for the teammate if needed
					if (!linemateResults.hasOwnProperty(tr.player_id)) {
						linemateResults[tr.player_id] = {
							first: tr.first,
							last: tr.last,
							positions: [],
							teams: [],
							toi: 0
						}
					}
					// Record positions, teams, and increment shared toi
					var tmObj = linemateResults[tr.player_id];
					if (tmObj.positions.indexOf(tr.position) < 0) {
						tmObj.positions.push(tr.position);
					}
					if (tmObj.teams.indexOf(tr.team) < 0) {
						tmObj.teams.push(tr.team);
					}
					tmObj.toi += _.intersection(pr.shifts, tr.shifts).length;
				});
			});



			return response.status(200).send(linemateResults);
		}

	});

	//
	// Handle GET request for teams api
	//

	server.get("/api/teams/", function(request, response) {

		var season = 2016;

		// Create query string for stats by game
		var statQueryString = "SELECT result1.*, result2.gp"
			+ " FROM "
			+ " ( "
				+ " SELECT team, score_sit, strength_sit, SUM(toi) AS toi,"
				+ "		SUM(gf) AS gf, SUM(ga) AS ga, SUM(sf) AS sf, SUM(sa) AS sa, (SUM(sf) + SUM(bsf) + SUM(msf)) AS cf, (SUM(sa) + SUM(bsa) + SUM(msa)) AS ca"
				+ " FROM game_stats"
				+ " WHERE player_id < 2 AND season = $1"
				+ " GROUP BY team, score_sit, strength_sit"
			+ " ) AS result1"
			+ " LEFT JOIN"
			+ " ( "
				+ " SELECT team, COUNT(DISTINCT game_id) AS gp"
				+ " FROM game_rosters" 
				+ " WHERE season = $1"
				+ " GROUP BY team"
			+ " ) AS result2"
			+ " ON result1.team = result2.team";

		// Create query string for wins and losses - exclude playoff games
		var resultQueryString = "SELECT *"
			+ " FROM game_results"
			+ " WHERE game_id < 30000 AND season = $1";

		// Run queries
		var statRows;
		var resultRows;
		query(statQueryString, [season], function(err, rows) {
			if (err) { return response.status(500).send("Error running query: " + err); }
			statRows = rows;
			processResults();
		});
		query(resultQueryString, [season], function(err, rows) {
			if (err) { return response.status(500).send("Error running query: " + err); }
			resultRows = rows;
			processResults();
		});

		// Process query results
		function processResults() {

			// Only start processing once all queries are finished
			if (!statRows || !resultRows) {
				return;
			}

			// Postgres aggregate functions like SUM return strings, so cast them as ints
			// Calculate score-adjusted corsi
			statRows.forEach(function(r) {
				["gp", "toi", "gf", "ga", "sf", "sa", "cf", "ca"].forEach(function(col) {
					r[col] = +r[col];
				});
				r["cf_adj"] = constants["cfWeights"][r["score_sit"]] * r["cf"];
				r["ca_adj"] = constants["cfWeights"][-1 * r["score_sit"]] * r["ca"];
			});

			// Group rows by team:
			// { "edm": [rows for edm], "tor": [rows for tor] }
			statRows = _.groupBy(statRows, "team");

			//
			// Calculate the number of points won
			//

			// Initialize points counter
			for (var tricode in statRows) {
				if (statRows.hasOwnProperty(tricode)) {
					statRows[tricode]["pts"] = 0;
				}
			}

			// Loop through game_result rows and increment points
			resultRows.forEach(function(r) {
				var winner = r["a_final"] > r["h_final"] ? "a_team" : "h_team";
				statRows[r[winner]].pts += 2;
				if (r["periods"] > 3) {
					var loser = r["a_final"] < r["h_final"] ? "a_team" : "h_team";
					statRows[r[loser]].pts += 1;
				}
			});

			// Structure results as an array of objects:
			// [ { team: "edm", data: [rows for edm] }, { team: "tor", data: [rows for tor] } ]
			var result = { teams: [] };
			for (var tricode in statRows) {
				if (!statRows.hasOwnProperty(tricode)) {
					continue;
				}
				result["teams"].push({
					team: tricode,
					pts: statRows[tricode]["pts"],
					gp: statRows[tricode][0]["gp"],
					data: statRows[tricode]
				});
			}

			// Set redundant properties in each team's data rows to be undefined - this removes them from the response
			result["teams"].forEach(function(t) {
				t.data.forEach(function(r) {
					r.team = undefined;
					r.gp = undefined;
				});
			});

			return response.status(200).send(result);
		}
	});

	// Start listening for requests
	server.listen(PORT, function(error) {
		if (error) { throw error; }
		console.log("Listening on " + PORT);
	});

	// Query the database and return result rows in json format
	// 'values' is an array of values for parameterized queries
	function query(text, values, cb) {
		pool.connect(function(err, client, done) {
			if (err) { returnError("Error fetching client from pool: " + err); }
			client.query(text, values, function(err, result) {
				done();
				// result.rows is is an array of Anonymous objects
				// Convert it to json using stringify and parse before returning it
				var returnedRows = err ? [] : JSON.parse(JSON.stringify(result.rows));
				cb(err, returnedRows);
			});
		});
	}
}