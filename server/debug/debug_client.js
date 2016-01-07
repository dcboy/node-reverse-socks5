/*
socket proxy debug client
*/
var request = require('request');
var Agent = require('socks5-http-client/lib/Agent');
var debug = require('debug')('debug-client');

function req() {
    request.get({
        url: 'http://www.baidu.com',
        agentClass: Agent,
        agentOptions: {
            socksHost: '10.0.0.2', // Defaults to 'localhost'.
            socksPort: 35747 // Defaults to 1080.
        }
    }, function(err, res) {
        if (err) {
            debug(err);
        } else {
            debug(res.body.length);
        }
    });
}
for (var i = 0; i < 100; i++) {
    setTimeout(req, i * 1);
}
