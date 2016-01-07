var debug = require('debug')('dmx-tunnel-server');
require('events').EventEmitter.defaultMaxListeners = Infinity;
process.setMaxListeners(0);
var apiOptions = {
    'Url': 'http://dev.sunlight-tech.com/proxy/gateway/index',
    'AppKey': 'nXsG55s5TeKiBIO7'
};
// var ApiClient = require('./lib/api-client');
// var apiClient = new ApiClient(apiOptions);
//服务器监听的端口
var serverOptions = {
    // 'udpPort': 53, //DNS 端口 防止被防火墙屏蔽
    'udpPort': 8000, //DNS 端口 防止被防火墙屏蔽
    'port': 8000,
    'proxyAddress': '127.0.0.1' //服务器的局域网IP,上报到API 提供PHP 连接
};
var TunnelServer = require('./lib/tunnel-server');
var tunnelServer = new TunnelServer(serverOptions,apiOptions);
tunnelServer.start();