const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const { captureStream, STREAM_LIMIT } = require('../stream-capture.cjs');
const roots = [];
function fixture(overrides = {}) {
    const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'stream-capture-'));
    roots.push(directory);
    const stream = new EventEmitter();
    const finish = captureStream(stream, { directory, index: 4, name: 'stdout', ...overrides });
    return { directory, stream, finish, file: path.join(directory, '0004-stdout.bin') };
}
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
const digest = buffer => createHash('sha256').update(buffer).digest('hex');
test('exact binary chunks, zero output, exclusive private file and idempotent completion', () => {
    const f = fixture();
    const chunks = [Buffer.from([0, 255, 13, 10]), Buffer.from('a😀b'), Buffer.alloc(0)];
    for (const chunk of chunks)
        f.stream.emit('data', chunk);
    const expected = Buffer.concat(chunks), result = f.finish();
    expect(result).toMatchObject({ bytes: expected.length, retainedBytes: expected.length, complete: true, limitReached: false, sha256: digest(expected), artifact: 'logs/0004-stdout.bin', error: null });
    expect(fs.readFileSync(f.file)).toEqual(expected);
    expect(fs.statSync(f.file).mode & 0o777).toBe(0o600);
    expect(f.finish()).toBe(result);
    expect(f.stream.listenerCount('data')).toBe(0);
    const empty = fixture();
    expect(empty.finish()).toMatchObject({ bytes: 0, retainedBytes: 0, complete: true, sha256: digest(Buffer.alloc(0)) });
    expect(fs.readFileSync(empty.file).length).toBe(0);
});
test('16MiB bound, exact boundary, prefix retention, full count/hash after overflow', () => {
    expect(STREAM_LIMIT).toBe(16 * 1024 * 1024);
    const exact = fixture({ limit: 4 });
    exact.stream.emit('data', Buffer.from('abcd'));
    expect(exact.finish()).toMatchObject({ complete: true, limitReached: false, retainedBytes: 4 });
    const f = fixture({ limit: 4 });
    for (const chunk of ['abc', 'def', 'tail'])
        f.stream.emit('data', Buffer.from(chunk));
    const r = f.finish();
    expect(r).toMatchObject({ bytes: 10, retainedBytes: 4, complete: false, limitReached: true, sha256: digest(Buffer.from('abcdeftail')) });
    expect(fs.readFileSync(f.file, 'utf8')).toBe('abcd');
    const zero = fixture({ limit: 0 });
    zero.stream.emit('data', Buffer.from('x'));
    expect(zero.finish()).toMatchObject({ bytes: 1, retainedBytes: 0, limitReached: true });
});
test('partial writes counted accurately and all IO error phases are sanitized and drained', () => {
    const partial = fixture({ io: { ...fs, writeSync: (fd, chunk, offset, length) => fs.writeSync(fd, chunk, offset, Math.min(2, length)) } });
    partial.stream.emit('data', Buffer.from('abcdef'));
    expect(partial.finish().complete).toBe(true);
    expect(fs.readFileSync(partial.file, 'utf8')).toBe('abcdef');
    for (const [method, error] of [['openSync', 'LOG_OPEN_ERROR'], ['writeSync', 'LOG_WRITE_ERROR'], ['fsyncSync', 'LOG_SYNC_ERROR']]) {
        const io = { ...fs, [method]: () => { throw new Error('private-payload'); } };
        const f = fixture({ io });
        f.stream.emit('data', Buffer.from('secret'));
        f.stream.emit('data', Buffer.from('more'));
        const r = f.finish();
        expect(r.error).toBe(error);
        expect(r.complete).toBe(false);
        expect(r.bytes).toBe(10);
        expect(r.sha256).toBe(digest(Buffer.from('secretmore')));
        expect(JSON.stringify(r)).not.toMatch(/private-payload|secretmore/);
    }
    let calls = 0;
    const close = fixture({ io: { ...fs, closeSync: fd => { calls++; fs.closeSync(fd); throw Error('close-secret'); } } });
    close.stream.emit('data', Buffer.from('x'));
    expect(close.finish()).toMatchObject({ error: 'LOG_CLOSE_ERROR', complete: false });
    expect(calls).toBe(1);
    for (const count of [0, -1, 100]) {
        const f = fixture({ io: { ...fs, writeSync: () => count } });
        f.stream.emit('data', Buffer.from('x'));
        expect(f.finish().error).toBe('LOG_WRITE_ERROR');
    }
});
test('path/index/stream validation, symlinks and preexisting targets never overwrite', () => {
    for (const overrides of [{ index: -1 }, { index: 10000 }, { index: '../x' }, { name: '../stderr' }, { limit: -1 }, { limit: STREAM_LIMIT + 1 }, { directory: '/nonexistent-private-logs' }]) {
        const f = fixture(overrides);
        f.stream.emit('data', Buffer.from('x'));
        expect(f.finish().complete).toBe(false);
    }
    const f = fixture();
    f.stream.emit('data', Buffer.from('original'));
    f.finish();
    const second = new EventEmitter();
    const finish = captureStream(second, { directory: f.directory, index: 4, name: 'stdout' });
    second.emit('data', Buffer.from('overwrite'));
    expect(finish().error).toBe('LOG_OPEN_ERROR');
    expect(fs.readFileSync(f.file, 'utf8')).toBe('original');
    const target = path.join(f.directory, 'target');
    fs.writeFileSync(target, 'intact');
    fs.symlinkSync(target, path.join(f.directory, '0005-stderr.bin'));
    const stream = new EventEmitter();
    const end = captureStream(stream, { directory: f.directory, index: 5, name: 'stderr' });
    stream.emit('data', Buffer.from('attack'));
    expect(end().complete).toBe(false);
    expect(fs.readFileSync(target, 'utf8')).toBe('intact');
    const link = path.join(f.directory, 'linked');
    fs.symlinkSync(f.directory, link);
    const directoryLink = fixture({ directory: link });
    expect(directoryLink.finish().error).toBe('LOG_PATH_ERROR');
    const fileDirectory = fixture({ directory: target });
    expect(fileDirectory.finish().error).toBe('LOG_PATH_ERROR');
});
test('pipe error is explicit, no unhandled error and descriptor still closed', () => { const f = fixture(); f.stream.emit('error', Error('private')); f.stream.emit('data', Buffer.from('after')); expect(f.finish()).toMatchObject({ error: 'LOG_STREAM_ERROR', complete: false, bytes: 5 }); });
test('close error never retries a potentially reused descriptor', () => {
    let calls = 0, sentinel;
    const f = fixture({ io: { ...fs, closeSync(fd) {
                calls++;
                fs.closeSync(fd);
                sentinel = fs.openSync(path.join(roots[roots.length - 1], 'sentinel'), 'w');
                throw Error('closed-before-error');
            } } });
    f.stream.emit('data', Buffer.from('done'));
    expect(f.finish()).toMatchObject({ error: 'LOG_CLOSE_ERROR', complete: false });
    expect(calls).toBe(1);
    try {
        expect(fs.writeSync(sentinel, Buffer.from('still-open'))).toBe(10);
    }
    finally {
        fs.closeSync(sentinel);
    }
});
