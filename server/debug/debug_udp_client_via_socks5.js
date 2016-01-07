var Socks = require('socks'),
    dgram = require('dgram'),
    debug = require('debug')('debug-udp-socks5-client'),
    program = require('commander');
//
program.version('1.0.0').option('-p, --port <port>', 'port', parseInt).option('-h, --host <host>', 'host').parse(process.argv);
if (!program.host || !program.port) {
    program.help();
}
//
var options = {
    proxy: {
        ipaddress: program.host,
        port: program.port,
        type: 5,
        command: "associate" // Since we are using associate, we must specify it here.
    },
    target: {
        // When using associate, either set the ip and port to 0.0.0.0:0 or the expected source of incoming udp packets.
        // Note: Some SOCKS servers MAY block associate requests with 0.0.0.0:0 endpoints.
        // Note: ipv4, ipv6, and hostnames are supported here.
        host: "0.0.0.0", // ip 接收信息的端口
        port: 0 //接收信息的端口
    }
};
Socks.createConnection(options, function(err, socket, info) {
    if (err) {
        debug(err);
    } else {
        // Associate request has completed.
        // info object contains the remote ip and udp port to send UDP packets to.
        //fan 
        debug(info);
        // { port: 42803, host: '202.101.228.108' }
        var udp = dgram.createSocket('udp4');
        udp.bind(); //本地绑定的端口
        udp.on('message', function(message, remote) {
            debug('recv message from udp server: %s:%d msg:%s', remote.address, remote.port, message);
        });
        // In this example we are going to send "Hello" to 1.2.3.4:2323 through the SOCKS proxy.
        var pack = Socks.createUDPFrame({
            host: "192.168.89.121", //目标IP
            port: 33333 //目标端口
        }, new Buffer("hello:" + Date.now()));
        // Send Packet to Proxy UDP endpoint given in the info object.
        for (var i = 0; i < 100; i++) {
            setTimeout(function() {
                udp.send(pack, 0, pack.length, info.port, info.host, function(error) {
                    if (!error) {
                        debug('send success!');
                    }
                });
            }, 1);
        }
    }
});