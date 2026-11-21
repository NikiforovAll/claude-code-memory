#!/usr/bin/env node
'use strict';

const cli = require('./lib/cli');

if (cli.isCommand(process.argv[2])) process.exitCode = cli.main(process.argv.slice(2));
else require('./server.js');
