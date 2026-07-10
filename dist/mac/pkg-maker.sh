#!/bin/sh
APP_NAME="$(cat package.json | grep '\"name\"' | cut -d '"' -f 4)"
APP_VER="$(cat package.json | grep version | cut -d '"' -f 4)"
PLATFORM="${1:-osx64}"
BUILD_PATH="${APP_NAME}/${PLATFORM}/${APP_NAME}.app"
CURRENT_DIR="$( dirname "${BASH_SOURCE[0]}" )"

cd $CURRENT_DIR/../../build

if [ ! -d "$BUILD_PATH" ]; then
    echo "Build not found: $BUILD_PATH (run gulp build --platforms=${PLATFORM} first)" >&2
    exit 1
fi

# distribution.xml references the intermediate by the fixed name Build.pkg,
# so this script must not run concurrently for multiple platforms.
rm -f Build.pkg "${APP_NAME}-${APP_VER}-${PLATFORM}.pkg"
pkgbuild --root $BUILD_PATH --version $APP_VER --ownership recommended --install-location /Applications/${APP_NAME}.app Build.pkg
productbuild --resources ../dist/mac/resources/ --distribution ../dist/mac/resources/distribution.xml --version $APP_VER "${APP_NAME}-${APP_VER}-${PLATFORM}.pkg"
rm -f Build.pkg
