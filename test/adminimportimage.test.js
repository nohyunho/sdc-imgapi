/*
 * Copyright (c) 2012 Joyent Inc. All rights reserved.
 *
 * Test AdminImportImage endpoint.
 */

var format = require('util').format;
var crypto = require('crypto');
var fs = require('fs');
var https = require('https');
var async = require('async');
var restify = require('restify');
//var IMGAPI = require('sdc-clients').IMGAPI;   // temp broken by TOOLS-211
var IMGAPI = require('sdc-clients/lib/imgapi');
var DSAPI = require('sdc-clients/lib/dsapi');


// node-tap API
if (require.cache[__dirname + '/tap4nodeunit.js'])
    delete require.cache[__dirname + '/tap4nodeunit.js'];
var tap4nodeunit = require('./tap4nodeunit.js');
var after = tap4nodeunit.after;
var before = tap4nodeunit.before;
var test = tap4nodeunit.test;
function skiptest() {}; // quick hack to comment out a test



//---- globals

var vader = '86055c40-2547-11e2-8a6b-4bb37edc84ba';
var luke = '91ba0e64-2547-11e2-a972-df579e5fddb3';
var sdc = 'ba28f844-8cb4-f141-882d-46d6251e6a9f';


//---- tests

before(function (next) {
    this.client = new IMGAPI({url: process.env.IMGAPI_URL});
    next();
});


test('AdminImportImage should fail if called for a user', function (t) {
    // Use a raw restify client. The IMGAPI client doesn't allow this
    // erroneous call.
    var client = restify.createJsonClient({url: process.env.IMGAPI_URL});
    var path = '/images/2e8a7f4d-4a38-0844-a489-3cd1ae25a5c8'
        + '?action=import&account=8d89dfe9-5cc7-6648-8ff7-50fa8bba1352';
    var data = {};
    client.post(path, data, function (err, req, res, body) {
        t.ok(err, 'got an error');
        t.equal(err.statusCode, 403, 'err.statusCode');
        t.equal(body.code, 'OperatorOnly', 'body.code');
        t.ok(body.message);
        t.end();
    });
});

test('AdminImportImage should error on UUID mismatch', function (t) {
    // Use a raw restify client. The IMGAPI client doesn't allow this
    // erroneous call.
    var client = restify.createJsonClient({url: process.env.IMGAPI_URL});
    var uuid = '43302fc6-9595-e94b-9166-039b0acda443';
    var data = {
        uuid: '83379eba-0ab1-4541-b82a-6d1d4701ec6d'
    };
    var path = format('/images/%s?action=import', uuid);
    client.post(path, data, function (err, req, res, body) {
        t.ok(err, 'got an error');
        t.equal(err.statusCode, 422, 'err.statusCode');
        t.equal(err.body.code, 'InvalidParameter', 'err.body.code');
        t.ok(err.body.message);
        t.equal(err.body.errors.length, 1, 'err.body has "errors" array');
        t.equal(err.body.errors[0].field, 'uuid', 'err.body.errors[0].field');
        t.end();
    });
});

test('AdminImportImage should fail if UUID already exists', function (t) {
    var data = {
        uuid: 'c58161c0-2547-11e2-a75e-9fdca1940570', // from test-data.ldif
        published_at: (new Date()).toISOString()
        //...
    };
    this.client.adminImportImage(data, function (err, image, res) {
        t.ok(err, 'got an error: ' + err);
        t.equal(err.statusCode, 409, 'err.statusCode');
        t.equal(err.body.code, 'ImageUuidAlreadyExists', 'err.body.code');
        t.ok(err.body.message);
        t.end();
    });
});

test('AdminImportImage should 404 on bogus UUID', function (t) {
    var data = {uuid: '3dae5131', foo: 'bar'}; // bogus UUID
    this.client.adminImportImage(data, function (err, image, res) {
        t.ok(err, 'got an error');
        t.equal(err.statusCode, 404, 'err.statusCode');
        t.equal(err.body.code, 'ResourceNotFound', 'err.body.code');
        t.ok(err.body.message);
        t.end();
    });
});

/**
 * AdminImportImage scenario from local file:
 * - AdminImportImage from local imgmanifest file
 * - AddImageFile from local file
 * - ActivateImage
 * - GetImage, GetImageFile checks
 * - clean up: delete it
 */
test('AdminImportImage from local .imgmanifest', function (t) {
    var self = this;
    var data = JSON.parse(
        fs.readFileSync(__dirname + '/fauxnodejs-1.4.0.imgmanifest', 'utf8'));
    var uuid = data.uuid;
    var filePath = __dirname + '/fauxnodejs-1.4.0.zfs.bz2';
    var size;
    var sha1;
    var md5;
    var aImage;

    function create(next) {
        self.client.adminImportImage(data, function (err, image, res) {
            t.ifError(err, err);
            t.ok(image);
            if (image) {
                t.equal(image.uuid, data.uuid);
                t.equal(image.published_at, data.published_at);
                t.equal(image.state, 'unactivated');
            }
            next(err);
        });
    }
    function getSize(next) {
        fs.stat(filePath, function (err, stats) {
            if (err)
                return next(err);
            size = stats.size;
            next();
        });
    }
    function getSha1(next) {
        var hash = crypto.createHash('sha1');
        var s = fs.createReadStream(filePath);
        s.on('data', function (d) { hash.update(d); });
        s.on('end', function () {
            sha1 = hash.digest('hex');
            next();
        });
    }
    function getMd5(next) {
        var hash = crypto.createHash('md5');
        var s = fs.createReadStream(filePath);
        s.on('data', function (d) { hash.update(d); });
        s.on('end', function () {
            md5 = hash.digest('base64');
            next();
        });
    }
    function addFile(next) {
        self.client.addImageFile(uuid, filePath, function (err, image, res) {
            t.ifError(err, err);
            t.ok(image);
            t.equal(image.files.length, 1, 'image.files');
            t.equal(image.files[0].sha1, sha1, 'image.files.0.sha1');
            t.equal(image.files[0].size, size, 'image.files.0.size');
            next(err);
        });
    }
    function activate(next) {
        self.client.activateImage(uuid, function (err, image, res) {
            t.ifError(err, err);
            t.ok(image);
            t.equal(image.state, 'active');
            aImage = image;
            next();
        });
    }
    function getImage(next) {
        self.client.getImage(uuid, vader, function (err, image, res) {
            t.ifError(err, err);
            t.equal(JSON.stringify(aImage), JSON.stringify(image), 'matches');
            next();
        });
    }
    function getFile(next) {
        var tmpFilePath = format('/var/tmp/imgapi-test-file-%s.zfs.bz2',
            process.pid);
        self.client.getImageFile(uuid, tmpFilePath, vader, function (err, res) {
            t.ifError(err, err);
            if (err) {
                return next(err);
            }
            t.equal(md5, res.headers['content-md5'], 'md5');
            var hash = crypto.createHash('sha1');
            var s = fs.createReadStream(tmpFilePath);
            s.on('data', function (d) { hash.update(d); });
            s.on('end', function () {
                var actual_sha1 = hash.digest('hex');
                t.equal(sha1, actual_sha1, 'sha1 matches upload');
                t.equal(aImage.files[0].sha1, actual_sha1,
                    'sha1 matches image data');
                next();
            });
        });
    }
    function deleteImage(next) {
        self.client.deleteImage(uuid, function (err, res) {
            t.ifError(err, err);
            if (err) {
                return next(err);
            }
            t.equal(res.statusCode, 204, 'res.statusCode 204');
            next();
        });
    }

    async.series(
        [
            create,
            getSize,
            getSha1,
            getMd5,
            addFile,
            activate,
            getImage,
            getFile,
            deleteImage
        ],
        function (err) {
            t.end();
        }
    );
});

/**
 * AdminImportImage scenario from local file:
 * - AdminImportImage from local dsmanifest file
 * - AddImageFile from local file
 * - ActivateImage
 * - GetImage, GetImageFile checks
 * - clean up: delete it
 */
test('AdminImportImage from local .dsmanifest', function (t) {
    var self = this;
    var data = JSON.parse(
        fs.readFileSync(__dirname + '/fauxnodejs-1.4.0.dsmanifest', 'utf8'));
    var uuid = data.uuid;
    var filePath = __dirname + '/fauxnodejs-1.4.0.zfs.bz2';
    var size;
    var sha1;
    var md5;
    var aImage;

    function create(next) {
        self.client.adminImportImage(data, function (err, image, res) {
            t.ifError(err, err);
            t.ok(image);
            if (image) {
                t.equal(image.uuid, data.uuid);
                t.equal(image.published_at, data.published_at);
                t.equal(image.state, 'unactivated');
            }
            next(err);
        });
    }
    function getSize(next) {
        fs.stat(filePath, function (err, stats) {
            if (err)
                return next(err);
            size = stats.size;
            next();
        });
    }
    function getSha1(next) {
        var hash = crypto.createHash('sha1');
        var s = fs.createReadStream(filePath);
        s.on('data', function (d) { hash.update(d); });
        s.on('end', function () {
            sha1 = hash.digest('hex');
            next();
        });
    }
    function getMd5(next) {
        var hash = crypto.createHash('md5');
        var s = fs.createReadStream(filePath);
        s.on('data', function (d) { hash.update(d); });
        s.on('end', function () {
            md5 = hash.digest('base64');
            next();
        });
    }
    function addFile(next) {
        self.client.addImageFile(uuid, filePath, function (err, image, res) {
            t.ifError(err, err);
            t.ok(image);
            t.equal(image.files.length, 1, 'image.files');
            t.equal(image.files[0].sha1, sha1, 'image.files.0.sha1');
            t.equal(image.files[0].size, size, 'image.files.0.size');
            next(err);
        });
    }
    function activate(next) {
        self.client.activateImage(uuid, function (err, image, res) {
            t.ifError(err, err);
            t.ok(image);
            t.equal(image.state, 'active');
            aImage = image;
            next();
        });
    }
    function getImage(next) {
        self.client.getImage(uuid, vader, function (err, image, res) {
            t.ifError(err, err);
            t.equal(JSON.stringify(aImage), JSON.stringify(image), 'matches');
            next();
        });
    }
    function getFile(next) {
        var tmpFilePath = format('/var/tmp/imgapi-test-file-%s.zfs.bz2',
            process.pid);
        self.client.getImageFile(uuid, tmpFilePath, vader, function (err, res) {
            t.ifError(err, err);
            if (err) {
                return next(err);
            }
            t.equal(md5, res.headers['content-md5'], 'md5');
            var hash = crypto.createHash('sha1');
            var s = fs.createReadStream(tmpFilePath);
            s.on('data', function (d) { hash.update(d); });
            s.on('end', function () {
                var actual_sha1 = hash.digest('hex');
                t.equal(sha1, actual_sha1, 'sha1 matches upload');
                t.equal(aImage.files[0].sha1, actual_sha1,
                    'sha1 matches image data');
                next();
            });
        });
    }
    function deleteImage(next) {
        self.client.deleteImage(uuid, function (err, res) {
            t.ifError(err, err);
            if (err) {
                return next(err);
            }
            t.equal(res.statusCode, 204, 'res.statusCode 204');
            next();
        });
    }

    async.series(
        [
            create,
            getSize,
            getSha1,
            getMd5,
            addFile,
            activate,
            getImage,
            getFile,
            deleteImage
        ],
        function (err) {
            t.end();
        }
    );
});


/**
 * AdminImportImage scenario from images.joyent.com:
 * - get manifest from images.joyent.com/images/:uuid
 * - AdminImportImage with that manifest
 * - AddImageFile *stream* from images.joyent.com/images/:uuid/file
 * - ActivateImage
 * - GetImage, GetImageFile checks
 * - clean up: delete it
 */
test('AdminImportImage from images.joyent.com', function (t) {
    var self = this;
    // smartos-1.3.18 (40MB) -- pick a small one for faster download in
    // shitty-networking BH-1 where testing is typically done.
    var uuid = "47e6af92-daf0-11e0-ac11-473ca1173ab0";
    var manifest;
    var filePath = format('/var/tmp/image-test-file-%s.zfs.bz2', process.pid);
    var size;
    var sha1;
    var md5;
    var aImage;

    //XXX var imagesClient = new IMGAPI({url: 'https://images.joyent.com'});
    var imagesClient = new IMGAPI({url: 'https://64.30.133.39'});

    function getManifestFromImagesJo(next) {
        imagesClient.getImage(uuid, function (err, image) {
            t.ifError(err, err);
            t.ok(image);
            manifest = image;
            next();
        })
    }
    function getFileFromImagesJo(next) {
        imagesClient.getImageFile(uuid, filePath, function (err, res) {
            t.ifError(err, err);
            if (err) {
                return next(err);
            }
            var sha1hash = crypto.createHash('sha1');
            var md5hash = crypto.createHash('md5');
            size = 0;
            var s = fs.createReadStream(filePath);
            s.on('data', function (d) {
                sha1hash.update(d);
                md5hash.update(d);
                size += d.length;
            });
            s.on('end', function () {
                sha1 = sha1hash.digest('hex');
                md5 = md5hash.digest('base64');
                t.equal(md5, res.headers['content-md5'], 'md5');
                t.equal(sha1, manifest.files[0].sha1,
                    'sha1 matches manifest data');
                t.equal(size, manifest.files[0].size,
                    'size matches manifest data');
                next();
            });
        });
    }
    function create(next) {
        self.client.adminImportImage(manifest, function (err, image, res) {
            t.ifError(err, err);
            t.ok(image);
            if (image) {
                t.equal(image.uuid, manifest.uuid);
                t.equal(image.published_at, manifest.published_at);
                t.equal(image.state, 'unactivated');
            }
            next(err);
        });
    }
    function addFile(next) {
        self.client.addImageFile(uuid, filePath, function (err, image, res) {
            t.ifError(err, err);
            t.ok(image);
            t.equal(image.files.length, 1, 'image.files');
            t.equal(image.files[0].sha1, sha1, 'image.files.0.sha1');
            t.equal(image.files[0].size, size, 'image.files.0.size');
            next(err);
        });
    }
    function activate(next) {
        self.client.activateImage(uuid, function (err, image, res) {
            t.ifError(err, err);
            t.ok(image);
            t.equal(image.state, 'active');
            aImage = image;
            next();
        });
    }
    function getImage(next) {
        self.client.getImage(uuid, vader, function (err, image, res) {
            t.ifError(err, err);
            t.equal(JSON.stringify(aImage), JSON.stringify(image), 'matches');
            next();
        });
    }
    function getFile(next) {
        var tmpFilePath = format('/var/tmp/imgapi-test-file-%s.zfs.bz2',
            process.pid);
        self.client.getImageFile(uuid, tmpFilePath, vader, function (err, res) {
            t.ifError(err, err);
            if (err) {
                return next(err);
            }
            t.equal(md5, res.headers['content-md5'], 'md5');
            var hash = crypto.createHash('sha1');
            var s = fs.createReadStream(tmpFilePath);
            s.on('data', function (d) { hash.update(d); });
            s.on('end', function () {
                var actual_sha1 = hash.digest('hex');
                t.equal(sha1, actual_sha1, 'sha1 matches upload');
                t.equal(aImage.files[0].sha1, actual_sha1,
                    'sha1 matches image data');
                next();
            });
        });
    }
    function deleteImage(next) {
        self.client.deleteImage(uuid, function (err, res) {
            t.ifError(err, err);
            if (err) {
                return next(err);
            }
            t.equal(res.statusCode, 204, 'res.statusCode 204');
            next();
        });
    }

    async.series(
        [
            getManifestFromImagesJo,
            getFileFromImagesJo,
            create,
            addFile,
            activate,
            getImage,
            getFile,
            deleteImage
        ],
        function (err) {
            t.end();
        }
    );
});


/**
 * AdminImportImage scenario from datasets.joyent.com:
 * - get manifest from datasets.joyent.com/datasets/:uuid
 * - AdminImportImage with that manifest
 * - AddImageFile *stream* from file URL from the dsmanifest
 * - ActivateImage
 * - GetImage, GetImageFile checks
 * - clean up: delete it
 */
test('AdminImportImage from datasets.joyent.com', function (t) {
    var self = this;
    // smartos-1.3.18 (40MB) -- pick a small one for faster download in
    // shitty-networking BH-1 where testing is typically done.
    var uuid = "47e6af92-daf0-11e0-ac11-473ca1173ab0";
    var manifest;
    var filePath = format('/var/tmp/dataset-test-file-%s.zfs.bz2', process.pid);
    var size;
    var sha1;
    var md5;
    var aImage;

    //var datasetsClient = new DSAPI({url: 'https://datasets.joyent.com'});
    // XXX Hack for running from the GZ:
    var datasetsClient = new DSAPI({url: 'https://165.225.154.107'});

    function getManifestFromDatasetsJo(next) {
        datasetsClient.getImage(uuid, function (err, dataset) {
            t.ifError(err, err);
            t.ok(dataset);
            manifest = dataset;
            next();
        })
    }
    function getFileFromDatasetsJo(next) {
        var url = manifest.files[0].url;
        // XXX Hack for running from the GZ:
        url = url.replace('datasets.joyent.com', '165.225.154.107');
        var stream = fs.createWriteStream(filePath);
        https.get(url, function (res) {
            var sha1hash = crypto.createHash('sha1');
            var md5hash = crypto.createHash('md5');
            size = 0;
            res.pipe(stream);
            res.on('data', function (d) {
                sha1hash.update(d);
                md5hash.update(d);
                size += d.length;
            });
            res.on('end', function () {
                sha1 = sha1hash.digest('hex');
                md5 = md5hash.digest('base64');
                // No 'Content-MD5' header check because datasets.joyent.com
                // doesn't set that header.
                t.equal(sha1, manifest.files[0].sha1,
                    'sha1 matches manifest data');
                t.equal(size, manifest.files[0].size,
                    'size matches manifest data');
                next();
            });
        });
    }
    function create(next) {
        self.client.adminImportImage(manifest, function (err, image, res) {
            t.ifError(err, err);
            t.ok(image);
            if (image) {
                t.equal(image.uuid, manifest.uuid);
                t.equal(image.published_at, manifest.published_at);
                t.equal(image.state, 'unactivated');
            }
            next(err);
        });
    }
    function addFile(next) {
        self.client.addImageFile(uuid, filePath, function (err, image, res) {
            t.ifError(err, err);
            t.ok(image);
            t.equal(image.files.length, 1, 'image.files');
            t.equal(image.files[0].sha1, sha1, 'image.files.0.sha1');
            t.equal(image.files[0].size, size, 'image.files.0.size');
            next(err);
        });
    }
    function activate(next) {
        self.client.activateImage(uuid, function (err, image, res) {
            t.ifError(err, err);
            t.ok(image);
            t.equal(image.state, 'active');
            aImage = image;
            next();
        });
    }
    function getImage(next) {
        self.client.getImage(uuid, vader, function (err, image, res) {
            t.ifError(err, err);
            t.equal(JSON.stringify(aImage), JSON.stringify(image), 'matches');
            next();
        });
    }
    function getFile(next) {
        var tmpFilePath = format('/var/tmp/imgapi-test-file-%s.zfs.bz2',
            process.pid);
        self.client.getImageFile(uuid, tmpFilePath, vader, function (err, res) {
            t.ifError(err, err);
            if (err) {
                return next(err);
            }
            t.equal(md5, res.headers['content-md5'], 'md5');
            var hash = crypto.createHash('sha1');
            var s = fs.createReadStream(tmpFilePath);
            s.on('data', function (d) { hash.update(d); });
            s.on('end', function () {
                var actual_sha1 = hash.digest('hex');
                t.equal(sha1, actual_sha1, 'sha1 matches upload');
                t.equal(aImage.files[0].sha1, actual_sha1,
                    'sha1 matches image data');
                next();
            });
        });
    }
    function deleteImage(next) {
        self.client.deleteImage(uuid, function (err, res) {
            t.ifError(err, err);
            if (err) {
                return next(err);
            }
            t.equal(res.statusCode, 204, 'res.statusCode 204');
            next();
        });
    }

    async.series(
        [
            getManifestFromDatasetsJo,
            getFileFromDatasetsJo,
            create,
            addFile,
            activate,
            getImage,
            getFile,
            deleteImage
        ],
        function (err) {
            t.end();
        }
    );
});