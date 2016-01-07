var _ = require('lodash'),
    util = require('util'),
    debug = require('debug')('tunnel-request'),
    net = require("net"),
    md5 = require('md5'),
    uuid = require('uuid'),
    dgram = require('dgram'),
    binary = require('binary'),
    SmartBuffer = require('smart-buffer'),
    ip = require('ip'),
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
//
var WebSocketTcpSocketRelay = function(tcpClient, tunnelClientID, connectionID, tunnelUdpServer) {
    EventEmitter.call(this);
    var self = this;
    this.tunnelUdpServer = tunnelUdpServer;
    this.tunnelClientID = tunnelClientID;
    this.connectionID = connectionID;
    this.tcpClient = tcpClient;
    this.clientAddress = tcpClient.remoteAddress;
    //这个udp 是接收内网的udp包 这个要释放
    this.udpClientServer = null;
    this.udpClientListenPort = 0;
    //远程tunnel udp 的 地址和port
    this.tunnelUdpRemoteAddr = null;
    this.tunnelUdpRemotePort = null;
    //回去的路径
    this.udpClientRemoteAddr = null;
    this.udpClientRemotePort = 0;
    //这里接收tunnelUdpServer 的 message
    this.tunnelUdpServer.on('message', function(message, remote) {
        var pkg = JSON.parse(message.toString('utf8'));
        if (pkg) {
            if (pkg['TunnelClientID'] == self.tunnelClientID && pkg['ConnectionID'] == self.connectionID) {
                //记录远程的 udp addr 和 port
                self.tunnelUdpRemoteAddr = remote.address;
                self.tunnelUdpRemotePort = remote.port;
                if (pkg['Cmd'] == 'Relay' && pkg['Data']) {
                    var uBuffer = new Buffer(pkg['Data'], 'base64');
                    //直接发送给客户端
                    if (self.udpClientServer && self.udpClientRemoteAddr && self.udpClientRemotePort) {
                        self.udpClientServer.send(uBuffer, 0, uBuffer.length, self.udpClientRemotePort, self.udpClientRemoteAddr, function(error) {
                            if (error) {
                                debug('udpClientServer send error', error);
                            }
                        });
                    }
                }
            }
        }
    });
};
WebSocketTcpSocketRelay.prototype.start = function(webSocketConnection) {
    this.tcpPackageSeq = 0;
    this.wsPackageSeq = 0;
    this.webSocketConnection = webSocketConnection;
    //
    debug('WebSocketTcpSocketRelay start connection id:%s', this.connectionID);
    var self = this;
    var tcpClient = this.tcpClient;
    //
    webSocketConnection.on('message', function(message) {
        if (message.type === 'binary') {
            var buffer = message.binaryData;
            if (self.wsPackageSeq == 0) {
                binary.stream(buffer).word8('ver').word8('methods').tap(function(args) {
                    // debug('===    ws args ', args);
                });
                self.wsPackageSeq++;
                tcpClient.write(buffer);
            } else if (self.wsPackageSeq == 1) {
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
                    // debug(args);
                    //这里重新构造数据包把本地的 udpClientServer 信息告诉他
                    // debug(self.tcpClient.localAddress);
                    var nBuff = new SmartBuffer();
                    nBuff.writeUInt8(args.ver);
                    nBuff.writeUInt8(args.rep);
                    nBuff.writeUInt8(args.rsv);
                    nBuff.writeUInt8(RFC_1928_ATYP.IPV4);
                    nBuff.writeBuffer(ip.toBuffer(self.tcpClient.localAddress));
                    nBuff.writeUInt16BE(self.udpClientListenPort);
                    tcpClient.write(nBuff.toBuffer());
                });
                self.wsPackageSeq++;
            } else {
                tcpClient.write(buffer);
            }
            //tcpClient.write(buffer);
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
        //self.close();
    });
    webSocketConnection.on("close", function(err) {
        debug('webSocketConnection close');
        tcpClient.destroy();
    });
    //socks5Client=====>tunnel
    tcpClient.on("data", function(buffer) {
        // debug('tcpClient recv data len:%d', buffer.length);
        if (self.tcpPackageSeq == 0) {
            binary.stream(buffer).word8('ver').word8('nmethods').buffer('methods', 'nmethods').tap(function(args) {
                // debug(args);
            })
            self.tcpPackageSeq++;
            webSocketConnection.sendBytes(buffer);
        } else if (self.tcpPackageSeq == 1) {
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
                    debug('udp cmd recv', args);
                    //这里要开udp 接收 记录开放的端口
                    self.udpClientServer = dgram.createSocket('udp4');
                    self.udpClientServer.on('message', function(message, remote) {
                        //记录回去的路径
                        self.udpClientRemoteAddr = remote.address;
                        self.udpClientRemotePort = remote.port;
                        debug('udpClientServer recv message', message, remote);
                        //这里需要把数据包通过tunnelUdpServer 组包发出去
                        var pkg = {
                            'TunnelClientID': self.tunnelClientID,
                            'ConnectionID': self.connectionID,
                            'Cmd': 'Relay',
                            'Data': message.toString('base64')
                        };
                        var uBuffer = new Buffer(JSON.stringify(pkg));
                        if (self.tunnelUdpServer) {
                            debug('udp data', uBuffer);
                            self.tunnelUdpServer.send(uBuffer, 0, uBuffer.length, self.tunnelUdpRemotePort, self.tunnelUdpRemoteAddr, function(error) {
                                if (error) {
                                    debug('tunnelUdpServer send error', error);
                                }
                            })
                        }
                    });
                    self.udpClientServer.on('listening', function(addr) {
                        self.udpClientListenPort = self.udpClientServer.address().port;
                        debug('udpClientListenPort:%d', self.udpClientListenPort);
                        webSocketConnection.sendBytes(buffer);
                    });
                    self.udpClientServer.bind();
                } else {
                    //非udp 的全部转发
                    webSocketConnection.sendBytes(buffer);
                }
            });
            self.socks5Package++;
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
        self.close();
    });
    //
    tcpClient.on('error', function(error) {
        //
        debug('tcpClient error:%s', error);
        self.close();
    });
    tcpClient.resume();
}
WebSocketTcpSocketRelay.prototype.close = function() {
    if (this.webSocketConnection) {
        this.webSocketConnection.close();
    }
    if (this.tcpClient) {
        this.tcpClient.destroy();
    }
    if (this.udpClientServer) {
        this.udpClientServer.close();
    }
    //关闭所有
    this.emit('close', this.connectionID);
};
util.inherits(WebSocketTcpSocketRelay, EventEmitter);
//
function TunnelRequest(tunnelClientID, tunnelClient, webSocketConnection, tunnelUdpServer, apiClient) {
    EventEmitter.call(this);
    var self = this;
    this.apiClient = apiClient;
    //客户端连接
    this._tcpClients = {};
    //这个是udp是外发的
    this.tunnelUdpServer = tunnelUdpServer;
    this.tunnelClientID = tunnelClientID;
    this.tunnelClient = tunnelClient;
    this.wsConnection = webSocketConnection;
    this.wsConnection.on('pong', function() {
        //提交api
        self.apiClient.post('ping', self.tunnelClient, function(err, data) {
            if (err) {
                debug(err);
            } else {
                if (data && data.error_code == 0) {
                    //debug('api tunnel client ping:%s', JSON.stringify(data));
                } else {
                    debug('api client connect ping:' + data.error_msg);
                }
            }
        });
    });
    //创建tcp
    this.tcpServer = new net.createServer();
    this.tcpServer.listen(0, '0.0.0.0', function() {
        //
        var tcp_listen_port = self.tcpServer.address().port;
        debug('TunnelID:%s TcpServer Listen:%d', self.tunnelClientID, tcp_listen_port);
        self.tunnelClient['ProxyPort'] = tcp_listen_port;
        self.apiClient.post('connect', self.tunnelClient, function(err, data) {
            if (err) {
                debug(err);
            } else {
                if (data && data.error_code == 0) {
                    debug('api tunnel client connect:%s', JSON.stringify(data));
                } else {
                    self.close();
                    debug('api client connect fail:' + data.error_msg);
                }
            }
        });
    });
    //
    this.tcpServer.on('connection', function(socket) {
        //
        socket.pause();
        var connectionID = md5(uuid.v1());
        //
        var msgConnection = JSON.stringify({
            'TunnelClientID': self.tunnelClientID,
            'ConnectionID': connectionID
        });
        //创建一个tcp的处理类
        //发送到控制ws
        var tcpClient = new WebSocketTcpSocketRelay(socket, tunnelClientID, connectionID, self.tunnelUdpServer);
        //断开连接的时候删除连接对象
        tcpClient.on('close', function(connectionID) {
            if (self._tcpClients[connectionID]) {
                delete self._tcpClients[connectionID];
            }
        });
        //放到连接集合
        self._tcpClients[connectionID] = tcpClient;
        //发送连接信息过去
        self.wsConnection.sendUTF(msgConnection);
    });
    //
    this.tcpServer.on('error', function(error) {
        //
        debug('tcpServer error:%s', error);
    });
    //主控tunnel ws
    this.wsConnection.on('message', function(message) {
        //
        debug('tunnel client connect and list port client:%s port:%d', JSON.stringify(client), listen_port);
    });
    //主控tunnel ws
    this.wsConnection.on('error', function(error) {
        //
        debug('wsConnection error', error);
        self.close();
    });
    //主控tunnel ws
    this.wsConnection.on('close', function(reasonCode, description) {
        debug('wsConnection close reasonCode:%s description:%s', reasonCode, description);
        self.close();
    });
}
//客户端请求建立连接
TunnelRequest.prototype.relay = function(webSocketRequest, connectInfo) {
    var self = this;
    //收到新的请求,判断此请求的connectInfo 是否合法
    var tcpClient = self._tcpClients[connectInfo['ConnectionID']];
    if (tcpClient) {
        //开始转发
        var webSocketConnection = webSocketRequest.accept('tunnel-protocol', webSocketRequest.origin);
        tcpClient.start(webSocketConnection);
    } else {
        webSocketRequest.reject();
    }
}
TunnelRequest.prototype.close = function() {
    //关闭
    try {
        if (this.wsConnection) {
            this.wsConnection.close();
        }
    } catch (e) {}
    //
    _.each(this._tcpClients, function(client, key) {
        client.close();
    });
    //api 
    this.apiClient.post('disconnect', this.tunnelClient, function(err, data) {
        if (err) {
            debug(err);
        } else {
            if (data && data.error_code == 0) {
                debug('api tunnel client disconnect:%s', JSON.stringify(data));
            } else {
                debug('api client connect fail:' + data.error_msg);
            }
        }
    });
    this.emit('close', this.tunnelClientID);
};
//exports
util.inherits(TunnelRequest, EventEmitter);
module.exports = TunnelRequest;