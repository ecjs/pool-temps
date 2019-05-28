'use strict';

const express = require('express');
const fetch = require('node-fetch');
const humanizeDuration = require('humanize-duration');
const app = express();

const api_key = "EOOEMOW4YR6QNB07";
const gmail_app_password = process.env.gmail_app_pass;
const gmail_account = process.env.gmail_account;
const timeZone = 'America/Chicago';

const projectId = process.env.gc_project_id  // 'pool-temps' Google Cloud Datastore ID
const Emailer = require('node-gmail-sender');
const emailer = new Emailer(gmail_account, gmail_app_password)

const {Datastore} = require('@google-cloud/datastore');
const datastore = new Datastore({
	projectId,
	credentials: JSON.parse(Buffer.from(process.env.gc_key, 'base64'))
});
const sessionKey = datastore.key(['Session', 'default']);

async function doLogin() {
	const session = await login();
	session.device_serial = await getDevice(session);
	
	await datastore.upsert({key: sessionKey, data: session});
	return session;
}

async function getSession() {	
	const sessions = await datastore.get(sessionKey);
	if (sessions[0]) {
		// Note that if this session has expired, we'll try to login again in getTemps
		return sessions[0];
	}

	return await doLogin();
}

async function login() {

	const response = await fetch('https://support.iaqualink.com/users/sign_in.json', {
		body: JSON.stringify({
			api_key: api_key, 
			email: process.env.poolEmail, 
			password: process.env.poolPassword }),
		headers: {
			'content-type': 'application/json'},
		method: 'POST'
	});
	if (response.status !== 200)
		throw new Error('sign_in.json failure - status:' + response.status);
	const json = await response.json();
	if (!('session_id' in json) || !('id' in json) || !('authentication_token' in json)) {
		console.error('Unexpected signin response: ', json);
		throw new Error('sign_in.json failure - unexpected response');
	}
	const s = {
		id: json.session_id,
		user_id: json.id,
		authentication_token: json.authentication_token};
	console.log('logged in with session', s);
	return s;
}

async function getDevice(session) {
	const url = 'https://support.iaqualink.com/devices.json' + 
		'?api_key=' + api_key +
		'&authentication_token=' + session.authentication_token +
		'&user_id=' + session.user_id;
	const response = await fetch(url);
	if (response.status !== 200) {
		const body = await response.text();
		console.error('devices.json failure', url, response.status, response.statusText, body);
		throw new Error('devices.json failure:' + response.status + ' ' + response.statusText);
	}
	const json = await response.json();
	if (!('0' in json) || !('serial_number' in json[0])) {
		console.error('Unexpected devices response: ', json);
		throw new Error('devices.json failure - unexpected response');
	}
	return json[0].serial_number;
}

async function getDevices(session) {
	let body;
	for (let attempt = 0; attempt < 2; attempt++) {
		const url = 'https://iaqualink-api.realtime.io/v1/mobile/session.json' +
			'?actionID=command' +
			'&command=get_devices' +
			'&serial=' + session.device_serial +
			'&sessionID=' + session.id;
		const response = await fetch(url);
		body = await response.text();
		if (response.status !== 200) {
			console.error('session.json failure', url, response.status, response.statusText, body);
			throw new Error('session.json failure:' + response.status + ' ' + response.statusText);
		}
	
		if (body) {
			// Success fetching something, no more attempts
			break;
		} else {
			// Empty body seems to imply a bad session ID, re-auth
			if (!attempt) {
				const oldSessionId = session.id;
				session = await doLogin();
				console.error(`session.json empty response with session ${oldSessionId}, retrying with new session ${session.id}`);
			} else {
				throw new Error('session.json repeated empty response');
			}
		}
	}
	const json = JSON.parse(body);
	return json
}

async function getTemps(session) {
	
	let body;
	for (let attempt = 0; attempt < 2; attempt++) {
		const url = 'https://iaqualink-api.realtime.io/v1/mobile/session.json' +
			'?actionID=command' +
			'&command=get_home' +
			'&serial=' + session.device_serial +
			'&sessionID=' + session.id;
		const response = await fetch(url);
		body = await response.text();
		if (response.status !== 200) {
			console.error('session.json failure', url, response.status, response.statusText, body);
			throw new Error('session.json failure:' + response.status + ' ' + response.statusText);
		}
		if (body) {
			// Success fetching something, no more attempts
			break;
		} else {
			// Empty body seems to imply a bad session ID, re-auth
			if (!attempt) {
				const oldSessionId = session.id;
				session = await doLogin();
				console.error(`session.json empty response with session ${oldSessionId}, retrying with new session ${session.id}`);
			} else {
				throw new Error('session.json repeated empty response');
			}
		}
	}

	const json = JSON.parse(body);
	// Convert array of key/value pairs into an object
	const items = Object.assign({}, ...json.home_screen);

	if (items.status !== 'Online') {
		console.error(`Failed to get temps.  Status: ${items.status} Response: ${items.response}`);
		// Use empty data so we can visualize how much is missing
		return {air: '', pool: '', heater: ''};
	}
	
	// Compute heater temperature.
	// "1" means heating, "3" means on but not heating
	// "spa" (temp 1) seems to take precedence when it's on
	let heater = 0;
	if (items.spa_heater==="1")
		heater = parseInt(items.spa_set_point, 10);
	else if(items.pool_heater==="1")
		heater = parseInt(items.pool_set_point, 10);
	else if(items.spa_heater!=="0" && items.spa_heater!=="3")
		throw new Error('Unexpected spa_heater: ' + items.spa_heater);
	else if(items.pool_heater!=="0" && items.pool_heater!=="3")
		throw new Error('Unexpected pool_heater: ' + items.pool_heater);

	return {
		air: items.air_temp ? parseInt(items.air_temp, 10) : '',
		pool: items.pool_temp ? parseInt(items.pool_temp, 10) : '',
		spa: items.spa_temp ? parseInt(items.spa_temp, 10) : '',
		heater: heater};
}

async function update() {
	const session = await getSession();
	const temps = await getTemps(session);
	// const devices = await getDevices(session)
	if (!temps)
		return 'Temperature unavailable';
	temps.timestamp = new Date();
	await datastore.save({key: datastore.key(['Temps']), data: temps});
	return 'Added entry: ' + JSON.stringify(temps);
}

async function checkRecentTemps (temps) {
	console.log('checking recent temps...')
	const query = datastore.createQuery('Temps')
		.order('timestamp', { descending: true }).limit(120) // if the updates happen every 5 minutes, this is 10 hrs.
	const results = temps || await datastore.runQuery(query)
	const resultData = results[0]
	if (resultData[0].heater === 1) { // check if the most recent entry has the heater on.
		let timePast = 0
		let firstTime = new Date(resultData[0].timestamp)
		for (let temps of resultData) { // loop through all remaining entries
			if (temps.heater !== 1) break;
			timePast = firstTime - new Date(temps.timestamp)
		}
		if (timePast > 3600000) { // If heater has been on longer than 1 hour
			console.log('sending email propane heat alert email...')
			emailer.send(`The propane heater has been on for longer than ${humanizeDuration(timePast)}.`, gmail_account, '7377049607@vtext.com', `Pool Alert`);
		}
	}
	console.log('finished checking recent temps...')
}

async function log(response, limit) {
	const query = datastore.createQuery('Temps')
    	.order('timestamp', { descending: true }).limit(Number(limit) || 2016); // whatever is passed in as a queryh or limit to a week of updates (if updating every 5 minutes)
	const results = await datastore.runQuery(query);
	let csv = 'timesamp, air, pool, spa, heater\n';
    for(let temps of results[0]) {
    	let date = temps.timestamp.toLocaleString('en-US', { timeZone: timeZone });
    	date = date.replace(",","");
    	csv += `${date}, ${temps.air}, ${temps.pool}, ${temps.spa}, ${temps.heater}\n`;
	}
	
	response
		.status(200)
        .set('Content-Type', 'text/csv')
     	.send(csv)
     	.end();
}

app.get('/', (req, res) => {
	res.sendFile(__dirname + "/static/index.html");
});

app.get('/update', (req, res) => {
	update().then(msg => {
		res.status(200).send(msg).end();
	}).catch(error => {
		console.error(error);
		res.status(500).send('Server error!');
	});
});

app.get('/chart-data', async (req, res) => {
	try {
		const limit = req.query.limit;
		const query = datastore.createQuery('Temps')
    	.order('timestamp', { descending: true }).limit(Number(limit) || 2016); // whatever is passed in as a queryh or limit to a week of updates (if updating every 5 minutes)
		const results = await datastore.runQuery(query);
		res.json(results[0]);
	}
	catch (e) {
		res.status(500).send('Server error!');
	}
	
})

app.get('/log.csv', (req, res) => {
	log(res, req.query.limit).catch(error => {
		console.error(error);
		res.status(500).send('Server error!');
	});
});


// Start the server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`App listening on port ${PORT}`);
  console.log('Press Ctrl+C to quit.');
});

setInterval(() => {
	update().then(msg => {
		console.log(msg)
		checkRecentTemps().catch(err => console.error(err))
	}).catch(error => {
		console.error(error);
		console.log('Server error!')
	});
}, 300000) // Run every 5 minutes (1000 * 60 * 5)
