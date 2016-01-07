var debug = require('debug')('dmx-tunnel-client'),
    md5 = require('md5'),
    os = require('os'),
    macaddress = require('macaddress');
require('events').EventEmitter.defaultMaxListeners = Infinity;
process.setMaxListeners(0);
//================
var deviceID = null;
var macInfo = macaddress.networkInterfaces();
if (macInfo['eth0'] && macInfo['eth0']['mac']) {
    deviceID = md5(macInfo['eth0']['mac']).toUpperCase();
}
if (macInfo['en5'] && macInfo['en5']['mac']) {
    deviceID = md5(macInfo['en5']['mac']).toUpperCase();
}
if (!deviceID) {
    debug('can\'t get device id');
    process.exit();
}
debug('DeviceID:%s', deviceID);

var osInfo = {
    'hostname': os.hostname(),
    'arch': os.arch(),
    'cpus': os.cpus(),
    'freemem': os.freemem(),
    'homedir': os.homedir(),
    'loadavg': os.loadavg(),
    'networkInterfaces': os.networkInterfaces(),
    'platform': os.platform(),
    'release': os.release(),
    'tmpdir': os.tmpdir(),
    'totalmem': os.totalmem(),
    'type': os.type(),
    'uptime': os.uptime()
};
//=======
var proxyOptions = {
    'addr': '127.0.0.1',
    'port': 0
};
//代理服务器
var socks5 = require('./lib/socks5'),
    server = socks5.createServer();
//本地监听socket5 的端口  tunnel 需要转发到此端口
server.listen(proxyOptions.port, proxyOptions.addr, function() {
    // debug(server.address().addr);
    proxyOptions['port'] = server.address().port;
    debug('socks5 proxy server start success! host: %s,listen port: %d', proxyOptions['addr'], proxyOptions['port']);
    initTunnelClient(proxyOptions);
});
//初始化tunnel client
function initTunnelClient(proxyOptions) {
    //
    var tunnelClientOptions = {
        'udpServerHost': '127.0.0.1',
        'udpServerPort': '8000',
        'wsServer': 'ws://127.0.0.1:8000',
        //转发到目的地址
        'remote_host': proxyOptions['addr'],
        //转发到目的端口
        'remote_port': proxyOptions['port'],
        //鉴权的结构
        'auth': {
            'DeviceID': deviceID,
            'DeviceInfo': osInfo
        }
    };
    var TunnelClient = require('./lib/tunnel-client');
    var tunnelClient = new TunnelClient(tunnelClientOptions);
    tunnelClient.start();
}
