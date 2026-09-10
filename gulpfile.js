'use strict';

/********
 * setup *
 ********/
const defaultNwVersion = '0.86.0',
  availablePlatforms = ['linux32', 'linux64', 'win32', 'win64', 'osx64', 'osx-arm64'],
  releasesDir = 'build',
  nwFlavor = 'sdk';

/***************
 * dependencies *
 ***************/
const gulp = require('gulp'),
  glp = require('gulp-load-plugins')(),
  del = require('del'),
  gulpRename = require('gulp-rename'),
  nwBuilder = require('nw-builder'),
  yargs = require('yargs'),
  nib = require('nib'),
  git = require('git-describe'),
  zip = require('gulp-zip'),
  fs = require('fs'),
  path = require('path'),
  exec = require('child_process').exec,
  spawn = require('child_process').spawn,
  pkJson = require('./package.json');

const { detectCurrentPlatform, Platforms } = require('nw-builder/dist/index.cjs');

// Patch nw-builder 3.x to support osx-arm64 (Apple Silicon / M1, M2, M3)
// nw-builder 3.x only knows osx32/osx64; we inject the ARM64 entry using the
// same key format that mapFilesToPlatforms() produces from the manifest ("osx-arm64").
if (!Platforms['osx-arm64']) {
  Platforms['osx-arm64'] = {
    needsZip: false,
    files: {
      '>=0.12.0 || ~0.12.0-alpha': ['nwjs.app']
    },
    versionNameTemplate: 'v${ version }/${ name }-v${ version }-osx-arm64.zip'
  };
}

// ARM64-aware platform detection.
// nw-builder 3.x detectCurrentPlatform() returns 'osx32' for arm64 darwin — wrong.
// We return 'osx-arm64' which matches both the Platforms key and the manifest file name.
const detectPlatform = () => {
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'osx-arm64' : 'osx64';
  }
  return detectCurrentPlatform(process);
};

const nwVersion = yargs.argv.nwVersion || defaultNwVersion;

/***********
 *  custom  *
 ***********/
// returns an array of platforms that should be built
const parsePlatforms = () => {
  const requestedPlatforms = (yargs.argv.platforms || detectPlatform()).split(
      ','
    ),
    validPlatforms = [];

  for (let i in requestedPlatforms) {
    if (availablePlatforms.indexOf(requestedPlatforms[i]) !== -1) {
      validPlatforms.push(requestedPlatforms[i]);
    }
  }

  // for osx and win, 32-bits works on 64, if needed
  if (
    availablePlatforms.indexOf('win64') === -1 &&
    requestedPlatforms.indexOf('win64') !== -1
  ) {
    validPlatforms.push('win32');
  }
  if (
    availablePlatforms.indexOf('osx64') === -1 &&
    requestedPlatforms.indexOf('osx64') !== -1
  ) {
    validPlatforms.push('osx32');
  }

  // remove duplicates
  validPlatforms.filter((item, pos) => {
    return validPlatforms.indexOf(item) === pos;
  });

  return requestedPlatforms[0] === 'all' ? availablePlatforms : validPlatforms;
};

// returns an array of paths with the node_modules to include in builds
const parseReqDeps = () => {
  return new Promise((resolve, reject) => {
    exec(
      'yarn list --prod --json',
      // `yarn list --prod --json` currently emits ~130 KB; the old 500 KB cap
      // left little room, and blowing it makes exec truncate stdout, which
      // used to surface as an unhandled JSON.parse throw inside this callback
      // (the promise never settled and the build hung).
      {maxBuffer: 1024 * 4096},
      (error, stdout, stderr) => {
        if (error) {
          return reject(
            new Error('`yarn list --prod --json` failed: ' + error.message)
          );
        }

        let npmList;
        try {
          npmList = JSON.parse(stdout);
        } catch (e) {
          return reject(
            new Error(
              'Could not parse `yarn list --prod --json` output: ' +
                e.message +
                (stderr ? '\nyarn stderr: ' + stderr : '')
            )
          );
        }

        if (!npmList.data || !Array.isArray(npmList.data.trees)) {
          return reject(
            new Error('Unexpected `yarn list --prod --json` payload shape')
          );
        }

        // format for nw-builder
        const deps = npmList.data.trees.map((obj) => {
          let name = obj.name;
          name = name.replace(/@[\d.]+$/, '');
          return './node_modules/' + name + '/**';
        });

        // not know why it not add
        deps.push('./node_modules/cheerio/**');

        // A build whose dependency list came back (nearly) empty still
        // produces an app that launches -- it just has no vendor scripts, so
        // the renderer dies on `jQuery is not defined` and the window, which
        // starts hidden, is never shown. Fail loudly instead.
        if (deps.length < 2) {
          return reject(
            new Error(
              'Resolved only ' +
                deps.length +
                ' production dependencies; refusing to package an app without node_modules'
            )
          );
        }

        resolve(deps);
      }
    );
  });
};

// Resolve the same glob library, from the same place, that nw-builder's
// Utils.getFileList() uses -- checking with a different matcher would prove
// nothing about what actually gets packaged.
const nwSimpleGlob = require(require.resolve('simple-glob', {
  paths: [path.dirname(require.resolve('nw-builder/package.json'))]
}));

// index.html loads its vendor libraries by root-relative path
// (`/node_modules/jquery/dist/jquery.min.js` and friends). If those files miss
// the package, NW.js still starts and the window still exists -- it is just
// never shown, because `window.show` is false in package.json and the
// `win.show()` in src/app/app.js is downstream of `App`, which needs Marionette,
// which needs Backbone, which needs jQuery. The app then looks like it has no
// UI at all, with nothing on stdout to say why. Verify before packaging.
const verifyVendorScriptsArePackaged = (files) => {
  const indexHtml = fs.readFileSync('./src/app/index.html', 'utf8'),
    required = [];

  let match;
  const scriptTag = /<script\s+src="(\/node_modules\/[^"]+)"/g;
  while ((match = scriptTag.exec(indexHtml)) !== null) {
    required.push('.' + match[1]);
  }

  if (!required.length) {
    throw new Error(
      'No /node_modules script tags found in src/app/index.html -- ' +
        'verifyVendorScriptsArePackaged() needs updating'
    );
  }

  // glob returns forward-slash paths on every platform, but path.normalize()
  // rewrites them to backslashes on Windows -- `required` is built from the
  // HTML src attributes and always uses '/', so compare on a single separator.
  const toPosix = (file) => path.normalize(file).split(path.sep).join('/');

  const packaged = new Set(
      nwSimpleGlob(files).map((file) => './' + toPosix(file))
    ),
    missing = required.filter((file) => !packaged.has(file));

  if (missing.length) {
    throw new Error(
      'These vendor scripts are referenced by src/app/index.html but would ' +
        'not be packaged:\n  ' +
        missing.join('\n  ') +
        '\nThe resulting build would start with a hidden window and no UI. ' +
        'Run `yarn` and rebuild.'
    );
  }

  console.log(
    'Verified %d vendor scripts from index.html are in the package',
    required.length
  );
};

const curVersion = () => {
    if (fs.existsSync('./git.json')) {
        const gitData = require('./git.json');
        return gitData.semver;
    } else {
        return pkJson.version;
    }
};

const nwSuffix = () => {
    if (nwVersion === defaultNwVersion) {
        return '';
    }
    return '-' + nwVersion;
};

const waitProcess = function(process) {
    return new Promise((resolve, reject) => {
        // display log only on failed build
        const logs = [];
        process.stdout.on('data', (buf) => {
            logs.push(buf.toString());
        });
        process.stderr.on('data', (buf) => {
            logs.push(buf.toString());
        });

        process.on('close', (exitCode) => {
            if (!exitCode) {
                resolve();
            } else {
                if (logs.length) {
                    console.log(logs.join('\n'));
                }
                reject();
            }
        });

        process.on('error', (error) => {
            console.log(error);
            reject();
        });
    });
};

// console.log for thenable promises
const log = () => {
  console.log.apply(console, arguments);
};

// del wrapper for `clean` tasks
const deleteAndLog = (path, what) => () =>
  del(path).then((paths) => {
    paths.length
      ? console.log('Deleted', what, ':\n', paths.join('\n'))
      : console.log('Nothing to delete');
  });

const renameFile = (dir, src, dest) => {
    return new Promise((resolve, reject) => {
        return gulp
            .src(path.join(dir, src))
            .pipe(gulpRename(dest))
            .pipe(gulp.dest(dir))
            .on('end', () => resolve());
    }).then(() => del(path.join(dir, src)));
};

// clean for dist
gulp.task('cleanForDist', (done) => {
  del([path.join(releasesDir, pkJson.name)]).then((paths) => {
    paths.length
      ? console.log('Deleted: \n', paths.join('\n'))
      : console.log('Nothing to delete');
    done();
  });
});

// nw-builder configuration
const nw = new nwBuilder({
  files: [],
  buildDir: releasesDir,
  zip: false,
  macIcns: './src/app/images/butter.icns',
  version: nwVersion,
  flavor: nwFlavor,
  manifestUrl: 'https://popcorn-time.serv00.net/version.json',
  // Official NW.js CDN. The previous mirror served the same layout but ran at
  // ~130 KB/s and stalled mid-transfer with no resume, which repeatedly hung
  // builds; this host sustains several MB/s for the same archives.
  // Use dl.node-webkit.org rather than dl.nwjs.io: the latter 302-redirects
  // here, and nw-builder's downloader is not verified to follow redirects.
  downloadUrl: 'https://dl.node-webkit.org/',
  platforms: parsePlatforms()
}).on('log', console.log);

/*************
 * gulp tasks *
 *************/
// start app in development
// default is help, because we can!
gulp.task('default', (done) => {
  console.log(
    [
      '\nBasic usage:',
      ' gulp run\tStart the application in dev mode',
      ' gulp build\tBuild the application',
      ' gulp dist\tCreate a redistribuable package',
      '\nAvailable options:',
      ' --platforms=<platform>',
      '\tArguments: ' + availablePlatforms + ',all',
      '\tExample 1:   `gulp dist --platforms=all`',
      '\tExample 2:   `gulp dist --platforms=win64,linux64`',
      '\nUse `gulp --tasks` to show the task dependency tree of gulpfile.js\n'
    ].join('\n')
  );
  done();
});
gulp.task('run', () => {
  return new Promise((resolve, reject) => {
    let platform = parsePlatforms()[0],
      bin = path.join('cache', nwVersion + '-' + nwFlavor, platform);

    // path to nw binary
    switch (platform.slice(0, 3)) {
      case 'osx':
        bin += '/nwjs.app/Contents/MacOS/nwjs';
        break;
      case 'lin':
        bin += '/nw';
        break;
      case 'win':
        bin += '/nw.exe';
        break;
      default:
        reject(new Error('Unsupported %s platform', platform));
    }

    console.log('Running %s from cache', platform);

    // spawn cached binary with package.json, toggle dev flag
    const child = spawn(bin, ['.', '--development']);

    // nwjs console speaks to stderr
    child.stderr.on('data', (buf) => {
      console.log(buf.toString());
    });

    child.on('close', (exitCode) => {
      console.log('%s exited with code %d', pkJson.name, exitCode);
      resolve();
    });

    child.on('error', (error) => {
      // nw binary most probably missing
      if (error.code === 'ENOENT') {
        console.log(
          '%s is not available in cache. Try running `gulp build` beforehand',
          platform
        );
      }
      reject(error);
    });
  });
});

// check entire sources for potential coding issues (tweak in .jshintrc)
gulp.task('jshint', () => {
  return gulp
    .src([
      'gulpfile.js',
      'src/app/lib/*.js',
      'src/app/lib/**/*.js',
      'src/app/vendor/videojshooks.js',
      'src/app/vendor/videojsplugins.js',
      'src/app/*.js'
    ])
    .pipe(glp.jshint('.jshintrc'))
    .pipe(glp.jshint.reporter('jshint-stylish'))
    .pipe(glp.jshint.reporter('fail'));
});
// zip compress all
gulp.task('compresszip', () => {
  return Promise.all(
    nw.options.platforms.map((platform) => {
      const zipName =
        pkJson.name + '-' + curVersion() + '-' + platform + nwSuffix() + '.zip';

      // macOS bundles must go through ditto, not gulp-zip. The .app contains
      // five symlinks that make up the versioned framework layout
      // (nwjs Framework.framework/Versions/Current and friends); gulp-zip
      // follows them and stores copies instead, so the extracted bundle has no
      // Versions/Current and `codesign --verify` fails with "bundle format
      // unrecognized, invalid, or unsuitable" -- which Gatekeeper surfaces as
      // "damaged and can't be opened". ditto is the system archiver, preserves
      // symlinks, permissions and the code signature, and as a side effect
      // produces a smaller archive because the symlink targets are not
      // duplicated.
      if (platform.match(/osx/) !== null) {
        if (process.platform !== 'darwin') {
          console.log(
            'Skipping %s zip: macOS bundles must be archived on macOS with ditto',
            platform
          );
          return Promise.resolve();
        }

        const app = path.join(releasesDir, pkJson.name, platform, pkJson.name + '.app');
        const dest = path.join(releasesDir, zipName);

        console.log('Packaging zip for: %s', platform);
        return waitProcess(
          spawn('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, dest])
        ).then(() => {
          console.log(
            '%s zip packaged in %s',
            platform,
            path.join(process.cwd(), releasesDir)
          );
        });
      }

      return new Promise((resolve, reject) => {
        console.log('Packaging zip for: %s', platform);
        const sources = path.join(releasesDir, pkJson.name, platform);
        return gulp
          .src(sources + '/**')
          .pipe(zip(zipName))
          .pipe(gulp.dest(releasesDir))
          .on('end', () => {
            console.log(
              '%s zip packaged in %s',
              platform,
              path.join(process.cwd(), releasesDir)
            );
            resolve();
          });
      });
    })
  ).catch(log);
});

// beautify entire code (tweak in .jsbeautifyrc)
gulp.task('jsbeautifier', () => {
  return gulp
    .src(
      [
        'src/app/lib/*.js',
        'src/app/lib/**/*.js',
        'src/app/*.js',
        'src/app/vendor/videojshooks.js',
        'src/app/vendor/videojsplugins.js',
        '*.js',
        '*.json'
      ],
      {
        base: './'
      }
    )
    .pipe(
      glp.jsbeautifier({
        config: '.jsbeautifyrc'
      })
    )
    .pipe(glp.jsbeautifier.reporter())
    .pipe(gulp.dest('./'));
});

// clean build files (nwjs)
gulp.task(
  'clean:build',
  deleteAndLog([path.join(releasesDir, pkJson.name)], 'build files')
);

// clean dist files (dist)
gulp.task(
  'clean:dist',
  deleteAndLog([path.join(releasesDir, '*.*')], 'distribuables')
);

// clean compiled css
gulp.task('clean:css', deleteAndLog(['src/app/themes'], 'css files'));

//TODO:
//setexecutable?
//bower_clean

// ad-hoc code signing for macOS bundles
// nw-builder renames the runtime's nwjs.app, rewrites Info.plist and the icon,
// and injects app.nw into Contents/Resources. Every one of those edits happens
// after NW.js signed the bundle, so the shipped .app has no valid signature at
// all (`codesign --verify` reports "code has no resources but signature
// indicates they must be present"). On Apple Silicon an unsigned or
// broken-signature bundle that carries the download quarantine flag is refused
// outright, with Finder reporting it as "damaged and can't be opened" rather
// than the usual unidentified-developer prompt.
//
// Re-signing ad-hoc (`--sign -`) makes the bundle structurally valid again and
// removes the "damaged" failure. It is not notarization: users still have to
// clear quarantine on first launch (right-click > Open, or
// `xattr -dr com.apple.quarantine`). Proper signing would need an Apple
// Developer ID, which this fork does not have.
gulp.task('codesign', () => {
  if (process.platform !== 'darwin') {
    console.log('Skipping codesign: only possible on macOS');
    return Promise.resolve();
  }

  return nw.options.platforms.reduce((chain, platform) => {
    if (platform.match(/osx/) === null) {
      return chain;
    }

    const app = path.join(releasesDir, pkJson.name, platform, pkJson.name + '.app');

    return chain.then(() => {
      console.log('Ad-hoc signing: %s', app);
      // --deep is deprecated for Developer ID signing but remains the only way
      // to sign the nested helper apps and framework of an ad-hoc bundle in one
      // pass, which is what NW.js's layout needs here.
      return waitProcess(spawn('codesign', ['--force', '--deep', '--sign', '-', app]))
        .then(() => waitProcess(spawn('codesign', ['--verify', '--deep', '--strict', app])))
        .then(() => console.log('%s signed and verified', platform));
    });
  }, Promise.resolve());
});

gulp.task('mac-pkg', () => {
  // pkg-maker.sh uses a fixed intermediate name (Build.pkg, referenced by
  // distribution.xml), so platforms are packaged sequentially, not in parallel.
  return nw.options.platforms.reduce((chain, platform) => {
    if (detectPlatform().indexOf('osx') === -1) {
      console.log('Packaging pkg is only possible on osx');
      return chain;
    }
    if (platform.indexOf('osx') !== 0) {
      console.log('Skipping pkg for non-osx platform: %s', platform);
      return chain;
    }

    return chain.then(() => new Promise((resolve) => {
      console.log('Packaging for: %s', platform);

      const child = spawn('bash', ['dist/mac/pkg-maker.sh', platform]);

      waitProcess(child).then(() => {
          console.log('%s pkg packaged in', platform, path.join(process.cwd(), releasesDir));
          return renameFile(
              path.join(process.cwd(), releasesDir),
              pkJson.name + '-' + pkJson.version + '-' + platform + '.pkg',
              pkJson.name + '-' + curVersion() + '-' + platform + nwSuffix() + '.pkg'
          ).then(() => resolve());
      }).catch((err) => {
          // Log and continue so one platform's failure doesn't skip the rest.
          console.log('%s failed to package pkg', platform, err || '');
          resolve();
      });
    }));
  }, Promise.resolve());
});

// download and compile nwjs
gulp.task('nwjs', () => {
  return parseReqDeps()
    .then((requiredDeps) => {
      // required files
      nw.options.files = [
        './src/**',
        '!./src/app/styl/**',
        './package.json',
        './README.md',
        './CHANGELOG.md',
        './LICENSE.txt',
        './git.json'
      ];
      // add node_modules
      nw.options.files = nw.options.files.concat(requiredDeps);
      // remove junk files
      nw.options.files = nw.options.files.concat([
        '!./node_modules/**/*.bin',
        '!./node_modules/**/*.c',
        '!./node_modules/**/*.h',
        '!./node_modules/**/Makefile',
        '!./node_modules/**/*.h',
        '!./**/test*/**',
        '!./**/doc*/**',
        '!./**/example*/**',
        '!./**/demo*/**',
        '!./*/bin/**',
        '!./**/.*/**'
      ]);

      verifyVendorScriptsArePackaged(nw.options.files);

      return nw.build();
    })
    .then(() => {
      return Promise.all(
        nw.options.platforms.map((platform) => {
            if (platform.indexOf('linux') === -1) {
                return null;
            }
            const child = spawn('bash', [
                'dist/linux/copy-libatomic.sh',
                releasesDir,
                pkJson.name,
                platform
            ]);
            return waitProcess(child);
        })
      );
    })
    .catch(function(error) {
      console.error(error);
      // Rethrow: this used to swallow the failure, so `gulp build` reported
      // success and `gulp dist` went on to zip/deb/nsis whatever half-packaged
      // tree was left behind. A package missing node_modules launches into a
      // permanently hidden window, which reads as "the app has no UI".
      throw error;
    });
});

// create git.json (used in 'About')
gulp.task('injectgit', () => {
  return git.gitDescribe()
    .then(
      (gitInfo) =>
        new Promise((resolve, reject) => {
          // pkJson.version can carry a prerelease tail (0.5.6-beta1) that git
          // describe knows nothing about, so it gets reattached here. On an
          // ordinary release there is no tail, and appending regardless left a
          // trailing '-': semver became "0.5.5+3.g6ff0661a-", which propagated
          // into artifact names and broke the deb rename looking for
          // Popcorn-Time-0.5.5+3.g6ff0661a--amd64.deb. That only happens while
          // package.json is ahead of the last tag -- precisely what a release
          // PR builds -- so it stayed hidden until PRs started building.
          const describe = gitInfo.semverString,
            prerelease = pkJson.version.split('-').slice(1).join('-');

          fs.writeFile(
            'git.json',
            JSON.stringify({
              commit: gitInfo.hash.substr(1),
              semver:
                describe.includes(pkJson.version) || !prerelease
                  ? describe
                  : describe + '-' + prerelease,
            }),
            (error) => {
              return error ? reject(error) : resolve(gitInfo);
            }
          );
        })
    )
    .then((gitInfo) => {
      console.log('Hash:', gitInfo.hash.substr(1));
      console.log('Raw:', gitInfo.raw);
    })
    .catch((error) => {
      console.log(error);
      console.log('Injectgit task failed');
    });
});

// compile styl files
gulp.task('css', () => {
  const sources = 'src/app/styl/*.styl',
    dest = 'src/app/themes/';

  return gulp
    .src(sources)
    .pipe(
      glp.stylus({
        use: nib()
      })
    )
    .pipe(gulp.dest(dest))
    .on('end', () => {
      console.log(
        'Stylus files compiled in %s',
        path.join(process.cwd(), dest)
      );
    });
});

// compile nsis installer
gulp.task('nsis', () => {
  return Promise.all(
    nw.options.platforms.map((platform) => {
      // nsis is for win only
      if (platform.match(/osx|linux/) !== null) {
        console.log('No `nsis` task for', platform);
        return null;
      }

      return new Promise((resolve, reject) => {
        console.log('Packaging nsis for: %s', platform);

        const child = platform === 'win32' ? spawn('makensis.exe', ['./dist/windows/installer_makensis32.nsi', '-DOUTDIR=' + path.join(process.cwd(), releasesDir)]) : spawn('makensis', ['./dist/windows/installer_makensis64.nsi', '-DOUTDIR=' + path.join(process.cwd(), releasesDir)]);

        waitProcess(child).then(() => {
          console.log('%s nsis packaged in', platform, path.join(process.cwd(), releasesDir));
          if (pkJson.version === curVersion() && !nwSuffix()) {
            resolve();
            return;
          }
          return renameFile(
            path.join(process.cwd(), releasesDir),
            pkJson.name + '-' + pkJson.version + '-' + platform + '-Setup.exe',
            pkJson.name + '-' + curVersion() + '-' + platform + nwSuffix() + '-Setup.exe'
          ).then(() => resolve());
        }).catch(() => {
          console.log('%s failed to package nsis', platform);
          reject();
        });
      });
    })
  ).catch(log);
});

// compile debian packages
// TODO: https://www.npmjs.com/package/nobin-debian-installer
gulp.task('deb', () => {
  return Promise.all(
    nw.options.platforms.map((platform) => {
      // deb is for linux only
      if (platform.match(/osx|win/) !== null) {
        console.log('No `deb` task for:', platform);
        return null;
      }
      if (detectPlatform().indexOf('linux') === -1) {
        console.log('Packaging deb is only possible on linux');
        return null;
      }

      return new Promise((resolve, reject) => {
        console.log('Packaging deb for: %s', platform);

        const child = spawn('bash', [
          'dist/linux/deb-maker.sh',
          nwVersion,
          platform,
          pkJson.name,
          curVersion(),
          releasesDir
        ]);

        waitProcess(child).then(() => {
            console.log('%s deb packaged in', platform, path.join(process.cwd(), releasesDir));
            if (!nwSuffix()) {
                resolve();
                return;
            }
            const suffix = platform === 'linux64' ? 'amd64' : 'i386';
            return renameFile(
                path.join(process.cwd(), releasesDir),
                pkJson.name + '-' + curVersion() + '-' + suffix + '.deb',
                pkJson.name + '-' + curVersion() + '-' + suffix + nwSuffix() + '.deb'
            ).then(() => resolve());
        }).catch(() => {
            console.log('%s failed to package deb', platform);
            reject();
        });
      });
    })
  ).catch(log);
});

// prevent commiting if conditions aren't met and force beautify (bypass with `git commit -n`)
gulp.task(
  'pre-commit',
  gulp.series('jshint', function(done) {
    // default task code here
    done();
  })
);

// build app from sources
gulp.task(
  'build',
  gulp.series('injectgit', 'css', 'nwjs', function(done) {
    // default task code here
    done();
  })
);

// create redistribuable packages
gulp.task(
  'dist',
  gulp.series(
    'build',
    'codesign',
    'compresszip',
    'deb',
   // 'mac-pkg',
    'nsis',
    'cleanForDist',
    function(done) {
      // default task code here
      done();
    }
  )
);

// clean gulp-created files
gulp.task(
  'clean',
  gulp.series('clean:dist', 'clean:build', 'clean:css', function(done) {
    // default task code here
    done();
  })
);
// travis tests
gulp.task(
  'test',
  gulp.series('jshint', 'injectgit', 'css', function(done) {
    // default task code here
    done();
  })
);
