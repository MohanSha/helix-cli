/*
 * Copyright 2018 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

/* eslint-env mocha */

const fs = require('fs-extra');
const assert = require('assert');
const path = require('path');
const $ = require('shelljs');
const NodeHttpAdapter = require('@pollyjs/adapter-node-http');
const FSPersister = require('@pollyjs/persister-fs');
const { setupMocha: setupPolly } = require('@pollyjs/core');
const { HelixConfig, Logger } = require('@adobe/helix-shared');
const { initGit, createTestRoot } = require('./utils.js');
const GitUtils = require('../src/git-utils');
const DeployCommand = require('../src/deploy.cmd.js');

const CI_TOKEN = 'nope';
const TEST_DIR = path.resolve('test/integration');
const CGI_BIN_TEST_DIR = path.resolve('test/integration-with-cgi-bin');

describe('hlx deploy (Integration)', () => {
  let testRoot;
  let hlxDir;
  let buildDir;
  let cwd;

  setupPolly({
    recordFailedRequests: true,
    recordIfMissing: false,
    logging: false,
    adapters: [NodeHttpAdapter],
    persister: FSPersister,
    persisterOptions: {
      fs: {
        recordingsDir: path.resolve(__dirname, 'fixtures/recordings'),
      },
    },
    matchRequestsBy: {
      body: false,
      headers: {
        exclude: ['content-length', 'user-agent'],
      },
    },
  });

  beforeEach(async function beforeEach() {
    testRoot = await createTestRoot();
    hlxDir = path.resolve(testRoot, '.hlx');
    buildDir = path.resolve(hlxDir, 'build');

    cwd = process.cwd();

    // ignore requests by snyk runtime agent
    this.polly.server.any('https://homebase.snyk.io/*').passthrough();

    this.polly.server.any().on('beforeResponse', (req) => {
      // don't record the authorization header
      req.removeHeaders(['authorization']);
    });
  });

  afterEach(async () => {
    $.cd(cwd);
    await fs.remove(testRoot);
  });

  it('deploy fails if no helix-config is present.', async () => {
    initGit(testRoot);
    const logger = Logger.getTestLogger();
    try {
      await new DeployCommand(logger)
        .withDirectory(testRoot)
        .withWskHost('adobeioruntime.net')
        .withWskAuth('secret-key')
        .withWskNamespace('hlx')
        .withEnableAuto(false)
        .withEnableDirty(true)
        .withDryRun(true)
        .withTarget(buildDir)
        .withFastlyAuth('nope')
        .withFastlyNamespace('justtesting')
        .withCircleciAuth(CI_TOKEN)
        .run();
      assert.fail('deploy should fail if no helix-config is present');
    } catch (e) {
      const log = await logger.getOutput();
      assert.ok(log.indexOf('error: No helix-config.yaml. Please add one before deployment.') >= 0);
    }
  });

  it('deploy fails if no git remote', async () => {
    await fs.copy(TEST_DIR, testRoot);
    await fs.rename(path.resolve(testRoot, 'default-config.yaml'), path.resolve(testRoot, 'helix-config.yaml'));
    initGit(testRoot);
    try {
      await new DeployCommand()
        .withDirectory(testRoot)
        .withWskHost('adobeioruntime.net')
        .withWskAuth('secret-key')
        .withWskNamespace('hlx')
        .withEnableAuto(false)
        .withEnableDirty(true)
        .withDryRun(true)
        .withTarget(buildDir)
        .withFastlyAuth('nope')
        .withFastlyNamespace('justtesting')
        .withCircleciAuth(CI_TOKEN)
        .run();
      assert.fail('deploy fails if no git remote');
    } catch (e) {
      assert.equal(e.toString(), 'Error: hlx cannot deploy without a remote git repository. Add one with\n$ git remote add origin <github_repo_url>.git');
    }
  });

  it('deploy fails if dirty', async () => {
    await fs.copy(TEST_DIR, testRoot);
    await fs.rename(path.resolve(testRoot, 'default-config.yaml'), path.resolve(testRoot, 'helix-config.yaml'));
    initGit(testRoot, 'git@github.com:adobe/project-helix.io.git');
    await fs.copy(path.resolve(testRoot, 'README.md'), path.resolve(testRoot, 'README-copy.md'));
    try {
      await new DeployCommand()
        .withDirectory(testRoot)
        .withWskHost('adobeioruntime.net')
        .withWskAuth('secret-key')
        .withWskNamespace('hlx')
        .withEnableAuto(false)
        .withEnableDirty(false)
        .withDryRun(true)
        .withTarget(buildDir)
        .withFastlyAuth('nope')
        .withFastlyNamespace('justtesting')
        .withCircleciAuth(CI_TOKEN)
        .run();
      assert.fail('deploy fails if dirty');
    } catch (e) {
      assert.equal(e.toString(), 'Error: hlx will not deploy a working copy that has uncommitted changes. Re-run with flag --dirty to force.');
    }
  });

  it('deploy fails if no strain is affected', async () => {
    await fs.copy(TEST_DIR, testRoot);
    await fs.rename(path.resolve(testRoot, 'default-config.yaml'), path.resolve(testRoot, 'helix-config.yaml'));
    initGit(testRoot, 'git@github.com:adobe/project-foo.io.git');
    const logger = Logger.getTestLogger();
    try {
      await new DeployCommand(logger)
        .withDirectory(testRoot)
        .withWskHost('adobeioruntime.net')
        .withWskAuth('secret-key')
        .withWskNamespace('hlx')
        .withEnableAuto(false)
        .withEnableDirty(false)
        .withDryRun(true)
        .withTarget(buildDir)
        .withFastlyAuth('nope')
        .withFastlyNamespace('justtesting')
        .withCircleciAuth(CI_TOKEN)
        .run();
      assert.fail('deploy fails if no stain is affected');
    } catch (e) {
      const log = await logger.getOutput();
      assert.ok(log.indexOf('error: Remote repository ssh://git@github.com/adobe/project-foo.io.git#master does not affect any strains.') >= 0);
      assert.ok(log.indexOf('http://localhost') < 0, true);
    }
  });

  it('deploy adds missing strain with --add=foo', async () => {
    await fs.copy(TEST_DIR, testRoot);
    const cfg = path.resolve(testRoot, 'helix-config.yaml');
    await fs.rename(path.resolve(testRoot, 'default-config.yaml'), cfg);
    initGit(testRoot, 'git@github.com:adobe/project-foo.io.git');
    const logger = Logger.getTestLogger();
    const cmd = await new DeployCommand(logger)
      .withDirectory(testRoot)
      .withWskHost('adobeioruntime.net')
      .withWskAuth('secret-key')
      .withWskNamespace('hlx')
      .withEnableAuto(false)
      .withEnableDirty(false)
      .withDryRun(true)
      .withTarget(buildDir)
      .withFastlyAuth('nope')
      .withFastlyNamespace('justtesting')
      .withCircleciAuth(CI_TOKEN)
      .withAddStrain('foo')
      .withCreatePackages('ignore')
      .run();

    const log = await logger.getOutput();
    assert.ok(log.indexOf('info: Updated strain foo in helix-config.yaml') >= 0);
    await cmd.config.saveConfig(); // trigger manual save because of dry-run
    const actual = await fs.readFile(cfg, 'utf-8');
    const expected = await fs.readFile(path.resolve(__dirname, 'fixtures', 'default-updated-foo.yaml'), 'utf-8');
    // eslint-disable-next-line no-underscore-dangle
    assert.equal(actual, expected.replace('$REF', cmd._prefix));
  });

  it('deploy replaces default --add=default with dirty', async () => {
    await fs.copy(TEST_DIR, testRoot);
    const cfg = path.resolve(testRoot, 'helix-config.yaml');
    initGit(testRoot, 'git@github.com:adobe/project-foo.io.git');
    await fs.rename(path.resolve(testRoot, 'default-config.yaml'), cfg);
    const logger = Logger.getTestLogger();
    const cmd = await new DeployCommand(logger)
      .withDirectory(testRoot)
      .withWskHost('adobeioruntime.net')
      .withWskAuth('secret-key')
      .withWskNamespace('hlx')
      .withEnableAuto(false)
      .withEnableDirty(true)
      .withDryRun(true)
      .withTarget(buildDir)
      .withFastlyAuth('nope')
      .withFastlyNamespace('justtesting')
      .withCircleciAuth(CI_TOKEN)
      .withAddStrain('default')
      .withCreatePackages('ignore')
      .run();

    const log = await logger.getOutput();
    assert.ok(log.indexOf('info: Updated strain default in helix-config.yaml') >= 0);
    await cmd.config.saveConfig(); // trigger manual save because of dry-run
    const actual = await fs.readFile(cfg, 'utf-8');
    const expected = await fs.readFile(path.resolve(__dirname, 'fixtures', 'default-updated.yaml'), 'utf-8');
    assert.equal(actual, expected);
  });

  it('deploy reports affected strains', async () => {
    await fs.copy(TEST_DIR, testRoot);
    await fs.rename(path.resolve(testRoot, 'default-config.yaml'), path.resolve(testRoot, 'helix-config.yaml'));
    initGit(testRoot, 'git@github.com:adobe/project-helix.io.git');
    const logger = Logger.getTestLogger();
    await new DeployCommand(logger)
      .withDirectory(testRoot)
      .withWskHost('adobeioruntime.net')
      .withWskAuth('secret-key')
      .withWskNamespace('hlx')
      .withEnableAuto(false)
      .withEnableDirty(false)
      .withDryRun(true)
      .withTarget(buildDir)
      .withFastlyAuth('nope')
      .withFastlyNamespace('justtesting')
      .withCircleciAuth(CI_TOKEN)
      .withCreatePackages('ignore')
      .run();

    const log = await logger.getOutput();
    assert.ok(log.indexOf('Affected strains of ssh://git@github.com/adobe/project-helix.io.git#master') >= 0);
    assert.ok(log.indexOf('- dev') >= 0);
  });

  it('deploy reports affected strains if no ref is specified', async () => {
    await fs.copy(TEST_DIR, testRoot);
    await fs.rename(path.resolve(testRoot, 'default-config-no-master.yaml'), path.resolve(testRoot, 'helix-config.yaml'));
    initGit(testRoot, 'git@github.com:adobe/project-helix.io.git');
    const logger = Logger.getTestLogger();
    await new DeployCommand(logger)
      .withDirectory(testRoot)
      .withWskHost('adobeioruntime.net')
      .withWskAuth('secret-key')
      .withWskNamespace('hlx')
      .withEnableAuto(false)
      .withEnableDirty(false)
      .withDryRun(true)
      .withTarget(buildDir)
      .withFastlyAuth('nope')
      .withFastlyNamespace('justtesting')
      .withCircleciAuth(CI_TOKEN)
      .withCreatePackages('ignore')
      .run();

    const log = await logger.getOutput();
    assert.ok(log.indexOf('Affected strains of ssh://git@github.com/adobe/project-helix.io.git#master') >= 0);
    assert.ok(log.indexOf('- dev') >= 0);
  });

  it('deploy reports affected strains with default proxy', async () => {
    await fs.copy(TEST_DIR, testRoot);
    const cfg = path.resolve(testRoot, 'helix-config.yaml');
    await fs.copy(path.resolve(__dirname, 'fixtures', 'default-proxy.yaml'), cfg);
    initGit(testRoot, 'git@github.com:adobe/dummy.git');
    const logger = Logger.getTestLogger();
    const cmd = await new DeployCommand(logger)
      .withDirectory(testRoot)
      .withWskHost('adobeioruntime.net')
      .withWskAuth('secret-key')
      .withWskNamespace('hlx')
      .withEnableAuto(false)
      .withEnableDirty(false)
      .withDryRun(true)
      .withTarget(buildDir)
      .withFastlyAuth('nope')
      .withFastlyNamespace('justtesting')
      .withCircleciAuth(CI_TOKEN)
      .withCreatePackages('ignore')
      .withAddStrain('new-strain')
      .run();

    const log = await logger.getOutput();
    assert.ok(log.indexOf('Affected strains of ssh://git@github.com/adobe/dummy.git#master') >= 0);
    assert.ok(log.indexOf('- new-strain') >= 0);
    await cmd.config.saveConfig(); // trigger manual save because of dry-run
    const actual = await fs.readFile(cfg, 'utf-8');
    const expected = await fs.readFile(path.resolve(__dirname, 'fixtures', 'default-proxy-updated.yaml'), 'utf-8');
    // eslint-disable-next-line no-underscore-dangle
    assert.equal(actual, expected.replace('$REF', cmd._prefix));
  });

  it.skip('Auto-Deploy works', (done) => {
    try {
      $.cd(testRoot);
      $.exec('git clone https://github.com/trieloff/helix-helpx.git');
      $.cd(path.resolve(testRoot, 'helix-helpx'));

      new DeployCommand()
        .withWskHost('adobeioruntime.net')
        .withWskAuth('secret-key')
        .withWskNamespace('hlx')
        .withEnableAuto(true)
        .withEnableDirty(true)
        .withDryRun(true)
        .withTarget(buildDir)
        .withFastlyAuth('nope')
        .withFastlyNamespace('justtesting')
        .withCircleciAuth(CI_TOKEN)
        .run()
        .then(() => { done(); });
    } catch (e) {
      done(e);
    }
  }).timeout(15000);

  it('Dry-Running works', async () => {
    await fs.copy(TEST_DIR, testRoot);
    await fs.rename(path.resolve(testRoot, 'default-config.yaml'), path.resolve(testRoot, 'helix-config.yaml'));
    initGit(testRoot, 'git@github.com:adobe/project-helix.io.git');
    const logger = Logger.getTestLogger();

    const cmd = await new DeployCommand(logger)
      .withDirectory(testRoot)
      .withWskHost('adobeioruntime.net')
      .withWskAuth('secret-key')
      .withWskNamespace('hlx')
      .withEnableAuto(false)
      .withEnableDirty(false)
      .withDryRun(true)
      .withTarget(buildDir)
      .withFiles([
        path.resolve(testRoot, 'src/html.htl'),
        path.resolve(testRoot, 'src/html.pre.js'),
        path.resolve(testRoot, 'src/helper.js'),
        path.resolve(testRoot, 'src/utils/another_helper.js'),
        path.resolve(testRoot, 'src/third_helper.js'),
      ])
      .withMinify(false)
      .run();

    const ref = await GitUtils.getCurrentRevision(testRoot);
    assert.equal(cmd.config.strains.get('default').package, '');
    assert.equal(cmd.config.strains.get('dev').package, `hlx/${ref}`);

    const log = await logger.getOutput();
    assert.ok(log.indexOf('deployment of 1 action completed') >= 0);
    assert.ok(log.indexOf(`- hlx/${ref}/html`) >= 0);
  }).timeout(60000);

  it('Dry-Running works with cgi-bin', async () => {
    await fs.copy(CGI_BIN_TEST_DIR, testRoot);
    await fs.rename(path.resolve(testRoot, 'default-config.yaml'), path.resolve(testRoot, 'helix-config.yaml'));
    initGit(testRoot, 'git@github.com:adobe/project-helix.io.git');
    const logger = Logger.getTestLogger();

    const cmd = await new DeployCommand(logger)
      .withDirectory(testRoot)
      .withWskHost('adobeioruntime.net')
      .withWskAuth('secret-key')
      .withWskNamespace('hlx')
      .withEnableAuto(false)
      .withEnableDirty(false)
      .withDryRun(true)
      .withMinify(false)
      .withTarget(buildDir)
      .withFiles([
        path.resolve(testRoot, 'src/html.htl'),
        path.resolve(testRoot, 'src/html.pre.js'),
        path.resolve(testRoot, 'src/helper.js'),
        path.resolve(testRoot, 'src/utils/another_helper.js'),
        path.resolve(testRoot, 'src/third_helper.js'),
        path.resolve(testRoot, 'cgi-bin/hello.js'),
      ])
      .run();

    const ref = await GitUtils.getCurrentRevision(testRoot);
    assert.equal(cmd.config.strains.get('default').package, '');
    assert.equal(cmd.config.strains.get('dev').package, `hlx/${ref}`);

    const log = await logger.getOutput();
    assert.ok(log.indexOf('deployment of 2 actions completed') >= 0);
    assert.ok(log.indexOf(`- hlx/${ref}/html`) >= 0);
    assert.ok(log.indexOf(`- hlx/${ref}/cgi-bin-hello`) >= 0);
  }).timeout(60000);

  it('Deploy works', async function test() {
    this.timeout(60000);

    await fs.copy(TEST_DIR, testRoot);
    await fs.rename(path.resolve(testRoot, 'default-config.yaml'), path.resolve(testRoot, 'helix-config.yaml'));
    initGit(testRoot, 'git@github.com:adobe/project-helix.io.git');
    const logger = Logger.getTestLogger();

    const ref = await GitUtils.getCurrentRevision(testRoot);

    this.polly.server.any().on('beforeResponse', (req, res) => {
      delete req.body;
      delete res.body;
    });
    this.polly.server.put(`https://adobeioruntime.net/api/v1/namespaces/hlx/packages/${ref}`).intercept((req, res) => {
      const body = JSON.parse(req.body);
      try {
        assert.deepEqual(body, {
          publish: true,
          parameters: [
            {
              key: 'FOO',
              value: 'bar',
            },
            {
              key: 'LOGGLY_HOST',
              value: 'loggly-host',
            },
            {
              key: 'LOGGLY_KEY',
              value: 'loggly-auth',
            },
            {
              key: 'RESOLVE_GITREF_SERVICE',
              value: 'my-resolver',
            },
          ],
          annotations: [
            {
              key: 'hlx-code-origin',
              value: 'ssh://git@github.com/adobe/project-helix.io.git#master',
            },
          ],
        });
        res.sendStatus(201);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(e);
        res.sendStatus(500);
      }
    });
    this.polly.server.put(`https://adobeioruntime.net/api/v1/namespaces/hlx/actions/${ref}/html`).intercept((req, res) => {
      res.sendStatus(201);
    });
    this.polly.server.put('https://adobeioruntime.net/api/v1/namespaces/hlx/packages/helix-services?overwrite=true').intercept((req, res) => {
      res.sendStatus(201);
    });
    this.polly.server.put(`https://adobeioruntime.net/api/v1/namespaces/hlx/actions/${ref}/hlx--static?overwrite=true`).intercept((req, res) => {
      res.sendStatus(201);
    });

    const cmd = await new DeployCommand(logger)
      .withDirectory(testRoot)
      .withWskHost('adobeioruntime.net')
      .withWskAuth('dummy')
      .withWskNamespace('hlx')
      .withEnableAuto(false)
      .withEnableDirty(false)
      .withDryRun(false)
      .withTarget(buildDir)
      .withFiles([
        path.resolve(testRoot, 'src/html.htl'),
        path.resolve(testRoot, 'src/html.pre.js'),
        path.resolve(testRoot, 'src/helper.js'),
        path.resolve(testRoot, 'src/utils/another_helper.js'),
        path.resolve(testRoot, 'src/third_helper.js'),
      ])
      .withMinify(false)
      .withLogglyAuth('loggly-auth')
      .withLogglyHost('loggly-host')
      .withDefault({
        FOO: 'bar',
      })
      .withResolveGitRefService('my-resolver')
      .run();

    assert.equal(cmd.config.strains.get('default').package, '');
    assert.equal(cmd.config.strains.get('dev').package, `hlx/${ref}`);

    const log = await logger.getOutput();
    assert.ok(log.indexOf('deployment of 1 action completed') >= 0);
    assert.ok(log.indexOf(`- hlx/${ref}/html`) >= 0);

    // check if written helix config contains package ref
    const newCfg = new HelixConfig()
      .withConfigPath(path.resolve(testRoot, 'helix-config.yaml'));
    await newCfg.init();
    assert.equal(newCfg.strains.get('default').package, '');
    assert.equal(newCfg.strains.get('dev').package, `hlx/${ref}`);
  });

  it('Failed action deploy throws', async function test() {
    this.timeout(60000);

    await fs.copy(TEST_DIR, testRoot);
    await fs.rename(path.resolve(testRoot, 'default-config.yaml'), path.resolve(testRoot, 'helix-config.yaml'));
    initGit(testRoot, 'git@github.com:adobe/project-helix.io.git');
    const logger = Logger.getTestLogger();

    const ref = await GitUtils.getCurrentRevision(testRoot);

    this.polly.server.any().on('beforeResponse', (req, res) => {
      delete req.body;
      delete res.body;
    });
    this.polly.server.put(`https://adobeioruntime.net/api/v1/namespaces/hlx/packages/${ref}`).intercept((req, res) => {
      res.sendStatus(201);
    });
    this.polly.server.put(`https://adobeioruntime.net/api/v1/namespaces/hlx/actions/${ref}/html?overwrite=true`).intercept((req, res) => {
      res.sendStatus(201);
    });
    this.polly.server.put('https://adobeioruntime.net/api/v1/namespaces/hlx/packages/helix-services?overwrite=true').intercept((req, res) => {
      res.sendStatus(201);
    });
    this.polly.server.get('https://adobeioruntime.net/api/v1/web/helix/helix-services/static@latest').intercept((req, res) => {
      res.sendStatus(500);
    });

    try {
      await new DeployCommand(logger)
        .withDirectory(testRoot)
        .withWskHost('adobeioruntime.net')
        .withWskAuth('dummy')
        .withWskNamespace('hlx')
        .withEnableAuto(false)
        .withEnableDirty(false)
        .withDryRun(false)
        .withMinify(false)
        .withTarget(buildDir)
        .withFiles([
          path.resolve(testRoot, 'src/html.htl'),
          path.resolve(testRoot, 'src/html.pre.js'),
          path.resolve(testRoot, 'src/helper.js'),
          path.resolve(testRoot, 'src/utils/another_helper.js'),
          path.resolve(testRoot, 'src/third_helper.js'),
        ])
        .run();
      assert.fail('Expected deploy to fail.');
    } catch (e) {
      // expected
      assert.equal(String(e), 'Error');
    }
  });
});

describe('DeployCommand #unittest', () => {
  it('setDeployOptions() #unittest', () => {
    const options = DeployCommand.getBuildVarOptions('FOO', 'BAR', 'adobe', 'helix-cli', {});
    assert.equal(options.method, 'POST');
    assert.equal(JSON.parse(options.body).name, 'FOO');
    assert.equal(JSON.parse(options.body).value, 'BAR');
  });
});
