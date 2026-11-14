'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const STREAM_LIMIT = 16 * 1024 * 1024;

/** Local evidence only. Never serialize raw chunks or arbitrary filesystem errors.
 * Synchronous writes keep at most the current pipe chunk in memory, with no queue
 * of pending writes. Wall time can vary with synchronous disk IO; child budgets
 * are not changed. A failed/limited sink still drains and hashes every byte. */
function captureStream(stream, { directory, index, name, io = fs, limit = STREAM_LIMIT }) {
  const hash = createHash('sha256');
  let bytes = 0, retainedBytes = 0, fd = null, error = null, limitReached = false;
  let artifact = null, finished = null;
  const failure = code => { if (!error) error = code; };
  const valid = Number.isSafeInteger(index) && index >= 0 && index < 10000
    && ['stdout', 'stderr'].includes(name) && Number.isSafeInteger(limit) && limit >= 0 && limit <= STREAM_LIMIT;
  if (!valid) failure('LOG_PATH_ERROR');
  else {
    const filename = String(index).padStart(4, '0') + '-' + name + '.bin';
    artifact = 'logs/' + filename;
    try {
      const stat = io.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()
        || io.realpathSync(directory) !== path.resolve(directory)) failure('LOG_PATH_ERROR');
      else fd = io.openSync(path.join(directory, filename),
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    } catch { failure('LOG_OPEN_ERROR'); }
  }
  function data(chunk) {
    bytes += chunk.length;
    hash.update(chunk);
    if (bytes > limit) limitReached = true;
    if (fd === null || error || retainedBytes >= limit) return;
    const length = Math.min(chunk.length, limit - retainedBytes);
    let offset = 0;
    try {
      while (offset < length) {
        const count = io.writeSync(fd, chunk, offset, length - offset);
        if (!Number.isInteger(count) || count <= 0 || count > length - offset) {
          failure('LOG_WRITE_ERROR'); break;
        }
        retainedBytes += count;
        offset += count;
      }
    } catch { failure('LOG_WRITE_ERROR'); }
  }
  const streamError = () => failure('LOG_STREAM_ERROR');
  stream.on('data', data);
  stream.on('error', streamError);
  return function finish() {
    if (finished) return finished;
    stream.removeListener('data', data);
    stream.removeListener('error', streamError);
    if (fd !== null) {
      try { io.fsyncSync(fd); } catch { failure('LOG_SYNC_ERROR'); }
      try { io.closeSync(fd); } catch {
        failure('LOG_CLOSE_ERROR');
        // Close may already have released this descriptor. Never retry a possibly
        // reused descriptor; uncertain closure remains incomplete evidence.
      }
      fd = null;
    }
    finished = { bytes, sha256: hash.digest('hex'), artifact,
      retainedBytes, complete: error === null && !limitReached && retainedBytes === bytes,
      limitReached, limitBytes: limit, error };
    return finished;
  };
}
module.exports = { captureStream, STREAM_LIMIT };
