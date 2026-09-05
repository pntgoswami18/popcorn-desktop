/** Global variables **/
var _ = require('underscore'),
  async = require('async'),
  inherits = require('util').inherits,
  // Machine readable
  os = require('os'),
  dayjs = require('dayjs'),
  crypt = require('crypto'),
  semver = require('semver'),
  // Files
  fs = require('fs'),
  path = require('path'),
  mkdirp = require('mkdirp'),
  rimraf = require('rimraf'),
  jsonFileEditor = require('edit-json-file'),
  // Compression
  AdmZip = require('adm-zip'),
  zlib = require('zlib'),
  // Encoding/Decoding
  charsetDetect = require('jschardet'),
  iconv = require('iconv-lite'),
  // GUI
  win = nw.Window.get(),
  data_path = nw.App.dataPath,
  i18n = require('i18n'),
  // Connectivity
  url = require('url'),
  tls = require('tls'),
  http = require('http'),
  request = require('request'),
  // Web
  URI = require('urijs'),
  Trakt = require('trakt.tv'),
  // Torrent engines
  WebTorrent = require('webtorrent'),
  torrentCollection = require('torrentcollection6'),
  // NodeJS
  child = require('child_process'),
  // package.json
  pkJson = nw.App.manifest,
  // supported external players list
  extPlayerlst = '',
  // setting default filters status
  curSetDefaultFilters = false;

dayjs.extend(require('dayjs/plugin/relativeTime'));
dayjs.extend(require('dayjs/plugin/localizedFormat'));

/**
 * Absolute path of the directory NW.js actually loaded package.json from.
 *
 * Code that edits the manifest used to open it as the relative path
 * 'package.json', which resolves against process.cwd(). That is the app
 * directory only by coincidence -- the repo root in a source run, the app.nw
 * directory in a packaged one -- and edit-json-file swallows a failed read and
 * hands back {}, so a miss silently turns a manifest edit into a one-key file
 * NW.js cannot boot.
 *
 * `nw.App.manifest.main` cannot anchor this on its own: NW.js reports it
 * relative in a source run ("file://src/app/index.html") but absolute in a
 * package ("file:///.../app.nw/src/app/index.html"), so there is no suffix to
 * subtract in the packaged case. process.mainModule.filename is always the real
 * on-disk entry point, so walk up from it to the manifest that NW.js loaded,
 * confirming identity by name and version rather than trusting the first
 * package.json encountered.
 */
var appRootPath = (function () {
  var mainFile = process.mainModule && process.mainModule.filename;

  if (!mainFile) {
    return process.cwd();
  }

  var dir = path.dirname(path.normalize(mainFile)),
    previous = null;

  while (dir !== previous) {
    var candidate = path.join(dir, 'package.json');

    if (fs.existsSync(candidate)) {
      try {
        var manifest = JSON.parse(fs.readFileSync(candidate, 'utf8'));

        if (manifest.name === pkJson.name && manifest.version === pkJson.version) {
          return dir;
        }
      } catch (e) {
        // Unreadable or malformed: not the manifest NW.js booted from.
      }
    }

    previous = dir;
    dir = path.dirname(dir);
  }

  return process.cwd();
})();

var appManifestPath = path.join(appRootPath, 'package.json');

/**
 * True when the app is running out of a source checkout rather than a package.
 * A build contains only src/, the manifest and a few docs (see the `files` list
 * in gulpfile.js), so gulpfile.js itself is present in the repo and never in a
 * package. In a checkout the manifest is version-controlled, and rewriting it
 * shows up as an unexplained working-tree change.
 */
var isSourceCheckout = fs.existsSync(path.join(appRootPath, 'gulpfile.js'));

/**
 * Open the app manifest for editing. Throws rather than returning an empty
 * editor, so a caller can never save a truncated package.json over a good one.
 */
var openAppManifest = function () {
  if (!fs.existsSync(appManifestPath)) {
    throw new Error('Could not locate the app manifest at ' + appManifestPath);
  }

  // Match the file's existing formatting so an edit does not reflow it.
  return jsonFileEditor(appManifestPath, {
    stringify_width: 2,
    stringify_eol: true
  });
};

/**
 * Toggle the audio-passthrough flag in an open manifest editor's chromium-args
 * without disturbing the other flags it ships with (--no-sandbox, for one:
 * dropping that stops a packaged Linux build from launching at all). Reads the
 * value back off the editor rather than nw.App.manifest, which is the boot-time
 * snapshot and goes stale after the first write in a session.
 */
var setResamplerFlag = function (editor, enabled) {
  var FLAG = '--disable-audio-output-resampler';
  var tokens = String(editor.get('chromium-args') || '')
    .split(/\s+/)
    .filter(Boolean)
    .filter(function (token) {
      return token !== FLAG;
    });

  if (!tokens.length) {
    tokens.push('--enable-node-worker');
  }

  if (enabled) {
    tokens.push(FLAG);
  }

  editor.set('chromium-args', tokens.join(' '));
};
