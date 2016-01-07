var request = require('request'),
    debug = require('debug')('api-client'),
    md5 = require('md5');
var api_client = function(options) {
    this.options = options;
    this.signParams = function(params) {
        if (params['Sign']) {
            delete params['Sign'];
        }
        var signStr = 'BizContent=' + params['BizContent'] + '&Method=' + params['Method'] + this.options['AppKey'];
        return md5(signStr);
    }
};
//设备上线提交api
api_client.prototype.post = function(method, params, cb) {
    var formData = {
        'Method': method,
        'BizContent': JSON.stringify(params)
    }
    formData['Sign'] = this.signParams(formData);
    request.post({
        url: this.options.Url,
        form: formData
    }, function(err, httpResponse, body) {
        if (err || httpResponse.statusCode != 200) {
            cb(err);
        } else {
            try {
                cb(null, JSON.parse(body));
            } catch (e) {
                cb(null, {});
            }
        }
    })
};
module.exports = api_client;