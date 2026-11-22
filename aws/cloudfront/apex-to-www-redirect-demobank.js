// Redirects the apex domains to www, keeping the path and query string.
function handler(event) {
    var request = event.request;
    var host = request.headers.host.value;

    if (host === 'demobank.ai' || host === 'demobank.si') {
        return {
            statusCode: 301,
            statusDescription: 'Moved Permanently',
            headers: {
                'location': {
                    value: 'https://www.' + host + request.uri + queryString(request.querystring)
                }
            }
        };
    }

    return request;
}

// Rebuilds the query string, including repeated parameters; values stay as received (URL-encoded).
function queryString(querystring) {
    var parts = [];
    for (var name in querystring) {
        var param = querystring[name];
        var values = param.multiValue ? param.multiValue : [param];
        for (var i = 0; i < values.length; i++) {
            parts.push(name + '=' + values[i].value);
        }
    }
    return parts.length ? '?' + parts.join('&') : '';
}
