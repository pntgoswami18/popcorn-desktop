((App) => {
    const mediaNameSymbol = Symbol('torrentMediaName');
    const maxTimeInCacheMs = 60 * 1000;

    class MediaNamePlugin {
        constructor() {
            this._infoHashToMediaName = new Map();
            this._infoHashToInsertTime = new Map();
            this._cleanupTask = setInterval(() => this.cleanMediaNames(), maxTimeInCacheMs);
        }

        cleanMediaNames() {
            const now = Date.now();
            for (const [infoHash, insertTime] of this._infoHashToInsertTime) {
                if (now - insertTime >= maxTimeInCacheMs) {
                    this._infoHashToInsertTime.delete(infoHash);
                    this._infoHashToMediaName.delete(infoHash);
                }
            }
        }

        setMediaName(infoHash, mediaName) {
            this._infoHashToMediaName.set(infoHash, mediaName);
            this._infoHashToInsertTime.set(infoHash, Date.now());
        }

        getMediaName(torrent) {
            if (torrent.name) {
                return torrent.name;
            }
            if (torrent[mediaNameSymbol]) {
                return torrent[mediaNameSymbol];
            }
            const mediaName = this._infoHashToMediaName.get(torrent.infoHash);
            this._infoHashToInsertTime.delete(torrent.infoHash);
            this._infoHashToMediaName.delete(torrent.infoHash);
            if (mediaName) {
                torrent[mediaNameSymbol] = mediaName;
                return mediaName;
            }
            return i18n.__('Unknown torrent');
        }
    }
    App.plugins.mediaName = new MediaNamePlugin();
})(window.App);
