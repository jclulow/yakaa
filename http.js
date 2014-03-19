'use strict';

// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

var net = require('net');
var EventEmitter = require('events').EventEmitter;
var util = require('util');

var debug = require('./lib/debuglog.js')('httpagent');

var TunnelClient = require('tunnel-client').TunnelClient;

// New Agent code.

// The largest departure from the previous implementation is that
// an Agent instance holds connections for a variable number of host:ports.
// Surprisingly, this is still API compatible as far as third parties are
// concerned. The only code that really notices the difference is the
// request object.

// Another departure is that all code related to HTTP parsing is in
// ClientRequest.onSocket(). The Agent is now *strictly*
// concerned with managing a connection pool.

function Agent(options) {
  if (!(this instanceof Agent)) return new Agent(options);

  EventEmitter.call(this);

  this.defaultPort = 80;
  this.protocol    = 'http:';

  this.options = util._extend({}, options);
  // don't confuse net and make it think that we're connecting to a pipe
  this.options.path = null;

  this.requests    = {};
  this.sockets     = {};
  this.freeSockets = {};

  this.tunnelClient = null;
  if (this.options.proxy) {
    if (this.options.proxy.protocol !== 'http:') {
      throw new Error('invalid proxy protocol: "' + this.options.proxy.protocol + '"');
    }
    this.tunnelClient = new TunnelClient({
      proxy_host: this.options.proxy.hostname || this.options.proxy.host,
      proxy_port: Number(this.options.proxy.port),
    });
  }

  this.keepAliveMsecs = this.options.keepAliveMsecs || 1000;
  this.keepAlive      = this.options.keepAlive || false;

  this.maxSockets     = this.options.maxSockets || Agent.defaultMaxSockets;
  this.maxFreeSockets = this.options.maxFreeSockets || 256;

  var self = this;
  this.on('tunnelError', function(error, options) {
    var name = self.getName(options);
    debug('agent.on(tunnelError)', name);

    if (self.requests[name].length) {
      self.requests[name].shift().emit('error', error);
      if (self.requests[name].length === 0) {
        delete self.requests[name];
      }
    }
  });
  this.on('free', function(socket, options) {
    var name = self.getName(options);
    debug('agent.on(free)', name);

    if (!socket.destroyed && self.requests[name] && self.requests[name].length) {
      self.requests[name].shift().onSocket(socket);
      if (self.requests[name].length === 0) {
        // don't leak
        delete self.requests[name];
      }
    }
    else {
      // If there are no pending requests, then put it in
      // the freeSockets pool, but only if we're allowed to do so.
      var req = socket._httpMessage;
      if (req && req.shouldKeepAlive && !socket.destroyed && self.options.keepAlive) {
        var freeSockets = self.freeSockets[name];
        var freeLen     = freeSockets ? freeSockets.length : 0;
        var count       = freeLen;

        if (self.sockets[name]) count += self.sockets[name].length;

        debug('potentially pooling', freeLen, count);

        if (count > self.maxSockets || freeLen >= self.maxFreeSockets) {
          debug('destroying socket', name);
          self.removeSocket(socket, options);
          socket.destroy();
        } else {
          debug('pooling socket', name);
          freeSockets = freeSockets || [];
          self.freeSockets[name] = freeSockets;
          socket.setKeepAlive(true, self.keepAliveMsecs);

          if (socket.unref) {
            socket.unref();
          }
          else if (socket.socket &&
                   socket.socket._handle &&
                   socket.socket._handle.unref) {
            socket.socket._handle.unref();
          }

          socket._httpMessage = null;
          self.removeSocket(socket, options);
          freeSockets.push(socket);

          // Avoid duplicate timeout events by removing timeout listeners set
          // on socket by previous requests. node does not do this normally
          // because it assumes sockets are too short-lived for it to matter.
          // It becomes a problem when sockets are being reused. Fixed sometime
          // around Node 0.10.0.
          //
          // See https://github.com/joyent/node/commit/451ff1540
          if (self.keepAliveTimeoutMsecs &&
              socket._events &&
              Array.isArray(socket._events.timeout)) {
            socket.removeAllListeners('timeout');
            // Restore the socket's setTimeout() that was remove as collateral
            // damage.
            socket.setTimeout(self.keepAliveTimeoutMsecs, socket._reapTimeout);
          }
        }
      } else {
        self.removeSocket(socket, options);
        socket.destroy();
      }
    }
  });
}

util.inherits(Agent, EventEmitter);
exports.Agent = Agent;

Agent.defaultMaxSockets = Infinity;

Agent.prototype.createConnection = net.createConnection;

Agent.prototype._createConnection = function(options, callback) {
  var self = this;

  if (self.tunnelClient) {
    self.tunnelClient.connect(options.host, options.port, callback);
  } else {
    callback(null, self.createConnection(options));
  }
};

// Get the key for a given set of request options
Agent.prototype.getName = function(options) {
  var name = '';

  if (options.host)
    name += options.host;
  else
    name += 'localhost';

  name += ':';
  if (options.port)
    name += options.port;
  name += ':';
  if (options.localAddress)
    name += options.localAddress;
  name += ':';
  return name;
};

Agent.prototype.addRequest = function(req, options) {
  debug('addRequest');
  // Legacy API: addRequest(req, host, port, path)
  if (typeof options === 'string') {
    options = {
      host: options,
      port: arguments[2],
      path: arguments[3]
    };
  }

  var name = this.getName(options);
  if (!this.sockets[name]) {
    this.sockets[name] = [];
  }

  var freeLen = this.freeSockets[name] ? this.freeSockets[name].length : 0;
  var sockLen = freeLen + this.sockets[name].length;

  if (freeLen) {
    // we have a free socket, so use that.
    var socket = this.freeSockets[name].shift();
    debug('have free socket');

    // don't leak
    if (!this.freeSockets[name].length)
      delete this.freeSockets[name];

    if (socket.ref) {
      socket.ref();
    }
    else if (socket.socket && socket.socket._handle && socket.socket._handle.ref) {
      socket.socket._handle.ref();
    }

    req.onSocket(socket);
    this.sockets[name].push(socket);
  } else if (sockLen < this.maxSockets) {
    debug('call onSocket', name, sockLen, freeLen);
    // If we are under maxSockets create a new one.
    this.createSocket(req, options, function(err, socket) {
      debug('createSocket error', err);
      if (err) {
        req.emit('error', err);
        return;
      }
      socket.removeAllListeners('connect');
      req.onSocket(socket);
      setImmediate(function() {
        socket.emit('connect');
      });
    });
  } else {
    debug('wait for socket');
    // We are over limit so we'll add it to the queue.
    if (!this.requests[name]) {
      this.requests[name] = [];
    }
    this.requests[name].push(req);
  }
};

Agent.prototype.createSocket = function(req, options, callback) {
  debug('createSocket');
  var self = this;
  options = util._extend({}, options);
  options = util._extend(options, self.options);

  options.servername = options.host;
  if (req) {
    var hostHeader = req.getHeader('host');
    if (hostHeader) {
      options.servername = hostHeader.replace(/:.*$/, '');
    }
  }

  var name = self.getName(options);

  debug('createConnection', name, options);
  options.encoding = null;

  self._createConnection(options, function (err, socket) {
    if (err) {
      callback(err);
      return;
    }
    self._afterCreateSocket(name, options, socket, callback);
  });
};

Agent.prototype._afterCreateSocket = function(name, options, s, callback) {
  debug('_afterCreateSocket');
  var self = this;

  if (!self.sockets[name]) {
    self.sockets[name] = [];
  }
  this.sockets[name].push(s);
  debug('sockets', name, this.sockets[name].length);

  if (options.keepAliveTimeoutMsecs) {
    s._reapTimeout = function () {
      debug('_reapTimeout, socket destroy()');
      s.destroy();
      self.removeSocket(s, options);
    };
    s.setTimeout(options.keepAliveTimeoutMsecs, s._reapTimeout);
  }

  function onFree() {
    self.emit('free', s, options);
  }
  s.on('free', onFree);

  function onTunnelError(err) {
    self.emit('tunnelError', err, options);
  }
  s.on('tunnelError', onTunnelError);

  function onClose() {
    debug('CLIENT socket onClose');
    // This is the only place where sockets get removed from the Agent.
    // If you want to remove a socket from the pool, just close it.
    // All socket errors end in a close event anyway.
    self.removeSocket(s, options);
  }
  s.on('close', onClose);

  function onRemove() {
    // We need this function for cases like HTTP 'upgrade'
    // (defined by WebSockets) where we need to remove a socket from the
    // pool because it'll be locked up indefinitely
    debug('CLIENT socket onRemove');
    self.removeSocket(s, options);
    s.removeListener('close', onClose);
    s.removeListener('free', onFree);
    s.removeListener('agentRemove', onRemove);
  }
  s.on('agentRemove', onRemove);
  callback(null, s);
};

Agent.prototype.removeSocket = function(s, options) {
  var name = this.getName(options);
  debug('removeSocket', name, 'destroyed:', s.destroyed);
  var sets = [this.sockets];

  // If the socket was destroyed, remove it from the free buffers too.
  if (s.destroyed)
    sets.push(this.freeSockets);

  sets.forEach(function(sockets) {
    if (sockets[name]) {
      var index = sockets[name].indexOf(s);
      if (index !== -1) {
        sockets[name].splice(index, 1);
        // Don't leak
        if (sockets[name].length === 0) delete sockets[name];
      }
    }
  });

  if (this.requests[name] && this.requests[name].length) {
    debug('removeSocket, have a request, make a socket');
    var req = this.requests[name][0];
    // If we have pending requests and a socket gets closed make a new one
    this.createSocket(req, options, function(err, socket) {
      if (err) {
        socket.emit('tunnelError', err);
      } else {
        socket.emit('free');
      }
    });
  }
};

Agent.prototype.destroy = function() {
  var sets = [this.freeSockets, this.sockets];
  sets.forEach(function(set) {
    Object.keys(set).forEach(function(name) {
      set[name].forEach(function(socket) {
        socket.destroy();
      });
    });
  });
};

module.exports = Agent;
