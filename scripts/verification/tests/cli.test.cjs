jest.mock('../runner.cjs', () => ({ verify: jest.fn() }));
const { verify } = require('../runner.cjs');
const { main } = require('../cli.cjs');
let log;
beforeEach(() => { log = jest.spyOn(console, 'log').mockImplementation(() => {}); jest.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => jest.restoreAllMocks());
test('no arbitrary commands or directories, duplicates rejected', async () => {
  expect(await main(['--command=bad'])).toBe(2); expect(await main(['--plan', '--plan'])).toBe(2);
});
test('plan never executes and limited profile remains marked non-acceptance', async () => {
  verify.mockClear(); expect(await main(['--plan'])).toBe(0);
  expect(JSON.parse(log.mock.calls[0][0]).acceptance).toBe(false); expect(verify).not.toHaveBeenCalled();
  expect(await main(['--plan', '--runner'])).toBe(0);
});
test('normal return, progress and signals are forwarded; listeners removed', async () => {
  const initial = process.listenerCount('SIGTERM');
  verify.mockImplementation(async options => {
    options.onStep('one', 'PASS'); process.emit('SIGTERM'); process.emit('SIGTERM'); process.emit('SIGINT'); process.emit('SIGINT');
    expect(options.signal.aborted).toBe(true);
    return { report: { status: 'INTERRUPTED' }, directory: '/tmp/fixture', exitCode: 1 };
  });
  expect(await main([])).toBe(1); expect(process.listenerCount('SIGTERM')).toBe(initial);
});
test('exceptions still remove signal listeners', async () => {
  const initial = process.listenerCount('SIGINT'); verify.mockRejectedValue(new Error('fixture'));
  await expect(main(['--runner'])).rejects.toThrow('fixture'); expect(process.listenerCount('SIGINT')).toBe(initial);
});
