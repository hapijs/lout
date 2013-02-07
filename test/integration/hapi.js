// Load modules

var Chai = require('chai');
var Hapi = require('hapi');
var Package = require('../../package.json');
var LoutPlugin = process.env.TEST_COV ? require('../../lib-cov') : require('../../lib');


// Declare internals

var internals = {};


// Test shortcuts

var expect = Chai.expect;
var S = Hapi.types.String;


describe('Docs Generator', function () {

    var _routeTemplate = '{{#each routes}}{{this.method}}|{{/each}}';
    var _indexTemplate = '{{#each routes}}{{this.path}}|{{/each}}';
    var _server = null;
    var _serverWithoutPost = null;

    var handler = function (request) {

        request.reply('ok');
    };

    function setupServer(done) {

        _server = new Hapi.Server();
        _server.route([
            { method: 'GET', path: '/test', config: { handler: handler, query: { param1: S().required() } } },
            { method: 'POST', path: '/test', config: { handler: handler, query: { param2: S().valid('first', 'last') } } },
            { method: 'GET', path: '/notincluded', config: { handler: handler, docs: false } }
        ]);

        var plugin = {
            name: 'lout',
            version: Package.version,
            hapi: Package.hapi,
            register: LoutPlugin.register
        };

        _server.plugin().register(plugin, { plugin: { routeTemplate: _routeTemplate, indexTemplate: _indexTemplate } }, function () {

            done();
        });
    }

    function setupServerWithoutPost(done) {

        _serverWithoutPost = new Hapi.Server();
        _serverWithoutPost.route({ method: 'GET', path: '/test', config: { handler: handler, query: { param1: S().required() } } });

        var plugin = {
            name: 'lout',
            version: Package.version,
            hapi: Package.hapi,
            register: LoutPlugin.register
        };

        _serverWithoutPost.plugin().register(plugin, function () {

            done();
        });
    }

    function makeRequest(path, callback) {

        var next = function (res) {

            return callback(res.result);
        };

        _server.inject({
            method: 'get',
            url: path
        }, next);
    }

    before(setupServer);

    it('shows template when correct path is provided', function (done) {

        makeRequest('/docs?path=/test', function (res) {

            expect(res).to.equal('GET|POST|');
            done();
        });
    });

    it('has a Not Found response when wrong path is provided', function (done) {

        makeRequest('/docs?path=blah', function (res) {

            expect(res.error).to.equal('Not Found');
            done();
        });
    });

    it('displays the index if no path is provided', function (done) {

        makeRequest('/docs', function (res) {

            expect(res).to.equal('/test|/test|');
            done();
        });
    });

    it('the index does\'t have the docs endpoint listed', function (done) {

        makeRequest('/docs', function (res) {

            expect(res).to.not.contain('/docs');
            done();
        });
    });

    it('the index does\'t include routes that are configured with docs disabled', function (done) {

        makeRequest('/docs', function (res) {

            expect(res).to.not.contain('/notincluded');
            done();
        });
    });

    describe('Index', function () {

        before(setupServerWithoutPost);

        it('doesn\'t throw an error when requesting the index when there are no POST routes', function (done) {

            _serverWithoutPost.inject({
                method: 'get',
                url: '/docs'
            }, function (res) {

                expect(res).to.exist;
                expect(res.result).to.contain('/test');
                done();
            });
        });
    });
});