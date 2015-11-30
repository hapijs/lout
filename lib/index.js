'use strict';

// Load modules
var Joi = require('joi');
var Boom = require('boom');
var Hoek = require('hoek');
var Path = require('path');
var Handlebars = require('handlebars');


// Declare internals

var internals = {
    defaults: {
        endpoint: '/docs',
        auth: false,
        apiVersion: null,
        basePath: Path.join(__dirname, '..', 'templates'),
        cssPath: Path.join(__dirname, '..', 'public', 'css'),
        helpersPath: Path.join(__dirname, '..', 'templates', 'helpers'),
        partialsPath: Path.join(__dirname, '..', 'templates'),
        indexTemplate: 'index',
        routeTemplate: 'route',
        methodsOrder: ['get', 'head', 'post', 'put', 'patch', 'delete', 'trace', 'options'],
        filterRoutes: null
    },
    options: Joi.object({
        engines: Joi.object(),
        endpoint: Joi.string(),
        apiVersion: Joi.string().allow(null),
        basePath: Joi.string(),
        cssPath: Joi.string().allow(null),
        helpersPath: Joi.string(),
        partialsPath: Joi.string(),
        auth: Joi.object(),
        indexTemplate: Joi.string(),
        routeTemplate: Joi.string(),
        filterRoutes: Joi.func()
    })
};


exports.register = function (plugin, options, pluginNext) {

    var validateOptions = internals.options.validate(options);
    if (validateOptions.error) {
        return pluginNext(validateOptions.error);
    }

    var settings = Hoek.clone(internals.defaults);
    Hoek.merge(settings, options);

    if (settings.endpoint[0] !== '/') {
        settings.endpoint = '/' + settings.endpoint;
    }

    if (settings.endpoint.length > 1 && settings.endpoint[settings.endpoint.length - 1] === '/') {
        settings.endpoint = settings.endpoint.slice(0, -1);
    }

    var cssBaseUrl = (settings.endpoint === '/' ? '' : settings.endpoint) + '/css';

    plugin.dependency(['inert', 'vision'], function (server, serverNext) {

        server.views({
            engines: settings.engines || {
                html: {
                    module: Handlebars.create()
                }
            },
            path: settings.basePath,
            partialsPath: settings.partialsPath,
            helpersPath: settings.helpersPath,
            runtimeOptions: {
                data: {
                    cssBaseUrl: cssBaseUrl.replace(/(.*?)((\/\w+)?\/css)/, '$2'),
                    apiVersion: settings.apiVersion
                }
            }
        });

        server.route({
            method: 'GET',
            path: settings.endpoint,
            config: internals.docs(settings, server)
        });

        if (settings.cssPath) {
            server.route({
                method: 'GET',
                path: cssBaseUrl + '/{path*}',
                config: {
                    handler: {
                        directory: {
                            path: settings.cssPath,
                            index: false,
                            listing: false
                        }
                    },
                    plugins: {
                        lout: false
                    },
                    auth: settings.auth
                }
            });
        }

        serverNext();
    });

    pluginNext();
};


exports.register.attributes = {
    pkg: require('../package.json'),
    multiple: true
};


internals.docs = function (settings, server) {

    return {
        auth: settings.auth,
        validate: {
            query: {
                path: Joi.string(),
                server: Joi.string()
            }
        },
        handler: function (request, reply) {

            var routingTable = server.table();
            var connections = [];

            routingTable.forEach(function (connection) {

                if (request.query.server && connection.info.uri !== request.query.server) {
                    return;
                }

                connection.table = connection.table.filter(function (item) {

                    if (request.query.path && item.path !== request.query.path) {

                        return false;
                    }

                    return !item.settings.isInternal &&
                        item.settings.plugins.lout !== false &&
                        item.method !== 'options' &&
                        (!settings.filterRoutes || settings.filterRoutes({
                            method: item.method,
                            path: item.path,
                            connection: connection
                        }));
                }).sort(function (route1, route2) {

                    if (route1.path > route2.path) {
                        return 1;
                    }

                    if (route1.path < route2.path) {
                        return -1;
                    }

                    return settings.methodsOrder.indexOf(route1.method) - settings.methodsOrder.indexOf(route2.method);
                });

                connections.push(connection);
            });

            if (connections.every(function (connection) {

                return !connection.table.length; })) {
                return reply(Boom.notFound());
            }

            if (request.query.path && request.query.server) {
                return reply.view(settings.routeTemplate, internals.getRoutesData(connections[0].table));
            }

            return reply.view(settings.indexTemplate, internals.getConnectionsData(connections));
        },
        plugins: {
            lout: false
        }
    };
};


internals.getConnectionsData = function (connections) {

    connections.forEach(function (connection) {

        connection.table = internals.getRoutesData(connection.table);
    });

    return connections;
};


internals.getRoutesData = function (routes) {

    return routes.map(function (route) {

        return {
            path: route.path,
            method: route.method.toUpperCase(),
            description: route.settings.description,
            notes: internals.processNotes(route.settings.notes),
            tags: route.settings.tags,
            auth: route.connection.auth.lookup(route),
            vhost: route.settings.vhost,
            cors: route.settings.cors,
            jsonp: route.settings.jsonp,
            pathParams: internals.describe(route.settings.validate.params),
            queryParams: internals.describe(route.settings.validate.query),
            payloadParams: internals.describe(route.settings.validate.payload),
            responseParams: internals.describe(route.settings.response.schema),
            statusSchema: internals.describeStatusSchema(route.settings.response.status)
        };
    });
};

internals.describe = function (params) {

    if (params === null || typeof params !== 'object') {

        return null;
    }

    var description = Joi.compile(params).describe();
    description = internals.getParamsData(description);
    description.root = true;
    return description;
};

internals.describeStatusSchema = function (status) {

    var codes = Object.keys(status || {});
    if (!codes.length) {
        return;
    }

    var result = {};
    codes.forEach(function (code) {

        result[code] = internals.describe(status[code]);
    });
    return result;
};


internals.getParamsData = function (param, name, typeName) {

    // Detection of "false" as validation rule
    if (!name && param.type === 'object' && param.children && Object.keys(param.children).length === 0) {

        return {
            isDenied: true
        };
    }

    // Detection of conditional alternatives
    if (param.ref && param.is) {

        return {
            condition: {
                key: param.ref.substr(4), // removes 'ref:'
                value: internals.getParamsData(param.is, undefined, param.is.type)
            },
            then: param.then && internals.getParamsData(param.then, undefined, param.then.type),
            otherwise: param.otherwise && internals.getParamsData(param.otherwise, undefined, param.otherwise.type)
        };
    }

    var type;
    if (param.valids && param.valids.some(Joi.isRef)) {
        type = 'reference';
    }
    else {
        type = param.type;
    }

    var data = {
        typeIsName: !name && !!typeName,
        name: name || typeName,
        description: param.description,
        notes: internals.processNotes(param.notes),
        tags: param.tags,
        meta: param.meta,
        unit: param.unit,
        type: type,
        allowedValues: type !== 'reference' && param.valids ? internals.getExistsValues(type, param.valids) : null,
        disallowedValues: type !== 'reference' && param.invalids ? internals.getExistsValues(type, param.invalids) : null,
        examples: param.examples,
        peers: param.dependencies && param.dependencies.map(internals.formatPeers),
        target: type === 'reference' ? internals.getExistsValues(type, param.valids) : null,
        flags: param.flags && {
            allowUnknown: param.flags.allowUnknown,
            default: param.flags.default,
            encoding: param.flags.encoding, // binary specific
            insensitive: param.flags.insensitive, // string specific
            required: param.flags.presence === 'required',
            forbidden: param.flags.presence === 'forbidden',
            stripped: param.flags.strip
        }
    };

    if (data.type === 'object') {
        var children = [];

        if (param.children) {
            var childrenKeys = Object.keys(param.children);
            children = children.concat(childrenKeys.map(function (key) {

                return internals.getParamsData(param.children[key], key);
            }));
        }

        if (param.patterns) {
            children = children.concat(param.patterns.map(function (pattern) {

                return internals.getParamsData(pattern.rule, pattern.regex);
            }));
        }

        data.children = children;
    }

    if (data.type === 'array' && param.items) {

        if (param.orderedItems) {
            data.orderedItems = param.orderedItems.map(function (item) {

                return internals.getParamsData(item);
            });
        }

        data.items = [];
        data.forbiddenItems = [];
        param.items.forEach(function (item) {

            item = internals.getParamsData(item);
            if (item.flags && item.flags.forbidden) {
                data.forbiddenItems.push(item);
            }
            else {
                data.items.push(item);
            }
        });
    }

    if (data.type === 'alternatives') {
        data.alternatives = param.alternatives.map(function (alternative) {

            return internals.getParamsData(alternative);
        });
    }
    else  {
        data.rules = {};
        if (param.rules) {
            param.rules.forEach(function (rule) {

                data.rules[internals.capitalize(rule.name)] = internals.processRuleArgument(rule);
            });
        }

        // If we have only one specific rule then set that to our type for
        // brevity.
        var rules = Object.keys(data.rules);
        if (rules.length === 1 && !data.rules[rules[0]]) {
            data.rules = {};
            data.type = rules[0];
        }
    }

    return data;
};


internals.getExistsValues = function (type, exists) {

    var values = exists.filter(function (value) {

        if (typeof value === 'string' && value.length === 0) {
            return false;
        }

        if (type === 'number' && Math.abs(value) === Infinity) {
            return false;
        }

        return true;
    }).map(function (value) {

        if (Joi.isRef(value)) {

            return (value.isContext ? '$' : '') + value.key;
        }

        return JSON.stringify(value);
    });

    return values.length ? values.join(', ') : null;
};


internals.capitalize = function (string) {

    return string.charAt(0).toUpperCase() + string.slice(1);
};


internals.formatPeers = function (condition) {

    if (condition.key) {

        return 'Requires ' + condition.peers.join(', ') + ' to ' + (condition.type === 'with' ? '' : 'not ') +
            'be present when ' + condition.key + ' is.';
    }

    return 'Requires ' + condition.peers.join(' ' + condition.type + ' ') + '.';
};


internals.formatReference = function (ref) {

    return (ref.isContext ? '$' : '') + ref.key;
};


internals.processRuleArgument = function (rule) {

    var arg = rule.arg;
    if (rule.name === 'assert') {

        return {
            key: internals.formatReference(arg.ref),
            value: internals.describe(arg.cast)
        };
    }
    else if (Joi.isRef(arg)) {
        return {
            ref: internals.formatReference(arg)
        };
    }

    return arg || '';
};

internals.processNotes = function (notes) {

    if (!notes) {
        return;
    }

    if (!Array.isArray(notes)) {
        return [notes];
    }

    return notes;
};
