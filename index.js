var events = require('events')
var inherits = require('inherits')
var duplexify = require('duplexify')
var lpstream = require('length-prefixed-stream')
var stream = require('readable-stream')
var crypto = require('crypto')
var encryption = require('sodium-encryption')
var increment = require('increment-buffer')
var equals = require('buffer-equals')
var varint = require('varint')
var xtend = require('xtend')
var pe = require('passthrough-encoding')
var messages = require('./messages')

var KEEP_ALIVE = Buffer([0])

var DEFAULT_TYPES = [
  messages.Handshake,
  messages.Have,
  messages.Want,
  messages.Request,
  messages.Data,
  messages.Cancel,
  null, // pause
  null  // resume
]

var DEFAULT_EVENTS = [
  'handshake',
  'have',
  'want',
  'request',
  'data',
  'cancel',
  'pause',
  'resume'
]

while (DEFAULT_EVENTS.length < 64) { // reserved
  DEFAULT_EVENTS.push('unknown')
  DEFAULT_TYPES.push(null)
}

module.exports = use({})

function use (extensions) {
  var extensionNames = Object.keys(extensions).sort()
  var types = DEFAULT_TYPES.slice(0)
  var eventNames = DEFAULT_EVENTS.slice(0)

  function Channel (protocol) {
    events.EventEmitter.call(this)

    this.state = null // set by someone else
    this.protocol = protocol
    this.opened = false
    this.closed = false
    this.key = null
    this.discoveryKey = null
    this.local = -1
    this.remote = -1
    this.buffer = []

    this._nonce = crypto.randomBytes(24)
    this._remoteNonce = null

    this._firstNonce = Buffer(24)
    this._nonce.copy(this._firstNonce)
    this.on('handshake', this._onhandshake)
  }

  inherits(Channel, events.EventEmitter)

  Channel.prototype.remoteSupports = function (name) {
    return this.protocol.remoteSupports(name)
  }

  Channel.prototype.handshake = function (message) {
    return this.protocol._send(this, 0, message)
  }

  Channel.prototype.have = function (message) {
    return this.protocol._send(this, 1, message)
  }

  Channel.prototype.want = function (message) {
    return this.protocol._send(this, 2, message)
  }

  Channel.prototype.request = function (message) {
    return this.protocol._send(this, 3, message)
  }

  Channel.prototype.data = function (message) {
    return this.protocol._send(this, 4, message)
  }

  Channel.prototype.cancel = function (message) {
    return this.protocol._send(this, 5, message)
  }

  Channel.prototype.pause = function () {
    return this.protocol._send(this, 6, null)
  }

  Channel.prototype.resume = function () {
    return this.protocol._send(this, 7, null)
  }

  Channel.prototype.end = function () {
    this.protocol._close(this)
  }

  Channel.prototype.destroy = function (err) {
    this.protocol.destroy(err)
  }

  Channel.prototype._onhandshake = function (handshake) {
    this.protocol._onhandshake(handshake)
  }

  extensionNames.forEach(function (name, type) {
    if (Channel.prototype[name] || name === 'error' || name === 'tick') {
      throw new Error('Invalid extension name')
    }

    var enc = isEncoder(extensions[name]) ? extensions[name] : pe

    types.push(enc)
    eventNames.push(name)

    Channel.prototype[name] = function (message) {
      return this.protocol._send(this, DEFAULT_TYPES.length + type, message)
    }
  })

  function Protocol (opts, onopen) {
    if (!(this instanceof Protocol)) return new Protocol(opts, onopen)
    if (typeof opts === 'function') {
      onopen = opts
      opts = null
    }
    if (!opts) opts = {}

    var self = this
    duplexify.call(this)

    this.channels = {}
    this.private = opts.private !== false

    this.id = opts.id || crypto.randomBytes(32)
    this.remoteId = null

    this._finalized = false
    this._paused = 0
    this._local = []
    this._remote = []

    this._remoteExtensions = new Array(extensions.length)
    this._localExtensions = new Array(extensions.length)
    for (var i = 0; i < extensions.length; i++) {
      this._remoteExtensions[i] = this._localExtensions[i] = -1
    }

    this._keepAlive = 0
    this._remoteKeepAlive = 0
    this._interval = null

    this._encode = stream.Readable()
    this._encode._read = noop

    this._decode = lpstream.decode({allowEmpty: true, limit: 5 * 1024 * 1024})
    this._decode.on('data', parse)

    this.setReadable(this._encode)
    this.setWritable(this._decode)

    this.on('close', onfinalize)
    this.on('end', onfinalize)
    this.on('finish', this.finalize)

    if (onopen) this.on('open', onopen)

    function onfinalize () {
      if (self._finalized) return
      self._finalized = true
      self.destroyed = true // defined by duplexify

      clearInterval(this._interval)

      var keys = Object.keys(self.channels)
      for (var i = 0; i < keys.length; i++) {
        self._close(self.channels[keys[i]])
      }
    }

    function parse (data) {
      self._parse(data)
    }
  }

  inherits(Protocol, duplexify)

  Protocol.use = function (ext) {
    if (typeof ext === 'string') ext = toObject(ext)
    return use(xtend(ext, extensions))
  }

  Protocol.prototype.finalize = function () {
    this._encode.push(null)
  }

  Protocol.prototype.setTimeout = function (ms, ontimeout) {
    if (this.destroyed) return
    if (ontimeout) this.once('timeout', ontimeout)

    var self = this

    this._keepAlive = 0
    this._remoteKeepAlive = 0

    clearInterval(this._interval)
    this._interval = setInterval(kick, (ms / 4) | 0)
    if (this._interval.unref) this._interval.unref()

    function kick () {
      if (self._remoteKeepAlive > 4) {
        clearInterval(self._interval)
        self.emit('timeout')
        return
      }

      self._tick()
      self._remoteKeepAlive++
      if (self._keepAlive > 2) {
        self._encode.push(KEEP_ALIVE)
        self._keepAlive = 0
      } else {
        self._keepAlive++
      }
    }
  }

  Protocol.prototype.remoteSupports = function (name) {
    var i = typeof name === 'string' ? extensionNames.indexOf(name) : name
    return i > -1 && this._localExtensions[i] > -1
  }

  Protocol.prototype.open = function (key, opts) {
    if (this.destroyed) return null // already finalized
    if (!opts) opts = {}

    var d = opts.discoveryKey || discoveryKey(key)
    var keyHex = d.toString('hex')
    var ch = this.channels[keyHex]

    if (!ch) {
      ch = new Channel(this)
      ch.discoveryKey = d
      this.channels[keyHex] = ch
    }

    if (ch.local > -1) return ch

    if (opts.state) ch.state = opts.state

    ch.key = key
    ch.local = this._local.indexOf(null)
    if (ch.local === -1) ch.local = this._local.push(null) - 1
    this._local[ch.local] = ch

    var open = messages.Open.encode({
      feed: ch.discoveryKey,
      nonce: ch._nonce
    })

    this._sendRaw(ch, open)

    if (!this.remoteId && opts.handshake !== false) {
      ch.handshake({
        id: this.id,
        extensions: extensionNames
      })
    }

    this.emit('channel', ch)
    if (ch.buffer.length) this._parseSoon(ch)

    return ch
  }

  Protocol.prototype._send = function (channel, type, message) {
    if (channel.closed) return false

    var enc = types[type]
    var len = enc ? enc.encodingLength(message) : 0
    var buf = Buffer(len + 1)

    buf[0] = type
    if (enc) enc.encode(message, buf, 1)

    if (this.private) buf = this._encrypt(channel, buf)

    return this._sendRaw(channel, buf)
  }

  Protocol.prototype._sendRaw = function (channel, buf) {
    this._keepAlive = 0

    var len = buf.length + varint.encodingLength(channel.local)
    var box = Buffer(varint.encodingLength(len) + len)
    var offset = 0

    varint.encode(len, box, offset)
    offset += varint.encode.bytes

    varint.encode(channel.local, box, offset)
    offset += varint.encode.bytes

    buf.copy(box, offset)

    return this._encode.push(box)
  }

  Protocol.prototype._pause = function () {
    if (!this._paused++) this._decode.pause()
  }

  Protocol.prototype._resume = function () {
    if (!--this._paused) this._decode.resume()
  }

  Protocol.prototype._parseSoon = function (channel) {
    var self = this

    this._pause()
    process.nextTick(drain)

    function drain () {
      if (self.destroyed || channel.closed) return

      var buffer = channel.buffer
      channel.buffer = []

      while (buffer.length) self._parse(buffer.shift())
      if (!self.destroyed) self._resume()
    }
  }

  Protocol.prototype._parse = function (data) {
    this._remoteKeepAlive = 0

    if (!data.length || this.destroyed) return

    var remote = varint.decode(data, 0)
    var offset = varint.decode.bytes

    if (remote >= this._remote.length) this._remote.push(null)
    if (remote > this._remote.length) return this.destroy(new Error('Unexpected channel number'))

    if (!this._remote[remote]) this._onopen(remote, data, offset)
    else if (offset !== data.length) this._onmessage(remote, data, offset)
    else this._onclose(remote)
  }

  Protocol.prototype._tick = function () {
    for (var i = 0; i < this._local.length; i++) {
      var ch = this._local[i]
      if (ch) ch.emit('tick')
    }
  }

  Protocol.prototype._parseType = function (type) {
    if (type > 127) return -1
    if (type < 64) return type
    if (type - 64 >= this._remoteExtensions.length) return -1

    type = this._remoteExtensions[type - 64]
    if (type === -1) return -1
    return type + 64
  }

  Protocol.prototype._onopen = function (remote, data, offset) {
    try {
      var open = messages.Open.decode(data, offset)
    } catch (err) {
      return this.destroy(err)
    }

    if (open.feed.length !== 32 || open.nonce.length !== 24) return this.destroy(new Error('Invalid open message'))

    var keyHex = open.feed.toString('hex')
    var ch = this.channels[keyHex]

    if (!ch) {
      ch = new Channel(this)
      ch.discoveryKey = open.feed
      this.channels[keyHex] = ch
    }

    if (ch.remote > -1) return this.destroy(new Error('Double open for same channel'))

    ch.remote = remote
    ch._remoteNonce = open.nonce
    this._remote[remote] = ch
    this._open(ch)

    if (!this.destroyed && ch.local === -1) this.emit('open', ch.discoveryKey)
  }

  Protocol.prototype._onmessage = function (remote, data, offset) {
    var channel = this._remote[remote]

    if (!channel.key || channel.buffer.length) {
      if (channel.buffer.length === 16) return this.destroy(new Error('Buffer overflow'))
      channel.buffer.push(data)
      return
    }

    var box = this._decrypt(channel, data.slice(offset))
    if (!box || !box.length) return this.destroy(new Error('Invalid message'))

    var type = this._parseType(box[0])
    if (type < 0) return

    if (type && !this.remoteId) return this.destroy(new Error('Did not receive handshake'))
    if (type >= types.length) return

    var enc = types[type]

    try {
      var message = enc ? enc.decode(box, 1) : null
    } catch (err) {
      return this.destroy(err)
    }

    channel.emit(eventNames[type], message)
  }

  Protocol.prototype._onclose = function (remote) {
    var channel = this._remote[remote]

    this._remote[remote] = null
    channel.remote = -1

    if (channel.local > -1) this._close(channel)

    var keyHex = channel.discoveryKey.toString('hex')
    if (this.channels[keyHex] === channel) delete this.channels[keyHex]
  }

  Protocol.prototype._onhandshake = function (handshake) {
    if (this.remoteId) return // already handshaked
    this.remoteId = handshake.id

    var exts = handshake.extensions
    // extensions *must* be sorted
    var local = 0
    var remote = 0

    while (local < extensionNames.length && remote < exts.length && remote < 64) {
      if (extensionNames[local] === exts[remote]) {
        this._localExtensions[local] = remote
        this._remoteExtensions[remote] = local
        local++
        remote++
      } else if (extensionNames[local] < exts[remote]) {
        local++
      } else {
        remote++
      }
    }

    this.emit('handshake')
  }

  Protocol.prototype._open = function (channel) {
    if (channel.local === -1 || channel.remote === -1) return
    if (equals(channel._remoteNonce, channel._firstNonce)) return this.destroy(new Error('Remote echoed nonce'))
    channel.opened = true
    channel.emit('open')
  }

  Protocol.prototype._close = function (channel) {
    if (channel.closed) return
    channel.closed = true

    if (!this.destroyed) this._sendRaw(channel, Buffer(0))

    this._local[channel.local] = null
    channel.local = -1
    channel.emit('end')
  }

  Protocol.prototype._encrypt = function (channel, buf) {
    if (!this.private) return buf
    var box = encryption.encrypt(buf, channel._nonce, channel.key)
    increment(channel._nonce)
    return box
  }

  Protocol.prototype._decrypt = function (channel, box) {
    if (!this.private) return box
    var buf = box.length < 16 ? null : encryption.decrypt(box, channel._remoteNonce, channel.key)
    if (!buf) return null
    increment(channel._remoteNonce)
    return buf
  }

  function discoveryKey (key) {
    return crypto.createHmac('sha256', key).update('hypercore').digest()
  }

  function isEncoder (val) {
    return val && typeof val.encode === 'function'
  }

  function toObject (name) {
    var tmp = {}
    tmp[name] = true
    return tmp
  }

  function noop () {}

  return Protocol
}
