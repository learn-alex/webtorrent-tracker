module.exports = Server

var debug = require('debug')('webtorrent-tracker')
var EventEmitter = require('events').EventEmitter
var http = require('http')
var inherits = require('inherits')
var WebSocketServer = require('ws').Server

var MAX_ANNOUNCE_PEERS = 20

inherits(Server, EventEmitter)

/**
 * A WebTorrent tracker server.
 *
 * A "WebTorrent tracker" is an HTTP/WebSocket service which responds to requests from
 * WebTorrent/WebRTC clients. The requests include metrics from clients that help the
 * tracker keep overall statistics about the torrent. Unlike a traditional BitTorrent
 * tracker, a WebTorrent tracker maintains an open connection to each peer in a swarm.
 * This is necessary to facilitate the WebRTC signaling (peer introduction) process.
 *
 * @param {Object}  opts            options object
 * @param {Number}  opts.server     use existing http server
 * @param {Number}  opts.interval   interval in ms that clients should announce on
 */
function Server (opts) {
  var self = this
  if (!(self instanceof Server)) return new Server(opts)
  EventEmitter.call(self)
  opts = opts || {}

  self._intervalMs = opts.interval
    ? opts.interval / 1000
    : 10 * 60 // 10 min (in secs)

  debug('new server %s', JSON.stringify(opts))

  self.port = null
  self.torrents = {}

  self._httpServer = opts.server || http.createServer()
  self._httpServer.on('error', self._onError.bind(self))
  self._httpServer.on('listening', self._onListening.bind(self))

  self._socketServer = new WebSocketServer({ server: self._httpServer })
  self._socketServer.on('error', self._onError.bind(self))
  self._socketServer.on('connection', function (socket) {
    socket.id = null
    socket.onSend = self._onSocketSend.bind(self, socket)
    socket.on('message', self._onSocketMessage.bind(self, socket))
    socket.on('error', self._onSocketError.bind(self, socket))
    socket.on('close', self._onSocketClose.bind(self, socket))
  })
}

Server.prototype.listen = function (port, onlistening) {
  var self = this
  debug('listen %s', port)
  self.port = port
  if (onlistening) self.once('listening', onlistening)
  self._httpServer.listen(port)
}

Server.prototype.close = function (cb) {
  var self = this
  debug('close')
  self._httpServer.close(cb)
}

Server.prototype._onListening = function () {
  var self = this
  debug('listening %s', self.port)
  self.emit('listening', self.port)
}

Server.prototype._onError = function (err) {
  var self = this
  debug('error %s', err.message || err)
  self.emit('error', err)
}

Server.prototype.getSwarm = function (infoHash) {
  var self = this
  var binaryInfoHash = Buffer.isBuffer(infoHash)
    ? infoHash.toString('binary')
    : new Buffer(infoHash, 'hex').toString('binary')
  return self._getSwarm(binaryInfoHash)
}

Server.prototype._getSwarm = function (binaryInfoHash) {
  var self = this
  var swarm = self.torrents[binaryInfoHash]
  if (!swarm) {
    swarm = self.torrents[binaryInfoHash] = {
      complete: 0,
      incomplete: 0,
      peers: {}
    }
  }
  return swarm
}

Server.prototype._onSocketMessage = function (socket, data) {
  var self = this

  try {
    data = JSON.parse(data)
  } catch (err) {
    return error('invalid socket message')
  }

  var peerId = typeof data.peer_id === 'string' && data.peer_id
  if (!peerId || peerId.length !== 20) return error('invalid peer_id')

  var infoHash = typeof data.info_hash === 'string' && data.info_hash
  if (!infoHash || infoHash.length !== 20) return error('invalid info_hash')

  debug('received %s from %s', JSON.stringify(data), binaryToHex(peerId))
  if (!socket.id) socket.id = peerId
  if (!socket.infoHash) socket.infoHash = infoHash

  var warning
  var swarm = self._getSwarm(infoHash)
  var peer = swarm.peers[peerId]

  switch (data.event) {
    case 'started':
      if (peer) {
        warning = 'unexpected `started` event from peer that is already in swarm'
        break
      }

      if (Number(data.left) === 0) {
        swarm.complete += 1
      } else {
        swarm.incomplete += 1
      }

      swarm.peers[peerId] = {
        socket: socket,
        id: peerId
      }
      self.emit('start')
      break

    case 'stopped':
      if (!peer) {
        warning = 'unexpected `stopped` event from peer that is not in swarm'
        break
      }

      if (peer.complete) {
        swarm.complete -= 1
      } else {
        swarm.incomplete -= 1
      }

      swarm.peers[peerId] = null
      self.emit('stop')
      break

    case 'completed':
      if (!peer) {
        warning = 'unexpected `completed` event from peer that is not in swarm'
        break
      }
      if (peer.complete) {
        warning = 'unexpected `completed` event from peer that is already marked as completed'
        break
      }

      swarm.complete += 1
      swarm.incomplete -= 1

      peer.complete = true
      self.emit('complete')
      break

    case '': // update
    case undefined:
      if (!peer) {
        warning = 'unexpected `update` event from peer that is not in swarm'
        break
      }

      self.emit('update')
      break

    default:
      return error('invalid event') // early return
  }

  var response = JSON.stringify({
    complete: swarm.complete,
    incomplete: swarm.incomplete,
    interval: self._intervalMs
  })
  if (warning) response['warning message'] = warning

  socket.send(response, socket.onSend)
  debug('sent response %s to %s', response, binaryToHex(peerId))

  var numWant = Math.min(
    Number(data.offers && data.offers.length) || 0,
    MAX_ANNOUNCE_PEERS
  )
  if (numWant) {
    debug('got %s offers', data.offers.length)
    var peers = self._getPeers(swarm, numWant)
    debug('got %s peers from swarm %s', peers.length, binaryToHex(infoHash))
    peers.forEach(function (peer, i) {
      if (peer.id === peerId) return // ignore self
      peer.socket.send(JSON.stringify({
        offer: data.offers[i].offer,
        offer_id: data.offers[i].offer_id,
        peer_id: peerId
      }))
      debug('sent offer to %s from %s', binaryToHex(peer.id), binaryToHex(peerId))
    })
  }

  if (data.answer) {
    debug('got answer %s from %s', data.answer, binaryToHex(peerId))
    var toPeerId = typeof data.to_peer_id === 'string' && data.to_peer_id
    if (!toPeerId) return error('invalid `to_peer_id`')
    var toPeer = swarm.peers[toPeerId]
    if (!toPeer) return self.emit('warning', new Error('no peer with that `to_peer_id`'))

    toPeer.socket.send(JSON.stringify({
      answer: data.answer,
      offer_id: data.offer_id,
      peer_id: peerId
    }))
    debug('sent answer to %s for %s', binaryToHex(toPeer.id), binaryToHex(peerId))
  }

  function error (message) {
    debug('sent error %s', message)
    socket.send(JSON.stringify({ 'failure reason': message }), socket.onSend)
    // even though it's an error for the client, it's just a warning for the server.
    // don't crash the server because a client sent bad data :)
    self.emit('warning', new Error(message))
  }
}

// TODO: randomize the peers that are given out
Server.prototype._getPeers = function (swarm, numWant) {
  var peers = []
  for (var peerId in swarm.peers) {
    if (peers.length >= numWant) break
    var peer = swarm.peers[peerId]
    if (!peer) continue // ignore null values
    peers.push(peer)
  }
  return peers
}

Server.prototype._onSocketSend = function (socket, err) {
  var self = this
  if (err) {
    debug('Socket error %s', err.message)
    self.handleClose(socket)
  }
}

Server.prototype._onSocketClose = function (socket) {
  var self = this
  debug('on socket close')
  if (!socket.id || !socket.infoHash) return

  var swarm = self.torrents[socket.infoHash]
  if (swarm) swarm.peers[socket.id] = null
}

Server.prototype._onSocketError = function (socket, err) {
  var self = this
  debug('socket error %s', err.message || err)
  self.emit('warning', err)
  self._onSocketClose(socket)
}

function binaryToHex (id) {
  return new Buffer(id, 'binary').toString('hex')
}
