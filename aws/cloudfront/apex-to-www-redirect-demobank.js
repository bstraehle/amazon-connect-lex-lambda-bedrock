function handler(event) {
    var request = event.request;
    var host = request.headers.host.value;
    
    if (host === 'demobank.ai' || host === 'demobank.si') {
        
        var response = {
            statusCode: 301,
            statusDescription: 'Moved Permanently',
            headers: {
                'location': {
                    value: 'https://www.' + host + '/'
                }
            }
        };
        return response;
    }
    
   return request;
}