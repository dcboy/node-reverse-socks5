var PORT = 33333;
var HOST = '192.168.89.91';
var dgram = require('dgram');
var message = new Buffer('My KungFu is Good!');

var client = dgram.createSocket('udp4');

client.bind(33335);

client.on('message', function (message, remote) {
    console.log('recv message from udp server: '+remote.address + ':' + remote.port +' - ' + message);
});


client.send(message, 0, message.length, PORT, HOST, function(err, bytes) {
    if (err) throw err;
    console.log('UDP message sent to ' + HOST + ':' + PORT);
   // client.close();
});
