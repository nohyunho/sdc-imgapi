#!/usr/bin/env node
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016 Joyent, Inc.
 */

/*
 * IMGAPI db migration: TODO: describe
 */

var p = console.log;
var fs = require('fs');
var path = require('path');
var moray = require('moray');
var bunyan = require('bunyan');
var assert = require('assert-plus');
var async = require('async');
var passwd = require('passwd');
var format = require('util').format;
var execFile = require('child_process').execFile;
var mkdirp = require('mkdirp');
var rimraf = require('rimraf');

var constants = require('../constants');
var errors = require('../errors');


//---- globals

var NAME = path.basename(__filename);

var CONFIG_PATH;
if (fs.existsSync('/data/imgapi/etc/imgapi.config.json')) {
    CONFIG_PATH = '/data/imgapi/etc/imgapi.config.json';
} else {
    CONFIG_PATH = path.resolve(__dirname, '..', '..', 'etc',
        'imgapi.config.json');
}
var IMGAPI_URL = 'http://127.0.0.1';
if (fs.existsSync('/root/THIS-IS-IMAGES.JOYENT.COM.txt') ||
    fs.existsSync('/root/THIS-IS-UPDATES.JOYENT.COM.txt')) {
    IMGAPI_URL = 'https://127.0.0.1';
}
var config = JSON.parse(fs.readFileSync(CONFIG_PATH));
var morayClient = null;  // set in `getMorayClient()`



//---- support functions

function errexit(err) {
    console.error(NAME + ' error: ' + err);
    process.exit(1);
}

function warn() {
    arguments[0] = NAME + ' warn: ' + arguments[0];
    console.warn.apply(null, arguments);
}

function info() {
    arguments[0] = NAME + ' info: ' + arguments[0];
    console.log.apply(null, arguments);
}


function getMorayClient(callback) {
    var client = moray.createClient({
        connectTimeout: config.moray.connectTimeout || 200,
        host: config.moray.host,
        port: config.moray.port,
        log: bunyan.createLogger({
            name: 'moray',
            level: 'INFO',
            stream: process.stdout,
            serializers: bunyan.stdSerializers
        }),
        reconnect: true,
        retry: (config.moray.retry === false ? false : {
            retries: Infinity,
            minTimeout: 1000,
            maxTimeout: 16000
        })
    });

    client.on('connect', function () {
        return callback(client);
    });
}

function morayListImages(callback) {
    var req = morayClient.findObjects('imgapi_images', 'uuid=*');
    var images = [];

    req.once('error', function (err) {
        return callback(err);
    });

    req.on('record', function (object) {
        images.push(object.value);
    });

    req.once('end', function () {
        return callback(null, images);
    });
}


var _nobodyCache;
function getNobody(callback) {
    if (_nobodyCache !== undefined)
        return callback(_nobodyCache);

    passwd.get('nobody', function (nobody) {
        _nobodyCache = nobody;
        callback(_nobodyCache);
    });
}


function boolFromString(value) {
    if (value === 'false') {
        return false;
    } else if (value === 'true') {
        return true;
    } else if (typeof (value) === 'boolean') {
        return value;
    }
}


function arrayToObject(array) {
    if (!array) {
        throw new TypeError('Array of key/values required');
    } else if (typeof (array) === 'string') {
        array = [array];
    }

    var obj = {};
    array.forEach(function (keyvalue) {
        var kv = keyvalue.split('=');

        if (kv.length != 2) {
            throw new TypeError('Key/value string expected');
        }

        obj[kv[0]] = kv[1];
    });

    return obj;
}


function toManifest(image) {
    if (image.activated !== undefined) {
        image.activated = boolFromString(image.activated);
    }
    if (image.disabled !== undefined) {
        image.disabled = boolFromString(image.disabled);
    }
    if (image['public'] !== undefined) {
        image['public'] = boolFromString(image['public']);
    }
    if (image.generate_passwords !== undefined) {
        image.generate_passwords = boolFromString(image.generate_passwords);
    }
    if (image.image_size) {
        image.image_size = Number(image.image_size);
    }
    if (image.tags) {
        image.tags = arrayToObject(image.tags);
    }
    if (image.files) {
        image.files = image.files.map(function (f) {
            return {
                sha1: f.sha1,
                size: f.size,
                compression: f.compression,
                dataset_guid: f.dataset_guid
            };
        });
    }

    return image;
}


function migrateImage(image, callback) {
    var archiveDir = constants.STORAGE_LOCAL_ARCHIVE_DIR;

    info('migrate "%s"', image.uuid);
    var manifest = toManifest(image);
    var content = JSON.stringify(manifest, null, 2);

    var archivePathFromImageUuid = function (uuid) {
        return path.resolve(archiveDir, uuid.slice(0, 3), uuid + '.json');
    };

    var archPath = archivePathFromImageUuid(image.uuid);
    var archDir = path.dirname(archPath);
    mkdirp(archDir, function (err) {
        if (err) {
            return callback(err);
        }
        rimraf(archPath, function (err2) {
            if (err2) {
                return callback(err2);
            }
            fs.writeFile(archPath, content, 'utf8', afterWrite);
        });
    });

    function afterWrite(err) {
        if (err) {
            return callback(err);
        }

        if (config.mode !== 'dc') {
            return callback();
        }
        // chown both dirs
        getNobody(function (nobody) {
            if (!nobody) {
                return callback(new Error('could not get nobody user'));
            }
            fs.chown(archPath, Number(nobody.userId), Number(nobody.groupId),
                function (chErr) {
                    if (chErr) {
                        return callback(chErr);
                    }
                    fs.chown(archDir, Number(nobody.userId),
                    Number(nobody.groupId), callback);
                });
        });
    }
}

function morayMigrate(callback) {
    assert.equal(config.databaseType, 'moray');
    getMorayClient(function (mclient) {
        morayClient = mclient;

        morayListImages(function (err2, images) {
            if (err2)
                return callback(err2);
            info('%d images to potentially migrate', images.length);
            async.forEachSeries(images, migrateImage, callback);
        });
    });
}


function localListImages(callback) {
    /*JSSTYLED*/
    var RAW_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.raw$/;
    fs.readdir(constants.DATABASE_LOCAL_DIR, function (err, files) {
        var images = [];
        async.forEachSeries(
            files,
            function oneFile(file, next) {
                if (!RAW_FILE_RE.test(file))
                    return next();
                var path_ = path.resolve(constants.DATABASE_LOCAL_DIR, file);
                fs.readFile(path_, 'utf8', function (readErr, content) {
                    if (readErr)
                        return next(readErr);
                    try {
                        images.push(JSON.parse(content));
                    } catch (ex) {
                        return next(ex);
                    }
                    next();
                });
            },
            function done(err2) {
                callback(err2, images);
            }
        );
    });
}


function localMigrate(callback) {
    assert.equal(config.databaseType, 'local');
    localListImages(function (err, images) {
        if (err)
            return callback(err);
        async.forEachSeries(images, migrateImage, callback);
    });
}



//---- mainline

function main(argv) {
    assert.string(config.databaseType, 'config.databaseType');
    var migrator = (config.databaseType === 'moray'
        ? morayMigrate : localMigrate);
    migrator(function (err) {
        if (err) {
            errexit(err);
        } else {
            process.exit(0);
        }
    });
}

if (require.main === module) {
    main(process.argv);
}
