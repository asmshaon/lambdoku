#!/usr/bin/env node

'use strict';

const commander = require('commander');
const fs = require('fs');
const exec = require('child-process-promise').exec;
const http = require('https');
const chalk = require('chalk');

const handle = function(fn) {
    return function() {
        return fn.apply(undefined, arguments)
            .catch(err => {
                console.log(chalk.red(err), err.stack);
            });
    }
};

const getLambdaName = function(commander) {
    if (commander.lambda) {
        return commander.lambda;
    }
    try {
        return fs.readFileSync('.lambdoku', {encoding: 'utf8'}).trim();
    } catch (err) {
        throw new Error('No lambda name param passed and reading .lambdoku file failed. Did you run \'lambdoku init\'?');
    }
};

const extractDownstreamFunctions = function(config) {
    const configStringVal = config['DOWNSTREAM_LAMBDAS'] || '';
    return configStringVal.length > 0 ? configStringVal.split(';') : [];
};

const downloadFunctionCode = function(codeLocation) {
    return withMessage('Getting code of lambda',
        () => new Promise((resolve, reject) => {
            const tempDir = fs.mkdtempSync('/tmp/lambdoku-');
            const tempFileLocation = tempDir + 'lambdoku-temp.zip';
            const tempLambdaZipStream = fs.createWriteStream(tempFileLocation);
            http.get(codeLocation, function(response) {
                response.pipe(tempLambdaZipStream);
                response.on('end', function() {
                    tempLambdaZipStream.end();
                    resolve(tempFileLocation);
                });
                response.on('error', (err) => reject(err));
            });
        }));
};

const withMessage = function(message, fn, verbose) {
    if (verbose) {
        process.stdout.write(message);
    }
    return fn()
        .then(result => {
            if (verbose) {
                process.stdout.write(`. ${chalk.green('\u2713')}\n`);
            }
            return result;
        });
};

const AWSLambda = function(lambdaArn, verbose) {

    const lambda = {
        getFunctionEnvVariables: function(version) {
            return withMessage(`Getting function configuration of ${chalk.blue(lambdaArn)}`, function() {
                const command = `aws lambda get-function-configuration --function-name \'${lambdaArn}\' --qualifier \'${version}\'`;
                return exec(command, {encoding: 'utf8'})
                    .then(res => {
                        const parsed = JSON.parse(res.stdout);
                        return parsed.Environment ? parsed.Environment.Variables : {};
                    }, verbose);
            });
        },
        setFunctionConfiguration: function(config) {
            return withMessage(`Changing environment variables of ${chalk.blue(lambdaArn)}`, function() {
                const jsonConfig = JSON.stringify({
                    Variables: config
                });
                const command = `aws lambda update-function-configuration --function-name \'${lambdaArn}\' --environment \'${jsonConfig}\'`;
                return exec(command, {encoding: 'utf8'});
            }, verbose);
        },
        getFunctionCodeLocation: function(version) {
            return withMessage(`Getting code location for ${chalk.blue(lambdaArn)}`, function() {
                const command = `aws lambda get-function --function-name \'${lambdaArn}\' --qualifier \'${version}\'`;
                return exec(command, {encoding: 'utf8'})
                    .then(res => JSON.parse(res.stdout).Code.Location);
            }, verbose);
        },
        publishFunction: function(description) {
            return withMessage(`Publishing new version of function ${chalk.blue(lambdaArn)}`, function() {
                return exec(`aws lambda publish-version --function-name \'${lambdaArn}\' --description \'${description}\'`);
            }, verbose);
        },
        updateFunctionCode: function(codeFileName) {
            return withMessage(`Updating function code for ${chalk.blue(lambdaArn)}`, function() {
                return exec(`aws lambda update-function-code --zip-file fileb://${codeFileName} --function-name \'${lambdaArn}\'`);
            }, verbose);
        },
        getFunctionVersions: function() {
            return withMessage(`Getting versions of ${chalk.blue(lambdaArn)}`, function() {
                return exec(`aws lambda list-versions-by-function --function-name \'${lambdaArn}\'`)
                    .then(res => JSON.parse(res.stdout).Versions);
            }, verbose);
        },
        getFunctionLatestPublishedVersion: function() {
            return lambda.getFunctionVersions(lambdaArn)
                .then(versions => {
                    return versions
                        .map(v => v.Version)
                        .filter(v => v !== '$LATEST')
                        .reverse()[0];
                });
        }
    };
    return lambda;
};

const createCommandLineLambda = function(commander) {
    return AWSLambda(getLambdaName(commander), commander.verbose);
};

commander
    .version('1.0')
    .option('-a, --lambda <lambdaName>', 'lambda to run operation on')
    .option('-v --verbose', 'turn on verbose output');

commander
    .command('help')
    .description('shows help')
    .action(() => {
        commander.help();
    });

commander
    .command('init <lambdaName>')
    .description('init directory for use with lambda')
    .action(lambdaName => {
        fs.writeFileSync(".lambdoku", lambdaName.trim(), {encoding: 'utf8'});
    });

commander
    .command('config')
    .description('get env configuration for lambda')
    .action(handle(() => {
        return createCommandLineLambda(commander).getFunctionEnvVariables('$LATEST')
            .then(config => {
                for (const k in config) {
                    console.log(`${k}='${config[k]}'`);
                }
            })
    }));

commander
    .command('config:unset <envName> [envName1...]')
    .description('unset env configuration value on lambda')
    .action(handle((envName, otherEnvNames) => {
        const lambda = createCommandLineLambda(commander);
        return lambda.getFunctionEnvVariables('$LATEST')
            .then(envs => {
                const envVarsToUnset = otherEnvNames.concat(envName);
                envVarsToUnset.forEach(envName => {
                    if (!envs.hasOwnProperty(envName)) {
                        throw new Error(`No env variable ${envName} set on lambda ${lambdaName}`);
                    }
                    delete envs[envName];
                });
                return envs;
            })
            .then(envs => lambda.setFunctionConfiguration(envs))
            .then(() => lambda.publishFunction(`Unsetting env variables ${envName}`));
    }));

commander
    .command('config:set <envName=envValue> [envName1=envValue1...]')
    .description('set env configuration value of lambda')
    .action(handle((assignment1, otherAssignments) => {
        const lambda = createCommandLineLambda(commander);
        const assignments = otherAssignments.concat(assignment1)
            .reduce((acc, assignment) => {
                const splitted = assignment.split('=');
                if (splitted.length != 2) {
                    throw new Error(`Assignment ${assignment} in wrong form. Should be envName='envValue'.`);
                }
                acc[splitted[0]] = splitted[1];
                return acc;
            }, {});
        return lambda.getFunctionEnvVariables('$LATEST')
            .then(envs => Object.assign({}, envs, assignments))
            .then(newEnv => lambda.setFunctionConfiguration(newEnv))
            .then(() => lambda.publishFunction(`Set env variables ${Object.keys(assignments)}`));
    }));

commander
    .command('config:get <envName> [envName1...]')
    .description('get env configuration value of lambda')
    .action(handle((envName1, otherEnvNames) => {
        const lambda = createCommandLineLambda(commander);
        return lambda.getFunctionEnvVariables('$LATEST')
            .then(envVariables => {
                const envs = otherEnvNames.concat(envName1)
                    .reduce((acc, envName) => {
                        const envValue = envVariables[envName];
                        if (envValue) {
                            acc[envName] = envValue;
                        } else {
                            throw new Error(`No such env variable set ${envName}`);
                        }
                        return acc;
                    }, {});
                for (const k in envs) {
                    console.log(`${k}=\'${envs[k]}\'`)
                }
            });
    }));

commander
    .command('downstream')
    .description('get downstream lambdas of given lambda')
    .action(handle(() => {
        const lambda = createCommandLineLambda(commander);
        return lambda.getFunctionEnvVariables('$LATEST')
            .then(config => {
                extractDownstreamFunctions(config)
                    .forEach(lambdaName => {
                        console.log(lambdaName);
                    });
            });
    }));

commander
    .command('downstream:add <downstreamLambdaName>')
    .description('add downstream to given lambda')
    .action(handle(downstreamLambdaName => {
        const lambda = createCommandLineLambda(commander);
        return lambda.getFunctionEnvVariables('$LATEST')
            .then(config => {
                const downstreamLambdas = extractDownstreamFunctions(config);
                downstreamLambdas.push(downstreamLambdaName);
                config['DOWNSTREAM_LAMBDAS'] = downstreamLambdas.join(';');
                return config;
            })
            .then(config => lambda.setFunctionConfiguration(config))
            .then(() => lambda.publishFunction(`Added downstream ${downstreamLambdaName}`));
    }));

commander
    .command('downstream:remove <downstreamLambdaName>')
    .description('remove downstream from given lambda')
    .action(handle(downstreamLambdaName => {
        const lambda = createCommandLineLambda(commander);
        return lambda.getFunctionEnvVariables('$LATEST')
            .then(config => {
                const downstreamLambdas = extractDownstreamFunctions(config);
                downstreamLambdas.splice(downstreamLambdas.indexOf(downstreamLambdaName), 1);
                config['DOWNSTREAM_LAMBDAS'] = downstreamLambdas.join(';');
                return config;
            })
            .then(config => lambda.setFunctionConfiguration(config))
            .then(() => lambda.publishFunction(`Removed downstream ${downstreamLambdaName}`));
    }));

commander
    .command('downstream:promote')
    .description('promote lambda to all its downstreams')
    .action(handle(() => {
        const lambdaName = getLambdaName(commander);
        const lambda = createCommandLineLambda(commander);
        return lambda.getFunctionLatestPublishedVersion()
            .then(version => {
                return lambda.getFunctionCodeLocation(version)
                    .then(functionCodeLocation => downloadFunctionCode(functionCodeLocation))
                    .then(codeFileName => {
                        return lambda.getFunctionEnvVariables(version)
                            .then(extractDownstreamFunctions)
                            .then(downstreamLambdas => {
                                return Promise.all(
                                    downstreamLambdas
                                        .map(downstreamLambda => AWSLambda(downstreamLambda, commander.verbose))
                                        .map(lambda => lambda.updateFunctionCode(codeFileName)
                                            .then(() => lambda.publishFunction(`Promoting code from ${lambdaName} version ${version}`))));
                            });
                    });
            });
    }));

commander
    .command('releases')
    .description('lists releases of lambda')
    .action(handle(() => {
        return createCommandLineLambda(commander).getFunctionVersions()
            .then(versions => {
                versions.reverse()
                    .filter(version => {
                        return version.Version !== '$LATEST';
                    })
                    .forEach(version => {
                        console.log(`${chalk.green(version.Version)} | ` +
                            `${version.Description} | ` +
                            `${chalk.red(version.LastModified)}`);
                    });
            });
    }));

commander
    .command('releases:rollback <version>')
    .description('rolls back to given version of lambda')
    .action(handle((version) => {
        const lambda = createCommandLineLambda(commander);
        return lambda.getFunctionCodeLocation(version)
            .then(codeLocation => downloadFunctionCode(codeLocation))
            .then(codeFileName => lambda.updateFunctionCode(codeFileName))
            .then(() => lambda.getFunctionEnvVariables(version))
            .then(config => lambda.setFunctionConfiguration(config))
            .then(() => lambda.publishFunction(`Rolling back to version ${version}`));
    }));

commander
    .command('*')
    .action(() => {
        commander.help();
    });

commander.parse(process.argv);
