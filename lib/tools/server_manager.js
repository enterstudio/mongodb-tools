var f = require('util').format;
var path = require('path');
var exec = require('child_process').exec;
var fs = require('fs');
var mkdirp = require('mkdirp');
var rimraf = require('rimraf');
var Server = require('mongodb-core').Server;

// SIGHUP      1       Term    Hangup detected on controlling terminal
//                             or death of controlling process
// SIGINT      2       Term    Interrupt from keyboard
// SIGQUIT       3       Core    Quit from keyboard
// SIGILL      4       Core    Illegal Instruction
// SIGABRT       6       Core    Abort signal from abort(3)
// SIGFPE      8       Core    Floating point exception
// SIGKILL       9       Term    Kill signal
// SIGSEGV      11       Core    Invalid memory reference
// SIGPIPE      13       Term    Broken pipe: write to pipe with no readers
// SIGALRM      14       Term    Timer signal from alarm(2)
// SIGTERM      15       Term    Termination signal
// Signal map
var signals = {
  1: 'SIGHUP',
  2: 'SIGINT',
  3: 'SIGQUIT',
  4: 'SIGABRT',
  6: 'SIGABRT',
  8: 'SIGFPE',
  9: 'SIGKILL',
  11: 'SIGSEGV',
  13: 'SIGPIPE',
  14: 'SIGALRM',
  15: 'SIGTERM',
  17: 'SIGSTOP',
  19: 'SIGSTOP',
  23: 'SIGSTOP'
};

//
// Remove any non-server specific settings
var filterInternalOptionsOut = function(options, internalOptions) {
  var opts = {};

  for (var name in options) {
    if (internalOptions.indexOf(name) === -1) {
      opts[name] = options[name];
    }
  }

  return opts;
};

var clone = function(obj) {
  var o = {};
  for(var name in obj) o[name] = obj[name];
  return o;
}

var ServerManager = function(serverOptions) {
  serverOptions = serverOptions || {};
  var host = serverOptions.host || 'localhost';
  var port = serverOptions.port = serverOptions.port || 27017;
  var bin = serverOptions.bin || 'mongod';
  // Set default db path if none set
  var dbpath = serverOptions.dbpath = serverOptions.dbpath || path.join(path.resolve('data'), f('data-%d', port));
  var logpath = serverOptions.logpath = serverOptions.logpath || path.join(path.resolve('data'), f('data-%d.log', port));
  var storageEngine = serverOptions.storageEngine;

  // Current process id
  var self = this;

  // Clone the options
  serverOptions = clone(serverOptions);

  Object.defineProperty(this, 'dbpath', {
    enumerable: true,
    get: function() {
      return dbpath;
    }
  });

  Object.defineProperty(this, 'logpath', {
    enumerable: true,
    get: function() {
      return logpath;
    }
  });

  // filtered out internal keys
  filterInternalOptionsOut(serverOptions, ['bin', 'host']);

  // internalOptions.fork = null;

  // Add rest options
  serverOptions.rest = null;

  // Contains the child process
  var process = null;

  // Any needed credentials
  var credentials;

  // Get the keys
  var keys = Object.keys(serverOptions);

  // Return
  this.port = port;
  this.host = host;
  this.name = f('%s:%s', host, port);

  // Actual server instance
  var server = null;
  var ismaster = null;

  // Allowed server options
  var allowedOptions = ['sslOnNormalPorts', 'sslMode', 'sslPEMKeyFile',
    'sslPEMKeyPassword', 'sslClusterFile', 'sslClusterPassword',
    'sslCAFile', 'sslCRLFile', 'sslWeakCertificateValidation',
    'sslAllowInvalidHostnames', 'sslAllowInvalidCertificates', 'sslFIPSMode',
    'configsvr', 'shardsvr', 'replSet', 'replIndexPrefetch',
    'autoresync', 'slavedelay', 'only', 'source', 'slave', 'master',
    'oplogSize', 'journalCommitInterval', 'journalOptions', 'nojournal',
    'journal', 'notablescan', 'noscripting', 'repairpath', 'repair',
    'upgrade', 'syncdelay', 'smallfiles', 'quotaFiles', 'quota',
    'nssize', 'noprealloc', 'noIndexBuildRetry', 'directoryperdb',
    'dbpath', 'sysinfo', 'cpu', 'profile', 'slowms', 'rest',
    'jsonp', 'ipv6', 'noauth', 'auth', 'fork', 'unixSocketPrefix',
    'nounixsocket', 'clusterAuthMode', 'httpinterface', 'setParameter',
    'keyFile', 'pidfilepath', 'timeStampFormat', 'logappend',
    'syslogFacility', 'syslog', 'logpath', 'maxConns', 'bind_ip', 'port',
    'storageEngine'];

  // Return the startup command
  var buildStartupCommand = function(options, opts) {
    opts = opts || {};
    var command = [];

    // Binary command
    command.push(f('%s', bin));
    command.push('--smallfiles');
    command.push('--noprealloc');
    // Push test commands
    if (!opts.noSetParameter) {
      command.push('--setParameter enableTestCommands=1');
    }

    // Add all other passed in options
    for (var name in options) {
      if (allowedOptions.indexOf(name) !== -1) {
        if (options[name] === null) {
          command.push(f('--%s', name));
        } else if (typeof options[name] === 'function') {
        // noop
        } else if (options[name]) {
          command.push(f('--%s %s', name, options[name]));
        }
      }
    }

    var keys = Object.keys(options);
    if (keys.indexOf('journal') === -1) {
      command.push('--nojournal');
    }

    return command.join(' ');
  };

  var bootServer = function(serverOptions, callback) {
    var pingServer = function() {
      if (server) {
        server.destroy();
      }
      var opt = {
        host: host,
        port: port,
        connectionTimeout: 2000,
        socketTimeout: 2000,
        size: 1,
        reconnect: false,
        emitError: typeof serverOptions.emitError === 'boolean' ? serverOptions.emitError : false
      };

      // Set the key
      if (keys.indexOf('sslOnNormalPorts') !== -1) {
        opt.ssl = true;
      }
      if (keys.indexOf('ssl') !== -1) {
        opt.ssl = serverOptions.ssl;
      }
      if (keys.indexOf('ca') !== -1) {
        opt.ca = serverOptions.ca;
      }
      if (keys.indexOf('cert') !== -1) {
        opt.cert = serverOptions.cert;
      }
      if (keys.indexOf('rejectUnauthorized') !== -1) {
        opt.rejectUnauthorized = serverOptions.rejectUnauthorized;
      }
      if (keys.indexOf('key') !== -1) {
        opt.key = serverOptions.key;
      }
      if (keys.indexOf('passphrase') !== -1) {
        opt.passphrase = serverOptions.passphrase;
      }

      // Else we need to start checking if the server is up
      server = new Server(opt);

      // On connect let's go
      server.on('connect', function(_server) {
        ismaster = server.lastIsMaster();
        _server.destroy();
        // Heap storage engine, no lock file available
        if (storageEngine === null) {
          try {
            // Read the pidfile
            /*eslint no-sync:0*/
            fs.readFileSync(path.join(dbpath, 'mongod.lock'), 'ascii').trim();
          } catch (err) {
            return setTimeout(pingServer, 1000);
          }
        }

        // Finish up
        if (callback) {
          var _callback = callback;
          callback = null;
          _callback(null, null);
        }
      });

      var errHandler = function() {
        setTimeout(pingServer, 1000);
      };

      // Error or close handling
      server.on('error', errHandler);
      server.on('close', errHandler);
      server.on('timeout', errHandler);
      server.once('parseError', errHandler);
      // Attempt connect
      server.connect();
    };

    setTimeout(function() {
      exec(bin + ' --version', function(error, stdout) {
        // Build startup command
        var cmd = stdout.indexOf('v2.2') !== -1
          ? buildStartupCommand(serverOptions, {
            noSetParameter: true
          })
          : buildStartupCommand(serverOptions);
        // Attempt to start
        process = exec(cmd, function(error, stdout, stderr) {
          console.log(stdout);
          if (error !== null && callback) {
            console.dir(error);
            console.dir(stderr);
            var _internal = callback;
            callback = null;
            return _internal(error);
          }
        });

        // process.on('exit', function() {
        //   process = null;
        // });
      });

      // Attempt to ping the server
      setTimeout(pingServer, 1000);
    }, 1000);
  };

  this.start = function(options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }

    // If we have decided to remove the directory
    if (options.purge) {
      try {
        rimraf.sync(serverOptions.dbpath);
        mkdirp.sync(serverOptions.dbpath);
      } catch (err) {
        console.error('purge failed', err);
      }
    }

    // Check if we have a pid file and remove it we do
    if (fs.existsSync(path.join(dbpath, 'mongod.lock'))) {
      fs.unlinkSync(path.join(dbpath, 'mongod.lock'));
    }

    // If we have decided to kill all the processes
    if (typeof options.signal === 'number' && options.kill) {
      options.signal = typeof options.signal === 'number' ? options.signal : -3;
      exec(f('killall %d mongod', options.signal), function() {
        setTimeout(function() {
          bootServer(serverOptions, callback);
        }, 1000);
      });
    } else {
      bootServer(serverOptions, callback);
    }
  };

  this.setCredentials = function(provider, db, user, password) {
    credentials = {
      provider: provider,
      db: db,
      user: user,
      password: password
    };
  };

  var waitToDie = function(pid, callback) {
    exec(f('ps %s', pid), function(error, stdout) {
      if (!error && stdout.indexOf(pid) === -1) return callback();
      setTimeout(function() {
        waitToDie(pid, callback);
      }, 100);
    });
  };

  var locateLockFile = function(dbpath) {
    var possibleLockFiles = ['mongod.lock', 'WiredTiger.lock'];

    for (var i = 0; i < possibleLockFiles.length; i++) {
      try {
        return {
          file: possibleLockFiles[i],
          pid: fs.readFileSync(path.join(dbpath, possibleLockFiles[i]), 'ascii').trim()
        };
      } catch (err) {}
    }
  };

  this.stop = function(options, callback) {
    var self = this;
    if (typeof options === 'function') {
      callback = options, options = {};
    }
    // Get the signal
    var signal = options.signal || -3;
    // We have no process kill the mongod process
    if (!process) {
      return exec(f('killall %d mongod', signal), function() {
        process = null;
        callback();
      });
    }

    // Wait for the exit signal to happen
    process.on('exit', function() {
      process = null;
      callback(null, self);
    });

    // Kill the process
    process.kill(signals[Math.abs(signal)]);
  };

  this.restart = function(options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }

    var self = this;
    self.stop(options, function(err) {
      if (err) return callback(err, null);

      self.start(options, function() {
        if (err) return callback(err, null);
        callback(null, null);
      });
    });
  };

  this.ismaster = function(callback) {
    self.connect(function(err, _server) {
      if (err) return callback(err);

      _server.command('system.$cmd', {
        ismaster: true
      }, function(err, r) {
        _server.destroy();
        if (err) return callback(err);
        ismaster = r.result;
        callback(null, ismaster);
      });
    });
  };

  this.lastIsMaster = function() {
    return ismaster;
  };

  this.isConnected = function() {
    return server !== null && server.isConnected();
  };

  this.updateServerOptions = function(options) {
    for (var attrname in options) {
      serverOptions[attrname] = options[attrname];
    }
  };

  this.connect = function(callback) {
    if (server.isConnected()) return callback(null, server);

    var opt = {
      host: host,
      port: port,
      connectionTimeout: 2000,
      socketTimeout: 2000,
      size: 1,
      reconnect: false,
      emitError: true
    };

    // Set the key
    if (keys.indexOf('sslOnNormalPorts') !== -1) {
      opt.ssl = true;
    }
    if (keys.indexOf('ssl') !== -1) {
      opt.ssl = serverOptions.ssl;
    }
    if (keys.indexOf('ca') !== -1) {
      opt.ca = serverOptions.ca;
    }
    if (keys.indexOf('cert') !== -1) {
      opt.cert = serverOptions.cert;
    }
    if (keys.indexOf('rejectUnauthorized') !== -1) {
      opt.rejectUnauthorized = serverOptions.rejectUnauthorized;
    }
    if (keys.indexOf('key') !== -1) {
      opt.key = serverOptions.key;
    }
    if (keys.indexOf('passphrase') !== -1) {
      opt.passphrase = serverOptions.passphrase;
    }

    // Else we need to start checking if the server is up
    var s = new Server(opt);

    // On connect let's go
    s.on('connect', function(_server) {
      server = _server;

      ['error', 'close', 'timeout', 'parseError'].forEach(function(e) {
        server.removeAllListeners(e);
      });

      // If we have credentials apply them
      if (credentials) {
        return _server.auth(credentials.provider, credentials.db, credentials.user, credentials.password, function(err) {
          if (err) return callback(err);
          callback(null, _server);
        });
      }

      callback(null, _server);
    });

    // Error
    var e = function(err) {
      callback(err, null);
    };

    // Error or close handling
    s.once('error', e);
    s.once('close', e);
    s.once('timeout', e);
    // Attempt connect
    s.connect();
  };

  this.server = function() {
    return server;
  };
};

module.exports = ServerManager;
