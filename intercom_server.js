/**
 * Project: WebRTC Intercom
 * Created: 2020.05.31
 * Author:  Michael Spencer <code.with.michael@gmail.com>
 * License: MIT
 */

"use strict";

var http = require('http')
var url = require('url')
var querystring = require('querystring')


const PORT = 8080
const CHARSET = 'utf-8'
const DEBUG_LOGGING = true


// connection format: { time, request, response, pathname, get, post, query }
// user format: { id, name, time, queue=[], connection=undefined }
const users_ = {}  // key=user_id, value=user


// =[ Routing ]===============================================================


const routes_ = {
    '/':           rootRoute,
    '/jsonLoader': jsonLoaderRoute,
}
const dataRoutes_ = {
    'register':   registerRoute,    // { register: name, id? } => { register: { name, id }, users }
    'unregister': unregisterRoute,  // { unregister: id }      => undefined
    'offer':      offerRoute,       // { id, offer, name }     => undefined
    'answer':     answerRoute,      // { id, answer, name }    => undefined
    'reject':     rejectRoute,      // { id, reject: name }    => undefined
    'wait':       waitRoute,        // { wait: id }            => { messages: [] }
}


http.createServer(function (request, response) {
    routeRequest(request, response)
        .catch(error => {
            if (!error.code) console.error(error)
            writeErrorResponse(response, error.code || 500, error.message)
        })
}).listen(PORT)


console.log(`Listening on port: ${PORT}`)


async function routeRequest(request, response) {
    let connection = await createConnectionObject(request, response)
    const route = routes_[connection.pathname]
    if (route) {
        await route(connection)
    } else {
        debugLog('Page not found: ' + connection.pathname)
        throw errorWithCode(404, "page not found")
        return
    }
}


// =[ Routes ]================================================================


async function rootRoute(connection) {
    for (let key in dataRoutes_) if (connection.query.hasOwnProperty(key)) {
        return await dataRoutes_[key](connection)
    }
    throw errorWithCode(400, "unknown request parameters")
}


async function jsonLoaderRoute(connection) {
    const javascript = `(${jsonLoader.toString()})()`
    writeHtmlResponse(connection.response, wrapAsHtmlScript(javascript))
}


// Register user
// { register: name, id? } => { register: { id, name }, users }
async function registerRoute(connection) {
    let { id, register: name } = connection.query
    if (typeof(name) === 'string') name = name.trim()
    if (!name) throw errorWithCode(400, "user name required")

    id           = id || uuidv4()
    let time     = connection.time
    let user     = users_[id]
    let old_name = undefined

    if (user) {
        old_name = user.name
        user = Object.assign({}, user, { name, time })
    } else {
        for (let id in users_) if (users_[id].name === name) {
            throw errorWithCode(400, "user name already in use")
        }
        let queue = []
        let connection = undefined
        user = { id, name, time, queue, connection }
    }

    let privateUser = { id, name }
    let publicUser  = { name }
    if (old_name) {
        Object.assign(privateUser, { old_name })
        Object.assign(publicUser, { old_name })
    }
    let otherUserIds = Object.keys(users_)
        .filter(user_id => id != user_id)
    let publicUsers = await generatePublicUsers(...otherUserIds)
        .then(users => users.concat(publicUser))
        .then(users => sortUsersByName(users))

    let privateData = { register: privateUser, users: publicUsers }
    let publicData  = { register: publicUser, users: publicUsers }

    writeJsonResponse(connection.response, privateData)
    users_[id] = user

    if (!old_name || old_name != name) {
        sendMessageToAll(publicData, id)
    }

    debugLog(`Registered user: ${name} (user_id: ${id})`)
}


// Unregister user
// { unregister: id } => undefined
async function unregisterRoute(connection) {
    let { unregister: id } = connection.query
    if (!id) throw errorWithCode(400, "user id required")

    let user = users_[id]
    if (user) {
        let data = { unregister: await generatePublicUser(id) }
        delete users_[id]
        data.users = await generatePublicUsers(...Object.keys(users_))
        if (user.connection) writeJsonResponse(user.connection.response)
        await sendMessageToAll(data, id)
        debugLog(`Unregistered user: ${user.name} (user_id: ${id})`)
    }

    writeJsonResponse(connection.response)
}


// Offer connection
// { id, offer, name } => undefined
async function offerRoute(connection) {
    let { id, offer, name } = connection.query
    if (!id)    throw errorWithCode(400, "user id required")
    if (!offer) throw errorWithCode(400, "offer required")
    if (!name)  throw errorWithCode(400, "user name required")

    let fromUser = users_[id]
    if (!fromUser) throw errorWithCode(400, "user id not found")

    let toUser = await findUserByName(name)
    if (!toUser) throw errorWithCode(400, "user name not found")

    await sendMessage(toUser.id, { offer, name: fromUser.name })

    writeJsonResponse(connection.response)
}


// Answer connection offer
// { id, answer, name } => undefined
async function answerRoute(connection) {
    let { id, answer, name } = connection.query
    if (!id)     throw errorWithCode(400, "user id required")
    if (!answer) throw errorWithCode(400, "answer required")
    if (!name)   throw errorWithCode(400, "user name required")

    let fromUser = users_[id]
    if (!fromUser) throw errorWithCode(400, "user id not found")

    let toUser = await findUserByName(name)
    if (!toUser) throw errorWithCode(400, "user name not found")

    await sendMessage(toUser.id, { answer, name: fromUser.name })

    writeJsonResponse(connection.response)
}


// Reject connection offer
// { id, reject: name } => undefined
async function rejectRoute(connection) {
    let { id, reject: name } = connection.query
    if (!id)   throw errorWithCode(400, "user id required")
    if (!name) throw errorWithCode(400, "user name required")

    let fromUser = users_[id]
    if (!fromUser) throw errorWithCode(400, "user id not found")

    let toUser = await findUserByName(name)
    if (!toUser) throw errorWithCode(400, "user name not found")

    await sendMessage(toUser.id, { reject: { name: fromUser.name }})

    writeJsonResponse(connection.response)
}


// Wait for message(s)
// { wait: id } => { messages: [] }
async function waitRoute(connection) {
    let { wait: id } = connection.query
    if (!id) throw errorWithCode(400, "user id required")

    let user = users_[id]
    if (!user) throw errorWithCode(400, "user not found")

    if (user.queue.length) {
        writeJsonResponse(connection.response, { messages: user.queue })
        user.queue.length = 0
    } else {
        if (user.connection) writeJsonResponse(user.connection.response)
        user.connection = connection
        user.connection.response.on('close', () => {
            if (user.connection === connection) user.connection = undefined
        })
    }
}


// =[ Data ]==================================================================


async function generatePublicUser(user_id) {
    let user = users_[user_id]
    if (!user) throw errorWithCode(400, 'user not found')
    user = { name: user.name }
    return user
}


async function generatePublicUsers(...user_ids) {
    return Promise.all(user_ids.map(generatePublicUser))
}


async function sortUsersByName(users) {
    return users.sort((a, b) => {
        a = a.name.toUpperCase()
        b = b.name.toUpperCase()
        return a < b ? -1 : a > b ? 1 : 0
    })
}


async function findUserByName(name) {
    for (let id of Object.keys(users_)) if (users_[id].name === name) {
        return users_[id]
    }
    return undefined
}


async function enqueueMessage(user_id, data) {
    // Store the message to be sent to the given user 
    let user = users_[user_id]
    if (!user) throw new Error('enqueueMessage: unknown user')
    user.queue.push(data)
}


async function sendQueue(user_id) {
    // Send all enqueued messages to the given user (if they are waiting)
    let user = users_[user_id]
    if (!user) throw new Error('sendQueue: unknown user')

    let connection = user.connection
    if (connection && user.queue.length) {
        writeJsonResponse(connection.response, { messages: user.queue })
        user.queue.length = 0
        user.connection = undefined
    }
}


async function sendMessage(user_id, data) {
    // Send or enqueue the message to the given user
    await enqueueMessage(user_id, data)
        .then(() => sendQueue(user_id))
        .catch(console.error)
}


async function sendMessageToAll(data, exclude_user_id=undefined) {
    // Send or enqueue the message to all users (except excluded)
    for (let user_id in users_) if (users_.hasOwnProperty(user_id)) {
        if (user_id === exclude_user_id) return
        await sendMessage(user_id, data)
    }
}



// =[ HTTP ]==================================================================


function writeHtmlResponse(response, str) {
    // Respond with an HTML document
    response.writeHead(200, {'Content-Type': 'text/html', CHARSET});
    response.end(str)
}


function writeJsonResponse(response, obj) {
    // Respond with a JSON object
    response.writeHead(200, {'Content-Type': 'application/json', CHARSET});
    response.end(obj ? JSON.stringify(obj) : undefined);
}


function writeErrorResponse(response, code, description) {
    // Respond with an error code and message
    response.writeHead(code, description, {'Content-Type': 'text/plain', CHARSET});
    response.end();
}


async function createConnectionObject(request, response) {
    // Generate an object encapsulating usable request/response information
    const time = new Date().getTime()
    const { pathname, query: get } = url.parse(request.url, true)
    const post = await parsePostQuery(request)
    const query = Object.assign({}, post, get)
    return { time, pathname, request, response, get, post, query }
}


async function parsePostQuery(request) {
    // Wait for all POST data to be received, parse it as querystring format,
    // and return and data object containing the defined properties
    if (request.method != 'POST') return {}

    let queryData = ''
    return new Promise((resolve, reject) => {
        request.on('data', onData)
        request.on('end', onEnd)

        function stopListening() {
            request.off('data', onData)
            request.off('end', onEnd)
        }

        function onData(data) {
            queryData += data
            if (queryData.length > 1e6) {
                stopListening()
                request.connection.destroy()
                reject(errorWithCode(413, 'Request Entity Too Large'))
            }
        }

        function onEnd() {
            stopListening()
            resolve(querystring.parse(queryData))
        }
    })
}


// =[ Util ]==================================================================


function debugLog(message) {
    // Log only if DEBUG_LOGGING is enabled
    if (DEBUG_LOGGING) console.log(...arguments)
}


function errorWithCode(code, message) {
    // Generate an error with a specified 'code' property
    return Object.assign(new Error(message), { code })
}


function uuidv4() {
    // Generate a random UUID version 4 string
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8)
        return v.toString(16)
    });
}


function wrapAsHtmlScript(scriptString) {
    // Wrap the given JavaScript string in <html> and <script> tags to be
    // served in a browser
    return (`<DOCTYPE html><html><head><meta charset="${CHARSET}"/></head><body><script>"use strict";${scriptString}</script></body></html>`)
}


// =[ JSON Loader ]===========================================================


// Runs in browser
function jsonLoader() {
    let user_id = undefined
    window.addEventListener('message', onMessage)
    window.addEventListener('unload', onUnload)


    function makeQueryString(data) {
        // Encode a JSON object to querystring format
        const enc = encodeURIComponent
        return Object.keys(data)
             .map(k => enc(k) + '=' + enc(data[k]))
             .join('&')
    }


    function onMessage(event) {
        let { _id, _timeout, data } = event.data
        if (typeof(_id) !== 'string' || !_id) return
        if (!data) return
        
        let abortController = undefined
        let signal          = undefined
        let timer           = undefined

        if (_timeout) {
            // Abort request after the given timeout
            abortController = new AbortController()
            signal = abortController.signal
            timer = setTimeout(() => { abortController.abort() }, _timeout)
        }

        // Send request to signal server
        fetch('/', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain', charset: "utf-8"},
            body: makeQueryString(data),
            signal,
        })
        .then(async response => {
            // Process response as JSON
            clearTimeout(timer)
            const { ok, status, statusText, headers } = response
            if (!ok) {
                throw new Error(`Data request failed: ${status} (${statusText})`)
            } else if (headers.get('Content-Type') != 'application/json') {
                throw new Error(`Data request failed: Non-JSON response received`)
            }
            return response.text()
        })
        .then(body => {
            return body ? JSON.parse(body) : undefined
        })
        .then(data => {
            // Capture registrations' user_id (for onUnload)
            let { register } = (data || {})
            if (register && typeof(register.id) === 'string') {
                user_id = register.id
            }
            return { data }
        })
        .catch(error => {
            // Convert errors to processable JSON objects
            if (error.name === 'AbortError') {
                return { error_name: error.name, error: 'response timed out' }
            } else {
                return { error: error.message }
            }
        })
        .then(data => {
            // Return JSON result object to request source
            event.source.postMessage(Object.assign(data, { _id }), '*')
        })
    }


    function onUnload() {
        // Unregister on close
        if (!user_id) return
        navigator.sendBeacon('/', makeQueryString({ unregister: user_id }))
    }
}