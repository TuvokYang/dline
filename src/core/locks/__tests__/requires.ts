// Minimal requires for lock service tests.
// Avoids src/test/requires.ts because it loads src/utils/path.ts
// which is ESM-only and conflicts with mocha's CJS loader.

String.prototype.toPosix = function () {
    return String(this).replace(/\\\\/g, "/")
}
