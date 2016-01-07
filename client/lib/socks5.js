var domain = require('domain'),
    binary = require('binary'),
    net = require('net'),
    put = require('put'),
    dgram = require('dgram'),
    debug = require('debug')('socks5-server'),
    // module specific events
    EVENTS = {
        AUTHENTICATION: 'authenticate',
        AUTHENTICATION_ERROR: 'authenticateError',
        HANDSHAKE: 'handshake',
        PROXY_CONNECT: 'proxyConnect',
        PROXY_DATA: 'proxyData',
        PROXY_END: 'proxyEnd',
        PROXY_ERROR: 'proxyError'
    },
    RFC_1928_ATYP = {
        IPV4: 0x01,
        DOMAINNAME: 0x03,
        IPV6: 0x04
    },
    RFC_1928_COMMANDS = {
        CONNECT: 0x01,
        BIND: 0x02,
        UDP_ASSOCIATE: 0x03
    },
    RFC_1928_METHODS = {
        NO_AUTHENTICATION_REQUIRED: 0x00,
        GSSAPI: 0x01,
        BASIC_AUTHENTICATION: 0x02,
        NO_ACCEPTABLE_METHODS: 0xff
    },
    RFC_1928_REPLIES = {
        SUCCEEDED: 0x00,
        GENERAL_FAILURE: 0x01,
        CONNECTION_NOT_ALLOWED: 0x02,
        NETWORK_UNREACHABLE: 0x03,
        HOST_UNREACHABLE: 0x04,
        CONNECTION_REFUSED: 0x05,
        TTL_EXPIRED: 0x06,
        COMMAND_NOT_SUPPORTED: 0x07,
        ADDRESS_TYPE_NOT_SUPPORTED: 0x08
    },
    RFC_1928_VERSION = 0x05,
    RFC_1929_REPLIES = {
        SUCCEEDED: 0x00,
        GENERAL_FAILURE: 0xff
    },
    RFC_1929_VERSION = 0x01;
/**
 * The following RFCs may be useful as background:
 *
 * https://www.ietf.org/rfc/rfc1928.txt - NO_AUTH SOCKS5
 * https://www.ietf.org/rfc/rfc1929.txt - USERNAME/PASSWORD SOCKS5
 *
 **/
module.exports = (function(self) {
    'use strict';
    // local state
    self.activeSessions = [];
    self.options = {};
    self.server = null;

    function Session(socket) {
        // Capture any unhandled errors
        socket.on('error', function(err) {
            self.server.emit(EVENTS.PROXY_ERROR, err);
        });
        socket.on('close', function() {
            // debug('socket close');
        });
        /**
         * +----+------+----------+------+----------+
         * |VER | ULEN |  UNAME   | PLEN |  PASSWD  |
         * +----+------+----------+------+----------+
         * | 1  |  1   | 1 to 255 |  1   | 1 to 255 |
         * +----+------+----------+------+----------+
         **/
        function authenticate(buffer) {
            var authDomain = domain.create();
            binary.stream(buffer).word8('ver').word8('ulen').buffer('uname', 'ulen').word8('plen').buffer('passwd', 'plen').tap(function(args) {
                // capture the raw buffer
                args.requestBuffer = buffer;
                // verify version is appropriate
                if (args.ver !== RFC_1929_VERSION) {
                    return end(RFC_1929_REPLIES.GENERAL_FAILURE, args);
                }
                authDomain.on('error', function(err) {
                    // emit failed authentication event
                    self.server.emit(EVENTS.AUTHENTICATION_ERROR, args.uname.toString(), err);
                    // respond with auth failure
                    return end(RFC_1929_REPLIES.GENERAL_FAILURE, args);
                });
                // perform authentication
                self.options.authenticate(args.uname.toString(), args.passwd.toString(), authDomain.intercept(function() {
                    // emit successful authentication event
                    self.server.emit(EVENTS.AUTHENTICATION, args.uname.toString());
                    // respond with success...
                    var responseBuffer = put().word8(RFC_1929_VERSION).word8(RFC_1929_REPLIES.SUCCEEDED).buffer();
                    // respond then listen for cmd and dst info
                    socket.write(responseBuffer, function() {
                        // now listen for more details
                        socket.once('data', connect);
                    });
                }));
            });
        }
        /**
         * +----+-----+-------+------+----------+----------+
         * |VER | CMD |  RSV  | ATYP | DST.ADDR | DST.PORT |
         * +----+-----+-------+------+----------+----------+
         * | 1  |  1  | X'00' |  1   | Variable |    2     |
         * +----+-----+-------+------+----------+----------+
         **/
        function connect(buffer) {
            binary.stream(buffer).word8('ver').word8('cmd').word8('rsv').word8('atyp').tap(function(args) {
                // capture the raw buffer
                args.requestBuffer = buffer;
                // verify version is appropriate
                if (args.ver !== RFC_1928_VERSION) {
                    return end(RFC_1928_REPLIES.GENERAL_FAILURE, args);
                }
                // append socket to active sessions
                self.activeSessions.push(socket);
                // create dst
                args.dst = {};
                // ipv4
                if (args.atyp === RFC_1928_ATYP.IPV4) {
                    this.buffer('addr.buf', 4).tap(function(args) {
                        args.dst.addr = [].slice.call(args.addr.buf).join('.');
                    });
                    // domain name
                } else if (args.atyp === RFC_1928_ATYP.DOMAINNAME) {
                    this.word8('addr.size').buffer('addr.buf', 'addr.size').tap(function(args) {
                        args.dst.addr = args.addr.buf.toString();
                    });
                    // ipv6
                } else if (args.atyp === RFC_1928_ATYP.IPV6) {
                    this.word32be('addr.a').word32be('addr.b').word32be('addr.c').word32be('addr.d').tap(function(args) {
                        args.dst.addr = ['a', 'b', 'c', 'd'].map(function(x) {
                            return args.addr[x].toString(16);
                        });
                    });
                    // unsupported address type
                } else {
                    return end(RFC_1928_REPLIES.ADDRESS_TYPE_NOT_SUPPORTED, args);
                }
            }).word16bu('dst.port').tap(function(args) {
                if (args.cmd === RFC_1928_COMMANDS.CONNECT) {
                    var destination = net.createConnection(args.dst.port, args.dst.addr, function() {
                        // prepare a success response
                        var responseBuffer = new Buffer(args.requestBuffer.length);
                        args.requestBuffer.copy(responseBuffer);
                        responseBuffer[1] = RFC_1928_REPLIES.SUCCEEDED;
                        // write acknowledgement to client...
                        socket.write(responseBuffer, function() {
                            // listen for data bi-directionally
                            destination.pipe(socket);
                            socket.pipe(destination);
                        });
                    });
                    // capture successful connection
                    destination.on('connect', function() {
                        var info = {
                            host: args.dst.addr,
                            port: args.dst.port
                        };
                        // emit connection event
                        self.server.emit(EVENTS.PROXY_CONNECT, info, destination);
                        // capture and emit proxied connection data
                        destination.on('data', function(data) {
                            self.server.emit(EVENTS.PROXY_DATA, data);
                        });
                    });
                    // capture connection errors and response appropriately
                    destination.on('error', function(err) {
                        // notify of connection error
                        err.addr = args.dst.addr;
                        err.atyp = args.atyp;
                        err.port = args.dst.port;
                        self.server.emit(EVENTS.PROXY_ERROR, err);
                        if (err.code && err.code === 'EADDRNOTAVAIL') {
                            return end(RFC_1928_REPLIES.HOST_UNREACHABLE, args);
                        }
                        if (err.code && err.code === 'ECONNREFUSED') {
                            return end(RFC_1928_REPLIES.CONNECTION_REFUSED, args);
                        }
                        return end(RFC_1928_REPLIES.NETWORK_UNREACHABLE, args);
                    });
                } else if (args.cmd === RFC_1928_COMMANDS.UDP_ASSOCIATE) {
                    // udp associate
                    var ssocket = dgram.createSocket('udp4');

                    //本机 ip
                    var sip = socket._getsockname().address;
                    //本机端口
                    var sport = null;

                    //client address
                    var cip = socket._getpeername().address;
                    //client port
                    var cport = args.dst.port;
                    //
                    debug("sip:%s sport:%s cip:%s cport:%s", sip, sport, cip, cport);

                    //udp 服务器监听成功后 发送成功监听的数据包
                    ssocket.on('listening', function(addr) {
                        sport = ssocket.address().port;
                        // debug(ssocket.address());
                        debug('send to client proxy udp listen to:' + sip + ':' + sport + ' success');
                        var buf = gen_resp(0, sip, sport);
                        socket.write(buf, function(err) {
                            if (!err) {} else {
                                ssocket.end();
                            }
                        });
                    });
                    //
                    ssocket.on('message', function(msg, rinfo) {
                        // +----+------+------+----------+----------+----------+
                        // |RSV | FRAG | ATYP | DST.ADDR | DST.PORT |   DATA   |
                        // +----+------+------+----------+----------+----------+
                        // | 2  |  1   |  1   | Variable |    2     | Variable |
                        // +----+------+------+----------+----------+----------+
                        // udp消息转发
                        debug(msg, rinfo, cip, cport);
                        if (rinfo.address == cip && rinfo.port == cport) {
                            // 发送消息
                            if (msg.length < 10) {
                                debug('udp bad length');
                                return;
                            }
                            if (msg[0] != 0 || msg[1] != 0) {
                                debug('udp rsv not zero');
                                return;
                            }
                            if (msg[2] != 0) { // do not support fragment
                                debug('udp do not support fragment');
                                return;
                            }
                            // 读取Host
                            var offset = 4;
                            var Host;
                            if (msg[3] == RFC_1928_ATYP.IPV4) {
                                // ipv4
                                Host = '' + msg[4] + '.' + msg[5] + '.' + msg[6] + '.' + msg[7];
                                offset += 4;
                            } else if (msg[3] == RFC_1928_ATYP.DOMAINNAME) {
                                // domain name
                                var len = msg[4];
                                if (msg.length < len + 1 + 6) {
                                    debug('udp bad length');
                                    return;
                                }
                                Host = msg.toString('utf8', 5, 5 + len);
                                offset += 1 + len;
                            } else /* if( ret[3] == ATYP.V6 )*/ {
                                // ipv6
                                debug('udp not support');
                                return;
                            }
                            // 读取Port
                            var Port = msg[offset] * 256 + msg[offset + 1];
                            offset += 2;
                            //发给远程服务器
                            ssocket.send(msg, offset, msg.length - offset, Port, Host);
                            debug('send udp to ' + Host + ':' + Port + ' length:' + (msg.length - offset));
                        } else {
                            // 接收消息
                            var nbuf = new Buffer(10 + msg.length);
                            nbuf[0] = 0;
                            nbuf[1] = 0;
                            nbuf[2] = 0;
                            nbuf[3] = RFC_1928_ATYP.IPV4;
                            var tmp = rinfo.address.split('.');
                            nbuf[4] = 0 + tmp[0];
                            nbuf[5] = 0 + tmp[1];
                            nbuf[6] = 0 + tmp[2];
                            nbuf[7] = 0 + tmp[3];
                            nbuf[8] = rinfo.port >> 8;
                            nbuf[9] = rinfo.port % 0x100;
                            msg.copy(nbuf, 10, 0, msg.length);
                            //发给代理客户端
                            ssocket.send(nbuf, 0, nbuf.length, cport, cip);
                            // ssocket.send(msg, 0, msg.length, cport, cip);
                            debug('recv udp from %s:%d length:%d to %s:%d', rinfo.address, rinfo.port, msg.length, cip, cport);
                        }
                    });
                    //
                    ssocket.on('close', function() {
                        debug('udp close');
                        socket.end();
                    });
                    //
                    ssocket.on('error', function(err) {
                        debug('udp err ' + err);
                        socket.end();
                    });
                    //
                    ssocket.bind();
                    socket.on('close', function() {
                        ssocket.close();
                    });
                } else {
                    // bind and udp associate commands
                    return end(RFC_1928_REPLIES.SUCCEEDED, args);
                }
            });
        }
        // +----+-----+-------+------+----------+----------+
        // |VER | REP |  RSV  | ATYP | BND.ADDR | BND.PORT |
        // +----+-----+-------+------+----------+----------+
        // | 1  |  1  | X'00' |  1   | Variable |    2     |
        // +----+-----+-------+------+----------+----------+
        // o  VER    protocol version: X'05'
        function gen_resp(resp, ip, port) {
            ip = ip ? ip : '0.0.0.0';
            port = port ? port : 0;
            var buf = new Buffer(4 + 6);
            buf[0] = 5; //VER
            buf[1] = resp; //SUCCESS
            buf[2] = 0; //rsv
            buf[3] = 1; //IP
            var Ip = ip.split('.');
            buf[4] = 0 + Ip[0];
            buf[5] = 0 + Ip[1];
            buf[6] = 0 + Ip[2];
            buf[7] = 0 + Ip[3];
            // Port
            buf[8] = port >> 8;
            buf[9] = port % 0x100;
            return buf;
        }
        /**
         * +----+-----+-------+------+----------+----------+
         * |VER | REP |  RSV  | ATYP | BND.ADDR | BND.PORT |
         * +----+-----+-------+------+----------+----------+
         * | 1  |  1  | X'00' |  1   | Variable |    2     |
         * +----+-----+-------+------+----------+----------+
         **/
        function end(response, args) {
            // either use the raw buffer (if available) or create a new one
            var responseBuffer = args.requestBuffer || put().word8(RFC_1928_VERSION).word8(response).buffer();
            // set the response as appropriate
            responseBuffer[1] = response;
            // respond then end the connection
            try {
                socket.end(responseBuffer);
            } catch (ex) {
                socket.destroy();
            }
            // indicate end of connection
            self.server.emit(EVENTS.PROXY_END, response, args);
        }
        /**
         * +----+----------+----------+
         * |VER | NMETHODS | METHODS  |
         * +----+----------+----------+
         * | 1  |    1     | 1 to 255 |
         * +----+----------+----------+
         **/
        function handshake(buffer) {
            binary.stream(buffer).word8('ver').word8('nmethods').buffer('methods', 'nmethods').tap(function(args) {
                // verify version is appropriate
                if (args.ver !== RFC_1928_VERSION) {
                    return end(RFC_1928_REPLIES.GENERAL_FAILURE, args);
                }
                // convert methods buffer to an array
                var acceptedMethods = [].slice.call(args.methods).reduce(function(methods, method) {
                        methods[method] = true;
                        return methods;
                    }, {}),
                    basicAuth = typeof self.options.authenticate === 'function',
                    next = connect,
                    noAuth = !basicAuth && typeof acceptedMethods[0] !== 'undefined' && acceptedMethods[0],
                    responseBuffer = put().word8(RFC_1928_VERSION).word8(RFC_1928_METHODS.NO_AUTHENTICATION_REQUIRED).buffer();
                // check for basic auth configuration
                if (basicAuth) {
                    responseBuffer[1] = RFC_1928_METHODS.BASIC_AUTHENTICATION;
                    next = authenticate;
                    // if NO AUTHENTICATION REQUIRED and
                } else if (!basicAuth && noAuth) {
                    responseBuffer[1] = RFC_1928_METHODS.NO_AUTHENTICATION_REQUIRED;
                    next = connect;
                    // basic auth callback not provided and no auth is not supported
                } else {
                    return end(RFC_1928_METHODS.NO_ACCEPTABLE_METHODS, args);
                }
                // respond then listen for cmd and dst info
                socket.write(responseBuffer, function() {
                    // emit handshake event
                    self.server.emit(EVENTS.HANDSHAKE, socket);
                    // now listen for more details
                    socket.once('data', next);
                });
            });
        }
        // capture the client handshake
        socket.once('data', handshake);
        // capture socket closure
        socket.once('end', function() {
            // remove the session from currently the active sessions list
            self.activeSessions.splice(self.activeSessions.indexOf(socket), 1);
        });
    }
    /**
     * Creates a TCP SOCKS5 proxy server
     **/
    self.createServer = function(options) {
        self.options = options || {};
        self.server = net.createServer(Session);
        return self.server;
    };
    return self;
}({}));