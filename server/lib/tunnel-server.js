var _ = require('lodash'),
    util = require('util'),
    debug = require('debug')('tunnel-server'),
    http = require('http'),
    dgram = require('dgram'),
    WebSocketServer = require('websocket').server,
    url = require("url"),
    uuid = require('uuid'),
    md5 = require('md5'),
    TunnelRequest = require('./tunnel-request'),
    EventEmitter = require('events').EventEmitter,
    ApiClient = require('./api-client');
/*
Tunnel Server class
*/
function TunnelServer(options, apiOptions) {
    EventEmitter.call(this);
    this.options = _.defaults(options, {
        //ws 监听端口
        'port': 8000
    });
    this.apiOptions = apiOptions;
    this.apiClient = new ApiClient(this.apiOptions);
    debug('init...');
    //存放所有tunnelClient
    this._tunnelClients = {};
}
/*
start listen
*/
TunnelServer.prototype.start = function() {
    debug('starting...');
    var self = this;
    //创建udp服务器
    self.udpServer = dgram.createSocket('udp4');
    self.udpServer.on('listening', function() {
        var address = self.udpServer.address();
        debug('UDP Server listening on ' + address.address + ":" + address.port);
    });
    self.udpServer.on('error', function(error) {
        if (error) {
            debug('udp server has error:%s', error.code);
            process.exit();
        }
    });
    self.udpServer.bind(self.options.udpPort, '0.0.0.0');
    //==================
    //http server
    this.httpServer = http.createServer(function(request, response) {
        response.writeHead(404);
        return response.end();
    });
    //websocket server
    this.wsServer = new WebSocketServer({
        httpServer: this.httpServer,
        autoAcceptConnections: false
    });
    //
    this.httpServer.listen(self.options.port, '0.0.0.0', function() {
        debug("tunnel server is listening on port " + self.options.port);
        //上报
    });
    //处理请求
    this.wsServer.on('request', function(webSocketRequest) {
        //获取当前请求的url
        var uri = url.parse(webSocketRequest.httpRequest.url, true);
        //判断请求是否合法
        if (uri.query.auth != undefined) {
            //websocket client 带的auth 参数
            var tunnelClient = _.defaults(JSON.parse(uri.query.auth), {
                'DeviceID': ''
            });
            tunnelClient['ProxyAddress'] = self.options['proxyAddress'];
            //判断设备是否存在
            if (!tunnelClient['DeviceID'] || tunnelClient['DeviceID'] == '') {
                webSocketRequest.reject();
                return;
            }
            //随机生成一个tunnel client id
            var tunnelClientID = md5(tunnelClient['DeviceID']);
            //判断客户端是否创建了连接
            if (self._tunnelClients[tunnelClientID]) {
                self._tunnelClients[tunnelClientID].close();
            }
            //新建一个tunnel-request
            var webSocketConnection = webSocketRequest.accept('tunnel-protocol', webSocketRequest.origin);
            var tunnelRequest = new TunnelRequest(tunnelClientID, tunnelClient, webSocketConnection, self.udpServer, self.apiClient);
            //放入客户端中
            self._tunnelClients[tunnelClientID] = tunnelRequest;
            //当断开连接的时候
            tunnelRequest.on('close', function(tunnelClientID) {
                var tunnelClient = self._tunnelClients[tunnelClientID];
                if (tunnelClient) {
                    delete self._tunnelClients[tunnelClientID];
                }
                debug('tunnel client close ID:%s', tunnelClientID);
            });
            debug('tunnel client request success', tunnelClient);
        }
        if (uri.query.connect != undefined) {
            var connectInfo = JSON.parse(uri.query.connect);
            if (connectInfo) {
                //找到tunnelID
                if (self._tunnelClients[connectInfo['TunnelClientID']]) {
                    self._tunnelClients[connectInfo['TunnelClientID']].relay(webSocketRequest, connectInfo);
                }
            }
        }
        //udp 转发
        if (uri.query.udp != undefined) {
            //udp 的数据
            var connectInfo = JSON.parse(uri.query.connect);
            if (connectInfo) {
                if (self._tunnelClients[connectInfo['TunnelClientID']]) {
                    // self._tunnelClients[connectInfo['TunnelClientID']].relay(webSocketRequest, connectInfo);
                }
            }
        }
    });
    //
    this.wsServer.on('connect', function(webSocketConnection) {
        //
    });
    //
    this.wsServer.on('close', function(webSocketConnection, closeReason, description) {
        //
    });
}
util.inherits(TunnelServer, EventEmitter);
module.exports = TunnelServer;