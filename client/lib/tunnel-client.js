var _ = require('lodash'),
    util = require('util'),
    debug = require('debug')('tunnel-client'),
    dgram = require('dgram'),
    WebSocketClient = require('websocket').client,
    net = require("net"),
    binary = require('binary'),
    EventEmitter = require('events').EventEmitter,
    RFC_1928_COMMANDS = {
        CONNECT: 0x01,
        BIND: 0x02,
        UDP_ASSOCIATE: 0x03
    },
    RFC_1928_ATYP = {
        IPV4: 0x01,
        DOMAINNAME: 0x03,
        IPV6: 0x04
    };
var WebSocketTcpSocketRelay = function(webSocketConnection, serverOptions, connectionVO) {
    this.wsPackageSeq = 0;
    var self = this;
    this.connectionVO = connectionVO;
    this.tcpPackageSeq = 0;
    this.wsPackageSeq = 0;
    this.tunnelUdpClient = null;
    this.udpClient = null;
    //
    var tcpClient = net.connect({
        port: serverOptions['remote_port'],
        host: serverOptions['remote_host']
    }, function() {});
    //
    tcpClient.on('connect', function() {
        //恢复websocket
        webSocketConnection.socket.resume();
        //start relay
        debug('tcpClient connect success!');
        // webSocketConnection.__paused=false;
    });
    //socks5 client====>
    webSocketConnection.on('message', function(message) {
        if (message.type === 'binary') {
            var buffer = message.binaryData;
            if (self.wsPackageSeq == 0) {
                binary.stream(buffer).word8('ver').word8('nmethods').buffer('methods', 'nmethods').tap(function(args) {
                    // debug(args);
                })
                self.wsPackageSeq++;
                tcpClient.write(buffer);
            } else if (self.wsPackageSeq == 1) {
                binary.stream(buffer).word8('ver').word8('cmd').word8('rsv').word8('atyp').tap(function(args) {
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
                    }
                }).word16bu('dst.port').tap(function(args) {
                    if (args.cmd === RFC_1928_COMMANDS.UDP_ASSOCIATE) {
                        debug(args);
                        //获取端口和目的
                        //创建一个udp 客户端
                        self.tunnelUdpClient = dgram.createSocket('udp4');
                        self.tunnelUdpClient.on('listening', function() {
                            //客户端准备好之后 发送数据包通知 tunnel udp server
                            // debug('tunnelUdpClient bind');
                            var pkg = {
                                'TunnelClientID': self.connectionVO['TunnelClientID'],
                                'ConnectionID': self.connectionVO['ConnectionID'],
                                'Cmd': 'Init'
                            }
                            var uBuffer = new Buffer(JSON.stringify(pkg));
                            self.tunnelUdpClient.send(uBuffer, 0, uBuffer.length, serverOptions['udpServerPort'], serverOptions['udpServerHost'], function(error) {
                                if (error) {
                                    debug('tunnelUdpClient send error', error);
                                }
                            });
                            tcpClient.write(buffer);
                        });
                        //收到tunnel udp server 的数据包
                        self.tunnelUdpClient.on('message', function(message, remote) {
                            var pkg = JSON.parse(message.toString('utf8'));
                            if (pkg && pkg['TunnelClientID'] == self.connectionVO['TunnelClientID'] && self.connectionVO['ConnectionID']) {
                                //分解udp 数据包
                                if (pkg['Data']) {
                                    var uBuffer = new Buffer(pkg['Data'], 'base64');
                                    self.processUdpFromTunnel(uBuffer);
                                }
                            }
                        });
                        self.tunnelUdpClient.bind();
                    } else {
                        //非udp 的全部转发
                        tcpClient.write(buffer);
                    }
                });
                self.wsPackageSeq++;
            } else {
                tcpClient.write(buffer);
            }
        }
    });
    //
    webSocketConnection.on("overflow", function() {
        debug('webSocketConnection overflow tcpClient pause');
        tcpClient.pause();
    });
    //
    webSocketConnection.socket.on("drain", function() {
        debug('webSocketConnection drain tcpClient resume');
        tcpClient.resume();
    });
    //
    webSocketConnection.on("error", function(err) {
        debug('webSocketConnection error');
        tcpClient.destroy();
    });
    webSocketConnection.on("close", function(err) {
        debug('webSocketConnection close');
        tcpClient.destroy();
    });
    //socks5 server ===> tunnel ======>socks5 client
    tcpClient.on("data", function(buffer) {
        if (self.tcpPackageSeq == 0) {
            binary.stream(buffer).word8('ver').word8('methods').tap(function(args) {
                // debug('=========>tcp client args ', args);
            });
            self.tcpPackageSeq++;
            webSocketConnection.sendBytes(buffer);
        } else if (self.tcpPackageSeq == 1) {
            //获取request 
            binary.stream(buffer).word8('ver').word8('rep').word8('rsv').word8('atyp').tap(function(args) {
                args.bnd = {};
                if (args.atyp === RFC_1928_ATYP.IPV4) {
                    this.buffer('addr.buf', 4).tap(function(args) {
                        args.bnd.addr = [].slice.call(args.addr.buf).join('.');
                    });
                    // domain name
                } else if (args.atyp === RFC_1928_ATYP.DOMAINNAME) {
                    this.word8('addr.size').buffer('addr.buf', 'addr.size').tap(function(args) {
                        args.bnd.addr = args.addr.buf.toString();
                    });
                    // ipv6
                } else if (args.atyp === RFC_1928_ATYP.IPV6) {
                    this.word32be('addr.a').word32be('addr.b').word32be('addr.c').word32be('addr.d').tap(function(args) {
                        args.bnd.addr = ['a', 'b', 'c', 'd'].map(function(x) {
                            return args.addr[x].toString(16);
                        });
                    });
                }
            }).word16bu('bnd.port').tap(function(args) {
                debug(args);
                //这里要创建发送的udp client
                self.udpClient = dgram.createSocket('udp4');
                self.udpClient.on('message', function(message, remote) {
                    //通过 tunnel udp client 打包发出去
                    debug('udpClient recv message:%s', message, remote);
                    var pkg = {
                        'TunnelClientID': self.connectionVO['TunnelClientID'],
                        'ConnectionID': self.connectionVO['ConnectionID'],
                        'Cmd': 'Relay',
                        'Data': message.toString('base64')
                    };
                    var uBuffer = new Buffer(JSON.stringify(pkg));
                    self.tunnelUdpClient.send(uBuffer, 0, uBuffer.length, serverOptions['udpServerPort'], serverOptions['udpServerHost'], function(error) {
                        if (error) {
                            debug('tunnelUdpClient send error', error);
                        }
                    });
                });
                self.udpClient.bind();
            });
            self.tcpPackageSeq++;
            webSocketConnection.sendBytes(buffer);
        } else {
            webSocketConnection.sendBytes(buffer);
        }
    });
    //
    tcpClient.on("drain", function() {
        debug('tcpClient drain webSocketConnection.socket.resume');
        webSocketConnection.socket.resume();
    });
    //
    tcpClient.on("close", function() {
        debug('tcpClient close');
        webSocketConnection.close();
    });
    //
    tcpClient.on('error', function(error) {
        //
        debug('tcpClient error:%s', error);
        webSocketConnection.close();
    });
}
WebSocketTcpSocketRelay.prototype.processUdpFromTunnel = function(buffer) {
    var self = this;
    binary.stream(buffer).word16bu('rsv').word8('fag').word8('atyp').tap(function(args) {
        args.dst = {};
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
        }
    }).word16bu('dst.port').tap(function(args) {
        this.buffer('userdata', buffer.length).tap(function(args) {
            debug('processUdpFromTunnel', args);
            //debug(args, args.userdata.toString('utf8'));
            //send to target
            if (args.userdata && self.udpClient) {
                var uBuff = args.userdata;
                self.udpClient.send(uBuff, 0, uBuff.length, args.dst.port, args.dst.addr, function(error) {
                    if (error) {
                        debug('udpClient Send error:%s', error);
                    }
                });
            }
        });
        // self.socks5UdpHost = args.bnd.addr;
        // self.socks5UdpPort = args.bnd.port;
    });
}
var TunnelClient = function(options) {
    EventEmitter.call(this);
    //参数
    this.options = _.defaults(options, {
        'wsServer': 'ws://127.0.0.1:8000',
        'remote_host': '127.0.0.1',
        'remote_port': '80',
        'heartbeat': 15000,
        'udpServerHost': '',
        'udpServerPort': 8000,
        'auth': {}
    });
    //
    this._reConnectTimer = null;
    this._pintInterval = null;
    debug('init...');
};
TunnelClient.prototype.reconnect = function() {
    var self = this;
    //reconnect...
    if (self._reConnectTimer) {
        clearTimeout(self._reConnectTimer);
    }
    self._reConnectTimer = setTimeout(function() {
        self.start();
    }, 2000);
    debug('reconnect after 2000ms');
};
TunnelClient.prototype.start = function() {
    debug('starting...');
    var self = this;
    var options = self.options;
    var wsUrl = options['wsServer'] + "/?auth=" + JSON.stringify(options['auth']);
    //判断ws是否存在
    if (this.wsClient) {
        this.wsClient = null;
    }
    //初始化websocket client
    this.wsClient = new WebSocketClient();
    this.wsClient.connect(wsUrl, 'tunnel-protocol');
    this.wsClient.on('connect', function(webSocketConnection) {
        //
        debug('wsClient connect');
        //
        webSocketConnection.on('message', function(message) {
            //
            if (message.type === 'utf8') {
                //var parsing = message.utf8Data.split(":");
                debug('websocket connection recv:%s', message.utf8Data);
                var msg = message.utf8Data;
                var connectionVO = null;
                try {
                    connectionVO = JSON.parse(msg);
                } catch (e) {}
                if (connectionVO) {
                    //创建data传输的websocket client
                    var wsClientData = new WebSocketClient();
                    wsClientData.connect(options['wsServer'] + "/?connect=" + msg, 'tunnel-protocol');
                    wsClientData.on('connect', function(webSocketConnection) {
                        //当连接成功后,暂停socket接收
                        wsClientData.socket.pause();
                        //创建tcp
                        new WebSocketTcpSocketRelay(webSocketConnection, options, connectionVO);
                    });
                }
            }
        });
        //
        webSocketConnection.on('frame', function(webSocketFrame) {
            //
        });
        webSocketConnection.on('close', function(reasonCode, description) {
            //
            debug('wsClient connection close! reasonCode:%s description:%s', reasonCode, description);
            self.reconnect();
        });
        webSocketConnection.on('error', function(error) {
            //
            debug('wsClient connection error:%s', error);
        });
        webSocketConnection.on('ping', function(cancel, data) {
            //
        });
        webSocketConnection.on('pong', function(data) {
            //
        });
    });
    this.wsClient.on('connectFailed', function(errorDescription) {
        //
        debug('wsClient connect fail...');
        self.reconnect();
    });
};
util.inherits(TunnelClient, EventEmitter);
module.exports = TunnelClient;