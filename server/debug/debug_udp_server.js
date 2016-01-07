var PORT = 33333;
var HOST = '0.0.0.0';
var dgram = require('dgram');
var server = dgram.createSocket('udp4');
server.on('listening', function() {
    var address = server.address();
    console.log('UDP Server listening on ' + address.address + ":" + address.port);
});
server.on('message', function(message, remote) {
    console.log(remote.address + ':' + remote.port + ' - ' + message);
    message = 'recv:' + message;
    server.send(message, 0, message.length, remote.port, remote.address, function(err, bytes) {
        if (err) throw err;
        console.log('UDP message sent to ' + remote.address + ':' + remote.port);
    });
});
server.bind(PORT, HOST);